/**
 * Events service (S07; AC2, AC3, G2).
 *
 * The journal-append authority: it validates event payloads against the
 * module schemas (G2 — the gateway validates what it persists), allocates
 * strictly monotonic per-stream sequences inside the append transaction, and
 * treats duplicate event_id as an idempotent no-op that returns the ORIGINAL
 * event (AC3). Aggregate state transitions live in their modules (e.g.
 * modules/conversations), which call appendEvent INSIDE their own transaction
 * so the transition and the event commit atomically (AC2) — the nested call
 * joins the open transaction instead of nesting SQLite transactions.
 */
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  EVENT_TYPES,
  type AppendEventInput,
  type EventEnvelope,
  type EventType,
} from "./events.types.ts";

/** Stable failure codes for the journal boundary (SCREAMING_SNAKE). */
export type EventsServiceFailureCode =
  | "EVENT_PAYLOAD_INVALID"
  | "EVENT_UNKNOWN_TYPE"
  | "EVENT_SEQUENCE_CONFLICT";

export class EventsServiceError extends Error {
  readonly code: EventsServiceFailureCode;
  readonly category: "validation" | "conflict";

  constructor(
    code: EventsServiceFailureCode,
    category: "validation" | "conflict",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EventsServiceError";
    this.code = code;
    this.category = category;
  }
}

export class EventsService {
  constructor(
    private readonly journal: EventJournalRepository,
    private readonly tx: SqliteTransactions,
  ) {}

  /**
   * Append one event: validate payload (G2), allocate the next per-stream
   * sequence, insert. Duplicate event_id returns the ORIGINAL event unchanged
   * (idempotent — AC3). Joins an already-open transaction (AC2 composition);
   * otherwise runs in its own short transaction.
   */
  appendEvent<T extends EventType>(input: AppendEventInput<T>): EventEnvelope<T> {
    const descriptor = EVENT_TYPES[input.type];
    if (!descriptor) {
      throw new EventsServiceError(
        "EVENT_UNKNOWN_TYPE",
        "validation",
        `event type ${input.type} has no schema`,
      );
    }
    const parsed = descriptor.payload.safeParse(input.payload);
    if (!parsed.success) {
      throw new EventsServiceError(
        "EVENT_PAYLOAD_INVALID",
        "validation",
        `payload for ${input.type} failed schema validation`,
      );
    }

    return this.tx.transaction((exec) => {
      const existing = this.journal.findById(input.workspace_id, input.event_id, exec);
      if (existing) {
        return this.toEnvelope(existing) as EventEnvelope<T>;
      }

      const sequence = this.journal.nextSequence(input.stream_id, input.workspace_id, exec);
      const inserted = this.journal.append(
        {
          stream_id: input.stream_id,
          sequence,
          event_id: input.event_id,
          event_type: input.type,
          schema_version: descriptor.schema_version,
          payload: JSON.stringify(parsed.data),
          workspace_id: input.workspace_id,
          occurred_at: new Date().toISOString(),
          correlation_id: input.correlation_id,
        },
        exec,
      );

      if (!inserted) {
        // Lost an idempotency race inside this transaction: return the winner.
        const winner = this.journal.findById(input.workspace_id, input.event_id, exec);
        if (!winner) {
          throw new EventsServiceError(
            "EVENT_SEQUENCE_CONFLICT",
            "conflict",
            "append neither inserted nor found the idempotent original",
          );
        }
        return this.toEnvelope(winner) as EventEnvelope<T>;
      }
      return this.toEnvelope(inserted, input.type) as EventEnvelope<T>;
    });
  }

  private toEnvelope(
    row: {
      event_id: string;
      stream_id: string;
      sequence: number;
      event_type: string;
      schema_version: number;
      payload: string;
      workspace_id: string;
      occurred_at: string;
      correlation_id: string;
    },
    knownType?: EventType,
  ): EventEnvelope {
    const type = (knownType ?? (row.event_type as EventType)) as EventType;
    return {
      event_id: row.event_id,
      stream_id: row.stream_id,
      sequence: row.sequence,
      type,
      schema_version: row.schema_version,
      payload: JSON.parse(row.payload) as never,
      workspace_id: row.workspace_id,
      occurred_at: row.occurred_at,
      correlation_id: row.correlation_id,
    };
  }
}
