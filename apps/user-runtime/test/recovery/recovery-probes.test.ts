/**
 * Remaining recovery probes (S09 chunk 3; E13 recovery-class matrix, D26).
 *
 * Each probe asserts a typed, bounded failure with NO partial effects — the
 * failed attempt leaves neither a journal row nor a command receipt behind
 * (proven by re-using the SAME idempotency key for a valid send afterwards:
 * the valid send must append a real message, which a poisoned receipt would
 * have replayed instead).
 *
 * - oversized message: text beyond the contract's 4000-char bound → typed 400;
 *   a body beyond the transport's 64kb limit → typed 413;
 * - empty message: the schema's min(1) bound → typed 400;
 * - duplicate send: covered at the DATABASE level in
 *   apps/user-runtime/src/modules/conversations/messages.test.ts ("a repeated
 *   idempotency key replays the receipt — one message at the DATABASE level")
 *   and over HTTP in
 *   apps/user-runtime/src/transport/local-api/s09-message-send.test.ts — this
 *   file adds the recovery-facing assertion only (receipt replay under the
 *   probe harness);
 * - two tabs: two concurrent WS clients on ONE conversation — both receive the
 *   live fanout (events AND delta frames), and a tab that closes and
 *   reconnects replays exactly its missed events once: consistent history,
 *   no duplicates.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_SCRIPTED_REPLY } from "../../src/modules/conversations/reply-streamer.ts";
import {
  DEFAULT_WORKSPACE_ID,
  composeRuntime,
  type RuntimeHandle,
} from "../../src/transport/local-api/compose.ts";

const tempDirs: string[] = [];
const WORKSPACE = DEFAULT_WORKSPACE_ID;

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

function composeAndListen(): Promise<RunningRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "shera-recovery-"));
  tempDirs.push(dir);
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    scriptedReplies: { ...DEFAULT_SCRIPTED_REPLY, deltaIntervalMs: 15 },
  });
  return new Promise((resolve) => {
    runtime.httpServer.listen(0, "127.0.0.1", () => {
      const address = runtime.httpServer.address() as { port: number };
      resolve({
        runtime,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => runtime.close(),
      });
    });
  });
}

async function postCommand(
  origin: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/v1/conversations/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function replayEvents(
  origin: string,
  conversationId: string,
): Promise<Array<{ sequence: number; type: string }>> {
  const response = await fetch(
    `${origin}/v1/conversations/${conversationId}/events?workspace_id=${WORKSPACE}&last_acknowledged_sequence=0`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    events: Array<{ sequence: number; type: string }>;
  };
  return body.events;
}

async function createConversation(origin: string, seedKey: string): Promise<string> {
  const created = await postCommand(origin, {
    type: "conversation.create",
    workspace_id: WORKSPACE,
    idempotency_key: seedKey,
    payload: { title: "General Assistant" },
  });
  expect(created.status).toBe(200);
  return created.body["conversation_id"] as string;
}

function sendBody(
  conversationId: string,
  idempotencyKey: string,
  text: string,
): Record<string, unknown> {
  return {
    type: "message.send",
    workspace_id: WORKSPACE,
    idempotency_key: idempotencyKey,
    payload: {
      conversation_id: conversationId,
      text,
      sender: { kind: "user", display_name: "Emon" },
    },
  };
}

/** A typed rejection body — the SheraError shape, never a raw stack (G3). */
function expectTypedRejection(
  response: { status: number; body: Record<string, unknown> },
  expectedStatus: number,
): void {
  expect(response.status).toBe(expectedStatus);
  expect(typeof response.body["code"]).toBe("string");
  expect(typeof response.body["safe_message"]).toBe("string");
  expect(String(response.body["safe_message"]).length).toBeGreaterThan(0);
  expect(response.body["correlation_id"]).toBeDefined();
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recovery: oversized message (typed rejection, no partial effects)", () => {
  it("rejects a 4001-char text with the typed 400 and leaves no receipt", async () => {
    const running = await composeAndListen();
    try {
      const conversationId = await createConversation(running.origin, "s09-recovery-seed-1");
      const before = await replayEvents(running.origin, conversationId);

      const oversized = await postCommand(
        running.origin,
        sendBody(conversationId, "s09-recovery-oversized-1", "x".repeat(4001)),
      );
      expectTypedRejection(oversized, 400);

      // No partial effects: the SAME key later carries a VALID message and
      // appends for real — a receipt from the failed attempt would have been
      // replayed instead (D23 rule 6).
      const valid = await postCommand(
        running.origin,
        sendBody(conversationId, "s09-recovery-oversized-1", "valid after rejection"),
      );
      expect(valid.status).toBe(200);
      expect(valid.body).toMatchObject({ kind: "message_sent" });

      const after = await replayEvents(running.origin, conversationId);
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)!.type).toBe("message.appended");
    } finally {
      await running.close();
    }
  });

  it("rejects a body beyond the 64kb transport limit with the typed 413", async () => {
    const running = await composeAndListen();
    try {
      const conversationId = await createConversation(running.origin, "s09-recovery-seed-2");
      const before = await replayEvents(running.origin, conversationId);

      const response = await fetch(`${running.origin}/v1/conversations/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          sendBody(conversationId, "s09-recovery-oversized-2", "y".repeat(70_000)),
        ),
      });
      const body = (await response.json()) as Record<string, unknown>;
      expectTypedRejection({ status: response.status, body }, 413);

      const after = await replayEvents(running.origin, conversationId);
      expect(after).toHaveLength(before.length);
    } finally {
      await running.close();
    }
  });
});

describe("recovery: empty message (typed rejection, no partial effects)", () => {
  it("rejects an empty text with the typed 400 and leaves no receipt", async () => {
    const running = await composeAndListen();
    try {
      const conversationId = await createConversation(running.origin, "s09-recovery-seed-3");
      const before = await replayEvents(running.origin, conversationId);

      const empty = await postCommand(
        running.origin,
        sendBody(conversationId, "s09-recovery-empty-1", ""),
      );
      expectTypedRejection(empty, 400);

      const valid = await postCommand(
        running.origin,
        sendBody(conversationId, "s09-recovery-empty-1", "valid after rejection"),
      );
      expect(valid.status).toBe(200);

      const after = await replayEvents(running.origin, conversationId);
      expect(after).toHaveLength(before.length + 1);
    } finally {
      await running.close();
    }
  });
});

describe("recovery: duplicate send under the probe harness (receipt replay)", () => {
  it("replays the recorded receipt and adds no journal rows (see messages.test.ts for the DB-level probe)", async () => {
    const running = await composeAndListen();
    try {
      const conversationId = await createConversation(running.origin, "s09-recovery-seed-4");
      const send = sendBody(
        conversationId,
        "s09-recovery-duplicate-1",
        "sent once, receipted twice",
      );
      const first = await postCommand(running.origin, send);
      expect(first.status).toBe(200);
      const second = await postCommand(running.origin, send);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);

      const events = await replayEvents(running.origin, conversationId);
      expect(events.filter((event) => event.type === "message.appended")).toHaveLength(1);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Two tabs on one conversation (D26/AC8): the gateway's rooms fan out every
// committed event and delta frame to ALL subscribers; the durable journal is
// the only history authority, so a reconnecting tab replays exactly its
// missed events once.

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}
const NodeWebSocket = globalThis.WebSocket as unknown as new (url: string) => MinimalWebSocket;

interface ServerEvent {
  name: string;
  payload: unknown;
}

class ProbeSocketClient {
  private nextAckId = 0;
  private readonly acks = new Map<number, (value: unknown) => void>();
  private readonly waiters: Array<{
    predicate: (event: ServerEvent) => boolean;
    resolve: (event: ServerEvent) => void;
  }> = [];
  readonly events: ServerEvent[] = [];
  private readonly ws: MinimalWebSocket;

  private constructor(ws: MinimalWebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : "";
      if (frame === "2") {
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
          resolve(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed);
        }
        return;
      }
      if (frame.startsWith("42")) {
        const [name, payload] = JSON.parse(frame.slice(2)) as [string, unknown];
        const serverEvent = { name, payload };
        this.events.push(serverEvent);
        const waiter = this.waiters.findIndex((w) => w.predicate(serverEvent));
        if (waiter >= 0) {
          this.waiters.splice(waiter, 1)[0]?.resolve(serverEvent);
        }
      }
    });
  }

  static async open(origin: string): Promise<ProbeSocketClient> {
    const url = `${origin.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
    const client = new ProbeSocketClient(new NodeWebSocket(url));
    await client.waitForFrame((frame) => frame.startsWith("0"), "engine.io open");
    client.ws.send("40");
    await client.waitForFrame((frame) => frame.startsWith("40"), "namespace connect");
    return client;
  }

  private waitForFrame(
    predicate: (frame: string) => boolean,
    label: string,
    timeoutMs = 5000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      const listener = (event: { data?: unknown }): void => {
        const frame = typeof event.data === "string" ? event.data : "";
        if (predicate(frame)) {
          clearTimeout(timer);
          this.ws.removeEventListener("message", listener);
          resolve(frame);
        }
      };
      this.ws.addEventListener("message", listener);
    });
  }

  emitWithAck(event: string, payload: unknown): Promise<unknown> {
    const id = this.nextAckId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ack of ${event}`)),
        5000,
      );
      this.acks.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.ws.send(`42${id}${JSON.stringify([event, payload])}`);
    });
  }

  waitForEvent(
    predicate: (event: ServerEvent) => boolean,
    label: string,
    timeoutMs = 8000,
  ): Promise<ServerEvent> {
    const buffered = this.events.find(predicate);
    if (buffered) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      this.waiters.push({
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

function streamSelector(streamId: string): Record<string, unknown> {
  return { workspace_id: WORKSPACE, stream_id: streamId };
}

describe("recovery: two tabs on one conversation (fanout, reconnect replay, no duplicates)", () => {
  it("fans out to both tabs and replays a reconnecting tab's missed events exactly once", async () => {
    const running = await composeAndListen();
    try {
      const conversationId = await createConversation(running.origin, "s09-recovery-seed-5");
      const streamId = `conversation:${conversationId}`;

      // Two tabs subscribe to the same stream; both get the initial history.
      const tabA = await ProbeSocketClient.open(running.origin);
      const tabB = await ProbeSocketClient.open(running.origin);
      try {
        expect(await tabA.emitWithAck("stream.subscribe", streamSelector(streamId))).toMatchObject({
          subscribed: true,
        });
        expect(await tabB.emitWithAck("stream.subscribe", streamSelector(streamId))).toMatchObject({
          subscribed: true,
        });
        for (const tab of [tabA, tabB]) {
          const replay = (await tab.emitWithAck("replay.request", {
            ...streamSelector(streamId),
            last_acknowledged_sequence: 0,
          })) as { kind: string; events: Array<{ sequence: number }> };
          expect(replay.kind).toBe("events");
          expect(replay.events.map((event) => event.sequence)).toEqual([1]);
        }

        // Tab A sends: BOTH tabs receive the durable user event, the delta
        // frames, and the durable agent reply.
        const sendA = await postCommand(
          running.origin,
          sendBody(conversationId, "s09-recovery-twotabs-1", "hello from tab A"),
        );
        expect(sendA.status).toBe(200);

        for (const [label, tab] of [
          ["tab A", tabA],
          ["tab B", tabB],
        ] as const) {
          const userEvent = await tab.waitForEvent(
            (event) =>
              event.name === "stream.event" &&
              (event.payload as { type?: string }).type === "message.appended",
            `${label}: durable user message`,
          );
          expect(
            (userEvent.payload as { payload: { sender: { kind: string } } }).payload.sender.kind,
          ).toBe("user");
          await tab.waitForEvent(
            (event) =>
              event.name === "stream.frame" &&
              (event.payload as { frame?: string }).frame === "message.delta",
            `${label}: reply delta frame`,
          );
          await tab.waitForEvent(
            (event) =>
              event.name === "stream.event" &&
              (event.payload as { payload?: { sender?: { kind?: string } } }).payload?.sender
                ?.kind === "agent",
            `${label}: durable agent reply`,
          );
        }

        // Tab B closes (mid-session "tab closed"); tab A keeps sending. The
        // reply to the second message commits while tab B is away.
        tabB.close();
        const sendB = await postCommand(
          running.origin,
          sendBody(conversationId, "s09-recovery-twotabs-2", "second turn while tab B is gone"),
        );
        expect(sendB.status).toBe(200);
        // Give the scripted reply leg time to commit its durable event.
        await tabA.waitForEvent((event) => {
          if (event.name !== "stream.event") {
            return false;
          }
          const envelope = event.payload as { sequence?: number };
          return envelope.sequence === 5;
        }, "tab A: second durable reply (sequence 5)");

        // Tab B reconnects and replays from its acknowledged cursor (3): it
        // receives EXACTLY the missed events, once, in order.
        const tabB2 = await ProbeSocketClient.open(running.origin);
        try {
          expect(
            await tabB2.emitWithAck("stream.subscribe", streamSelector(streamId)),
          ).toMatchObject({ subscribed: true });
          const replay = (await tabB2.emitWithAck("replay.request", {
            ...streamSelector(streamId),
            last_acknowledged_sequence: 3,
          })) as { kind: string; events: Array<{ sequence: number; type: string }> };
          expect(replay.kind).toBe("events");
          expect(replay.events.map((event) => event.sequence)).toEqual([4, 5]);

          // Consistent history: both tabs' full replays are identical, and
          // the reconnect replay adds nothing a fresh tab wouldn't see.
          const fullA = (await tabA.emitWithAck("replay.request", {
            ...streamSelector(streamId),
            last_acknowledged_sequence: 0,
          })) as { events: Array<{ sequence: number; type: string }> };
          const fullB = (await tabB2.emitWithAck("replay.request", {
            ...streamSelector(streamId),
            last_acknowledged_sequence: 0,
          })) as { events: Array<{ sequence: number; type: string }> };
          expect(fullA.events.map((event) => [event.sequence, event.type])).toEqual(
            fullB.events.map((event) => [event.sequence, event.type]),
          );
          expect(fullA.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
        } finally {
          tabB2.close();
        }
      } finally {
        tabA.close();
      }
    } finally {
      await running.close();
    }
  }, 30_000);
});
