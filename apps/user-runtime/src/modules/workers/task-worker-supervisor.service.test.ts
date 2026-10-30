/**
 * TaskWorkerSupervisor tests (S16 chunk 1) — red-first lifecycle suite.
 *
 * Covers the D32 layer-3 persistent task worker: one supervised worker per
 * run started on demand (no idle timer, no hibernation — a healthy worker
 * runs until done/stopped), heartbeat lease renewal observable on the
 * task_workers row, stall detection that never kills a slow-but-heartbeating
 * worker, durable progress/checkpoints (journal + row, never memory-only,
 * D10), crash/silence escalation (SIGTERM→SIGKILL like S12) with the run
 * left in the DEFINED RECOVERY_REQUIRED state (D8) — never silently lost —
 * done → worker.completed + run SUCCEEDED, graceful stops, and the AC25
 * independence proof: hibernating an Agent's session never touches the
 * run's worker.
 *
 * Every case runs the REAL fake task worker child process through the
 * injected spawn seam with ms-scale policies (D14/E8: deterministic fake
 * processes with individually switchable misbehaviors).
 *
 * Governing records: D32, D33, D10, D8, E1, PRD §19 item 25 (AC25).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawnFakePi } from "@shera-bot/pi-protocol";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import {
  appliedMigrationVersions,
  applyMigrations,
  sqliteTableExists,
} from "../../adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { PackAgentSeed } from "../../adapters/sqlite/agents-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { SessionSupervisor, type SessionChild } from "../sessions/session-supervisor.service.ts";
import { sessionStreamFor } from "../sessions/sessions.events.ts";
import {
  spawnFakeTaskWorker,
  type FakeTaskWorkerHandle,
  type SpawnFakeTaskWorkerOptions,
} from "./fake-task-worker.ts";
import {
  TaskWorkerSupervisor,
  type TaskRunOperationsSeam,
  type TaskWorkerChild,
  type TaskWorkerSnapshot,
  type TaskWorkerStartResult,
  type TaskWorkerSupervisorPolicy,
} from "./task-worker-supervisor.service.ts";

const WS = "ws-workers";
const OTHER_WS = "ws-workers-other";
const AGENT = "agent_worker_test";

/**
 * S16 chunk 2 widened startWorker's result with the E1 QUEUED outcome; the
 * chunk-1 suite only exercises admitted starts — narrow with an assertion.
 */
function expectRunning(result: TaskWorkerStartResult): TaskWorkerSnapshot {
  if (result.state !== "running") {
    throw new Error(`expected a running worker, got a ${result.state} result`);
  }
  return result;
}

/** Poll until the reader returns a value; bounded wait, chunk-1 style. */
async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * ms-scale worker policy: stall window = 40ms × 50 missed beats = 2s. The
 * window is deliberately WIDE (not the naive 3-beat 120ms): the suite's
 * healthy children beat every 40ms, and a transiently starved event loop
 * (sibling vitest workers running the kernel suites, prlimit children
 * hoarding gigabytes) must never be misread as a stalled worker — a false
 * stall lands runs in RECOVERY_REQUIRED and completion waits time out
 * (observed on loaded machines at tighter windows). The watchdog tests still
 * verify stall DETECTION (a hung child produces no frames at all); they
 * detect it at the 2s window, far inside their 5s until budget.
 */
const WORKER_POLICY: Partial<TaskWorkerSupervisorPolicy> = {
  heartbeatIntervalMs: 40,
  missedHeartbeatLimit: 50,
  leaseWindowMs: 120,
  handshakeTimeoutMs: 2_000,
  shutdownGraceMs: 150,
  killGraceMs: 150,
  stderrMaxBytes: 4_096,
};

const FAKE_SEED: PackAgentSeed = {
  agent_id: AGENT,
  display_name: "Worker Test Agent",
  role_description: "runs supervised work",
  default_provider: { provider_id: "fake", model: "fake-model" },
  skills: ["skill_worker_core"],
  tools: [{ tool_id: "tool_shell", version: "1.0.0" }],
  connectors: [],
  ui_identity: { avatar_hue: 10, initial_glyph: "W" },
  home_operation_id: null,
};

interface WorkerHarness {
  supervisor: TaskWorkerSupervisor;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  workersRepo: TaskWorkersRepository;
  ops: OperationsService;
  /** The real operations seam adapter the supervisor runs against. */
  runControl: TaskRunOperationsSeam;
  /** The operation each workspace's runs were created under (harness seam scoping). */
  operationIds: Map<string, string>;
  runSeq: { n: number };
  /** Run-state writes the seam performed, in order (the run-state evidence). */
  seamWrites: Array<{ run_id: string; state: string }>;
  spawns: FakeTaskWorkerHandle[];
  stderrChunks: string[];
  dir: string;
}

interface HarnessOptions {
  spawnSpec?: (spawnIndex: number) => SpawnFakeTaskWorkerOptions;
  policy?: Partial<TaskWorkerSupervisorPolicy>;
  /** S22: wire the runtime-owned worker-failure policy seam (see the suite). */
  onWorkerReportedFailure?: (info: {
    workspaceId: string;
    runId: string;
    workerId: string;
    failureClass: string;
    failureEventId: string | null;
  }) => void;
}

const openHarnesses: WorkerHarness[] = [];

function makeHarness(options: HarnessOptions = {}): WorkerHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s16-workers-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const workersRepo = new TaskWorkersRepository(tx);
  const ops = new OperationsService({
    operations: new OperationsRepository(tx),
    tx,
    packCatalog: {
      pack_id: "pack_workers_test",
      pack_version: "1.0.0",
      agents: [FAKE_SEED],
      locateAgentPack: (agentId) => (agentId === AGENT ? "pack_workers_test" : null),
      skills: [],
      connectors: [],
    },
  });

  const operationIds = new Map<string, string>();
  const seamWrites: Array<{ run_id: string; state: string }> = [];

  const runControl: TaskRunOperationsSeam = {
    // The chunk-3 composition resolves a run's operation from the run row;
    // this harness seam closes over the operations it created and forwards
    // through the REAL OperationsService.applyRunState (D8-validated writes).
    runState: (workspaceId, runId) => {
      const operationId = operationIds.get(workspaceId);
      if (operationId === undefined) return null;
      try {
        return ops.getRun(workspaceId, operationId, runId).state;
      } catch {
        return null; // unknown run — the honest seam answer
      }
    },
    applyRunState: (workspaceId, runId, state) => {
      seamWrites.push({ run_id: runId, state });
      ops.applyRunState(workspaceId, operationIds.get(workspaceId)!, runId, state);
    },
  };

  const spawns: FakeTaskWorkerHandle[] = [];
  const stderrChunks: string[] = [];

  const supervisor = new TaskWorkerSupervisor({
    events,
    tx,
    taskWorkers: workersRepo,
    runControl,
    spawnChild: (request) => {
      const spec = options.spawnSpec ? options.spawnSpec(spawns.length) : {};
      const handle = spawnFakeTaskWorker({
        runId: request.run_id,
        workerId: request.worker_id,
        heartbeatMs: request.heartbeat_interval_ms,
        ...spec,
      });
      spawns.push(handle);
      const child: TaskWorkerChild = {
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
    stderrSink: { write: (chunk) => stderrChunks.push(chunk) },
    // ms-scale policies by default (tests may override per harness).
    policy: { ...WORKER_POLICY, ...(options.policy ?? {}) },
    ...(options.onWorkerReportedFailure
      ? { onWorkerReportedFailure: options.onWorkerReportedFailure }
      : {}),
  });

  const harness: WorkerHarness = {
    supervisor,
    conn,
    tx,
    journal,
    workersRepo,
    ops,
    runControl,
    operationIds,
    runSeq: { n: 0 },
    seamWrites,
    spawns,
    stderrChunks,
    dir,
  };
  openHarnesses.push(harness);
  return harness;
}

/** One operation per workspace (lazily created through the REAL service). */
function ensureOperation(harness: WorkerHarness, workspaceId: string): string {
  const existing = harness.operationIds.get(workspaceId);
  if (existing !== undefined) return existing;
  const created = harness.ops.createOperation(workspaceId, {
    definition_ref: null,
    name: `Worker Op ${workspaceId}`,
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  });
  harness.operationIds.set(workspaceId, created.operation_id);
  return created.operation_id;
}

/** Create one run through the REAL OperationsService (D8 CREATED state). */
function createRun(harness: WorkerHarness, workspaceId: string): string {
  const operationId = ensureOperation(harness, workspaceId);
  const runId = `run-${++harness.runSeq.n}`;
  harness.ops.createRun(workspaceId, operationId, { run_id: runId });
  return runId;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()!;
    try {
      await Promise.race([
        harness.supervisor.stopAll(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // A failed test may leave children wedged; force-reap below.
    }
    for (const handle of harness.spawns) {
      try {
        handle.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    try {
      harness.conn.close();
    } catch {
      // already closed
    }
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

describe("S16 chunk 1 — v8 migration (task_workers)", () => {
  it("records version 8 in the chain and creates the task_workers table", () => {
    const harness = makeHarness();
    expect(appliedMigrationVersions(harness.conn.db)).toContain(8);
    expect(sqliteTableExists(harness.conn.db, "task_workers")).toBe(true);
  });

  it("scopes rows by workspace (the same run_id/worker_id in two workspaces are independent rows, E12)", () => {
    const harness = makeHarness();
    const now = new Date().toISOString();
    const base = {
      worker_id: "wk-shared",
      pid: null,
      heartbeat_at: null,
      lease_expires_at: now,
      last_progress_json: null,
      started_at: now,
    };
    harness.workersRepo.insertWorker({
      ...base,
      workspace_id: WS,
      run_id: "run-shared",
      state: "starting",
    });
    harness.workersRepo.insertWorker({
      ...base,
      workspace_id: OTHER_WS,
      run_id: "run-shared",
      state: "starting",
    });
    expect(harness.workersRepo.getWorker(WS, "run-shared", "wk-shared")?.state).toBe("starting");
    expect(harness.workersRepo.getWorker(OTHER_WS, "run-shared", "wk-shared")?.state).toBe(
      "starting",
    );
  });

  it("rejects a state outside the worker vocabulary and a non-JSON progress blob", () => {
    const harness = makeHarness();
    const now = new Date().toISOString();
    const base = {
      workspace_id: WS,
      run_id: "run-check",
      worker_id: "wk-check",
      pid: null,
      heartbeat_at: null,
      lease_expires_at: now,
      started_at: now,
    };
    expect(() =>
      harness.workersRepo.insertWorker({
        ...base,
        state: "hibernating" as never,
        last_progress_json: null,
      }),
    ).toThrow();
    expect(() =>
      harness.workersRepo.insertWorker({ ...base, state: "starting", last_progress_json: "{oops" }),
    ).toThrow();
  });
});

describe("S16 chunk 1 — start, ready, one worker per run", () => {
  it("starts a worker on demand: ready → row running with pid, worker.started journaled on the run stream", async () => {
    const harness = makeHarness();
    const runA = createRun(harness, WS);

    const snapshot = expectRunning(await harness.supervisor.startWorker(WS, runA));
    expect(snapshot.run_id).toBe(runA);
    expect(snapshot.worker_id.length).toBeGreaterThan(0);
    expect(snapshot.pid).toBeGreaterThan(0);
    expect(snapshot.state).toBe("running");
    expect(harness.spawns.length).toBe(1);

    const liveRow = await until(() => {
      const row = harness.workersRepo.getWorker(WS, runA, snapshot.worker_id);
      return row?.state === "running" ? row : undefined;
    });
    expect(liveRow.pid).toBe(snapshot.pid);

    const stream = harness.journal.listStream(runA, WS);
    const started = stream.find((row) => row.event_type === "worker.started");
    expect(started).toBeDefined();
    const payload = JSON.parse(started!.payload) as {
      worker_id: string;
      pid: number;
      start_latency_ms: number;
    };
    expect(payload.worker_id).toBe(snapshot.worker_id);
    expect(payload.pid).toBe(snapshot.pid);
    expect(payload.start_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("coalesces a second startWorker for the same run onto the ONE live worker", async () => {
    const harness = makeHarness();
    const runA = createRun(harness, WS);

    const first = expectRunning(await harness.supervisor.startWorker(WS, runA));
    const second = expectRunning(await harness.supervisor.startWorker(WS, runA));
    expect(second.worker_id).toBe(first.worker_id);
    expect(harness.spawns.length).toBe(1);
  });

  it("refuses to spawn a worker for an unknown run (typed) and for a terminal run", async () => {
    const harness = makeHarness();
    const runA = createRun(harness, WS);

    await expect(harness.supervisor.startWorker(WS, "run-never-created")).rejects.toMatchObject({
      name: "TaskWorkerError",
      code: "WORKER_NOT_FOUND",
    });

    const worker = expectRunning(await harness.supervisor.startWorker(WS, runA));
    await until(() => {
      const row = harness.workersRepo.getWorker(WS, runA, worker.worker_id);
      return row?.state === "exited" ? row : undefined;
    });
    await expect(harness.supervisor.startWorker(WS, runA)).rejects.toMatchObject({
      name: "TaskWorkerError",
      code: "WORKER_RUN_TERMINAL",
    });
  });
});

describe("S16 chunk 1 — lease + durable progress (D10, D32)", () => {
  it("heartbeats renew the lease observably on the task_workers row", async () => {
    const harness = makeHarness();
    const runA = createRun(harness, WS);

    const snapshot = expectRunning(await harness.supervisor.startWorker(WS, runA));
    const initial = harness.workersRepo.getWorker(WS, runA, snapshot.worker_id)!;
    const initialLease = Date.parse(initial.lease_expires_at);

    const renewed = await until(() => {
      const row = harness.workersRepo.getWorker(WS, runA, snapshot.worker_id);
      if (row === null || row.heartbeat_at === null) return undefined;
      return Date.parse(row.lease_expires_at) > initialLease ? row : undefined;
    });
    expect(renewed.heartbeat_at).not.toBeNull();
  });

  it("persists every progress frame and checkpoint to the journal AND the row — never memory-only", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 4, stepDelayMs: 15, checkpointEvery: 2 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await until(() => {
      const rows = harness.workersRepo.listByRun(WS, runA);
      return rows.some((row) => row.state === "exited") ? rows : undefined;
    });

    const stream = harness.journal.listStream(runA, WS);
    const progress = stream.filter((row) => row.event_type === "worker.progress");
    const checkpoints = stream.filter((row) => row.event_type === "worker.checkpoint");
    expect(progress.map((row) => (JSON.parse(row.payload) as { percent: number }).percent)).toEqual(
      [25, 50, 75, 100],
    );
    expect(checkpoints.length).toBe(2);
    const stepIds = checkpoints.map(
      (row) => (JSON.parse(row.payload) as { checkpoint: { step_id: string } }).checkpoint.step_id,
    );
    expect(stepIds).toEqual(["step-2", "step-4"]);

    const exitedRow = harness.workersRepo
      .listByRun(WS, runA)
      .find((row) => row.state === "exited")!;
    const lastProgress = JSON.parse(exitedRow.last_progress_json!) as {
      percent: number;
      text: string;
    };
    expect(lastProgress.percent).toBe(100);
    expect(lastProgress.text).toBe("step 4 of 4");
  });

  it("completes: done → worker.completed, run SUCCEEDED, worker row exited", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 4, stepDelayMs: 15 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await until(() => {
      const rows = harness.workersRepo.listByRun(WS, runA);
      return rows.some((row) => row.state === "exited") ? rows : undefined;
    });

    const stream = harness.journal.listStream(runA, WS);
    const completed = stream.find((row) => row.event_type === "worker.completed");
    expect(completed).toBeDefined();
    expect((JSON.parse(completed!.payload) as { summary: string }).summary).toContain("4 steps");
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "SUCCEEDED" });
  });
});

describe("S16 chunk 1 — crash, stall, worker-reported error (D32 recovery posture)", () => {
  it("worker crash (exit 137): worker.crashed journaled, run RECOVERY_REQUIRED, state + last progress survive", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 3, stepDelayMs: 15, crashOnStep: 2 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    const crashed = await until(() => {
      return harness.journal
        .listStream(runA, WS)
        .find((row) => row.event_type === "worker.crashed");
    });

    const payload = JSON.parse(crashed.payload) as {
      cause: string;
      exit_code: number | null;
      last_percent: number | null;
    };
    expect(payload.cause).toBe("unexpected_exit");
    expect(payload.exit_code).toBe(137);
    expect(payload.last_percent).toBe(33);

    // The run is NOT silently lost: a defined non-terminal state + durable progress.
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
    const rows = harness.workersRepo.listByRun(WS, runA);
    expect(rows.some((row) => row.state === "exited")).toBe(true);
    expect(rows.some((row) => row.last_progress_json !== null)).toBe(true);
  });

  it("silence past the missed-heartbeat window escalates (row killed, cause hang, RECOVERY_REQUIRED)", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 5, stepDelayMs: 200, hangAfterStep: 0 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    const crashed = await until(() => {
      return harness.journal
        .listStream(runA, WS)
        .find((row) => row.event_type === "worker.crashed");
    });

    expect((JSON.parse(crashed.payload) as { cause: string }).cause).toBe("hang");
    expect(harness.workersRepo.listByRun(WS, runA).some((row) => row.state === "killed")).toBe(
      true,
    );
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
  });

  it("a slow-but-heartbeating worker is NEVER killed by the stall watchdog (stalled ≠ slow)", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 2, stepDelayMs: 30, slowTtftMs: 400 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await until(() => {
      const rows = harness.workersRepo.listByRun(WS, runA);
      return rows.some((row) => row.state === "exited") ? rows : undefined;
    }, 8000);

    const stream = harness.journal.listStream(runA, WS);
    expect(stream.some((row) => row.event_type === "worker.crashed")).toBe(false);
    expect(stream.some((row) => row.event_type === "worker.completed")).toBe(true);
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "SUCCEEDED" });
  });

  it("a worker-reported error frame is journaled with its failure class and escalates", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({
        steps: 3,
        stepDelayMs: 15,
        errorOnStep: 1,
        errorClass: "provider_unavailable",
      }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    const crashed = await until(() => {
      return harness.journal
        .listStream(runA, WS)
        .find((row) => row.event_type === "worker.crashed");
    });

    const payload = JSON.parse(crashed.payload) as { cause: string; error_class: string | null };
    expect(payload.cause).toBe("worker_error");
    expect(payload.error_class).toBe("provider_unavailable");
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
  });
});

/**
 * S22 — the runtime-owned FAILURE POLICY seam (PRD §8, AC14, AC10, E27
 * unchanged elsewhere): a worker-REPORTED error (the failure_class frame) is
 * a classified failure the retry policy owns. When the seam is wired, the
 * escalation still runs to completion (the process is reaped, the crash
 * event committed — the E27 aftermath discipline) but the RUN-STATE decision
 * belongs to the policy: the supervisor hands over (workspace, run, failure
 * class, crash event id) and does NOT write RECOVERY_REQUIRED itself. A
 * policy that throws falls back to the recovery write — a failure is never
 * silently dropped (G5). Crashes/hangs/protocol violations NEVER route here.
 */
describe("S22 — the worker-failure decision seam (runtime-owned retry policy)", () => {
  it("routes a worker-reported error to the wired policy (no RECOVERY_REQUIRED write)", async () => {
    const reports: Array<{
      workspaceId: string;
      runId: string;
      workerId: string;
      failureClass: string;
      failureEventId: string | null;
    }> = [];
    const harness = makeHarness({
      spawnSpec: () => ({
        steps: 3,
        stepDelayMs: 15,
        errorOnStep: 1,
        errorClass: "TOOL_EXECUTION_TIMEOUT",
      }),
      onWorkerReportedFailure: (info) => {
        reports.push(info);
        // The policy owns the run state: simulate the retry coordinator's
        // RETRYING decision through the same seam.
        harness.runControl.applyRunState(info.workspaceId, info.runId, "RETRYING");
      },
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    const crashed = await until(() => {
      return harness.journal
        .listStream(runA, WS)
        .find((row) => row.event_type === "worker.crashed");
    });

    // The escalation completed BEFORE the policy was consulted (the crash
    // event is the aftermath-completion marker), and the report carries the
    // failure class and the crash event id (the failure_event_id reference).
    const payload = JSON.parse(crashed.payload) as { cause: string; error_class: string | null };
    expect(payload.cause).toBe("worker_error");
    expect(payload.error_class).toBe("TOOL_EXECUTION_TIMEOUT");
    await until(() => (reports.length > 0 ? reports : undefined));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      workspaceId: WS,
      runId: runA,
      failureClass: "TOOL_EXECUTION_TIMEOUT",
    });
    expect(reports[0]!.failureEventId).toBe(crashed.event_id);
    // The POLICY's write is the only run-state write — no RECOVERY_REQUIRED.
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RETRYING" });
    expect(harness.seamWrites).not.toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
  });

  it("a throwing policy falls back to the recovery write (a failure is never dropped)", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({
        steps: 3,
        stepDelayMs: 15,
        errorOnStep: 1,
        errorClass: "TOOL_EXECUTION_TIMEOUT",
      }),
      onWorkerReportedFailure: () => {
        throw new Error("policy exploded");
      },
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await until(() => {
      return harness.journal.listStream(runA, WS).find((row) => row.event_type === "worker.crashed");
    });
    await until(() =>
      harness.seamWrites.some((write) => write.state === "RECOVERY_REQUIRED"),
    );
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
  });

  it("a CRASH exit never routes through the policy (E27 recovery posture unchanged)", async () => {
    const reports: Array<{ failureClass: string }> = [];
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 3, stepDelayMs: 15, crashOnStep: 2 }),
      onWorkerReportedFailure: (info) => {
        reports.push({ failureClass: info.failureClass });
      },
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await until(() => {
      return harness.journal.listStream(runA, WS).find((row) => row.event_type === "worker.crashed");
    });
    await until(() =>
      harness.seamWrites.some((write) => write.state === "RECOVERY_REQUIRED"),
    );
    expect(reports).toHaveLength(0);
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
  });
});

describe("S16 chunk 1 — stops (graceful escalation, D32: governed by the task)", () => {
  it("stopWorker escalates, records worker.stopped, and leaves the run state to the caller", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 50, stepDelayMs: 50 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await harness.supervisor.stopWorker(WS, runA);

    expect(harness.workersRepo.listByRun(WS, runA).some((row) => row.state === "killed")).toBe(
      true,
    );
    const stream = harness.journal.listStream(runA, WS);
    const stopped = stream.find((row) => row.event_type === "worker.stopped");
    expect(stopped).toBeDefined();
    expect((JSON.parse(stopped!.payload) as { reason: string }).reason).toBe("requested");
    expect(harness.seamWrites).toEqual([]); // the run flow owns run state (chunk 3 wires it)
  });

  it("stopping an unknown run is a typed no-op; stopAll reaps every live worker", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 50, stepDelayMs: 50 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    await expect(harness.supervisor.stopWorker(WS, "run-never-created")).resolves.toBeUndefined();

    await harness.supervisor.startWorker(WS, runA);
    await harness.supervisor.startWorker(WS, runB);
    await harness.supervisor.stopAll();

    expect(harness.workersRepo.listByRun(WS, runA).some((row) => row.state === "killed")).toBe(
      true,
    );
    expect(harness.workersRepo.listByRun(WS, runB).some((row) => row.state === "killed")).toBe(
      true,
    );
    for (const handle of harness.spawns) {
      const exit = await handle.waitForExit();
      expect(exit.code !== null || exit.signal !== null).toBe(true);
    }
  });
});

describe("S16 chunk 1 — AC25: session hibernation never stops the run's worker", () => {
  it("hibernating the Agent's session leaves the worker running to completion", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 3, stepDelayMs: 60 }),
    });
    const runA = createRun(harness, WS);

    // The SAME journal composition: session events + worker events share it.
    const session = new SessionSupervisor({
      events: new EventsService(harness.journal, harness.tx),
      spawnChild: (request) => {
        const handle = spawnFakePi({
          sessionId: request.session_id,
          heartbeatMs: 20,
          tokens: 1,
          tokenDelayMs: 5,
        });
        const child: SessionChild = {
          onLine: (listener) => handle.onFrame((entry) => listener(entry.line)),
          onStderr: () => () => {},
          send: (frame) => handle.send(frame),
          kill: (signal) => handle.kill(signal ?? "SIGKILL"),
          waitForExit: () => handle.waitForExit(),
        };
        return child;
      },
      contextProvider: (workspaceId, agentId) => ({
        workspace_id: workspaceId,
        agent_id: agentId,
        display_name: "Worker Test Agent",
        instructions: null,
        pack_profile: null,
      }),
      policy: {
        // ms-scale: the session idles into hibernation almost immediately.
        idleHibernateMs: 60,
        heartbeatIntervalMs: 40,
        missedHeartbeatLimit: 2,
        handshakeTimeoutMs: 1_000,
        shutdownGraceMs: 100,
        killGraceMs: 100,
      },
    });

    // The worker starts FIRST and the session then idles into hibernation
    // WHILE the worker runs — the AC25 shape: the user's session dies away
    // (browser closure idles the chat) and the healthy worker must keep
    // running to completion untouched (D32 rule: a running worker is never
    // stopped by the session idle timer). No worker.* stop/crash may appear
    // from the session side.
    await harness.supervisor.startWorker(WS, runA);
    await session.ensureStarted(WS, AGENT);
    await until(() => {
      return harness.journal
        .listStream(sessionStreamFor(WS, AGENT), WS)
        .find((row) => row.event_type === "session.hibernate");
    }, 8000);
    await until(() => {
      const rows = harness.workersRepo.listByRun(WS, runA);
      return rows.some((row) => row.state === "exited") ? rows : undefined;
    }, 8000);

    const workerStream = harness.journal.listStream(runA, WS);
    expect(workerStream.some((row) => row.event_type === "worker.completed")).toBe(true);
    expect(workerStream.some((row) => row.event_type === "worker.crashed")).toBe(false);
    expect(workerStream.some((row) => row.event_type === "worker.stopped")).toBe(false);
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "SUCCEEDED" });

    await session.stopAll();
  });
});
