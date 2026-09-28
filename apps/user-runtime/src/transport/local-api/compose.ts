/**
 * Minimal composition root for the typed local API (S07).
 *
 * Wires the container-local SQLite database (WAL, foreign keys, committed
 * migrations) through the repositories into the chunk-2 services and the
 * Express app factory. This is the wiring the container entrypoint will
 * reuse; here it exists so tests exercise the REAL stack — real SQLite, real
 * transactions, real HTTP — not a mock transport.
 *
 * The replay snapshot loader is the conversation aggregate read through its
 * repository (workspace-scoped, E12); the retention horizon defaults to the
 * journal's lowest held sequence minus one (no compaction in this slice —
 * E10 hook), and can be overridden where a future compactor raises it.
 */
import type { Express } from "express";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../../modules/events/events.service.ts";
import { ReplayService } from "../../modules/events/replay.service.ts";
import {
  ConversationsService,
  type ConversationPublisher,
} from "../../modules/conversations/conversations.service.ts";
import { createLocalApi } from "./app.ts";

export interface ComposeLocalApiOptions {
  /** Path of the container-local SQLite database file. */
  dbPath: string;
  /** Post-commit live fanout hook (WebSocket layer arrives in a later chunk). */
  publish?: ConversationPublisher;
  /**
   * E10 hook: cursors strictly below the returned sequence are not replayable.
   * Default: the journal's lowest held sequence minus one (nothing compacted).
   */
  retentionHorizon?: (workspaceId: string, streamId: string) => number;
}

export interface LocalApiHandle {
  app: Express;
  /** Closes the SQLite connection. The caller owns the database file. */
  close(): void;
}

export function composeLocalApi(options: ComposeLocalApiOptions): LocalApiHandle {
  const conn = openDatabase(options.dbPath);
  applyMigrations(conn.db);

  const tx = new SqliteTransactions(conn.db);
  const conversationsRepository = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const events = new EventsService(journal, tx);

  const conversations = new ConversationsService({
    journal: events,
    conversations: conversationsRepository,
    receipts,
    tx,
    ...(options.publish ? { publish: options.publish } : {}),
  });

  const replay = new ReplayService({
    journal,
    loadSnapshot: (workspaceId, streamId) => {
      const conversationId = streamId.replace(/^conversation:/, "");
      const row = conversationsRepository.findById(workspaceId, conversationId, conn.db);
      if (!row) {
        return null;
      }
      return {
        kind: "conversation",
        conversation_id: row.id,
        workspace_id: row.workspace_id,
        title: row.title,
        revision: row.revision,
        up_to_sequence: journal.maxSequence(workspaceId, streamId, conn.db),
      };
    },
    retentionHorizon:
      options.retentionHorizon ??
      ((workspaceId, streamId) =>
        Math.max(0, journal.minSequence(workspaceId, streamId, conn.db) - 1)),
  });

  const app = createLocalApi({ conversations, replay });
  return { app, close: () => conn.close() };
}
