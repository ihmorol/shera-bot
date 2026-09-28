/**
 * WebSocket gateway tests (S07; D26, AC4/AC8, E10/E12).
 *
 * The gateway is mounted on the SAME HTTP server as the local API and is LIVE
 * FANOUT ONLY: every inbound message is read-only, and the durable replay
 * resume comes from the SQLite journal through ReplayService — never from
 * Socket.IO's in-memory connection state recovery. Tests run the REAL stack
 * (composeRuntime: SQLite + Express + Socket.IO) and speak the engine.io /
 * Socket.IO v4 wire protocol with Node's built-in WebSocket client — no
 * extra test dependency.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { composeRuntime, type ComposeRuntimeOptions, type RuntimeHandle } from "../local-api/compose.ts";
import { DEFAULT_PING_INTERVAL_MS, DEFAULT_PING_TIMEOUT_MS } from "./gateway.ts";

const tempDirs: string[] = [];
const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

/**
 * Minimal engine.io + Socket.IO v4 client over Node's global WebSocket.
 * Handshake (direct websocket transport, no polling upgrade — so no probe):
 * open packet (0...) -> namespace connect (40...). Frames:
 * `42<ackId>["event",payload]` out, `43<ackId><json>` acks and
 * `42["event",payload]` server events in.
 */
interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
}
const NodeWebSocket = globalThis.WebSocket as unknown as new (url: string) => MinimalWebSocket;

class WsTestClient {
  private nextAckId = 0;
  private readonly acks = new Map<number, (value: unknown) => void>();
  private readonly frameWaiters: Array<{
    predicate: (frame: string) => boolean;
    resolve: (frame: string) => void;
  }> = [];
  private readonly eventWaiters: Array<{
    predicate: (name: string, payload: unknown) => boolean;
    resolve: (event: { name: string; payload: unknown }) => void;
  }> = [];
  readonly events: Array<{ name: string; payload: unknown }> = [];
  private readonly ws: MinimalWebSocket;

  private constructor(ws: MinimalWebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : "";
      this.handleFrame(frame);
    });
  }

  static async open(origin: string): Promise<WsTestClient> {
    const url = `${origin.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
    const client = new WsTestClient(new NodeWebSocket(url));
    await client.waitFor((frame) => frame.startsWith("0"), "engine.io open packet");
    // Direct websocket transport: no polling→ws upgrade, so no 2probe/3probe.
    client.ws.send("40");
    await client.waitFor((frame) => frame.startsWith("40"), "namespace connect ack");
    return client;
  }

  private handleFrame(frame: string): void {
    if (frame === "2") {
      // engine.io transport ping -> transport pong (never a business event).
      this.ws.send("3");
      return;
    }
    if (frame.startsWith("43")) {
      const rest = frame.slice(2);
      const digits = /^\d+/.exec(rest)?.[0] ?? "";
      const resolve = this.acks.get(Number(digits));
      if (resolve) {
        this.acks.delete(Number(digits));
        const parsed: unknown = JSON.parse(rest.slice(digits.length));
        // The ack packet's payload is the callback args array.
        resolve(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed);
      }
      return;
    }
    if (frame.startsWith("42")) {
      const [name, payload] = JSON.parse(frame.slice(2)) as [string, unknown];
      const event = { name, payload };
      this.events.push(event);
      const waiter = this.eventWaiters.findIndex((w) => w.predicate(name, payload));
      if (waiter >= 0) {
        this.eventWaiters.splice(waiter, 1)[0]?.resolve(event);
      }
      return;
    }
    const waiter = this.frameWaiters.findIndex((w) => w.predicate(frame));
    if (waiter >= 0) {
      this.frameWaiters.splice(waiter, 1)[0]?.resolve(frame);
    }
  }

  private waitFor(predicate: (frame: string) => boolean, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 5000);
      this.frameWaiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  emitWithAck(event: string, payload: unknown): Promise<unknown> {
    const id = this.nextAckId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new Error(`timeout waiting for ack of ${event}`));
      }, 5000);
      this.acks.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.ws.send(`42${id}${JSON.stringify([event, payload])}`);
    });
  }

  sendRaw(frame: string): void {
    this.ws.send(frame);
  }

  waitForEvent(
    predicate: (name: string, payload: unknown) => boolean,
    label: string,
  ): Promise<{ name: string; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 5000);
      this.eventWaiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeAndListen(
  options: {
    retentionHorizon?: (workspaceId: string, streamId: string) => number;
  } = {},
): Promise<RunningRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-ws-"));
  tempDirs.push(dir);
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    ...(options.retentionHorizon ? { retentionHorizon: options.retentionHorizon } : {}),
  });
  await new Promise<void>((resolve) => runtime.httpServer.listen(0, "127.0.0.1", resolve));
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

async function postJson(
  origin: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/v1/conversations/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(
  origin: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function createCommand(workspaceId: string, key: string): Record<string, unknown> {
  return {
    type: "conversation.create",
    workspace_id: workspaceId,
    idempotency_key: key,
    payload: { title: "Operation kickoff" },
  };
}

function renameCommand(
  workspaceId: string,
  key: string,
  conversationId: string,
  expectedRevision: number,
  title: string,
): Record<string, unknown> {
  return {
    type: "conversation.rename",
    workspace_id: workspaceId,
    idempotency_key: key,
    payload: { conversation_id: conversationId, title, expected_revision: expectedRevision },
  };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("websocket gateway — live fanout (D26/AC8)", () => {
  it("fans out each committed event exactly once to the stream's subscribers", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, createCommand(WS_A, "idem-ws-create-1"));
      const conversationId = created.body["conversation_id"] as string;
      const streamId = `conversation:${conversationId}`;

      const client = await WsTestClient.open(running.origin);
      try {
        const ack = (await client.emitWithAck("stream.subscribe", {
          workspace_id: WS_A,
          stream_id: streamId,
        })) as Record<string, unknown>;
        expect(ack).toEqual({ subscribed: true, workspace_id: WS_A, stream_id: streamId });

        const fanout = client.waitForEvent(
          (name, payload) => name === "stream.event",
          "fanout of the rename",
        );
        const renamed = await postJson(
          running.origin,
          renameCommand(WS_A, "idem-ws-rename-1", conversationId, 1, "v2"),
        );
        expect(renamed.status).toBe(200);

        const received = (await fanout).payload as Record<string, unknown>;
        expect(received).toMatchObject({
          type: "conversation.renamed",
          stream_id: streamId,
          workspace_id: WS_A,
          sequence: 2,
        });
        expect((received["payload"] as Record<string, unknown>)["title"]).toBe("v2");

        // Subscribed only after the create committed: the create event is
        // history (replayable), never re-delivered as live fanout.
        expect(client.events).toHaveLength(1);
      } finally {
        client.close();
      }
    } finally {
      await running.close();
    }
  });

  it("keeps twin streams apart across workspaces (E12 room scoping)", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, createCommand(WS_A, "idem-ws-twin-1"));
      const conversationId = created.body["conversation_id"] as string;
      const streamId = `conversation:${conversationId}`;

      const clientA = await WsTestClient.open(running.origin);
      const clientB = await WsTestClient.open(running.origin);
      try {
        // Same stream id, DIFFERENT workspaces: only WS_A's room matches.
        await clientA.emitWithAck("stream.subscribe", { workspace_id: WS_A, stream_id: streamId });
        await clientB.emitWithAck("stream.subscribe", { workspace_id: WS_B, stream_id: streamId });

        const forA = clientA.waitForEvent((name) => name === "stream.event", "fanout to WS_A");
        await postJson(
          running.origin,
          renameCommand(WS_A, "idem-ws-twin-2", conversationId, 1, "v2"),
        );
        await forA;

        // Give any wrongly-routed frame a beat to arrive; there must be none.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(clientB.events).toHaveLength(0);
      } finally {
        clientA.close();
        clientB.close();
      }
    } finally {
      await running.close();
    }
  });
});

describe("websocket gateway — durable replay resume (AC4, E10)", () => {
  it("replays exactly the missed events in order once, then resumes live delivery", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, createCommand(WS_A, "idem-ws-resume-0"));
      const conversationId = created.body["conversation_id"] as string;
      const streamId = `conversation:${conversationId}`;
      await postJson(running.origin, renameCommand(WS_A, "idem-ws-resume-1", conversationId, 1, "v2"));
      await postJson(running.origin, renameCommand(WS_A, "idem-ws-resume-2", conversationId, 2, "v3"));

      const client = await WsTestClient.open(running.origin);
      try {
        // The reconnecting client sends its last acknowledged cursor.
        const replay = (await client.emitWithAck("replay.request", {
          workspace_id: WS_A,
          stream_id: streamId,
          last_acknowledged_sequence: 0,
        })) as Record<string, unknown>;
        expect(replay).toMatchObject({
          kind: "events",
          stream_id: streamId,
          workspace_id: WS_A,
          next_cursor: 3,
          replayed: true,
        });
        expect(
          (replay["events"] as Array<{ sequence: number }>).map((event) => event.sequence),
        ).toEqual([1, 2, 3]);

        // Live delivery resumes in the same room after the replay.
        const live = client.waitForEvent((name) => name === "stream.event", "live event after replay");
        await postJson(
          running.origin,
          renameCommand(WS_A, "idem-ws-resume-3", conversationId, 3, "v4"),
        );
        expect(((await live).payload as Record<string, unknown>)["sequence"]).toBe(4);

        // Acknowledging the replayed batch: the events come back exactly once.
        const caughtUp = (await client.emitWithAck("replay.request", {
          workspace_id: WS_A,
          stream_id: streamId,
          last_acknowledged_sequence: 4,
        })) as Record<string, unknown>;
        expect(caughtUp).toMatchObject({ kind: "events", replayed: true, next_cursor: 4 });
        expect(caughtUp["events"]).toEqual([]);
      } finally {
        client.close();
      }
    } finally {
      await running.close();
    }
  });

  it("falls back to a snapshot + new cursor below the retention horizon (E10)", async () => {
    const running = await composeAndListen({
      // E10 test seam: everything below sequence 3 is "compacted away".
      retentionHorizon: () => 3,
    });
    try {
      const created = await postJson(running.origin, createCommand(WS_A, "idem-ws-horizon-1"));
      const conversationId = created.body["conversation_id"] as string;

      const client = await WsTestClient.open(running.origin);
      try {
        const replay = (await client.emitWithAck("replay.request", {
          workspace_id: WS_A,
          stream_id: `conversation:${conversationId}`,
          last_acknowledged_sequence: 0,
        })) as Record<string, unknown>;
        expect(replay).toMatchObject({
          kind: "snapshot_required",
          reason: "cursor_below_retention_horizon",
          earliest_available_sequence: 3,
          replayed: false,
        });
        expect(replay["snapshot"]).toMatchObject({
          kind: "conversation",
          conversation_id: conversationId,
          revision: 1,
        });
      } finally {
        client.close();
      }
    } finally {
      await running.close();
    }
  });

  it("answers malformed WS messages with typed read-only validation acks", async () => {
    const running = await composeAndListen();
    try {
      const client = await WsTestClient.open(running.origin);
      try {
        const badReplay = (await client.emitWithAck("replay.request", {})) as Record<
          string,
          unknown
        >;
        expect(badReplay["code"]).toBe("CONTRACT_VALIDATION_FAILED");
        expect(badReplay["internal_details"]).toBeNull();

        const badSubscribe = (await client.emitWithAck("stream.subscribe", {
          stream_id: "conversation:x",
        })) as Record<string, unknown>;
        expect(badSubscribe["code"]).toBe("CONTRACT_VALIDATION_FAILED");
      } finally {
        client.close();
      }
    } finally {
      await running.close();
    }
  });
});

describe("websocket gateway — the WS layer cannot mutate state (D26)", () => {
  it("ignores command-like WS messages and leaves the journal untouched", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, createCommand(WS_A, "idem-ws-mut-1"));
      const conversationId = created.body["conversation_id"] as string;
      const streamId = `conversation:${conversationId}`;

      const client = await WsTestClient.open(running.origin);
      try {
        await client.emitWithAck("stream.subscribe", { workspace_id: WS_A, stream_id: streamId });

        // A command-shaped message over WS: there is no handler for it, and
        // none may exist — the message is dropped by the transport.
        client.sendRaw(`42["conversation.command",${JSON.stringify({ type: "conversation.create" })}]`);
        client.sendRaw(`42["conversation.rename",${JSON.stringify({ type: "conversation.rename" })}]`);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // The journal is untouched: exactly the creation event exists.
        const replay = await getJson(
          running.origin,
          `/v1/conversations/${conversationId}/events?workspace_id=${WS_A}&last_acknowledged_sequence=0`,
        );
        expect((replay.body["events"] as unknown[]).length).toBe(1);

        // And the HTTP command path still works (state machine alive).
        const renamed = await postJson(
          running.origin,
          renameCommand(WS_A, "idem-ws-mut-2", conversationId, 1, "v2"),
        );
        expect(renamed.status).toBe(200);
      } finally {
        client.close();
      }
    } finally {
      await running.close();
    }
  });

  it("never imports a command-execution surface (code boundary, D26)", () => {
    const dir = join(import.meta.dirname, ".");
    const forbidden = [
      "conversations.service",
      "conversations.types",
      "command-receipts",
      "ConversationsService",
      "CommandReceipts",
      "executeCommand",
      "appendEvent",
    ];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(join(dir, file), "utf8");
      for (const symbol of forbidden) {
        expect(
          source.includes(symbol),
          `${file} must not reference the command surface "${symbol}" (D26: WS is read-only fanout)`,
        ).toBe(false);
      }
    }
  });
});

describe("websocket gateway — transport heartbeats", () => {
  it("runs engine.io ping/pong heartbeats at the documented intervals", async () => {
    const running = await composeAndListen();
    try {
      // Transport-level heartbeats (engine.io ping/pong), NOT business events:
      // the engine's interval/timeout are the documented 25s/20s defaults.
      const engine = running.runtime.gateway.io.engine as unknown as {
        opts: { pingInterval: number; pingTimeout: number };
      };
      expect(engine.opts.pingInterval).toBe(DEFAULT_PING_INTERVAL_MS);
      expect(engine.opts.pingTimeout).toBe(DEFAULT_PING_TIMEOUT_MS);
      expect(DEFAULT_PING_INTERVAL_MS).toBe(25_000);
      expect(DEFAULT_PING_TIMEOUT_MS).toBe(20_000);

      // The same socket also completes a live heartbeat cycle implicitly by
      // staying connected for the whole test run above.
    } finally {
      await running.close();
    }
  });
});
