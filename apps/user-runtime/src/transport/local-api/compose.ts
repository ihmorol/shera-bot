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
import type { PackSnapshot } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { HarnessAdapter } from "../../adapters/process/harness-adapter.ts";
import { FakeHarnessAdapter } from "../../adapters/process/fake-harness-adapter.ts";
import { EventsService } from "../../modules/events/events.service.ts";
import { ReplayService } from "../../modules/events/replay.service.ts";
import type { EventEnvelope } from "../../modules/events/events.types.ts";
import {
  ConversationsService,
  type ConversationPublisher,
} from "../../modules/conversations/conversations.service.ts";
import {
  ScriptedReplyStreamer,
  type ScriptedReplyOptions,
} from "../../modules/conversations/reply-streamer.ts";
import { HarnessRunService } from "../../modules/runtime/harness-run-service.ts";
import { createLocalApi } from "./app.ts";
import { consoleRedactedLogger, type RedactedLogger } from "../http/typed-errors.ts";
import { attachWebSocketGateway, type WebSocketGatewayHandle } from "../websocket/gateway.ts";

/**
 * The container's default workspace (E12: every product-state record carries
 * workspace_id; the prototype container has exactly one). PROTOTYPE DEFAULT —
 * owner-confirmable: production wiring supersedes this via the
 * RUNTIME_DEFAULT_WORKSPACE_ID environment variable (main.ts).
 */
export const DEFAULT_WORKSPACE_ID = "ws-local-default";

/** The prototype's pinned pack (D28): a fixed snapshot, no pack store yet. */
const DEFAULT_PACK: PackSnapshot = {
  pack_id: "pack_default",
  pack_version: "0.1.0",
  pack_hash: "0".repeat(64),
};

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
  /** B-1: the redacted sink untyped HTTP faults are recorded to. Default: console.error JSON line. */
  logUntypedFault?: RedactedLogger;
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
  /** D51 seam: the harness adapter to drive task runs. Default: the deterministic fake. */
  harnessAdapter?: HarnessAdapter;
  /** E12: the container's default workspace. Default: DEFAULT_WORKSPACE_ID. */
  workspaceId?: string;
  /** D28: the pinned pack recorded on harness-created runs. Default: DEFAULT_PACK. */
  pinnedPack?: PackSnapshot;
  /**
   * Deterministic clock for harness-run journal envelopes. Default: wall
   * clock; the E8 mock mode pins it so runs are byte-comparable.
   */
  now?: () => string;
  /**
   * S09 chunk 2: enable the scripted reply producer for conversation turns
   * (the mock/E2E "demo stream equivalent"). When set, every durable USER
   * message triggers transient message.delta frames followed by ONE durable
   * agent reply through the command path. Default: undefined — NO replies are
   * produced (G4: nothing fabricates a response without configuration).
   */
  scriptedReplies?: ScriptedReplyOptions;
}

export interface RuntimeHandle {
  app: Express;
  /** The one HTTP server serving BOTH the local API and the WS gateway. */
  httpServer: HTTPServer;
  gateway: WebSocketGatewayHandle;
  /** The harness seam: later slices (and tests) start runs; the fake is default. */
  harness: HarnessRunService;
  /** The scripted reply producer when enabled; undefined otherwise (G4). */
  replyStreamer: ScriptedReplyStreamer | undefined;
  /** Closes the gateway (and with it the HTTP server), then SQLite. */
  close(): Promise<void>;
}

interface Wired {
  conn: SqliteConnection;
  app: Express;
  replay: ReplayService;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  events: EventsService;
  conversations: ConversationsService;
  setPublisher(publisher: ConversationPublisher): void;
}

/**
 * Fanout containment (B4/AC8): the publish hook fires strictly AFTER commit —
 * a subscriber's failure (the WS broadcast, any future transport) must never
 * fail an already-committed command or run. Errors are contained at THIS
 * wiring and recorded through the composition's redacted sink; the committed
 * result and the journal row are untouched by the fanout's fate.
 */
function containFanout<E extends EventEnvelope>(
  publisher: (event: E) => void,
  logFault: RedactedLogger,
): (event: E) => void {
  return (event) => {
    try {
      publisher(event);
    } catch (error) {
      logFault("fanout_failed", {
        stream_id: event.stream_id,
        workspace_id: event.workspace_id,
        sequence: event.sequence,
        event_type: event.type,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
    }
  };
}

function wire(options: ComposeLocalApiOptions): Wired {
  const logFault = options.logUntypedFault ?? consoleRedactedLogger;
  const conn = openDatabase(options.dbPath);
  applyMigrations(conn.db);

  const tx = new SqliteTransactions(conn.db);
  const conversationsRepository = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const events = new EventsService(journal, tx);

  // Late-bound fanout: subscribers bind after construction (the WS gateway
  // mounts later); the post-commit discipline lives in the service, and the
  // subscriber's failures are contained HERE (B4) — never at the command.
  let publisher: ConversationPublisher = options.publish ?? (() => {});
  const conversations = new ConversationsService({
    journal: events,
    conversations: conversationsRepository,
    receipts,
    tx,
    publish: containFanout((event) => publisher(event), logFault),
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

  const app = createLocalApi({
    conversations,
    replay,
    ...(options.logUntypedFault ? { logUntypedFault: options.logUntypedFault } : {}),
  });
  return {
    conn,
    app,
    replay,
    tx,
    journal,
    events,
    conversations,
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
 * Full runtime composition: local API + WebSocket gateway on one HTTP server,
 * plus the harness seam. Live fanout flows from the post-commit publish hooks
 * (conversations AND harness runs) into the gateway's per-stream rooms; the
 * WS layer itself stays read-only (D26).
 */
export function composeRuntime(options: ComposeRuntimeOptions): RuntimeHandle {
  const wired = wire(options);
  const httpServer = createServer(wired.app);
  const gateway = attachWebSocketGateway(httpServer, {
    replay: wired.replay,
    ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
    ...(options.pingTimeoutMs ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
  });
  // Every fanout route (conversation commands AND harness runs) flows through
  // the same containment (B4): a broadcast failure is recorded, never fatal.
  const logFault = options.logUntypedFault ?? consoleRedactedLogger;
  // S09 chunk 2: the scripted reply producer (mock/E2E) reacts to committed
  // user messages with delta frames + ONE durable agent reply through the
  // command path. Default: absent — a turn simply receives no reply (G4).
  const replyStreamer = options.scriptedReplies
    ? new ScriptedReplyStreamer({
        conversations: wired.conversations,
        broadcastFrame: (workspaceId, streamId, payload) =>
          gateway.broadcastStreamFrame(workspaceId, streamId, payload),
        options: options.scriptedReplies,
        onFault: (fault) =>
          logFault("reply_stream_failed", {
            name: fault instanceof Error ? fault.name : "Error",
            message: fault instanceof Error ? fault.message : String(fault),
          }),
      })
    : undefined;
  const broadcast = containFanout((event) => {
    gateway.broadcastStreamEvent(event);
    replyStreamer?.handleCommittedEvent(event);
  }, logFault);
  wired.setPublisher(broadcast);

  // D51 seam wiring: adapters propose through the sink; the service validates
  // and executes into the journal; committed envelopes fan out on the WS task
  // stream through the same gateway rooms as every other stream.
  const harness = new HarnessRunService({
    adapter: options.harnessAdapter ?? new FakeHarnessAdapter(),
    tx: wired.tx,
    journal: wired.journal,
    events: wired.events,
    pinned_pack: options.pinnedPack ?? DEFAULT_PACK,
    workspace_id: options.workspaceId ?? DEFAULT_WORKSPACE_ID,
    policy: { max_retries: 3 },
    publish: broadcast,
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    app: wired.app,
    httpServer,
    gateway,
    harness,
    replyStreamer,
    close: async () => {
      replyStreamer?.stopAll();
      // io.close() also closes the attached HTTP server (socket.io v4).
      await gateway.close();
      wired.conn.close();
    },
  };
}
