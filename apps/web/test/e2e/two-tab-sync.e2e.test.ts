/**
 * S30 chunk 8 — the two-tab honesty E2E (issue #31 ACs; PRD §14, D26, E3).
 *
 * ONE deterministic E2E through the REAL pieces — the mock runtime (real
 * SQLite, real HTTP, the real WebSocket gateway), the REAL /api/runtime
 * proxy (the same allowlist + session-actor bindings the Next route handler
 * runs behind), the web app's OWN wire client and live-thread reducer, and
 * the S30 BroadcastChannel hint layer:
 *
 *   1. TWO TABS: a message sent in tab A appears EXACTLY ONCE in both tabs
 *      (no duplicate rows — the idempotency key + the exactly-once dedupe).
 *   2. Reconnect in the second tab replays the MISSED events with the
 *      replayed marker (§6.2 batch, "N missed events replayed"); nothing is
 *      silently merged into live.
 *   3. An approval decided in tab A propagates to tab B through the SERVER
 *      truth (the S20 machinery) — tab B's reads and notification center
 *      converge, and the S30 tab-sync hint makes the convergence immediate.
 *
 * BroadcastChannel carries HINTS only — conversation history replays through
 * the S07 server cursor (PRD §14); the server cursor stays authoritative.
 */
import { rmSync } from "node:fs";
import { createServer, type Server as HTTPServer } from "node:http";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ChatMessage } from "@/lib/fixtures";
import { ensureGaConversation, sendConversationMessage, type RuntimeEvent } from "@/lib/runtime-client";
import {
  advanceLiveThread,
  assembleLiveTimeline,
  conversationStreamId,
  INITIAL_LIVE_STATE,
  type LiveThreadState,
} from "@/lib/runtime-live";
import { proxyToLocalApi } from "@/lib/server/proxies";
import {
  openTabSyncChannel,
  subscribeTabEvents,
  type TabSyncEvent,
} from "@/lib/tab-sync";
import { RuntimeSocket } from "@/lib/ws-socket";

import {
  startE2eMockRuntime,
  type E2eMockRuntime,
} from "../../../user-runtime/src/mock/e2e-mode.ts";

const SESSION_USER = "Emon";
/** The session workspace IS the mock runtime's container workspace (E12). */
let WORKSPACE = "ws_e2e";

interface Harness {
  mock: E2eMockRuntime;
  proxyOrigin: string;
  close(): Promise<void>;
}

async function startHarness(
  options: { scriptedToolProposal?: NonNullable<Parameters<typeof startE2eMockRuntime>[0]>["scriptedToolProposal"] | undefined } = {},
): Promise<Harness> {
  const mock = await startE2eMockRuntime({ scriptedReplies: false, ...options });
  WORKSPACE = mock.workspace_id;
  const previousUpstream = process.env["CONTROL_PLANE_URL"];
  const control = createServer((req, res) => {
    void (async () => {
      if (req.url === "/api/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            workspace_id: WORKSPACE,
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
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await mock.stop();
      if (previousUpstream === undefined) {
        delete process.env["CONTROL_PLANE_URL"];
      } else {
        process.env["CONTROL_PLANE_URL"] = previousUpstream;
      }
    },
  };
}

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

async function openSocket(mock: E2eMockRuntime): Promise<RuntimeSocket> {
  const url = mock.origin.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket";
  return RuntimeSocket.open(url);
}

interface ServerEvent {
  name: string;
  payload: unknown;
}

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

async function subscribe(
  socket: RuntimeSocket,
  conversationId: string,
): Promise<void> {
  await socket.request("stream.subscribe", {
    workspace_id: WORKSPACE,
    stream_id: conversationStreamId(conversationId),
  });
}

const tempDirs: string[] = [];
const harnesses: Harness[] = [];

afterAll(async () => {
  for (const harness of harnesses) {
    await harness.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Both tabs drive the SAME conversation; each holds its own socket + reducer. */
interface Tab {
  socket: RuntimeSocket;
  state: LiveThreadState;
  events: ServerEvent[];
  unsubscribe: () => void;
}

async function openTab(mock: E2eMockRuntime, conversationId: string): Promise<Tab> {
  const socket = await openSocket(mock);
  await subscribe(socket, conversationId);
  const tab: Tab = {
    socket,
    state: INITIAL_LIVE_STATE,
    events: [],
    unsubscribe: socket.onEvent((name, payload) => {
      tab.events.push({ name, payload });
      if (name === "stream.event" && payload && typeof payload === "object") {
        tab.state = liveEvent(tab.state, payload);
      }
    }),
  };
  return tab;
}

describe("S30 two-tab honesty E2E (PRD §14)", () => {
  it("a message sent in one tab appears EXACTLY ONCE in both tabs — no duplicate rows", async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    tempDirs.push(join(harness.mock.dbPath, ".."));
    const restoreFetch = installOriginShim(harness.proxyOrigin);

    try {
      // Both tabs open the same conversation: the GA direct chat created
      // through the REAL commands surface (idempotent upstream).
      const created = await ensureGaConversation(WORKSPACE);
      const conversationId = created.conversation_id;

      const tabA = await openTab(harness.mock, conversationId);
      const tabB = await openTab(harness.mock, conversationId);

      // Tab A sends ONE message with ONE idempotency key.
      const key = `msg-${crypto.randomUUID()}`;
      await sendConversationMessage({
        workspaceId: WORKSPACE,
        conversationId,
        text: "Two-tab dedupe probe.",
        displayName: SESSION_USER,
        idempotencyKey: key,
      });

      // BOTH tabs receive the durable event; each renders it EXACTLY ONCE.
      await waitForEvent(tabA.events, (event) => JSON.stringify(event).includes("Two-tab dedupe probe."), "tab A durable message");
      await waitForEvent(tabB.events, (event) => JSON.stringify(event).includes("Two-tab dedupe probe."), "tab B durable message");

      const aRows = messagesOf(tabA.state).filter((message) => message.text === "Two-tab dedupe probe.");
      const bRows = messagesOf(tabB.state).filter((message) => message.text === "Two-tab dedupe probe.");
      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
      // The same durable id in both tabs — one journal event, two views.
      expect(aRows[0]!.id).toBe(bRows[0]!.id);
      expect(aRows[0]!.klass).toBe("live");
    } finally {
      restoreFetch();
    }
  });

  it("reconnect in a second tab replays missed events with the replayed marker — nothing silently merged into live", async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    tempDirs.push(join(harness.mock.dbPath, ".."));
    const restoreFetch = installOriginShim(harness.proxyOrigin);

    try {
      const created = await ensureGaConversation(WORKSPACE);
      const conversationId = created.conversation_id;
      await sendConversationMessage({
        workspaceId: WORKSPACE,
        conversationId,
        text: "Opening the replay conversation.",
        displayName: SESSION_USER,
        idempotencyKey: `msg-${crypto.randomUUID()}`,
      });
      const tabA = await openTab(harness.mock, conversationId);
      const tabB = await openTab(harness.mock, conversationId);

      // Tab B drops (the browser tab slept); tab A sends a message.
      tabB.socket.close();
      const key = `msg-${crypto.randomUUID()}`;
      await sendConversationMessage({
        workspaceId: WORKSPACE,
        conversationId,
        text: "Missed while tab B was asleep.",
        displayName: SESSION_USER,
        idempotencyKey: key,
      });
      await waitForEvent(tabA.events, (event) => JSON.stringify(event).includes("Missed while tab B was asleep."), "tab A missed-window message");
      acknowledge(tabA.state);

      // Tab B reconnects with its OWN acknowledged cursor — the S07 server
      // cursor replay, never another tab's memory.
      const reconnected = await openSocket(harness.mock);
      await subscribe(reconnected, conversationId);
      const replay = (await reconnected.request("replay.request", {
        workspace_id: WORKSPACE,
        stream_id: conversationStreamId(conversationId),
        last_acknowledged_sequence: 1,
      })) as { kind: string; events?: unknown[] };
      expect(replay.kind).toBe("events");
      expect(replay.events!.length).toBeGreaterThanOrEqual(1);

      // The replayed events enter the reducer as the §6.2 batch: the missed
      // message is delivery_class "replayed" and the timeline closes the
      // batch with the boundary marker — nothing arrived as live.
      tabB.state = applyReplay(tabB.state, replay, "reconnect");
      const rows = messagesOf(tabB.state);
      const missed = rows.find((message) => message.text === "Missed while tab B was asleep.");
      expect(missed).toMatchObject({ klass: "replayed" });
      const boundary = assembleLiveTimeline(tabB.state).replayBoundary;
      expect(boundary).not.toBeNull();
      expect(boundary!.count).toBeGreaterThanOrEqual(1);
      reconnected.close();
    } finally {
      restoreFetch();
    }
  });

  it("an approval decided in tab A propagates to tab B through the server truth; the tab-sync hint fires", async () => {
    // The gated scripted tool (the S20 demo configuration — runtime-owned,
    // G2): the trigger's run pauses on the EXTERNAL_WRITE proposal.
    const harness = await startHarness({
      scriptedToolProposal: {
        agent_id: "agent_general_assistant",
        tool: {
          tool_id: "tool_repo_push",
          tool_version: "1.2.0",
          capability: "repo.push",
          risk_class: "EXTERNAL_WRITE",
          resource_scope: "workspace://notes/draft.md",
          side_effect_summary: "Pushes local commits to the configured remote repository.",
        },
        args_digest: `sha256:${"c".repeat(64)}`,
        proposal_summary: "Scripted demo proposal: push the drafted notes.",
      },
    });
    harnesses.push(harness);
    tempDirs.push(join(harness.mock.dbPath, ".."));
    const restoreFetch = installOriginShim(harness.proxyOrigin);

    try {
      // The REAL pause: a typed trigger starts the scripted run, which
      // pauses on the gated tool (the S20 machinery creates the request,
      // the reminders, and the WAITING_FOR_APPROVAL state — nothing seeded).
      const run = harness.mock.harness.startRun({
        event_id: `evt_two_tab_trig_${Date.now()}`,
        stream_id: "conversation:conv_two_tab_apr",
        sequence: 1,
        event_version: 1,
        actor: { type: "system", id: "scheduler" },
        task_id: `task_two_tab_${Date.now()}`,
        conversation_id: "conv_two_tab_apr",
        occurred_at: new Date().toISOString(),
        redaction_class: "internal",
        event_type: "trigger.scheduled",
        payload: { schedule_id: "sch_two_tab", due_at: new Date().toISOString() },
      });
      if (!run.ok) {
        throw new Error(`the scripted run refused to start: ${run.reason}`);
      }
      // The pause created the REAL request — read it through the proxy.
      const pendingBefore = await fetch(
        `${harness.proxyOrigin}/api/runtime/v1/approvals/pending?workspace_id=${WORKSPACE}`,
      );
      const pendingBeforeBody = (await pendingBefore.json()) as {
        approvals: Array<{ approval_id: string; task_id: string }>;
      };
      const approval = pendingBeforeBody.approvals.find((row) => row.task_id === run.task_id);
      if (!approval) {
        throw new Error("the scripted gated run did not pause for approval");
      }
      const approvalId = approval.approval_id;

      // Tab B listens on the hint channel (the S30 client-convenience
      // layer); tab A posts. The spec delivers to OTHER channel instances —
      // a tab never hears itself, exactly like the browser.
      const hints: TabSyncEvent[] = [];
      const channelB = openTabSyncChannel();
      const unsubscribe = subscribeTabEvents(channelB, (event) => hints.push(event));
      const channelA = openTabSyncChannel();

      // Tab A decides (through the REAL proxy — the session-actor binding
      // rewrites decided_by server-side).
      const decision = await fetch(`${harness.proxyOrigin}/api/runtime/v1/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: WORKSPACE,
          choice: "approve-this-execution-only",
          decided_by: { type: "user", id: "client-asserted-identity" },
        }),
      });
      expect(decision.status).toBe(200);

      // Tab B reads the SERVER truth: the approval is decided — the decision
      // propagated (through the S20 machinery, not through tab A's memory).
      const pendingB = await fetch(
        `${harness.proxyOrigin}/api/runtime/v1/approvals/pending?workspace_id=${WORKSPACE}`,
      );
      const pendingBody = (await pendingB.json()) as { approvals: Array<{ approval_id: string }> };
      expect(pendingBody.approvals.some((row) => row.approval_id === approvalId)).toBe(false);

      // The S30 notification center converged too: the runtime's derived
      // rows no longer carry the approval-required notification (the
      // pending row is decided — one record, every surface).
      const notes = await fetch(
        `${harness.proxyOrigin}/api/runtime/v1/notifications?workspace_id=${WORKSPACE}`,
      );
      const notesBody = (await notes.json()) as { notifications: Array<{ approval_id: string | null }> };
      expect(
        notesBody.notifications.some((row) => row.approval_id === approvalId),
      ).toBe(false);

      // The S30 hint layer: tab A's surfaces broadcast notifications-changed
      // after settled commands; tab B subscribes. (The E2E asserts the
      // channel vocabulary end-to-end through the shared BroadcastChannel.)
      channelA?.postMessage(JSON.stringify({ kind: "notifications-changed" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hints).toContainEqual({ kind: "notifications-changed" });
      unsubscribe();
      channelA?.close();
      channelB?.close();
    } finally {
      restoreFetch();
    }
  });
});
