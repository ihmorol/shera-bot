/**
 * Journal-driven conversation projection (S07; D5, D23 rule 2).
 *
 * Rebuilds the conversations aggregate of one workspace from the event
 * journal ALONE — the D5 claim "projections are rebuildable from the journal"
 * is implemented and test-proven HERE, for conversations. Task-run
 * projections are in-memory only and rebuild with the recovery slice (S31).
 *
 * Every replayed row's payload is re-validated against the journal registry
 * (EVENT_TYPES) as it folds — the same schema the append boundary enforced —
 * so a row that was never written by the gateway cannot silently shape the
 * rebuilt state (G2). Fold discipline: creation must precede renames, stream
 * id and payload conversation_id must agree, and revisions must be gapless
 * (new_revision = current + 1); any mismatch is a corruption signal, never a
 * silent repair.
 */
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteExec } from "../../adapters/sqlite/transactions.ts";
import { EVENT_TYPES, type EventType } from "../events/events.types.ts";

/** The durable conversation state the journal can always reproduce. */
export interface ConversationProjection {
  id: string;
  workspace_id: string;
  title: string;
  revision: number;
}

export function rebuildConversationProjections(
  workspaceId: string,
  journal: EventJournalRepository,
  exec?: SqliteExec,
): Map<string, ConversationProjection> {
  const projections = new Map<string, ConversationProjection>();

  const streams = journal
    .listWorkspaceStreams(workspaceId, exec)
    .filter((streamId) => streamId.startsWith("conversation:"));

  for (const streamId of streams) {
    for (const row of journal.listStream(streamId, workspaceId, exec)) {
      const descriptor = EVENT_TYPES[row.event_type as EventType];
      if (!descriptor) {
        // Append-only rows were registry-validated at write time; an unknown
        // type in storage is corruption, not a client error (same policy as
        // replay.service's envelope reader).
        throw new Error(
          `conversation projection: event ${row.event_id} has unknown type ${row.event_type}`,
        );
      }
      let payload: {
        conversation_id: string;
        title: string;
        previous_revision?: number;
        new_revision?: number;
      };
      try {
        payload = descriptor.payload.parse(JSON.parse(row.payload)) as typeof payload;
      } catch (error) {
        // Registry validation failure during the fold: surfaced with its row,
        // never silently repaired (G2/G5).
        throw new Error(
          `conversation projection: event ${row.event_id} failed registry validation: ${String(error)}`,
          { cause: error },
        );
      }

      if (streamId !== `conversation:${payload.conversation_id}`) {
        throw new Error(
          `conversation projection: event ${row.event_id} stream ${streamId} does not match payload conversation ${payload.conversation_id}`,
        );
      }

      const existing = projections.get(payload.conversation_id);
      if (row.event_type === "conversation.created") {
        if (existing) {
          throw new Error(
            `conversation projection: duplicate creation for conversation ${payload.conversation_id}`,
          );
        }
        projections.set(payload.conversation_id, {
          id: payload.conversation_id,
          workspace_id: workspaceId,
          title: payload.title,
          revision: 1,
        });
        continue;
      }

      if (row.event_type === "conversation.renamed") {
        if (!existing) {
          throw new Error(
            `conversation projection: rename before creation for conversation ${payload.conversation_id}`,
          );
        }
        if (
          payload.previous_revision !== existing.revision ||
          payload.new_revision !== existing.revision + 1
        ) {
          throw new Error(
            `conversation projection: gapless revision check failed for conversation ${payload.conversation_id} (journal ${payload.previous_revision}->${payload.new_revision}, projected ${existing.revision})`,
          );
        }
        projections.set(payload.conversation_id, {
          ...existing,
          title: payload.title,
          revision: payload.new_revision ?? existing.revision + 1,
        });
        continue;
      }

      throw new Error(
        `conversation projection: unexpected event type ${row.event_type} on ${streamId}`,
      );
    }
  }

  return projections;
}
