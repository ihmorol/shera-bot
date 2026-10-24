/**
 * The mock-runtime E2E (S09 chunk 3 — the E8 acceptance path).
 *
 * ONE deterministic test drives the thin slice's whole user path through the
 * REAL components and processes — no browser, no fabricated content:
 *
 *   login → prepare workspace → chat → send → stream → refresh → replay
 *
 * - The runtime is the E8 mock (startE2eMockRuntime): real SQLite, real HTTP,
 *   the real WebSocket gateway, the scripted reply streamer.
 * - The web app's server-side piece is the REAL /api/runtime proxy
 *   (proxyToLocalApi) mounted on a plain HTTP harness — the same allowlist the
 *   Next route handler runs behind.
 * - The client is the web app's OWN typed client (ensureGaConversation,
 *   sendConversationMessage, fetchConversationEvents) and the web app's OWN
 *   wire client (RuntimeSocket) feeding the web app's OWN reducer
 *   (advanceLiveThread) — the same dispatches the React hook performs.
 * - "Login" is asserted honestly: the S01 sign-in surface renders with its
 *   control-plane provider link (real OAuth remains outside this mock test) and the
 *   prototype session is the fixture user the sends are attributed to (Emon).
 *
 * DETERMINISM: the scripted reply streams one delta per 15ms and commits its
 * durable message after the full burst, so the refresh/reconnect legs have
 * stable windows. The ~500ms send-ack target (§6.3) is asserted loosely and
 * the measured value is printed (the demo-path doc cites it).
 */
import { rmSync } from "node:fs";
import { createServer, type Server as HTTPServer } from "node:http";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";

import LoginPage from "@/app/login/page";
import type { ChatMessage } from "@/lib/fixtures";
import {
  ensureGaConversation,
  fetchConversationEvents,
  sendConversationMessage,
  type RuntimeEvent,
} from "@/lib/runtime-client";
import {
  advanceLiveThread,
  assembleLiveTimeline,
  conversationStreamId,
  INITIAL_LIVE_STATE,
  type LiveThreadState,
} from "@/lib/runtime-live";
import { proxyToLocalApi } from "@/lib/server/proxies";
import { RuntimeSocket } from "@/lib/ws-socket";

import {
  startE2eMockRuntime,
  type E2eMockRuntime,
} from "../../../user-runtime/src/mock/e2e-mode.ts";

const tempDirs: string[] = [];
const SESSION_USER = "Emon";

interface E2eHarness {
  mock: E2eMockRuntime;
  proxyOrigin: string;
  close(): Promise<void>;
}

/** Start the mock runtime + the REAL /api/runtime proxy on a local harness. */
async function startHarness(): Promise<E2eHarness> {
  const mock = await startE2eMockRuntime();
  tempDirs.push(join(mock.dbPath, ".."));
  // The proxy reads its upstream from the deployment env — the harness IS the
  // deployment here. Its explicit mock identity service is test-only; there
  // is no production authentication bypass.
  const previousUpstream = process.env["CONTROL_PLANE_URL"];
  const control = createServer((req, res) => {
    void (async () => {
      if (req.url === "/api/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            workspace_id: mock.workspace_id,
            google_sub: "e8-user",
            email: "e8@example.com",
            display_name: SESSION_USER,
            tier: "balanced",
            is_admin: false,
            created_at: "2026-10-01T00:00:00Z",
            last_active_at: "2026-10-01T00:00:00Z",
          }),
        );
        return;
      }
      if (!req.url?.startsWith("/api/runtime/local/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await fetch(mock.origin + req.url.slice("/api/runtime/local".length), {
        method: req.method ?? "GET",
        headers: { "content-type": "application/json" },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  process.env["CONTROL_PLANE_URL"] =
    `http://127.0.0.1:${(control.address() as { port: number }).port}`;

  const proxy: HTTPServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
        }
      }
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const response = await proxyToLocalApi(request, url.pathname.replace(/^\/api\/runtime/, ""));
      const payload = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(payload);
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy harness failure" }));
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;

  return {
    mock,
    proxyOrigin: `http://127.0.0.1:${proxyPort}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await mock.stop();
      if (previousUpstream === undefined) {
        delete process.env["CONTROL_PLANE_URL"];
      } else {
        process.env["CONTROL_PLANE_URL"] = previousUpstream;
      }
    },
  };
}

/**
 * Point the web client's relative fetches at the proxy harness — the browser
 * resolves same-origin URLs; in Node the harness plays that origin. Absolute
 * URLs (the proxy's own upstream fetches) pass through untouched.
 */
function installOriginShim(origin: string): () => void {
  const realFetch = globalThis.fetch;
  const shimmed = ((input: string | URL | Request, init?: RequestInit) =>
    typeof input === "string" && input.startsWith("/")
      ? realFetch(new URL(input, origin), init)
      : realFetch(input, init)) as typeof fetch;
  globalThis.fetch = shimmed;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Connect the REAL web wire client to the mock gateway. */
async function openSocket(mock: E2eMockRuntime): Promise<RuntimeSocket> {
  const url = mock.origin.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket";
  return RuntimeSocket.open(url);
}

interface ServerEvent {
  name: string;
  payload: unknown;
}

/** Poll a fanout buffer until the predicate matches (the hook's onEvent leg). */
async function waitForEvent(
  source: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<ServerEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const buffered = source.find(predicate);
    if (buffered) {
      return buffered;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function liveEvent(state: LiveThreadState, payload: unknown): LiveThreadState {
  return advanceLiveThread(state, { type: "live_event", event: payload as RuntimeEvent });
}

function acknowledge(state: LiveThreadState): LiveThreadState {
  return advanceLiveThread(state, { type: "cursor_acknowledged", sequence: state.cursor });
}

/** Drive the reducer exactly as the hook does for one replay result. */
function applyReplay(
  state: LiveThreadState,
  result: { kind: string; events?: unknown[] },
  mode: "initial" | "reconnect",
): LiveThreadState {
  const events = (result.kind === "events" ? (result.events ?? []) : []) as RuntimeEvent[];
  let next = advanceLiveThread(state, { type: "replay_started", total: events.length });
  for (const event of events) {
    next = advanceLiveThread(next, { type: "replay_event", event, mode });
  }
  next = advanceLiveThread(next, { type: "replay_complete" });
  return acknowledge(next);
}

function messagesOf(state: LiveThreadState): Array<{ id: string; klass: string; text: string }> {
  return assembleLiveTimeline(state)
    .timeline.flatMap((item) => (item.kind === "message" ? [item.message] : []))
    .map((message) => ({
      id: message.message_id,
      klass: message.delivery_class,
      text: message.text,
    }));
}

function optimisticMessage(key: string, conversationId: string, text: string): ChatMessage {
  return {
    message_id: key,
    conversation_id: conversationId,
    sender: { kind: "user", display_name: SESSION_USER },
    text,
    sent_at: new Date().toISOString(),
    delivery: "sending",
    delivery_class: "live",
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("S09 mock-runtime E2E (E8): login → chat → send → stream → refresh → replay", () => {
  it("drives the full thin-slice path through the real client, proxy, and runtime", async () => {
    // -- Phase 0: LOGIN — the honest S01 surface, no fake provider success ----
    const loginMarkup = renderToStaticMarkup(createElement(LoginPage));
    expect(loginMarkup).toContain("Sign in");
    expect(loginMarkup).toContain('href="/api/control/api/auth/signin/google"');
    expect(loginMarkup).not.toContain("Signed in");

    const harness = await startHarness();
    const restoreFetch = installOriginShim(harness.proxyOrigin);
    try {
      const workspaceId = harness.mock.workspace_id;

      // -- Phase 1: PREPARE the workspace / conversation (receipt idempotent) --
      const created = await ensureGaConversation(workspaceId);
      expect(created.kind).toBe("created");
      const again = await ensureGaConversation(workspaceId);
      expect(again.kind).toBe("created");
      expect(again.conversation_id).toBe(created.conversation_id);
      const conversationId = created.conversation_id;
      const streamId = conversationStreamId(conversationId);

      // -- Phase 2: the tab connects — subscribe + initial replay -------------
      const socket = await openSocket(harness.mock);
      try {
        expect(
          await socket.request("stream.subscribe", {
            workspace_id: workspaceId,
            stream_id: streamId,
          }),
        ).toMatchObject({ subscribed: true });

        const initialReplay = (await socket.request("replay.request", {
          workspace_id: workspaceId,
          stream_id: streamId,
          last_acknowledged_sequence: 0,
        })) as { kind: string; events: unknown[] };
        expect(initialReplay.kind).toBe("events");
        expect(initialReplay.events).toHaveLength(1);

        let state = applyReplay(INITIAL_LIVE_STATE, initialReplay, "initial");
        expect(state.acknowledged).toBe(1);

        // -- Phase 3: SEND — optimistic copy + idempotent command (~500ms) ----
        const fanout: ServerEvent[] = [];
        socket.onEvent((name, payload) => fanout.push({ name, payload }));

        const sendKey = `msg-${crypto.randomUUID()}`;
        const sendText = "Outline a plan for my thesis chapter, please.";
        state = advanceLiveThread(state, {
          type: "send_started",
          message: optimisticMessage(sendKey, conversationId, sendText),
        });

        const ackStarted = Date.now();
        const sent = await sendConversationMessage({
          workspaceId,
          conversationId,
          text: sendText,
          displayName: SESSION_USER,
          idempotencyKey: sendKey,
        });
        const ackMs = Date.now() - ackStarted;
        expect(sent.kind).toBe("message_sent");
        // The §6.3 ack target, asserted loosely; the measured value feeds the
        // demo-path doc. A loopback round trip through two HTTP hops sits far
        // below 500ms.
        expect(ackMs).toBeLessThan(500);
        process.stdout.write(
          `${JSON.stringify({ event: "e2e_send_ack_ms", measured: ackMs, target: 500 })}\n`,
        );

        // The durable user event fans out live and RECONCILES the optimistic
        // copy — exactly one message, and it is the journal's identity now.
        const userEvent = await waitForEvent(
          fanout,
          (event) =>
            event.name === "stream.event" &&
            (event.payload as { type?: string }).type === "message.appended",
          "the durable user message",
        );
        state = liveEvent(state, userEvent.payload);
        state = advanceLiveThread(state, { type: "send_acked", key: sendKey });
        state = acknowledge(state);
        const userMessageId = (userEvent.payload as { payload: { message_id: string } }).payload
          .message_id;
        expect(messagesOf(state)).toEqual([{ id: userMessageId, klass: "live", text: sendText }]);

        // -- Phase 4: STREAM — transient deltas, then the durable reply -------
        const deltaFrame = await waitForEvent(
          fanout,
          (event) =>
            event.name === "stream.frame" &&
            (event.payload as { frame?: string }).frame === "message.delta",
          "reply delta frames",
        );
        const replyKey = (deltaFrame.payload as { stream_key: string }).stream_key;

        const replyEvent = await waitForEvent(
          fanout,
          (event) =>
            event.name === "stream.event" &&
            (event.payload as { correlation_id?: string }).correlation_id === replyKey,
          "the durable agent reply",
        );
        // All deltas are transient frames the client received BEFORE the
        // durable reply committed — collect the full burst now.
        let streamedText = "";
        for (const event of fanout) {
          const frame = event.payload as {
            frame?: string;
            stream_key?: string;
            text_delta?: string;
          };
          if (
            event.name === "stream.frame" &&
            frame.frame === "message.delta" &&
            frame.stream_key === replyKey
          ) {
            streamedText += frame.text_delta ?? "";
          }
        }
        expect(streamedText.length).toBeGreaterThan(0);
        // The bubble renders the streamed text while it lasts.
        state = advanceLiveThread(state, {
          type: "stream_text",
          streamKey: replyKey,
          agentId: "agent_general_assistant",
          text: streamedText,
          announcementText: streamedText,
        });
        expect(state.stream!.text).toBe(streamedText);

        state = liveEvent(state, replyEvent.payload);
        state = acknowledge(state);
        // The reply is durable truth exactly once — the bubble is gone, and
        // the streamed text matches the journaled message verbatim.
        expect(state.stream).toBeNull();
        const visible = messagesOf(state);
        expect(visible).toHaveLength(2);
        expect(visible[1]!.klass).toBe("live");
        expect(visible[1]!.text).toBe(streamedText);
        // G2/D34: a plain conversation turn produced NO task run anywhere.
        expect(
          fanout.some((event) =>
            String((event.payload as { type?: string }).type ?? "").startsWith("task."),
          ),
        ).toBe(false);

        // -- Phase 5: HARD REFRESH --------------------------------------------
        // A reload carries NOTHING over: fresh reducer, fresh socket, and the
        // initial replay renders exactly the durable prefix. Unpersisted
        // presentation state (the bubble) leaves no trace.
        socket.close();
        const refreshSocket = await openSocket(harness.mock);
        try {
          await refreshSocket.request("stream.subscribe", {
            workspace_id: workspaceId,
            stream_id: streamId,
          });
          const refreshReplay = (await refreshSocket.request("replay.request", {
            workspace_id: workspaceId,
            stream_id: streamId,
            last_acknowledged_sequence: 0,
          })) as { kind: string; events: unknown[] };
          expect(refreshReplay.events).toHaveLength(3);

          const refreshed = applyReplay(INITIAL_LIVE_STATE, refreshReplay, "initial");
          expect(refreshed.stream).toBeNull();
          expect(refreshed.optimistic).toHaveLength(0);
          expect(assembleLiveTimeline(refreshed).replayBoundary).toBeNull();
          expect(messagesOf(refreshed)).toEqual([
            { id: expect.any(String), klass: "live", text: sendText },
            { id: expect.any(String), klass: "live", text: streamedText },
          ]);

          // -- Phase 6: RECONNECT REPLAY with the marker ----------------------
          // The tab goes offline; a turn commits elsewhere (another device —
          // here: the typed client over HTTP); the tab reconnects and replays
          // from its acknowledged cursor.
          const acknowledgedBefore = refreshed.acknowledged;
          expect(acknowledgedBefore).toBe(3);
          refreshSocket.close();

          const offlineSend = await sendConversationMessage({
            workspaceId,
            conversationId,
            text: "Second turn from another device.",
            displayName: SESSION_USER,
            idempotencyKey: `msg-${crypto.randomUUID()}`,
          });
          expect(offlineSend.kind).toBe("message_sent");

          // The scripted reply must also have committed before the reconnect.
          for (;;) {
            const replay = await fetchConversationEvents(conversationId, workspaceId);
            if (replay.kind === "events" && replay.events.length >= 5) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          const reconnectSocket = await openSocket(harness.mock);
          try {
            await reconnectSocket.request("stream.subscribe", {
              workspace_id: workspaceId,
              stream_id: streamId,
            });
            const missed = (await reconnectSocket.request("replay.request", {
              workspace_id: workspaceId,
              stream_id: streamId,
              last_acknowledged_sequence: acknowledgedBefore,
            })) as { kind: string; events: unknown[] };
            expect(missed.events).toHaveLength(2);

            let reconnected = refreshed;
            reconnected = advanceLiveThread(reconnected, { type: "reconnecting" });
            reconnected = applyReplay(reconnected, missed, "reconnect");

            // The missed batch renders as the marked replayed batch (§6.2).
            const boundary = assembleLiveTimeline(reconnected).replayBoundary;
            expect(boundary).toEqual({ at: expect.any(String), count: 2 });
            // Five durable journal events — one conversation.created plus
            // four messages; the two missed messages carry the marker.
            expect(messagesOf(reconnected).map((message) => message.klass)).toEqual([
              "live",
              "live",
              "replayed",
              "replayed",
            ]);
            expect(messagesOf(reconnected)[2]!.text).toBe("Second turn from another device.");
            expect(messagesOf(reconnected)[3]!.text).toContain("initial take");
            // The cursor re-acknowledged after render.
            expect(reconnected.acknowledged).toBe(5);

            // Final integrity: the journal holds exactly the five durable
            // events and NEVER a task.* event (G2/D34 across the whole path).
            const finalReplay = await fetchConversationEvents(conversationId, workspaceId);
            expect(finalReplay.kind).toBe("events");
            if (finalReplay.kind === "events") {
              expect(finalReplay.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
              expect(finalReplay.events.filter((event) => event.type.startsWith("task."))).toEqual(
                [],
              );
            }
          } finally {
            reconnectSocket.close();
          }
        } finally {
          refreshSocket.close();
        }
      } finally {
        socket.close();
      }
    } finally {
      restoreFetch();
      await harness.close();
    }
  }, 60_000);
});
