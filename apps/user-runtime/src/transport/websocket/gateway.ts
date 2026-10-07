/**
 * WebSocket gateway (S07; D26, AC4/AC8, E10/E12).
 *
 * Socket.IO server mounted on the SAME HTTP server as the typed local API.
 * WS is LIVE FANOUT ONLY and never mutates state (D26): the only inbound
 * messages are read-only — a stream subscription and a replay-cursor request
 * — both answered through server-side acknowledgements. There is no reference
 * to any command-execution path in this module (asserted by a boundary test);
 * mutations enter exclusively through the HTTP command route.
 *
 * Socket.IO features adopted vs avoided (E-note for the PR):
 * - ADOPT rooms: one server-side room per (workspace_id, stream_id) so a
 *   subscriber receives exactly its workspace's stream — the room name
 *   carries the workspace (E12); rooms are ephemeral and server-only, which
 *   is fine because durable history lives in the SQLite journal, not in WS.
 * - ADOPT server-side acknowledgements for both inbound messages: the ack is
 *   a typed, read-only response (a subscription receipt or the ReplayResult).
 * - AVOID Connection state recovery: it is backed by in-memory adapter state
 *   for a bounded window and is lost on restart ("recovery will not always be
 *   successful"). Durable resume comes from the SQLite journal through the
 *   ReplayService (AC4/E10) — see the replay.request handler where the two
 *   approaches meet.
 *
 * Heartbeats: Socket.IO's built-in engine.io ping/pong is transport-level —
 * NOT business events. Defaults below follow engine.io's (25s interval,
 * 20s timeout) and are configurable through the deps.
 */
import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HTTPServer } from "node:http";
import { z } from "zod";

import { Id, WorkspaceId } from "@shera-bot/contracts";

import type { EventEnvelope } from "../../modules/events/events.types.ts";
import type { ReplayService } from "../../modules/events/replay.service.ts";
import {
  consoleRedactedLogger,
  toSheraErrorResponse,
  contractValidationResponse,
  type RedactedLogger,
} from "../http/typed-errors.ts";

/** Server → client: one live, committed stream event (never replay batches). */
export const STREAM_EVENT = "stream.event" as const;
/** Client → server: subscribe to a stream's live fanout (read-only, acked). */
export const STREAM_SUBSCRIBE = "stream.subscribe" as const;
/** Client → server: replay missed durable events from a cursor (read-only, acked). */
export const REPLAY_REQUEST = "replay.request" as const;
/**
 * Server → client: one TRANSIENT stream frame (S09 chunk 2 — the reply
 * streamer's `message.delta` text deltas). Frames are presentation-side
 * fanout on this single channel: never journaled, never replayed, and losing
 * them is safe — the durable journal event that lands at stream end is the
 * source of truth. The payload carries `{ frame: <kind>, ... }`.
 */
export const STREAM_FRAME = "stream.frame" as const;

/** engine.io defaults; transport heartbeats only, not business events. */
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_PING_TIMEOUT_MS = 20_000;

const StreamSelector = z.strictObject({
  workspace_id: WorkspaceId,
  stream_id: Id,
});

const ReplayRequestBody = z.strictObject({
  workspace_id: WorkspaceId,
  stream_id: Id,
  /** The client's cursor; 0 replays the whole stream. */
  last_acknowledged_sequence: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
});

/**
 * E12: the room name carries the workspace, so twin streams never cross.
 * Each component is percent-encoded so the ":" separator is unambiguous:
 * workspace "ws1:conversation" + stream "abc" lands in a DIFFERENT room than
 * workspace "ws1" + stream "conversation:abc" (the encoding is lossless and
 * injective — "%" itself becomes "%25"), so a crafted selector can never
 * alias another workspace's room. ALL room names must come from THIS helper
 * (subscribe, replay-resume join, and broadcast share it).
 */
export function streamRoom(workspaceId: string, streamId: string): string {
  return `stream:${encodeURIComponent(workspaceId)}:${encodeURIComponent(streamId)}`;
}

export interface WebSocketGatewayDeps {
  /** AC4 durability — the ONLY replay authority (never an in-memory buffer). */
  replay: Pick<ReplayService, "resolve">;
  /** B3: the redacted sink a contained handler fault is recorded to. Default: console.error JSON line. */
  logHandlerFault?: RedactedLogger;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

export interface WebSocketGatewayHandle {
  io: SocketIOServer;
  /**
   * Live fanout of one committed journal envelope (D26/AC8: called strictly
   * AFTER the committing transaction; the WS layer owns no mutation path).
   * General over streams: conversation and task envelopes both route to their
   * workspace-scoped room (E12).
   */
  broadcastStreamEvent(event: EventEnvelope): void;
  /**
   * Transient frame fanout to a stream's room (S09 chunk 2): reply-streaming
   * text deltas ride the single STREAM_FRAME channel. Frames carry NO durable
   * state — they are never journaled and never replayed; the WS layer stays
   * read-only (D26).
   */
  broadcastStreamFrame(workspaceId: string, streamId: string, payload: unknown): void;
  /** Closes the gateway AND the HTTP server it is mounted on. */
  close(): Promise<void>;
}

function subscribeAck(
  workspaceId: string,
  streamId: string,
): {
  subscribed: true;
  workspace_id: string;
  stream_id: string;
} {
  return { subscribed: true, workspace_id: workspaceId, stream_id: streamId };
}

export function attachWebSocketGateway(
  server: HTTPServer,
  deps: WebSocketGatewayDeps,
): WebSocketGatewayHandle {
  const logHandlerFault = deps.logHandlerFault ?? consoleRedactedLogger;
  const io = new SocketIOServer(server, {
    // Transport-level heartbeats (engine.io ping/pong) — NOT business events.
    pingInterval: deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
    pingTimeout: deps.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
    // Connection state recovery is deliberately NOT enabled: it is in-memory
    // only (lost on restart, bounded window, not guaranteed). Durable replay
    // resume is the replay.request handler below, backed by the SQLite journal.
  });

  io.on("connection", (socket: Socket) => {
    // Every inbound handler is wrapped (B3): a synchronous fault — e.g.
    // ReplayService.resolve on a corrupt journal row — is CONTAINED here. The
    // client is acked a typed INTERNAL_ERROR carrying no internals (G3), the
    // fault is recorded through the redacted sink, and the socket stays
    // connected. An unwrapped throw would surface as an uncaughtException and
    // kill the whole runtime process.
    const guarded = (handler: string, run: () => void, ack?: (response: unknown) => void): void => {
      try {
        run();
      } catch (error) {
        logHandlerFault("ws_handler_failed", {
          handler,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        });
        // Same stable SheraError fields as the HTTP untyped-fault path.
        ack?.(toSheraErrorResponse(error).body);
      }
    };

    // Read-only subscription: join the stream's room, ack the receipt. No
    // command surface is reachable from here (D26 — WS never mutates state).
    socket.on(STREAM_SUBSCRIBE, (payload: unknown, ack?: (response: unknown) => void) => {
      guarded(
        "stream.subscribe",
        () => {
          const parsed = StreamSelector.safeParse(payload);
          if (!parsed.success) {
            ack?.(
              contractValidationResponse("The subscription is not a valid stream selector.").body,
            );
            return;
          }
          socket.join(streamRoom(parsed.data.workspace_id, parsed.data.stream_id));
          ack?.(subscribeAck(parsed.data.workspace_id, parsed.data.stream_id));
        },
        ack,
      );
    });

    // Durable replay resume (AC4): the client's cursor is answered from the
    // SQLite journal via ReplayService — exactly the missed durable events in
    // order once, or the E10 snapshot fallback below the retention horizon.
    // Socket.IO's in-memory connection state recovery would NOT satisfy this
    // (no durability), so it is not used here. Live delivery then resumes in
    // the joined stream room.
    socket.on(REPLAY_REQUEST, (payload: unknown, ack?: (response: unknown) => void) => {
      guarded(
        "replay.request",
        () => {
          const parsed = ReplayRequestBody.safeParse(payload);
          if (!parsed.success) {
            ack?.(
              contractValidationResponse(
                "The replay request is not valid: workspace_id, stream_id and last_acknowledged_sequence are required.",
              ).body,
            );
            return;
          }
          const result = deps.replay.resolve(
            parsed.data.workspace_id,
            parsed.data.stream_id,
            parsed.data.last_acknowledged_sequence,
          );
          socket.join(streamRoom(parsed.data.workspace_id, parsed.data.stream_id));
          ack?.(result);
        },
        ack,
      );
    });
  });

  return {
    io,
    broadcastStreamEvent(event) {
      io.to(streamRoom(event.workspace_id, event.stream_id)).emit(STREAM_EVENT, event);
    },
    broadcastStreamFrame(workspaceId, streamId, payload) {
      io.to(streamRoom(workspaceId, streamId)).emit(STREAM_FRAME, payload);
    },
    close: () => io.close(),
  };
}
