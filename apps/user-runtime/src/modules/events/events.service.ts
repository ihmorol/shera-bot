/**
 * Events service (S07; AC2, AC3, G2).
 *
 * The service is the ONLY caller of the journal and aggregate repositories:
 * it validates event payloads against the module schemas (G2 — the gateway
 * validates what it persists), allocates strictly monotonic per-stream
 * sequences, treats duplicate event_id as an idempotent no-op (AC3), and
 * commits each state transition together with its event in ONE transaction
 * (AC2): a failure anywhere inside the unit rolls back both the aggregate
 * row and the journal append.
 */
import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type {
  ConversationsRepository,
  ConversationRow,
} from "../../adapters/sqlite/conversations-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  EVENT_TYPES,
  type AppendEventInput,
  type EventEnvelope,
  type EventType,
} from "./events.types.ts";

/** Stable failure codes for the persistence boundary (SCREAMING_SNAKE). */
export type EventsServiceFailureCode =
  | "EVENT_PAYLOAD_INVALID"
  | "EVENT_UNKNOWN_TYPE"
  | "EVENT_SEQUENCE_CONFLICT"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_REVISION_CONFLICT";

export class EventsServiceError extends Error {
  readonly code: EventsServiceFailureCode;
  readonly category: "validation" | "conflict" | "state";

  constructor(
    code: EventsServiceFailureCode,
    category: "validation" | "conflict" | "state",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EventsServiceError";
    this.code = code;
    this.category = category;
  }
}

export interface CreateConversationInput {
  workspace_id: string;
  conversation_id?: string;
  title: string;
  correlation_id: string;
}

export interface RenameConversationInput {
  workspace_id: string;
  conversation_id: string;
  title: string;
  expected_revision: number;
  correlation_id: string;
}

export interface ConversationTransitionOutcome {
  conversation: ConversationRow;
  event: EventEnvelope;
}

export class EventsService {
  constructor(
    private readonly journal: EventJournalRepository,
    private readonly conversations: ConversationsRepository,
    private readonly tx: SqliteTransactions,
  ) {}

  /** The transaction primitive itself — any composed transition may use it. */
  transaction<T>(fn: (exec: DatabaseSync) => T): T {
    return this.tx.transaction(fn);
  }

  /**
   * Append one event: validate payload (G2), allocate the next per-stream
   * sequence, insert. Duplicate event_id returns the ORIGINAL event unchanged
   * (idempotent — AC3). Runs in its own short transaction when none is open.
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

  /** State transition + event append in one atomic unit (AC2). */
  createConversation(input: CreateConversationInput): ConversationTransitionOutcome {
    const conversationId = input.conversation_id ?? randomUUID();
    const now = new Date().toISOString();

    return this.tx.transaction((exec) => {
      const conversation: ConversationRow = {
        id: conversationId,
        workspace_id: input.workspace_id,
        title: input.title,
        revision: 1,
        created_at: now,
        updated_at: now,
      };
      this.conversations.create(conversation, exec);

      const event = this.appendEvent(
        {
          event_id: randomUUID(),
          stream_id: `conversation:${conversationId}`,
          type: "conversation.created",
          payload: {
            conversation_id: conversationId,
            workspace_id: input.workspace_id,
            title: input.title,
          },
          workspace_id: input.workspace_id,
          correlation_id: input.correlation_id,
        },
        // No transaction argument: appendEvent joins the ALREADY-OPEN outer
        // transaction through SqliteTransactions' nested-join behavior.
      ) as EventEnvelope<"conversation.created">;

      return { conversation, event };
    });
  }

  /** Optimistic rename; the transition and its event commit or roll back together (AC2). */
  renameConversation(input: RenameConversationInput): ConversationTransitionOutcome {
    return this.tx.transaction((exec) => {
      const existing = this.conversations.findById(input.workspace_id, input.conversation_id, exec);
      if (!existing) {
        throw new EventsServiceError(
          "CONVERSATION_NOT_FOUND",
          "state",
          `conversation ${input.conversation_id} does not exist in this workspace`,
        );
      }
      if (existing.revision !== input.expected_revision) {
        throw new EventsServiceError(
          "CONVERSATION_REVISION_CONFLICT",
          "conflict",
          `expected revision ${input.expected_revision}, current revision is ${existing.revision}`,
        );
      }

      const now = new Date().toISOString();
      const renamed = this.conversations.rename(
        input.workspace_id,
        input.conversation_id,
        input.expected_revision,
        input.title,
        now,
        exec,
      );
      if (!renamed) {
        throw new EventsServiceError(
          "CONVERSATION_REVISION_CONFLICT",
          "conflict",
          "rename matched no row at the expected revision",
        );
      }

      const event = this.appendEvent({
        event_id: randomUUID(),
        stream_id: `conversation:${input.conversation_id}`,
        type: "conversation.renamed",
        payload: {
          conversation_id: input.conversation_id,
          workspace_id: input.workspace_id,
          title: input.title,
          previous_revision: input.expected_revision,
          new_revision: renamed.revision,
        },
        workspace_id: input.workspace_id,
        correlation_id: input.correlation_id,
      }) as EventEnvelope<"conversation.renamed">;

      return { conversation: renamed, event };
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
