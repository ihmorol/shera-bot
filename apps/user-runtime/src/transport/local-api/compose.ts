/**
 * Minimal composition root for the typed local API and its WebSocket gateway
 * (S07).
 *
 * Wires the container-local SQLite database (WAL, foreign keys, committed
 * migrations) through the repositories into the chunk-2 services, the Express
 * app factory, and — for the full runtime — a Socket.IO gateway mounted on
 * the SAME HTTP server. This is the wiring the container entrypoint will
 * reuse; here it exists so tests exercise the REAL stack — real SQLite, real
 * transactions, real HTTP and WS — not a mock transport.
 *
 * The replay snapshot loader is the conversation aggregate read through its
 * repository (workspace-scoped, E12); the retention horizon defaults to the
 * journal's lowest held sequence minus one (no compaction in this slice —
 * E10 hook), and can be overridden where a future compactor raises it.
 *
 * The publish hook is late-bound: the gateway does not exist when the
 * conversations service is constructed, but the D26/AC8 discipline holds —
 * the hook fires strictly AFTER the committing transaction, whichever
 * subscriber(s) are bound by then.
 */
import { createServer, type Server as HTTPServer } from "node:http";

import type { Express } from "express";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
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
import {
  attachWebSocketGateway,
  type WebSocketGatewayHandle,
} from "../websocket/gateway.ts";

export interface ComposeLocalApiOptions {
  /** Path of the container-local SQLite database file. */
  dbPath: string;
  /** Post-commit live fanout hook (HTTP-only composition; tests). */
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

export interface ComposeRuntimeOptions extends ComposeLocalApiOptions {
  /** Transport heartbeats (engine.io ping/pong); defaults documented in the gateway. */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

export interface RuntimeHandle {
  app: Express;
  /** The one HTTP server serving BOTH the local API and the WS gateway. */
  httpServer: HTTPServer;
  gateway: WebSocketGatewayHandle;
  /** Closes the gateway (and with it the HTTP server), then SQLite. */
  close(): Promise<void>;
}

interface Wired {
  conn: SqliteConnection;
  app: Express;
  replay: ReplayService;
  setPublisher(publisher: ConversationPublisher): void;
}

function wire(options: ComposeLocalApiOptions): Wired {
  const conn = openDatabase(options.dbPath);
  applyMigrations(conn.db);

  const tx = new SqliteTransactions(conn.db);
  const conversationsRepository = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const events = new EventsService(journal, tx);

  // Late-bound fanout: subscribers bind after construction (the WS gateway
  // mounts later); the post-commit discipline lives in the service.
  let publisher: ConversationPublisher = options.publish ?? (() => {});
  const conversations = new ConversationsService({
    journal: events,
    conversations: conversationsRepository,
    receipts,
    tx,
    publish: (event) => publisher(event),
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
  return {
    conn,
    app,
    replay,
    setPublisher(next) {
      publisher = next;
    },
  };
}

export function composeLocalApi(options: ComposeLocalApiOptions): LocalApiHandle {
  const wired = wire(options);
  return { app: wired.app, close: () => wired.conn.close() };
}

/**
 * Full runtime composition: local API + WebSocket gateway on one HTTP server.
 * Live fanout flows from the conversations service's post-commit publish hook
 * into the gateway's per-stream rooms; the WS layer itself stays read-only.
 */
export function composeRuntime(options: ComposeRuntimeOptions): RuntimeHandle {
  const wired = wire(options);
  const httpServer = createServer(wired.app);
  const gateway = attachWebSocketGateway(httpServer, {
    replay: wired.replay,
    ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
    ...(options.pingTimeoutMs ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
  });
  wired.setPublisher((event) => gateway.broadcastConversationEvent(event));
  return {
    app: wired.app,
    httpServer,
    gateway,
    close: async () => {
      // io.close() also closes the attached HTTP server (socket.io v4).
      await gateway.close();
      wired.conn.close();
    },
  };
}
