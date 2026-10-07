/**
 * Event journal repository (S07; AC3, E12) — the only place journal SQL lives.
 *
 * The journal is append-only. Per-stream sequences are strictly monotonic:
 * the next sequence is allocated inside the same transaction as the insert,
 * and PRIMARY KEY (workspace_id, stream_id, sequence) makes any duplicate
 * allocation fail rather than silently overwrite. Duplicate (workspace_id,
 * event_id) inserts are idempotently ignored (AC3): the original row stays
 * intact and the caller learns no new row was written. Uniqueness — like
 * everything else in this table — is workspace-scoped (E12): the same
 * event_id in two workspaces are independent rows (C-3), so the no-op path
 * can only ever match a row the SAME workspace wrote. Every read and write
 * is workspace-scoped (E12).
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export interface EventJournalRow {
  stream_id: string;
  sequence: number;
  event_id: string;
  event_type: string;
  schema_version: number;
  /** Immutable JSON payload, stored as text. */
  payload: string;
  workspace_id: string;
  occurred_at: string;
  correlation_id: string;
}

export class EventJournalRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  /**
   * Allocate the next per-stream sequence. Called inside the SAME transaction
   * as the append so no other writer can interleave between allocation and
   * insert (BEGIN IMMEDIATE serializes writers; the composite primary key is
   * the backstop that fails loudly instead of overwriting).
   */
  nextSequence(streamId: string, workspaceId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM event_journal WHERE stream_id = ? AND workspace_id = ?",
      )
      .get(streamId, workspaceId) as { next_sequence: number | bigint } | undefined;
    const next = row?.next_sequence;
    if (typeof next === "bigint") {
      return Number(next);
    }
    if (typeof next !== "number") {
      throw new Error("event journal: failed to allocate the next stream sequence");
    }
    return next;
  }

  /**
   * Append one event. Returns the inserted row, or null when an event with
   * the same (workspace_id, event_id) already exists (idempotent no-op —
   * AC3). A conflicting (workspace_id, stream_id, sequence) with a NEW
   * event_id is a hard failure, never a silent drop.
   */
  append(row: EventJournalRow, exec?: DatabaseSync): EventJournalRow | null {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `INSERT INTO event_journal
           (stream_id, sequence, event_id, event_type, schema_version,
            payload, workspace_id, occurred_at, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, event_id) DO NOTHING`,
      )
      .run(
        row.stream_id,
        row.sequence,
        row.event_id,
        row.event_type,
        row.schema_version,
        row.payload,
        row.workspace_id,
        row.occurred_at,
        row.correlation_id,
      );

    if (result.changes === 0) {
      const existing = this.findById(row.workspace_id, row.event_id, db);
      if (!existing) {
        throw new Error(
          `event journal: append reported no change but event_id ${row.event_id} is absent`,
        );
      }
      return null;
    }
    return row;
  }

  findById(workspaceId: string, eventId: string, exec?: DatabaseSync): EventJournalRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT stream_id, sequence, event_id, event_type, schema_version,
                payload, workspace_id, occurred_at, correlation_id
         FROM event_journal
         WHERE event_id = ? AND workspace_id = ?`,
      )
      .get(eventId, workspaceId) as EventJournalRow | undefined;
    return row ?? null;
  }

  listStream(streamId: string, workspaceId: string, exec?: DatabaseSync): EventJournalRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT stream_id, sequence, event_id, event_type, schema_version,
                payload, workspace_id, occurred_at, correlation_id
         FROM event_journal
         WHERE stream_id = ? AND workspace_id = ?
         ORDER BY sequence ASC`,
      )
      .all(streamId, workspaceId) as unknown as EventJournalRow[];
  }

  /**
   * Distinct journal streams of one workspace (projection-rebuild discovery,
   * E12): callers fold each stream back into aggregate state.
   */
  listWorkspaceStreams(workspaceId: string, exec?: DatabaseSync): string[] {
    const db = exec ?? this.tx.connection();
    const rows = db
      .prepare("SELECT DISTINCT stream_id FROM event_journal WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ stream_id: string }>;
    return rows.map((row) => row.stream_id);
  }

  countStream(streamId: string, workspaceId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM event_journal WHERE stream_id = ? AND workspace_id = ?")
      .get(streamId, workspaceId) as { n: number | bigint } | undefined;
    const n = row?.n;
    return typeof n === "bigint" ? Number(n) : (n ?? 0);
  }

  /**
   * Replay read (AC4): the durable events of one stream strictly after
   * `afterSequence`, in order, workspace-scoped. `limit` bounds a single
   * replay batch; the caller pages by advancing its cursor.
   */
  readFrom(
    workspaceId: string,
    streamId: string,
    afterSequence: number,
    limit: number,
    exec?: DatabaseSync,
  ): EventJournalRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT stream_id, sequence, event_id, event_type, schema_version,
                payload, workspace_id, occurred_at, correlation_id
         FROM event_journal
         WHERE workspace_id = ? AND stream_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(workspaceId, streamId, afterSequence, limit) as unknown as EventJournalRow[];
  }

  /** Lowest sequence still present for a stream (E10 retention horizon). */
  minSequence(workspaceId: string, streamId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        "SELECT MIN(sequence) AS min_sequence FROM event_journal WHERE workspace_id = ? AND stream_id = ?",
      )
      .get(workspaceId, streamId) as { min_sequence: number | bigint | null } | undefined;
    const value = row?.min_sequence;
    if (value === null || value === undefined) {
      return 0;
    }
    return typeof value === "bigint" ? Number(value) : value;
  }

  /** Highest sequence currently held for a stream (snapshot cursor anchor). */
  maxSequence(workspaceId: string, streamId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        "SELECT MAX(sequence) AS max_sequence FROM event_journal WHERE workspace_id = ? AND stream_id = ?",
      )
      .get(workspaceId, streamId) as { max_sequence: number | bigint | null } | undefined;
    const value = row?.max_sequence;
    if (value === null || value === undefined) {
      return 0;
    }
    return typeof value === "bigint" ? Number(value) : value;
  }
}
