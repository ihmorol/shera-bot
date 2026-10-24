/**
 * S12 chunk 3 — session wiring, presence, and restart persistence proofs.
 *
 * Chunk 2 proved the SessionSupervisor lifecycle against the fake Pi through
 * the injected spawn seam; THIS suite proves the WIRING: the composed runtime
 * spawns real fake-Pi harness children through the production process adapter
 * (adapters/process — the only production file inside the process boundary),
 * the direct-chat send path addresses sessions on demand (NEVER at boot),
 * replies land as durable conversation messages the replay machinery returns
 * after a refresh, the agent API exposes session presence, and kill/restart
 * persistence holds end-to-end through compose → close → fresh compose on the
 * same data directory.
 *
 * The disabled-supervisor compose (no harness command configured) must behave
 * exactly like the S09 baseline: presence "none" everywhere and the scripted
 * reply producer unchanged (G4 — nothing spawns without configuration).
 *
 * Governing records: D14, D15, D32, E17; the start-latency AC.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { FAKE_PI_CHILD_SCRIPT } from "@shera-bot/pi-protocol";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  DEFAULT_SCRIPTED_REPLY,
  type ScriptedReplyOptions,
} from "../../modules/conversations/reply-streamer.ts";
import { sessionStreamFor } from "../../modules/sessions/sessions.events.ts";
import type { SessionSupervisorPolicy } from "../../modules/sessions/session-supervisor.service.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import { SUBMIT_CONVERSATION_COMMAND_PATH } from "./app.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The in-repo pack tree: agent-packs/ at the repository root (five levels up).
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const GENERAL = "agent_general_assistant";

/**
 * The REAL fake-Pi child script as the configured session harness command —
 * the production spawn adapter launches it exactly as it would launch any
 * configured harness executable. `{session_id}` and `{heartbeat_interval_ms}`
 * are the documented per-spawn placeholders the adapter substitutes from the
 * supervisor's spawn request; the child beats fast so ms-scale policy windows
 * apply. `--crash-on-prompt true` is the D14 crash-on-demand misbehavior
 * (hard exit 137 on a prompt whose text is exactly "crash").
 */
const FAKE_PI_HARNESS = {
  command: process.execPath,
  args: [
    FAKE_PI_CHILD_SCRIPT,
    "--session-id",
    "{session_id}",
    "--heartbeat-ms",
    "{heartbeat_interval_ms}",
    "--tokens",
    "3",
  ],
};

/** ms-scale supervisor overrides: the watchdog window tracks the child's beat. */
const MS_POLICY: Partial<SessionSupervisorPolicy> = {
  heartbeatIntervalMs: 50,
  missedHeartbeatLimit: 3,
};

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

interface ComposeOptions {
  sessionHarness?: { command: string; args?: readonly string[] };
  sessionPolicy?: Partial<SessionSupervisorPolicy>;
  scriptedReplies?: ScriptedReplyOptions;
  /** The composition's redacted untyped-fault sink (B-1) — test collector. */
  logUntypedFault?: (event: string, fields: Record<string, unknown>) => void;
}

async function composeOn(dbPath: string, options: ComposeOptions = {}): Promise<RunningRuntime> {
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    ...(options.sessionHarness ? { sessionHarness: options.sessionHarness } : {}),
    ...(options.sessionPolicy ? { sessionPolicy: options.sessionPolicy } : {}),
    ...(options.scriptedReplies ? { scriptedReplies: options.scriptedReplies } : {}),
    ...(options.logUntypedFault ? { logUntypedFault: options.logUntypedFault } : {}),
  });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dbPath,
    close: () => runtime.close(),
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Bounded poll until the reader yields a value (chunk-2 suite style). */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The session presence an agent detail response reports ("MISSING" = no field, red). */
async function sessionPresence(origin: string, agentId: string): Promise<string> {
  const detail = await getJson(origin, `/v1/agents/${agentId}?workspace_id=${DEFAULT_WORKSPACE_ID}`);
  expect(detail.status).toBe(200);
  const session = detail.body["session"] as { presence?: string } | undefined;
  return session?.presence ?? "MISSING";
}

interface ReplayRow {
  type: string;
  payload: Record<string, unknown>;
}

/** Full durable replay of one conversation from sequence 0 (the refresh path). */
async function replayConversation(origin: string, chatId: string): Promise<ReplayRow[]> {
  const events = await getJson(
    origin,
    `/v1/conversations/${chatId}/events?workspace_id=${DEFAULT_WORKSPACE_ID}&last_acknowledged_sequence=0`,
  );
  expect(events.status).toBe(200);
  return (events.body["events"] ?? []) as ReplayRow[];
}

/** Poll the replay until at least one durable AGENT message exists. */
function untilAgentReply(origin: string, chatId: string): Promise<ReplayRow[]> {
  return until(async () => {
    const rows = await replayConversation(origin, chatId);
    return rows.some(
      (row) =>
        row.type === "message.appended" &&
        (row.payload["sender"] as { kind?: string } | undefined)?.kind === "agent",
    )
      ? rows
      : undefined;
  });
}

/** Send one durable user message into a conversation; asserts the 200. */
async function sendUserMessage(
  origin: string,
  chatId: string,
  key: string,
  text: string,
): Promise<void> {
  const sent = await postJson(origin, SUBMIT_CONVERSATION_COMMAND_PATH, {
    type: "message.send",
    workspace_id: DEFAULT_WORKSPACE_ID,
    idempotency_key: key,
    payload: { conversation_id: chatId, text, sender: { kind: "user", display_name: "Emon" } },
  });
  expect(sent.status).toBe(200);
  expect(sent.body).toMatchObject({ kind: "message_sent", conversation_id: chatId });
}

/** The Agent's session journal stream, read straight off the committed rows. */
function readSessionEvents(dbPath: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const conn = openDatabase(dbPath);
  try {
    const journal = new EventJournalRepository(new SqliteTransactions(conn.db));
    return journal
      .listStream(sessionStreamFor(DEFAULT_WORKSPACE_ID, GENERAL), DEFAULT_WORKSPACE_ID)
      .map((row) => ({ type: row.event_type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  } finally {
    conn.close();
  }
}

/** Message texts and senders of one replay, in stream order. */
function messageFlow(rows: ReplayRow[]): Array<{ from: string; text: string }> {
  return rows
    .filter((row) => row.type === "message.appended")
    .map((row) => {
      const sender = row.payload["sender"] as { kind: string };
      return { from: sender.kind, text: row.payload["text"] as string };
    });
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S12 session wiring — on-demand start (D32 layer 2, wired)", () => {
  it("boots with NO session process: presence 'none' everywhere, reads never address a session", async () => {
    const dir = makeTempDir("shera-runtime-s12-boot-");
    const dbPath = join(dir, "runtime.db");
    const running = await composeOn(dbPath, {
      sessionHarness: FAKE_PI_HARNESS,
      sessionPolicy: MS_POLICY,
    });
    try {
      // The supervisor seam exists when a harness command is configured.
      expect(running.runtime.sessions).toBeDefined();

      const list = await getJson(running.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      expect(list.status).toBe(200);
      const agents = list.body["agents"] as Array<Record<string, unknown>>;
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) {
        expect(agent["session"]).toEqual({ presence: "none" });
      }

      // Detail reads (get-or-create chat) must NOT start a session either.
      const detail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.body["session"]).toEqual({ presence: "none" });
      expect(await sessionPresence(running.origin, GENERAL)).toBe("none");

      // Still nothing after the reads: only the send path addresses a session.
      const listAgain = await getJson(
        running.origin,
        `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      for (const agent of listAgain.body["agents"] as Array<Record<string, unknown>>) {
        expect(agent["session"]).toEqual({ presence: "none" });
      }
    } finally {
      await running.close();
    }
  });

  it("starts the session on the first direct-chat message, records start latency, and the reply is durable + replayable", async () => {
    const dir = makeTempDir("shera-runtime-s12-send-");
    const dbPath = join(dir, "runtime.db");
    const running = await composeOn(dbPath, {
      sessionHarness: FAKE_PI_HARNESS,
      sessionPolicy: MS_POLICY,
    });
    let chatId: string;
    try {
      const detail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      chatId = detail.body["direct_chat_id"] as string;
      expect(typeof chatId).toBe("string");

      // The send path: on-demand start + prompt, no boot-time process.
      await sendUserMessage(running.origin, chatId, "idem-s12-send-1", "hello session");
      await until(() =>
        sessionPresence(running.origin, GENERAL).then((p) => (p === "active" ? p : undefined)),
      );

      // The fake-Pi reply flows back as a DURABLE conversation message.
      const rows = await untilAgentReply(running.origin, chatId);
      expect(messageFlow(rows)).toEqual([
        { from: "user", text: "hello session" },
        { from: "agent", text: "t1t2t3" },
      ]);

      // Roster presence reflects the live session; the other Agents stay none.
      const list = await getJson(running.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      const byId = new Map(
        (list.body["agents"] as Array<Record<string, unknown>>).map((agent) => [
          agent["agent_id"],
          agent["session"],
        ]),
      );
      expect(byId.get(GENERAL)).toEqual({ presence: "active" });
      for (const [agentId, session] of byId) {
        if (agentId !== GENERAL) expect(session).toEqual({ presence: "none" });
      }
    } finally {
      await running.close();
    }

    // The start was measured: exactly one session.started for the one address.
    const started = readSessionEvents(dbPath).filter((row) => row.type === "session.started");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({
      session_id: expect.any(String),
      workspace_id: DEFAULT_WORKSPACE_ID,
      agent_id: GENERAL,
    });
    const latency = started[0]!.payload["start_latency_ms"];
    expect(typeof latency).toBe("number");
    expect(latency as number).toBeGreaterThanOrEqual(0);
  });
});

describe("S12 session wiring — crash persistence (kill mid-conversation)", () => {
  /**
   * The AC at the WIRING level: a session child killed mid-conversation loses
   * no durable data — the journal replays everything — and the next message
   * transparently continues on the supervised restart. The crash is the D14
   * crash-on-demand misbehavior: the child hard-exits(137) on the prompt
   * whose text is exactly "crash".
   */
  it("loses no durable data when the child dies; the next message continues the conversation", async () => {
    const dir = makeTempDir("shera-runtime-s12-crash-");
    const dbPath = join(dir, "runtime.db");
    const faults: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const running = await composeOn(dbPath, {
      sessionHarness: {
        ...FAKE_PI_HARNESS,
        args: [...FAKE_PI_HARNESS.args, "--crash-on-prompt", "true"],
      },
      sessionPolicy: MS_POLICY,
      logUntypedFault: (event, fields) => faults.push({ event, fields }),
    });
    let chatId: string;
    try {
      const detail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      chatId = detail.body["direct_chat_id"] as string;

      // A healthy first turn: message, session start, durable reply.
      await sendUserMessage(running.origin, chatId, "idem-s12-crash-1", "hello session");
      const firstReply = await untilAgentReply(running.origin, chatId);
      expect(messageFlow(firstReply)).toEqual([
        { from: "user", text: "hello session" },
        { from: "agent", text: "t1t2t3" },
      ]);

      // Kill the child on demand: the "crash" user message commits, then the
      // session prompt hits a child that hard-exits. The interruption is
      // CONTAINED (recorded through the redacted fault sink, never propagated
      // as a runtime fault) and the supervised restart takes over.
      await sendUserMessage(running.origin, chatId, "idem-s12-crash-2", "crash");
      await until(async () =>
        faults.some((fault) => fault.event === "agent_session_reply_failed") ? true : undefined,
      );
      // The supervised restart settles the session back to active.
      await until(() =>
        sessionPresence(running.origin, GENERAL).then((p) => (p === "active" ? p : undefined)),
      );

      // The next message transparently continues on the fresh incarnation.
      await sendUserMessage(running.origin, chatId, "idem-s12-crash-3", "still there?");
      const rows = await until(async () => {
        const replayed = await replayConversation(running.origin, chatId);
        const flow = messageFlow(replayed);
        return flow.length >= 5 ? flow : undefined;
      });

      // NO durable data lost: both user messages before AND after the crash
      // replay in order; only the interrupted in-flight reply is absent.
      expect(rows).toEqual([
        { from: "user", text: "hello session" },
        { from: "agent", text: "t1t2t3" },
        { from: "user", text: "crash" },
        { from: "user", text: "still there?" },
        { from: "agent", text: "t1t2t3" },
      ]);
    } finally {
      await running.close();
    }

    // The journal carries the crash AND the supervised restart (D14).
    const events = readSessionEvents(dbPath);
    const crashed = events.filter((row) => row.type === "session.crashed");
    expect(crashed).toHaveLength(1);
    expect(crashed[0]!.payload).toMatchObject({
      workspace_id: DEFAULT_WORKSPACE_ID,
      agent_id: GENERAL,
      exit_code: 137,
    });
    expect(events.filter((row) => row.type === "session.restarted").length).toBeGreaterThanOrEqual(1);
  });
});

describe("S12 session wiring — full runtime restart persistence", () => {
  /**
   * The s11 restart pattern, extended with sessions: identity, chat binding,
   * history, and settings persist across compose → close → fresh compose on
   * the SAME data directory; the fresh runtime boots with NO session process
   * (on-demand, not boot) and starts a fresh session only when addressed
   * again.
   */
  it("persists identity/chat/history/settings and boots session-free until addressed again", async () => {
    const dir = makeTempDir("shera-runtime-s12-restart-");
    const dbPath = join(dir, "runtime.db");

    // --- First session: address the Agent, exchange messages. ---
    const first = await composeOn(dbPath, {
      sessionHarness: FAKE_PI_HARNESS,
      sessionPolicy: MS_POLICY,
    });
    let chatId: string;
    try {
      const detail = await getJson(
        first.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      chatId = detail.body["direct_chat_id"] as string;
      await sendUserMessage(first.origin, chatId, "idem-s12-restart-1", "before the restart");
      await untilAgentReply(first.origin, chatId);
      expect(await sessionPresence(first.origin, GENERAL)).toBe("active");
    } finally {
      await first.close(); // stopAll reaps the session child (chunk-2 guarantee)
    }

    // --- Second session: FRESH compose on the same data directory. ---
    const second = await composeOn(dbPath, {
      sessionHarness: FAKE_PI_HARNESS,
      sessionPolicy: MS_POLICY,
    });
    try {
      // NO session process until an Agent is addressed again.
      const list = await getJson(second.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      for (const agent of list.body["agents"] as Array<Record<string, unknown>>) {
        expect(agent["session"]).toEqual({ presence: "none" });
      }

      // Identity, chat binding, and history all persist (s11 pattern).
      const detail = await getJson(
        second.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.body["direct_chat_id"]).toBe(chatId);
      const rows = await replayConversation(second.origin, chatId);
      expect(messageFlow(rows)).toEqual([
        { from: "user", text: "before the restart" },
        { from: "agent", text: "t1t2t3" },
      ]);

      // Addressing again starts a FRESH session on demand.
      await sendUserMessage(second.origin, chatId, "idem-s12-restart-2", "after the restart");
      await until(() =>
        sessionPresence(second.origin, GENERAL).then((p) => (p === "active" ? p : undefined)),
      );
      const after = await until(async () => {
        const replayed = await replayConversation(second.origin, chatId);
        return messageFlow(replayed).length >= 4 ? messageFlow(replayed) : undefined;
      });
      expect(after).toEqual([
        { from: "user", text: "before the restart" },
        { from: "agent", text: "t1t2t3" },
        { from: "user", text: "after the restart" },
        { from: "agent", text: "t1t2t3" },
      ]);
    } finally {
      await second.close();
    }

    // Both runtimes measured their own on-demand start (one per address).
    const started = readSessionEvents(dbPath).filter((row) => row.type === "session.started");
    expect(started.length).toBeGreaterThanOrEqual(2);
    for (const row of started) {
      expect(typeof row.payload["start_latency_ms"]).toBe("number");
    }
  });
});

describe("S12 session wiring — disabled supervisor (G4 fallback)", () => {
  /**
   * Without a configured harness command the compose runs with the supervisor
   * DISABLED: presence "none" everywhere, the send path behaves exactly as
   * today, and the S09 scripted reply producer keeps working unchanged — the
   * E2E regression budget runs on that path.
   */
  it("keeps presence 'none' everywhere and the scripted streamer path unchanged", async () => {
    const dir = makeTempDir("shera-runtime-s12-disabled-");
    const dbPath = join(dir, "runtime.db");
    const running = await composeOn(dbPath, {
      scriptedReplies: { ...DEFAULT_SCRIPTED_REPLY, deltaIntervalMs: 10 },
    });
    let chatId: string;
    try {
      expect(running.runtime.sessions).toBeUndefined();

      const list = await getJson(running.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      for (const agent of list.body["agents"] as Array<Record<string, unknown>>) {
        expect(agent["session"]).toEqual({ presence: "none" });
      }

      const detail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      chatId = detail.body["direct_chat_id"] as string;
      await sendUserMessage(running.origin, chatId, "idem-s12-disabled-1", "scripted please");
      await until(async () => {
        const rows = await replayConversation(running.origin, chatId);
        return rows.some(
          (row) =>
            row.type === "message.appended" &&
            row.payload["text"] === DEFAULT_SCRIPTED_REPLY.replyText,
        )
          ? rows
          : undefined;
      });
      expect(await sessionPresence(running.origin, GENERAL)).toBe("none");
    } finally {
      await running.close();
    }
  });
});
