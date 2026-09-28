/**
 * Replay cursors (S07; AC4, E10).
 *
 * The client drives delivery with `last_acknowledged_sequence`: the gateway
 * returns EXACTLY the missed durable events of a stream, in order, once, and
 * the client resumes live delivery from the returned cursor. When a cursor
 * falls below the stream's retention horizon — events the journal no longer
 * holds — the E10 fallback answers with a SNAPSHOT of current state plus a
 * fresh cursor instead of pretending the gap is replayable (G4: no fake
 * completeness). The prototype implements the contract and the API shape; it
 * does not compact the journal (no compaction in this slice), so the horizon
 * is exercised through the horizon parameter and by tests that trim the
 * journal the way a future compactor would.
 */
import type {
  EventJournalRepository,
  EventJournalRow,
} from "../../adapters/sqlite/event-journal-repository.ts";
import { EVENT_TYPES, type EventEnvelope, type EventType } from "./events.types.ts";

/** Durable events are replayed in batches of at most this size. */
export const REPLAY_BATCH_LIMIT = 100;

export type ReplayResult<T extends EventType = EventType> =
  | {
      kind: "events";
      stream_id: string;
      workspace_id: string;
      /** Events strictly after the cursor, in ascending sequence order. */
      events: EventEnvelope<T>[];
      /** The sequence to acknowledge after consuming this batch. */
      next_cursor: number;
      replayed: true;
    }
  | {
      kind: "snapshot_required";
      stream_id: string;
      workspace_id: string;
      /** Why the cursor is not replayable (E10 hook — stable client contract). */
      reason: "cursor_below_retention_horizon" | "unknown_stream";
      /** The lowest sequence still held by the journal for this stream. */
      earliest_available_sequence: number;
      /** Snapshot of current aggregate state + the cursor to resume from. */
      snapshot: unknown;
      next_cursor: number;
      replayed: false;
    };

export interface ReplaySnapshot {
  kind: "conversation";
  conversation_id: string;
  workspace_id: string;
  title: string;
  revision: number;
  /** The sequence the snapshot reflects. */
  up_to_sequence: number;
}

export interface ReplayDeps {
  journal: EventJournalRepository;
  /** Loads the current aggregate state for the snapshot fallback. */
  loadSnapshot: (workspaceId: string, streamId: string) => ReplaySnapshot | null;
  /**
   * The retention horizon: cursors strictly below the returned sequence are
   * not replayable. The prototype returns the journal's lowest held sequence
   * (no compaction); a future compactor raises it.
   */
  retentionHorizon: (workspaceId: string, streamId: string) => number;
}

function toEnvelope(row: EventJournalRow): EventEnvelope {
  const type = row.event_type as EventType;
  if (!EVENT_TYPES[type]) {
    // The journal is append-only and every writer validated its payload; an
    // unknown type in storage is a corruption signal, not a client error.
    throw new Error(`replay: event ${row.event_id} has unknown type ${row.event_type}`);
  }
  return {
    event_id: row.event_id,
    stream_id: row.stream_id,
    sequence: row.sequence,
    type,
    schema_version: row.schema_version,
    payload: JSON.parse(row.payload),
    workspace_id: row.workspace_id,
    occurred_at: row.occurred_at,
    correlation_id: row.correlation_id,
  };
}

export class ReplayService {
  constructor(private readonly deps: ReplayDeps) {}

  resolve(workspaceId: string, streamId: string, lastAcknowledgedSequence: number): ReplayResult {
    const horizon = this.deps.retentionHorizon(workspaceId, streamId);

    if (lastAcknowledgedSequence < horizon) {
      // The gap is not fully journaled: fall back to a snapshot + new cursor
      // (E10). An unknown stream reports itself the same way, with horizon 0.
      const snapshot = this.deps.loadSnapshot(workspaceId, streamId);
      if (!snapshot) {
        return {
          kind: "snapshot_required",
          stream_id: streamId,
          workspace_id: workspaceId,
          reason: "unknown_stream",
          earliest_available_sequence: horizon,
          snapshot: null,
          next_cursor: 0,
          replayed: false,
        };
      }
      return {
        kind: "snapshot_required",
        stream_id: streamId,
        workspace_id: workspaceId,
        reason: "cursor_below_retention_horizon",
        earliest_available_sequence: horizon,
        snapshot,
        next_cursor: snapshot.up_to_sequence,
        replayed: false,
      };
    }

    const rows = this.deps.journal.readFrom(
      workspaceId,
      streamId,
      lastAcknowledgedSequence,
      REPLAY_BATCH_LIMIT,
    );
    const events = rows.map(toEnvelope);
    const nextCursor =
      events.length > 0 ? events[events.length - 1]!.sequence : lastAcknowledgedSequence;
    return {
      kind: "events",
      stream_id: streamId,
      workspace_id: workspaceId,
      events,
      next_cursor: nextCursor,
      replayed: true,
    };
  }
}
