/**
 * Admission control tests (S16 chunk 2) — red-first suite for E1.
 *
 * Covers the admission gate in front of TaskWorkerSupervisor.startWorker:
 * when a resource limit is reached the RUN becomes QUEUED (D8 vocabulary)
 * with a MACHINE-READABLE reason ({code, limit, current} + human text)
 * recorded durably — a `worker.queued` journal event on the run stream AND
 * the run row state through the seam — and a bounded internal dequeue
 * re-admits queued runs oldest-first as capacity frees. The limits are:
 * maxConcurrentWorkers (process count over LIVE worker rows),
 * maxWorkerMemoryBytes / maxTotalWorkersMemoryBytes (per-worker / summed),
 * minFreeDiskBytes (free-space probe), maxConcurrentRunsPerProvider
 * (provider taken from the run spec's provider snapshot).
 *
 * Kernel enforcement (the AC's REAL-limits demand) is proven with prlimit(1)
 * exec'd as a binary (no shell): `--as` denies a memory-hoarding fake worker
 * (allocation fails → nonzero exit → worker.crashed → RECOVERY_REQUIRED),
 * `--nproc` denies process creation, and a generous limit leaves a normal
 * worker untouched. Missing prlimit binary is a typed startup failure (G4).
 *
 * Pressure + session coordination (D32 layering): under pressure an idle
 * Agent session may hibernate IMMEDIATELY (chunk-1 guidance) through
 * SessionSupervisor.hibernateIdleSessionsNow("resource_pressure") — and the
 * never-kill guarantee holds: reaching a limit never touches running workers
 * or their leases; only new work queues.
 *
 * Governing records: E1, D27, D32, D10, D8.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawnFakePi } from "@shera-bot/pi-protocol";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { PackAgentSeed } from "../../adapters/sqlite/agents-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import {
  SessionSupervisor,
  type SessionChild,
  type SessionSupervisorPolicy,
} from "../sessions/session-supervisor.service.ts";
import { sessionStreamFor } from "../sessions/sessions.events.ts";
import {
  FAKE_TASK_WORKER_CHILD_SCRIPT,
  fakeWorkerArgs,
  spawnFakeTaskWorker,
  type SpawnFakeTaskWorkerOptions,
} from "./fake-task-worker.ts";
import {
  TaskWorkerAdmissionGate,
  AdmissionPolicyError,
  type AdmissionGate,
  type AdmissionPolicy,
} from "./admission.ts";
import {
  PrlimitUnavailableError,
  resolvePrlimitBinary,
  spawnTaskWorkerChild,
} from "./worker-process-spawn.ts";
import {
  TaskWorkerSupervisor,
  type TaskRunOperationsSeam,
  type TaskWorkerChild,
  type TaskWorkerSnapshot,
  type TaskWorkerSpawnRequest,
  type TaskWorkerStartResult,
  type TaskWorkerSupervisorPolicy,
} from "./task-worker-supervisor.service.ts";

const WS = "ws-admission";
const AGENT = "agent_admission_test";

/** Narrow an admitted start (E1 widened the result with the QUEUED outcome). */
function expectRunning(result: TaskWorkerStartResult): TaskWorkerSnapshot {
  if (result.state !== "running") {
    throw new Error(`expected a running worker, got a ${result.state} result`);
  }
  return result;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * ms-scale worker policy with a WIDE stall window for kernel-limit tests
 * (50 ms × 60 = 3 s): these children all beat or exit on their own, and the
 * suite's own hoarding test (plus sibling vitest workers) can transiently
 * starve an event loop for seconds — a false stall would land a healthy run
 * in RECOVERY_REQUIRED and its completion wait would time out (observed on
 * loaded machines at tighter windows). No test here depends on stall
 * DETECTION timing; the dedicated watchdog suite owns it. The one test that
 * needs an even wider window (the --as hoard, whose allocation blocks the
 * child's loop) overrides this further below.
 */
const WORKER_POLICY: Partial<TaskWorkerSupervisorPolicy> = {
  heartbeatIntervalMs: 50,
  missedHeartbeatLimit: 60,
  leaseWindowMs: 1_000,
  handshakeTimeoutMs: 10_000,
  shutdownGraceMs: 150,
  killGraceMs: 150,
  stderrMaxBytes: 8_192,
};

const SESSION_POLICY: Partial<SessionSupervisorPolicy> = {
  // The natural idle tick must NOT hibernate inside the pressure test — the
  // hibernation under test is the explicit pressure hibernation.
  idleHibernateMs: 3_600_000,
  heartbeatIntervalMs: 50,
  missedHeartbeatLimit: 10,
  handshakeTimeoutMs: 5_000,
  shutdownGraceMs: 150,
  killGraceMs: 150,
};

const FAKE_SEED: PackAgentSeed = {
  agent_id: AGENT,
  display_name: "Admission Test Agent",
  role_description: "runs supervised work under admission control",
  default_provider: { provider_id: "fake", model: "fake-model" },
  skills: ["skill_worker_core"],
  tools: [{ tool_id: "tool_shell", version: "1.0.0" }],
  connectors: [],
  ui_identity: { avatar_hue: 11, initial_glyph: "A" },
  home_operation_id: null,
};

interface AdmissionHarness {
  supervisor: TaskWorkerSupervisor;
  gate: AdmissionGate | null;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  workersRepo: TaskWorkersRepository;
  ops: OperationsService;
  runControl: TaskRunOperationsSeam;
  operationIds: Map<string, string>;
  runSeq: { n: number };
  seamWrites: Array<{ run_id: string; state: string }>;
  /** Fake-spawn handles (fake mode only). */
  spawns: FakeWorkerSpawn[];
  /** Every spawn request the supervisor issued, in order. */
  spawnRequests: TaskWorkerSpawnRequest[];
  stderrChunks: string[];
  dir: string;
}

interface FakeWorkerSpawn {
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<{ code: number | null; signal: string | null }>;
}

interface HarnessOptions {
  /** Build the admission gate from this policy (injected probe support). */
  admissionPolicy?: AdmissionPolicy;
  /** Injected free-disk probe for the gate (machine-readable pressure tests). */
  probeFreeDiskBytes?: () => number | null;
  /** Route spawns through the prlimit adapter (kernel enforcement tests). */
  spawnMode?: "fake" | "prlimit";
  spawnSpec?: (spawnIndex: number) => SpawnFakeTaskWorkerOptions;
  policy?: Partial<TaskWorkerSupervisorPolicy>;
}

const openHarnesses: AdmissionHarness[] = [];

/**
 * An upper bound on the machine's current task count (processes + threads).
 * RLIMIT_NPROC is enforced per real user id, so a GENEROUS --nproc cap must
 * sit above the live total or the capped worker dies at boot (its own
 * thread creation denied) — this keeps the "generous limit" tests honest
 * and machine-independent.
 */
function totalTaskUpperBound(): number {
  try {
    let count = 0;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      count += 1;
      try {
        count += readdirSync(join("/proc", entry, "task")).length;
      } catch {
        // the process vanished between the two reads
      }
    }
    return count;
  } catch {
    return 4_096; // non-procfs fallback; still generous on any dev box
  }
}

const NPROC_GENEROUS = totalTaskUpperBound() + 1_024;

function makeHarness(options: HarnessOptions = {}): AdmissionHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s16-admission-"));
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
      pack_id: "pack_admission_test",
      pack_version: "1.0.0",
      agents: [FAKE_SEED],
      locateAgentPack: (agentId) => (agentId === AGENT ? "pack_admission_test" : null),
      skills: [],
      connectors: [],
    },
  });

  const operationIds = new Map<string, string>();
  const seamWrites: Array<{ run_id: string; state: string }> = [];
  const runControl: TaskRunOperationsSeam = {
    runState: (workspaceId, runId) => {
      const operationId = operationIds.get(workspaceId);
      if (operationId === undefined) return null;
      try {
        return ops.getRun(workspaceId, operationId, runId).state;
      } catch {
        return null;
      }
    },
    applyRunState: (workspaceId, runId, state) => {
      seamWrites.push({ run_id: runId, state });
      ops.applyRunState(workspaceId, operationIds.get(workspaceId)!, runId, state);
    },
  };

  const spawns: FakeWorkerSpawn[] = [];
  const spawnRequests: TaskWorkerSpawnRequest[] = [];
  const stderrChunks: string[] = [];

  let gate: AdmissionGate | null = null;
  let supervisorRef: TaskWorkerSupervisor | null = null;
  if (options.admissionPolicy !== undefined) {
    gate = new TaskWorkerAdmissionGate(
      options.admissionPolicy,
      {
        liveWorkerCount: () => workersRepo.listLiveAll().length,
        // Per-provider counting is the supervisor's in-process spec knowledge,
        // reached through the same public read model composition roots use.
        liveWorkerCountForProvider: (providerId) =>
          supervisorRef?.liveWorkerCountByProvider(providerId) ?? 0,
      },
      {
        probeFreeDiskBytes: options.probeFreeDiskBytes,
        dataDir: options.probeFreeDiskBytes === undefined ? tmpdir() : undefined,
      },
    );
  }

  const supervisor = new TaskWorkerSupervisor({
    events,
    tx,
    taskWorkers: workersRepo,
    runControl,
    admission: gate ?? undefined,
    spawnChild: (request) => {
      spawnRequests.push(request);
      const spec = options.spawnSpec ? options.spawnSpec(spawns.length) : {};
      if (options.spawnMode === "prlimit") {
        // The PRODUCTION spawn path: the adapter wraps the worker command in
        // prlimit(1) using the resource limits the supervisor attached to the
        // spawn request. No shell — prlimit is exec'd as a binary.
        const child = spawnTaskWorkerChild(request, {
          file: process.execPath,
          args: [
            FAKE_TASK_WORKER_CHILD_SCRIPT,
            ...fakeWorkerArgs({
              runId: request.run_id,
              workerId: request.worker_id,
              heartbeatMs: request.heartbeat_interval_ms,
              ...spec,
            }),
          ],
        });
        spawns.push(child);
        return child;
      }
      // The chunk-1 fake path (no kernel limits — the fake ignores the
      // request's resourceLimits; the enforcement tests use prlimit mode).
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
    policy: { ...WORKER_POLICY, ...(options.policy ?? {}) },
  });
  supervisorRef = supervisor;

  const harness: AdmissionHarness = {
    supervisor,
    gate,
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
    spawnRequests,
    stderrChunks,
    dir,
  };
  openHarnesses.push(harness);
  return harness;
}

function ensureOperation(harness: AdmissionHarness, workspaceId: string): string {
  const existing = operationIdOf(harness, workspaceId);
  if (existing !== undefined) return existing;
  const created = harness.ops.createOperation(workspaceId, {
    definition_ref: null,
    name: `Admission Op ${workspaceId}`,
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  });
  harness.operationIds.set(workspaceId, created.operation_id);
  return created.operation_id;
}

function operationIdOf(harness: AdmissionHarness, workspaceId: string): string | undefined {
  return harness.operationIds.get(workspaceId);
}

function createRun(harness: AdmissionHarness, workspaceId: string): string {
  const operationId = ensureOperation(harness, workspaceId);
  const runId = `run-${++harness.runSeq.n}`;
  harness.ops.createRun(workspaceId, operationId, { run_id: runId });
  return runId;
}

function queuedEventsOf(
  harness: AdmissionHarness,
  runId: string,
): Array<{
  reason: { code: string; limit: number | null; current: number | null };
  message: string;
}> {
  return harness.journal
    .listStream(runId, WS)
    .filter((row) => row.event_type === "worker.queued")
    .map(
      (row) =>
        JSON.parse(row.payload) as {
          reason: { code: string; limit: number | null; current: number | null };
          message: string;
        },
    );
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()!;
    try {
      await Promise.race([
        harness.supervisor.stopAll(),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    } catch {
      // A failed test may leave children wedged; force-reap below.
    }
    for (const child of harness.spawns) {
      try {
        child.kill("SIGKILL");
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

// ── E1: admission policy validation (G4 honesty at startup) ──────────────────

describe("S16 chunk 2 — admission policy validation (G4)", () => {
  it("rejects garbage limits with a typed error naming the offending field", () => {
    const base: AdmissionPolicy = {
      maxConcurrentWorkers: 2,
      maxWorkerMemoryBytes: 2 * GB,
      maxTotalWorkersMemoryBytes: 4 * GB,
      minFreeDiskBytes: 0,
      maxConcurrentRunsPerProvider: 2,
      maxWorkerProcesses: 64,
    };
    const cases: Array<Partial<AdmissionPolicy>> = [
      { maxConcurrentWorkers: 0 },
      { maxConcurrentWorkers: -1 },
      { maxWorkerMemoryBytes: 0 },
      { maxWorkerMemoryBytes: 1.5 },
      { maxTotalWorkersMemoryBytes: 1 * GB }, // < one worker's own limit
      { minFreeDiskBytes: -5 },
      { maxConcurrentRunsPerProvider: 0 },
      { maxWorkerProcesses: 0 },
    ];
    for (const override of cases) {
      expect(
        () => new TaskWorkerAdmissionGate({ ...base, ...override }, { liveWorkerCount: () => 0 }),
      ).toThrowError(AdmissionPolicyError);
    }
    // The error names the field.
    expect(
      () =>
        new TaskWorkerAdmissionGate(
          { ...base, maxConcurrentWorkers: 0 },
          { liveWorkerCount: () => 0 },
        ),
    ).toThrowError(/maxConcurrentWorkers/);
  });

  it("demands a way to measure the disk floor (dataDir or probe) — never a silent no-op check", () => {
    const policy: AdmissionPolicy = {
      maxConcurrentWorkers: 2,
      maxWorkerMemoryBytes: 2 * GB,
      maxTotalWorkersMemoryBytes: 4 * GB,
      minFreeDiskBytes: 1 * GB,
      maxConcurrentRunsPerProvider: 2,
      maxWorkerProcesses: 64,
    };
    expect(() => new TaskWorkerAdmissionGate(policy, { liveWorkerCount: () => 0 })).toThrowError(
      AdmissionPolicyError,
    );
    // A real default probe resolves the prlimit-adjacent honesty: the default
    // probe over a dataDir works without an injected probe.
    expect(
      () =>
        new TaskWorkerAdmissionGate(policy, { liveWorkerCount: () => 0 }, { dataDir: tmpdir() }),
    ).not.toThrow();
  });

  it("resolvePrlimitBinary finds the binary; missing candidates fail typed naming the binary (G4)", () => {
    const resolved = resolvePrlimitBinary();
    expect(existsSync(resolved)).toBe(true);
    expect(resolved.endsWith("prlimit")).toBe(true);

    expect(() => resolvePrlimitBinary(["/nonexistent/dir/prlimit"])).toThrowError(
      PrlimitUnavailableError,
    );
    expect(() => resolvePrlimitBinary(["/nonexistent/dir/prlimit"])).toThrowError(/prlimit/);
  });
});

// ── E1: limit reached → QUEUED with a machine-readable reason ────────────────

describe("S16 chunk 2 — limit reached → QUEUED (D8) with a machine-readable reason", () => {
  it("worker_limit_reached: the run becomes QUEUED, the reason is durable (journal + seam), no worker row, no spawn", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 4 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 30, stepDelayMs: 40 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    const snapshotA = await harness.supervisor.startWorker(WS, runA);
    expect(snapshotA.state).toBe("running");
    expect(harness.spawns.length).toBe(1);

    const resultB = await harness.supervisor.startWorker(WS, runB);
    expect(resultB.state).toBe("queued");
    if (resultB.state !== "queued") return;
    expect(resultB.reason.code).toBe("worker_limit_reached");
    expect(resultB.reason.limit).toBe(1);
    expect(resultB.reason.current).toBe(1);
    expect(resultB.message.length).toBeGreaterThan(0);

    // Durable: the run row is QUEUED through the seam...
    expect(harness.runControl.runState(WS, runB)).toBe("QUEUED");
    expect(harness.seamWrites).toContainEqual({ run_id: runB, state: "QUEUED" });
    // ...and the journal carries the machine-readable reason on the run stream.
    const queued = queuedEventsOf(harness, runB);
    expect(queued.length).toBe(1);
    expect(queued[0]!.reason).toEqual({ code: "worker_limit_reached", limit: 1, current: 1 });

    // Nothing was spawned or inserted for the queued run.
    expect(harness.spawns.length).toBe(1);
    expect(harness.workersRepo.listByRun(WS, runB)).toEqual([]);
    expect(harness.supervisor.presenceState(WS, runB)).toBe("none");

    // A retry of the same queued run does NOT duplicate the durable event.
    const again = await harness.supervisor.startWorker(WS, runB);
    expect(again.state).toBe("queued");
    expect(queuedEventsOf(harness, runB).length).toBe(1);
  });

  it("memory_limit: the summed live-worker memory reaching the total cap denies admission", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 10,
        maxWorkerMemoryBytes: 1 * GB,
        maxTotalWorkersMemoryBytes: Math.floor(1.5 * GB),
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 30, stepDelayMs: 40 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    const resultB = await harness.supervisor.startWorker(WS, runB);
    expect(resultB.state).toBe("queued");
    if (resultB.state !== "queued") return;
    expect(resultB.reason.code).toBe("memory_limit");
    expect(resultB.reason.limit).toBe(Math.floor(1.5 * GB));
    // Current usage: ONE live worker at its per-worker limit.
    expect(resultB.reason.current).toBe(1 * GB);
    expect(harness.runControl.runState(WS, runB)).toBe("QUEUED");
  });

  it("provider_concurrency: counts live workers PER PROVIDER from the spec's provider snapshot", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 10,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 20 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 1,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 30, stepDelayMs: 40 }),
    });
    // The provider snapshot placeholder arrives on the run's worker spec.
    const specA = { providerSnapshot: { provider_id: "prov-a", model: "model-a" } };
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);
    const runC = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA, specA);
    const resultB = await harness.supervisor.startWorker(WS, runB, specA);
    expect(resultB.state).toBe("queued");
    if (resultB.state !== "queued") return;
    expect(resultB.reason.code).toBe("provider_concurrency");
    expect(resultB.reason.limit).toBe(1);
    expect(resultB.reason.current).toBe(1);

    // A DIFFERENT provider still admits: the counting is per provider.
    const resultC = await harness.supervisor.startWorker(WS, runC, {
      providerSnapshot: { provider_id: "prov-b", model: "model-b" },
    });
    expect(resultC.state).toBe("running");
    expect(harness.spawns.length).toBe(2);
  });

  it("disk_pressure: the free-disk probe gates admission with limit/current in the reason", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 10,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 20 * GB,
        minFreeDiskBytes: 1 * GB,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      probeFreeDiskBytes: () => 512 * MB,
    });
    const runA = createRun(harness, WS);

    const resultA = await harness.supervisor.startWorker(WS, runA);
    expect(resultA.state).toBe("queued");
    if (resultA.state !== "queued") return;
    expect(resultA.reason.code).toBe("disk_pressure");
    expect(resultA.reason.limit).toBe(1 * GB);
    expect(resultA.reason.current).toBe(512 * MB);
    expect(harness.runControl.runState(WS, runA)).toBe("QUEUED");

    // Above the floor the same probe admits (the gate is a real comparison).
    const freeGate = new TaskWorkerAdmissionGate(
      {
        maxConcurrentWorkers: 10,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 20 * GB,
        minFreeDiskBytes: 1 * GB,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      { liveWorkerCount: () => 0 },
      { probeFreeDiskBytes: () => 2 * GB },
    );
    const decision = freeGate.check({ providerId: null });
    expect(decision.admitted).toBe(true);
  });
});

// ── E1: bounded internal dequeue (oldest-first re-admission) ─────────────────

describe("S16 chunk 2 — dequeue: oldest-first re-admission as capacity frees", () => {
  it("queued runs re-admit oldest-first on capacity-free events; later runs wait their turn", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 4 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 100, stepDelayMs: 200 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);
    const runC = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await harness.supervisor.startWorker(WS, runB);
    await harness.supervisor.startWorker(WS, runC);
    expect(harness.spawns.length).toBe(1);
    expect(harness.supervisor.admissionPressure().queuedRuns).toBe(2);

    // Freeing capacity admits B (oldest first) and keeps C queued.
    await harness.supervisor.stopWorker(WS, runA, "requested");
    const startedB = await until(() => {
      const event = harness.journal
        .listStream(runB, WS)
        .find((row) => row.event_type === "worker.started");
      return event ?? undefined;
    });
    expect(startedB).toBeDefined();
    expect(harness.supervisor.admissionPressure().queuedRuns).toBe(1);
    expect(harness.supervisor.presenceState(WS, runC)).toBe("none");
    expect(harness.spawns.length).toBe(2);

    // C carries no worker.started yet — it waits behind B.
    expect(
      harness.journal.listStream(runC, WS).some((row) => row.event_type === "worker.started"),
    ).toBe(false);

    // B's capacity frees → C re-admits AFTER B's started evidence. (The
    // per-run streams each own their gapless cursor — cross-stream order is
    // asserted through the spawn-request order, not event sequences.)
    await harness.supervisor.stopWorker(WS, runB, "requested");
    await until(() => {
      const event = harness.journal
        .listStream(runC, WS)
        .find((row) => row.event_type === "worker.started");
      return event ?? undefined;
    });
    const workerIdB = (
      JSON.parse(
        harness.journal.listStream(runB, WS).find((row) => row.event_type === "worker.started")!
          .payload,
      ) as { worker_id: string }
    ).worker_id;
    const workerIdC = (
      JSON.parse(
        harness.journal.listStream(runC, WS).find((row) => row.event_type === "worker.started")!
          .payload,
      ) as { worker_id: string }
    ).worker_id;
    const idxB = harness.spawnRequests.findIndex((request) => request.worker_id === workerIdB);
    const idxC = harness.spawnRequests.findIndex((request) => request.worker_id === workerIdC);
    expect(idxC).toBeGreaterThan(idxB);
    expect(harness.spawns.length).toBe(3);
  });

  it("the dequeue passes the ORIGINAL spec back (resource limits + provider snapshot) and drops terminal runs", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerMemoryBytes: 1 * GB,
        maxTotalWorkersMemoryBytes: 2 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 100, stepDelayMs: 200 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA, {
      providerSnapshot: { provider_id: "prov-x", model: "m" },
    });
    await harness.supervisor.startWorker(WS, runB, {
      providerSnapshot: { provider_id: "prov-x", model: "m" },
    });

    // Cancel B while it is queued; then free capacity — the dequeue must drop
    // the terminal run (never resurrect a cancelled run, never spawn for it).
    harness.ops.applyRunState(WS, harness.operationIds.get(WS)!, runB, "CANCELLED");
    await harness.supervisor.stopWorker(WS, runA, "requested");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(harness.supervisor.presenceState(WS, runB)).toBe("none");
    expect(harness.spawns.length).toBe(1); // only A ever spawned
    expect(harness.runControl.runState(WS, runB)).toBe("CANCELLED");
    // The re-pump did not resurrect it through a start failure either.
    expect(
      harness.journal.listStream(runB, WS).some((row) => row.event_type === "worker.started"),
    ).toBe(false);
  });
});

// ── E1: REAL kernel enforcement via prlimit (no shell) ───────────────────────

describe("S16 chunk 2 — kernel enforcement: prlimit --as / --nproc on the spawn path", () => {
  it("attaches per-worker resource limits from the admission policy to every spawn request", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 4,
        maxWorkerMemoryBytes: 1 * GB,
        maxTotalWorkersMemoryBytes: 4 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 64,
      },
      spawnSpec: () => ({ steps: 30, stepDelayMs: 40 }),
    });
    const runA = createRun(harness, WS);
    await harness.supervisor.startWorker(WS, runA);
    expect(harness.spawnRequests.length).toBe(1);
    expect(harness.spawnRequests[0]!.resourceLimits).toEqual({
      memoryBytes: 1 * GB,
      maxProcesses: 64,
    });
  });

  it("--as denies a memory-hoarding worker: allocation fails, crash recorded, run RECOVERY_REQUIRED", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 4,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 8 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: NPROC_GENEROUS,
      },
      spawnMode: "prlimit",
      spawnSpec: () => ({ steps: 2, stepDelayMs: 20, allocateMb: 4096 }),
      // TEST-LOCAL RACE FIX (kernel timing, no supervisor change): the hoard
      // blocks the child's event loop, so no heartbeats flow while it fills
      // ~2 GB of address space before the kernel denial lands. The suite's
      // ms-scale watchdog window (50 ms x 20 = 1 s) can expire first on a
      // loaded machine — the full-suite run saw the STALL watchdog win with
      // cause "hang" instead of the kernel exit. Widening ONLY this test's
      // window to 10 s gives the wall-clock-bound allocation room to lose to
      // the KERNEL (exit(1) → "unexpected_exit") on any ordinary host, which
      // is the behavior under test.
      policy: { missedHeartbeatLimit: 200 },
    });
    const runA = createRun(harness, WS);

    // The handshake completes (2GB of address space boots the worker fine);
    // the allocation loop then hits the kernel cap.
    await harness.supervisor.startWorker(WS, runA);
    const crashed = await until(() => {
      return harness.journal
        .listStream(runA, WS)
        .find((row) => row.event_type === "worker.crashed");
    }, 15_000);

    const payload = JSON.parse(crashed.payload) as {
      cause: string;
      exit_code: number | null;
      signal: string | null;
    };
    expect(payload.cause).toBe("unexpected_exit");
    expect(payload.exit_code === null || payload.exit_code !== 0).toBe(true);

    // Defined aftermath: row terminal, run RECOVERY_REQUIRED, diagnostic on
    // the bounded stderr sink (G3: diagnostic, never journaled raw).
    expect(harness.workersRepo.listByRun(WS, runA).some((row) => row.state === "exited")).toBe(
      true,
    );
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
    await until(() =>
      harness.stderrChunks.join("").includes("allocation_failed") ? true : undefined,
    );
  });

  it("a generous --as leaves a normal worker untouched (completes, SUCCEEDED)", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 4,
        maxWorkerMemoryBytes: 4 * GB,
        maxTotalWorkersMemoryBytes: 16 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: NPROC_GENEROUS,
      },
      spawnMode: "prlimit",
      spawnSpec: () => ({ steps: 3, stepDelayMs: 15, allocateMb: 64 }),
    });
    const runA = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA);
    await until(() => {
      const rows = harness.workersRepo.listByRun(WS, runA);
      return rows.some((row) => row.state === "exited") ? rows : undefined;
    }, 15_000);

    const stream = harness.journal.listStream(runA, WS);
    expect(stream.some((row) => row.event_type === "worker.completed")).toBe(true);
    expect(stream.some((row) => row.event_type === "worker.crashed")).toBe(false);
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "SUCCEEDED" });
  });

  it("--nproc denies process creation: the capped worker dies before ready, crash recorded", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 4,
        maxWorkerMemoryBytes: 4 * GB,
        maxTotalWorkersMemoryBytes: 16 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 1, // the kernel denies ANY process/thread creation
      },
      spawnMode: "prlimit",
      spawnSpec: () => ({ steps: 3, stepDelayMs: 15, forkChildren: 3 }),
    });
    const runA = createRun(harness, WS);

    await expect(harness.supervisor.startWorker(WS, runA)).rejects.toMatchObject({
      name: "TaskWorkerError",
      code: "WORKER_START_FAILED",
    });

    const crashed = harness.journal
      .listStream(runA, WS)
      .find((row) => row.event_type === "worker.crashed");
    expect(crashed).toBeDefined();
    const payload = JSON.parse(crashed!.payload) as {
      cause: string;
      exit_code: number | null;
      signal: string | null;
    };
    expect(payload.cause).toBe("unexpected_exit");
    expect(payload.exit_code !== 0 || payload.signal !== null).toBe(true);
    expect(harness.seamWrites).toContainEqual({ run_id: runA, state: "RECOVERY_REQUIRED" });
    expect(
      harness.workersRepo
        .listByRun(WS, runA)
        .some((row) => row.state === "exited" || row.state === "killed"),
    ).toBe(true);
  });
});

// ── E1: admissionPressure + never-kill guarantee + session coordination ──────

describe("S16 chunk 2 — admissionPressure + the never-kill guarantee", () => {
  it("admissionPressure is machine-readable: configured=false without a gate, live/queued/limits with one", async () => {
    const plain = makeHarness({ spawnSpec: () => ({ steps: 30, stepDelayMs: 40 }) });
    expect(plain.supervisor.admissionPressure().configured).toBe(false);

    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerMemoryBytes: 1 * GB,
        maxTotalWorkersMemoryBytes: 4 * GB,
        // BELOW the injected probe (12345) so admissions flow; the probe
        // value is still surfaced verbatim on the pressure read model.
        minFreeDiskBytes: 1_000,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 64,
      },
      probeFreeDiskBytes: () => 12345,
      spawnSpec: () => ({ steps: 100, stepDelayMs: 200 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    await harness.supervisor.startWorker(WS, runA, {
      providerSnapshot: { provider_id: "prov-p", model: "m" },
    });
    await harness.supervisor.startWorker(WS, runB, {
      providerSnapshot: { provider_id: "prov-p", model: "m" },
    });

    const pressure = harness.supervisor.admissionPressure();
    expect(pressure.configured).toBe(true);
    expect(pressure.liveWorkers).toBe(1);
    expect(pressure.queuedRuns).toBe(1);
    expect(pressure.freeDiskBytes).toBe(12345);
    expect(pressure.limits).toEqual({
      maxConcurrentWorkers: 1,
      maxWorkerMemoryBytes: 1 * GB,
      maxTotalWorkersMemoryBytes: 4 * GB,
      minFreeDiskBytes: 1_000,
      maxConcurrentRunsPerProvider: 10,
      maxWorkerProcesses: 64,
    });
    expect(pressure.projectedTotalWorkersMemoryBytes).toBe(1 * GB);
    expect(pressure.perProviderLive).toEqual([{ provider_id: "prov-p", live_workers: 1 }]);
  });

  it("never-kill: reaching a limit leaves running workers, their leases and children untouched", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 4 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 100, stepDelayMs: 200 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    const snapshotA = expectRunning(await harness.supervisor.startWorker(WS, runA));
    const resultB = await harness.supervisor.startWorker(WS, runB);
    expect(resultB.state).toBe("queued");

    // A's worker: row still running (lease alive), child alive, no stop/crash.
    const rowA = await until(() => {
      const row = harness.workersRepo.getWorker(WS, runA, snapshotA.worker_id);
      return row?.state === "running" && row.heartbeat_at !== null ? row : undefined;
    });
    expect(rowA.state).toBe("running");
    const streamA = harness.journal.listStream(runA, WS);
    expect(streamA.some((row) => row.event_type === "worker.stopped")).toBe(false);
    expect(streamA.some((row) => row.event_type === "worker.crashed")).toBe(false);
    const exitA = harness.spawns[0]!.waitForExit();
    const stillAlive = await Promise.race([
      exitA.then(() => "exited" as const),
      new Promise((resolve) => setTimeout(() => resolve("alive" as const), 120)),
    ]);
    expect(stillAlive).toBe("alive");

    // Only then does the caller stop A — the queueing itself never touched it.
    await harness.supervisor.stopWorker(WS, runA, "requested");
  });
});

describe("S16 chunk 2 — pressure: idle session hibernates, healthy worker does not", () => {
  it("under resource pressure an idle Agent session hibernates NOW while the worker and queued run wait", async () => {
    const harness = makeHarness({
      admissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerMemoryBytes: 2 * GB,
        maxTotalWorkersMemoryBytes: 4 * GB,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 10,
        maxWorkerProcesses: 256,
      },
      spawnSpec: () => ({ steps: 100, stepDelayMs: 200 }),
    });
    const runA = createRun(harness, WS);
    const runB = createRun(harness, WS);

    // Capacity filled; B queued with its reason (the pressure trigger).
    const snapshotA = expectRunning(await harness.supervisor.startWorker(WS, runA));
    const resultB = await harness.supervisor.startWorker(WS, runB);
    expect(resultB.state).toBe("queued");

    // A healthy worker keeps running under pressure — never killed.
    expect(harness.supervisor.presenceState(WS, runA)).toBe("running");
    expect(
      harness.journal.listStream(runA, WS).some((row) => row.event_type === "worker.stopped"),
    ).toBe(false);

    // The session composition over the SAME journal (S12 supervisor).
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
        display_name: "Admission Test Agent",
        instructions: null,
        pack_profile: null,
      }),
      policy: SESSION_POLICY,
    });

    await session.ensureStarted(WS, AGENT);
    // SESSION_POLICY's idle window is an hour — nothing hibernates naturally
    // inside this test; the hibernation below is the PRESSURE path.

    // Pressure hibernation: the idle session hibernates IMMEDIATELY with the
    // machine-readable reason on the journal event.
    const hibernated = await session.hibernateIdleSessionsNow("resource_pressure");
    expect(hibernated).toBe(1);
    await until(() => (session.presenceState(WS, AGENT) === "hibernating" ? true : undefined));
    const hibernateEvent = harness.journal
      .listStream(sessionStreamFor(WS, AGENT), WS)
      .filter((row) => row.event_type === "session.hibernate")
      .map((row) => JSON.parse(row.payload) as { reason?: string })
      .find((payload) => payload.reason === "resource_pressure");
    expect(hibernateEvent).toBeDefined();

    // A second call hibernates nothing (already hibernating).
    expect(await session.hibernateIdleSessionsNow("resource_pressure")).toBe(0);

    // The healthy worker is STILL running and the queued run STILL waits.
    const rowA = harness.workersRepo.getWorker(WS, runA, snapshotA.worker_id);
    expect(rowA?.state).toBe("running");
    expect(
      harness.journal.listStream(runA, WS).some((row) => row.event_type === "worker.crashed"),
    ).toBe(false);
    const queuedB = queuedEventsOf(harness, runB);
    expect(queuedB.length).toBe(1);
    expect(queuedB[0]!.reason.code).toBe("worker_limit_reached");
    expect(harness.supervisor.admissionPressure().queuedRuns).toBe(1);

    await session.stopAll();
  });
});
