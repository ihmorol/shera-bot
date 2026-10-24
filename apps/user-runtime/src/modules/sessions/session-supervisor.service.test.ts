/**
 * SessionSupervisor tests (S12 chunk 2) — red-first lifecycle suite.
 *
 * Covers the D32 layer-2 warm Agent session: on-demand start (nothing at
 * boot), one session per (workspace, agent) with warm reuse, idle
 * hibernation with transparent restart, heartbeat hang detection that never
 * kills a slow-but-healthy child, supervised crash restarts with the
 * policy-limit terminal `failed` state, the D14 protocol-failure cap, the
 * D15 context rebuild from the provider on every (re)start (the supervisor
 * owns NO durable data), the chunk-1 shutdown escalation (no orphan), and
 * the presence state machine the UI reads.
 *
 * Every case runs the REAL fake Pi child process through the injected
 * SessionChild spawn seam with ms-scale timings (D14: fake Pi processes with
 * deterministic events and failures).
 *
 * Governing records: D14, D15, D32, E17.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawnFakePi, type FakePiHandle, type SpawnFakePiOptions } from "@shera-bot/pi-protocol";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { AgentsRepository } from "../../adapters/sqlite/agents-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { sessionStreamFor } from "./sessions.events.ts";
import {
  AgentSessionFailedError,
  AgentSessionInterruptedError,
  SessionSupervisor,
  type AgentSessionContext,
  type SessionChild,
  type SessionSupervisorPolicy,
} from "./session-supervisor.service.ts";

const WS = "ws-sessions";
const AGENT = "agent_session_test";

/** Poll until the reader returns a value; chunk-1 style bounded wait. */
async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  supervisor: SessionSupervisor;
  conn: SqliteConnection;
  journal: EventJournalRepository;
  spawns: FakePiHandle[];
  spawnSpecs: SpawnFakePiOptions[];
  contexts: (AgentSessionContext | undefined)[];
  stderrChunks: string[];
  dir: string;
}

interface HarnessOptions {
  /** Fake Pi misbehavior per spawn index (index 0 is the first child). */
  spawnSpec?: (spawnIndex: number) => SpawnFakePiOptions;
  policy?: Partial<SessionSupervisorPolicy>;
  /** Awaited before each spawn (gates make transient states observable). */
  beforeSpawn?: (spawnIndex: number) => Promise<void> | void;
  context?: Omit<AgentSessionContext, "workspace_id" | "agent_id">;
}

const openHarnesses: Harness[] = [];

function makeSupervisor(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s12-sessions-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);

  const spawns: FakePiHandle[] = [];
  const spawnSpecs: SpawnFakePiOptions[] = [];
  const contexts: (AgentSessionContext | undefined)[] = [];
  const stderrChunks: string[] = [];

  const supervisor = new SessionSupervisor({
    events,
    spawnChild: async (request) => {
      await options.beforeSpawn?.(spawns.length);
      const spec = options.spawnSpec ? options.spawnSpec(spawns.length) : {};
      const handle = spawnFakePi({ sessionId: request.session_id, ...spec });
      spawns.push(handle);
      spawnSpecs.push(spec);
      const child: SessionChild = {
        onLine: (listener) => handle.onFrame((entry) => listener(entry.line)),
        onStderr: (listener) => {
          handle.child.stderr?.setEncoding("utf8");
          handle.child.stderr?.on("data", (chunk: string) => listener(chunk));
          return () => {};
        },
        send: (frame) => handle.send(frame),
        kill: (signal) => handle.kill(signal ?? "SIGKILL"),
        waitForExit: () => handle.waitForExit(),
      };
      return child;
    },
    contextProvider: (workspaceId, agentId) => {
      // Fresh object per call: the supervisor must re-fetch on EVERY start,
      // never hold a stale context across restarts (D15).
      const context: AgentSessionContext = {
        workspace_id: workspaceId,
        agent_id: agentId,
        display_name: options.context?.display_name ?? "Session Test Agent",
        instructions: options.context?.instructions ?? "Be brief.",
        pack_profile: options.context?.pack_profile ?? "pack_default profile",
      };
      contexts.push(context);
      return context;
    },
    stderrSink: { write: (chunk) => stderrChunks.push(chunk) },
    ...(options.policy ? { policy: options.policy } : {}),
  });

  const harness: Harness = {
    supervisor,
    conn,
    journal,
    spawns,
    spawnSpecs,
    contexts,
    stderrChunks,
    dir,
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()!;
    try {
      // stopAll resolves when every child exited; a stuck gated spawn (a
      // failed test) must not hang the hook — force-reap below.
      await Promise.race([
        harness.supervisor.stopAll(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } finally {
      for (const handle of harness.spawns) handle.kill("SIGKILL");
      harness.conn.close();
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

/** Session journal events of one type, payloads decoded, in stream order. */
function eventsOf(harness: Harness, type: string): Array<Record<string, unknown>> {
  return harness.journal
    .listStream(sessionStreamFor(WS, AGENT), WS)
    .filter((row) => row.event_type === type)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

/**
 * Durable product-table state read through the repositories (boundary guard:
 * SQL stays in adapters/sqlite) — the supervisor must never write any of it.
 */
function durableCounts(harness: Harness): Record<string, unknown> {
  const agents = new AgentsRepository(new SqliteTransactions(harness.conn.db));
  const conversations = new ConversationsRepository(new SqliteTransactions(harness.conn.db));
  return {
    agents: agents.listAgents(WS).length,
    agent_settings_blob: JSON.stringify(agents.getSettings(WS, AGENT)),
    agent_direct_chat: agents.findDirectChat(WS, AGENT),
    conversations: conversations.list(WS).length,
  };
}

describe("SessionSupervisor on-demand start (D32 layer 2)", () => {
  it("starts the child only on the first address; nothing spawns at construction", async () => {
    const h = makeSupervisor({ spawnSpec: () => ({ heartbeatMs: 25 }) });
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("none");
    expect(h.spawns).toHaveLength(0);

    const snapshot = await h.supervisor.ensureStarted(WS, AGENT);
    expect(snapshot.presence).toBe("active");
    expect(snapshot.session_id.length).toBeGreaterThan(0);
    expect(snapshot.pid).toBeGreaterThan(0);
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("active");
    expect(h.spawns).toHaveLength(1);
  });

  it("warm-reuses a starting/active session: a second address spawns no second child", async () => {
    const h = makeSupervisor({ spawnSpec: () => ({ heartbeatMs: 25 }) });
    const [first, second] = await Promise.all([
      h.supervisor.ensureStarted(WS, AGENT),
      h.supervisor.ensureStarted(WS, AGENT),
    ]);
    expect(first.session_id).toBe(second.session_id);
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("active");

    const reply = await h.supervisor.prompt(WS, AGENT, "warm?");
    expect(reply.text).toBe("t1t2t3");
    expect(h.spawns).toHaveLength(1);
  });
});

describe("SessionSupervisor idle hibernation (D32 layer 2)", () => {
  it("hibernates at the idle timeout, touches no durable state, and transparently restarts on the next address", async () => {
    const h = makeSupervisor({
      spawnSpec: () => ({ heartbeatMs: 25 }),
      policy: { idleHibernateMs: 250 },
    });
    const before = durableCounts(h);
    const first = await h.supervisor.ensureStarted(WS, AGENT);
    const firstHandle = h.spawns[0]!;

    await until(() => (h.supervisor.presenceState(WS, AGENT) === "hibernating" ? true : undefined));
    const firstExit = await firstHandle.waitForExit();
    expect(firstExit.code).toBe(0); // graceful shutdown frame, not SIGKILL
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("hibernating");

    const hibernated = eventsOf(h, "session.hibernate");
    expect(hibernated).toHaveLength(1);
    expect(hibernated[0]!["session_id"]).toBe(first.session_id);
    expect(hibernated[0]!["agent_id"]).toBe(AGENT);

    // The supervisor owns NO durable data: only the event journal grew.
    expect(durableCounts(h)).toEqual(before);

    // The next address is a PROMPT: the restart is transparent and the
    // conversation continues on a fresh child.
    const reply = await h.supervisor.prompt(WS, AGENT, "still with me?");
    expect(reply.text).toBe("t1t2t3");
    expect(h.spawns).toHaveLength(2);
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("active");

    const resumed = eventsOf(h, "session.restarted");
    expect(resumed[0]!["reason"]).toBe("idle_resume");
    expect(resumed[0]!["previous_session_id"]).toBe(first.session_id);
  });
});

describe("SessionSupervisor heartbeat health (D14)", () => {
  it("kills a hung (silent) child within the heartbeat window, records the event, and restarts", async () => {
    const h = makeSupervisor({
      // First child: the silence misbehavior (no heartbeats at all). The
      // restarted child beats normally, so the conversation continues.
      spawnSpec: (index) => (index === 0 ? { heartbeatMs: 0 } : { heartbeatMs: 25 }),
      policy: { heartbeatIntervalMs: 60, missedHeartbeatLimit: 2 }, // 120ms window
    });
    await h.supervisor.ensureStarted(WS, AGENT);
    const startedAt = Date.now();

    await until(() =>
      h.spawns.length === 2 && h.supervisor.presenceState(WS, AGENT) === "active" ? true : undefined,
    );
    const detectedAfterMs = Date.now() - startedAt;
    expect(detectedAfterMs).toBeLessThan(2000); // window is 120ms; generous CI bound

    const crashed = eventsOf(h, "session.crashed");
    expect(crashed).toHaveLength(1);
    expect(crashed[0]!["cause"]).toBe("hang");
    const restarted = eventsOf(h, "session.restarted");
    expect(restarted[0]!["reason"]).toBe("hang");
    expect(restarted[0]!["previous_session_id"]).toBeTruthy();

    const reply = await h.supervisor.prompt(WS, AGENT, "still there?");
    expect(reply.text).toBe("t1t2t3");
  });

  it("does NOT kill a slow-but-healthy child whose reply outlasts one heartbeat interval", async () => {
    const h = makeSupervisor({
      spawnSpec: () => ({ heartbeatMs: 120, ttftDelayMs: 300, tokenDelayMs: 80, tokens: 3 }),
      policy: { heartbeatIntervalMs: 150, missedHeartbeatLimit: 4 }, // 600ms window
    });
    await h.supervisor.ensureStarted(WS, AGENT);

    // Reply takes ~540ms — slower than ONE heartbeat interval — but
    // heartbeats keep arriving, so the window never trips.
    const reply = await h.supervisor.prompt(WS, AGENT, "take your time");
    expect(reply.text).toBe("t1t2t3");
    expect(h.spawns).toHaveLength(1);
    expect(eventsOf(h, "session.crashed")).toHaveLength(0);
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("active");
  });
});

describe("SessionSupervisor crash restarts (D32 layer 2)", () => {
  it("records the crash, restarts supervised, and the conversation continues", async () => {
    const h = makeSupervisor({
      spawnSpec: (index) => (index === 0 ? { crashAfterTokens: 1, heartbeatMs: 25 } : { heartbeatMs: 25 }),
    });
    await h.supervisor.ensureStarted(WS, AGENT);

    await expect(h.supervisor.prompt(WS, AGENT, "crash mid-reply")).rejects.toBeInstanceOf(
      AgentSessionInterruptedError,
    );
    const exit = await h.spawns[0]!.waitForExit();
    expect(exit.code).toBe(137); // crashed child is reaped, never orphaned

    await until(() =>
      h.spawns.length === 2 && h.supervisor.presenceState(WS, AGENT) === "active" ? true : undefined,
    );
    const crashed = eventsOf(h, "session.crashed");
    expect(crashed[0]!["cause"]).toBe("unexpected_exit");
    expect(crashed[0]!["exit_code"]).toBe(137);
    const restarted = eventsOf(h, "session.restarted");
    expect(restarted[0]!["reason"]).toBe("crash");
    expect(restarted[0]!["previous_session_id"]).toBeTruthy();

    const reply = await h.supervisor.prompt(WS, AGENT, "after the crash");
    expect(reply.text).toBe("t1t2t3");
  });

  it("marks the session terminal failed after the consecutive crash-restart policy limit", async () => {
    const h = makeSupervisor({
      spawnSpec: () => ({ crashAfterTokens: 1, heartbeatMs: 25 }),
      policy: { maxConsecutiveRestarts: 1, restartWindowMs: 60_000 },
    });
    await h.supervisor.ensureStarted(WS, AGENT);

    // First crash: the one allowed restart.
    await expect(h.supervisor.prompt(WS, AGENT, "one")).rejects.toBeInstanceOf(
      AgentSessionInterruptedError,
    );
    await until(() =>
      h.spawns.length === 2 && h.supervisor.presenceState(WS, AGENT) === "active" ? true : undefined,
    );
    // Second crash: past the policy limit → terminal failed.
    await expect(h.supervisor.prompt(WS, AGENT, "two")).rejects.toBeInstanceOf(
      AgentSessionInterruptedError,
    );
    await until(() => (h.supervisor.presenceState(WS, AGENT) === "failed" ? true : undefined));

    const failed = eventsOf(h, "session.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!["reason"]).toBe("restart_limit");
    expect(h.spawns).toHaveLength(2); // terminal: no further spawns
    await expect(h.supervisor.ensureStarted(WS, AGENT)).rejects.toBeInstanceOf(AgentSessionFailedError);
    await expect(h.supervisor.prompt(WS, AGENT, "anything")).rejects.toBeInstanceOf(
      AgentSessionFailedError,
    );
  });
});

describe("SessionSupervisor protocol-failure policy (D14)", () => {
  it("records every protocol failure and applies the cap: one restart, then terminal failed", async () => {
    const h = makeSupervisor({
      // Child 1 violates twice (invalid JSON line + unknown frame type); the
      // post-cap restart child violates once more → terminal failed.
      spawnSpec: (index) =>
        index === 0
          ? { invalidJsonLine: true, unknownFrameType: true, heartbeatMs: 25 }
          : { invalidJsonLine: true, heartbeatMs: 25 },
      policy: { maxProtocolViolations: 2 },
    });
    await h.supervisor.ensureStarted(WS, AGENT);

    // The post-cap restart child (index 1) may briefly be `active` (its
    // violating line arriving in a separate burst) or skip straight from
    // `restarting` to `failed` (violation in the same stdout burst as its
    // ready frame) — both orders are legal; wait for either.
    await until(() => {
      const presence = h.supervisor.presenceState(WS, AGENT);
      return h.spawns.length === 2 && (presence === "active" || presence === "failed")
        ? true
        : undefined;
    });
    const failures = eventsOf(h, "session.protocol_failure");
    expect(failures.length).toBeGreaterThanOrEqual(2); // child 1 exhausted the cap
    expect(failures[0]!["code"]).toBe("PROTOCOL_VIOLATION");
    expect(failures[0]!["reason"]).toBe("unparseable_json_line");
    // G3: the recorded detail is bounded — never a raw child stderr dump.
    const detail = failures[0]!["detail"];
    expect(detail === null || (typeof detail === "string" && detail.length <= 200)).toBe(true);

    await until(() => (h.supervisor.presenceState(WS, AGENT) === "failed" ? true : undefined));
    expect(eventsOf(h, "session.protocol_failure")).toHaveLength(3);
    const failed = eventsOf(h, "session.failed");
    expect(failed[0]!["reason"]).toBe("protocol_violation_limit");
    expect(h.spawns).toHaveLength(2); // the one post-cap restart happened; no more
    await expect(h.supervisor.prompt(WS, AGENT, "anything")).rejects.toBeInstanceOf(
      AgentSessionFailedError,
    );
  });
});

describe("SessionSupervisor context reconstruction (D15/D32)", () => {
  it("re-fetches the compact context from the provider on every restart; no durable session state", async () => {
    const h = makeSupervisor({
      spawnSpec: (index) => (index === 0 ? { crashAfterTokens: 1, heartbeatMs: 25 } : { heartbeatMs: 25 }),
    });
    await h.supervisor.ensureStarted(WS, AGENT);
    await expect(h.supervisor.prompt(WS, AGENT, "crash me")).rejects.toBeInstanceOf(
      AgentSessionInterruptedError,
    );
    await until(() =>
      h.spawns.length === 2 && h.supervisor.presenceState(WS, AGENT) === "active" ? true : undefined,
    );

    // The previous context object is discarded; the restart rebuilt a fresh
    // one from the provider — the supervisor never held durable context.
    expect(h.contexts.length).toBe(2);
    const first = h.contexts[0]!;
    h.contexts[0] = undefined; // "delete" the previous context object
    const second = h.contexts[1]!;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(first.workspace_id).toBe(WS);
    expect(second.agent_id).toBe(AGENT);
    expect(second.instructions).toBe("Be brief.");
  });
});

describe("SessionSupervisor process-tree termination (D14/D32)", () => {
  it("stops through the shutdown escalation with the exit observed (no orphan), and reaps crash-on-demand children", async () => {
    const h = makeSupervisor({
      spawnSpec: () => ({ heartbeatMs: 25 }),
      policy: { shutdownGraceMs: 150, killGraceMs: 300 },
    });
    await h.supervisor.ensureStarted(WS, AGENT);
    const handle = h.spawns[0]!;
    await h.supervisor.stop(WS, AGENT);
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("none");
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0); // shutdown frame honored; escalation timers cleared

    // Crash on demand: the supervisor observes the death and reaps the child.
    const h2 = makeSupervisor({ spawnSpec: () => ({ crashOnPrompt: true, heartbeatMs: 25 }) });
    await h2.supervisor.ensureStarted(WS, AGENT);
    await expect(h2.supervisor.prompt(WS, AGENT, "crash")).rejects.toBeInstanceOf(
      AgentSessionInterruptedError,
    );
    const crashed = await h2.spawns[0]!.waitForExit();
    expect(crashed.code).toBe(137);
    // stopAll resolves only once every child has exited — no orphans left.
    await h2.supervisor.stopAll();
    for (const child of h2.spawns) {
      const childExit = await child.waitForExit();
      expect(childExit.code !== undefined).toBe(true);
    }
  });
});

describe("SessionSupervisor presence state machine (D32 layer 2)", () => {
  it("walks none → starting → active → hibernating → restarting → active → none", async () => {
    const gates: Array<(() => void) | undefined> = [];
    const h = makeSupervisor({
      // Child 0 healthy; child 1 silent (hangs the window); child 2 healthy.
      spawnSpec: (index) => (index === 1 ? { heartbeatMs: 0 } : { heartbeatMs: 25 }),
      policy: {
        idleHibernateMs: 200,
        heartbeatIntervalMs: 60,
        missedHeartbeatLimit: 2,
      },
      beforeSpawn: (index) =>
        new Promise<void>((resolve) => {
          gates[index] = resolve;
        }),
    });
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("none");

    const starting = h.supervisor.ensureStarted(WS, AGENT);
    await until(() => (h.supervisor.presenceState(WS, AGENT) === "starting" ? true : undefined));
    await gateReady(gates, 0);
    gates[0]!();
    await starting;
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("active");

    await until(() => (h.supervisor.presenceState(WS, AGENT) === "hibernating" ? true : undefined));

    const resumed = h.supervisor.ensureStarted(WS, AGENT); // transparent resume
    await gateReady(gates, 1);
    gates[1]!();
    await resumed;
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("active");
    expect(h.spawns).toHaveLength(2);

    // Child 1 is silent → the watchdog kills it; the supervised restart holds
    // on the gated spawn so "restarting" is observable.
    await until(() => (h.supervisor.presenceState(WS, AGENT) === "restarting" ? true : undefined));
    await gateReady(gates, 2);
    gates[2]!();
    await until(() =>
      h.supervisor.presenceState(WS, AGENT) === "active" && h.spawns.length === 3 ? true : undefined,
    );

    await h.supervisor.stop(WS, AGENT);
    expect(h.supervisor.presenceState(WS, AGENT)).toBe("none");
  });
});

/** Wait until the gated spawn for `index` is actually pending. */
async function gateReady(gates: Array<(() => void) | undefined>, index: number): Promise<void> {
  await until(() => (typeof gates[index] === "function" ? true : undefined));
}
