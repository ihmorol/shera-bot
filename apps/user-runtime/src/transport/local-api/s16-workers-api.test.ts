/**
 * S16 chunk 3 — run wiring, restart reconciliation, and the resource readout.
 *
 * Chunk 2 delivered the supervisor core and the E1 admission gate as a
 * self-contained module; THIS suite proves the WIRING:
 *
 *  1. The REAL run seam (OperationsRunSeam) resolves a run's operation from
 *     the run row — a run of another workspace is unreachable (E12, typed
 *     refusal), and run-state writes go through OperationsService.applyRunState
 *     (the D8-validated path).
 *  2. The harness-configured composition starts a worker per run on the
 *     RUNNING transition through the PRODUCTION spawn adapter (prlimit-wrapped
 *     fake worker child), and a done worker lands the run in SUCCEEDED
 *     end-to-end. A CANCELLING transition stops the worker (escalation
 *     observed: worker.stopped + row killed). Without the harness the runs
 *     behave exactly as before (G4 — no workers, no rows, no events).
 *  3. Restart reconciliation: live task_workers rows whose pid is gone are
 *     reaped (row killed + worker.reaped on the run stream), QUEUED runs
 *     re-enter the admission queue, RECOVERY_REQUIRED runs stay as-is (the
 *     recovery slice owns them), and live-pid rows are left alone.
 *  4. The admission read endpoint (GET /v1/workers/admission) reports the
 *     configured limits, the live worker count, and the queued runs with
 *     their verbatim reason — honestly empty-shaped when no worker harness
 *     is configured.
 *  5. The env knob: SHERA_WORKER_HARNESS_COMMAND/_ARGS parse next to the
 *     session knobs.
 *
 * The fake task worker child (chunk 1) is the harness command — the committed
 * demo worker; production real workers arrive with the tools slice.
 *
 * Governing records: D32, D10, D8, E1, D27, G4, E12; AC25.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { PackAgentSeed } from "../../adapters/sqlite/agents-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../../modules/events/events.service.ts";
import { OperationsService } from "../../modules/operations/operations.service.ts";
import { OperationsRunSeam } from "../../modules/workers/operations-run-seam.ts";
import {
  reconcileTaskWorkersAfterRestart,
  type WorkerReconciliationReport,
} from "../../modules/workers/worker-reconciliation.ts";
import {
  TaskWorkerSupervisor,
  type TaskWorkerChild,
  type TaskWorkerSupervisorPolicy,
} from "../../modules/workers/task-worker-supervisor.service.ts";
import { TaskWorkerAdmissionGate } from "../../modules/workers/admission.ts";
import {
  spawnFakeTaskWorker,
  type FakeTaskWorkerHandle,
} from "../../modules/workers/fake-task-worker.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import { runtimeConfigFromEnv } from "../../main.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(resolve(PACKS_ROOT, "student/v1/manifest.json"), "utf8"),
) as { pack_id: string; version: string };

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";
const CITATION = "agent_citation_manager";

/**
 * The committed fake worker child as the CONFIGURED harness command — the
 * production spawn adapter launches it exactly as it would launch a real
 * worker executable. `{run_id}`, `{worker_id}` and `{heartbeat_interval_ms}`
 * are the documented per-spawn placeholders; the child beats fast so the
 * ms-scale supervisor policy applies, and completes two steps so the run
 * reaches SUCCEEDED on its own.
 */
const FAKE_WORKER_HARNESS = {
  file: process.execPath,
  args: [
    resolve(here, "../../modules/workers/fake-task-worker-child.ts"),
    "--run-id",
    "{run_id}",
    "--worker-id",
    "{worker_id}",
    "--heartbeat-ms",
    "{heartbeat_interval_ms}",
    "--steps",
    "2",
    "--step-delay-ms",
    "20",
  ],
};

/** ms-scale supervisor overrides: the watchdog window tracks the child's beat. */
const MS_POLICY: Partial<TaskWorkerSupervisorPolicy> = {
  heartbeatIntervalMs: 40,
  missedHeartbeatLimit: 3,
  leaseWindowMs: 150,
  handshakeTimeoutMs: 4_000,
  shutdownGraceMs: 200,
  killGraceMs: 200,
};

/**
 * An upper bound on the machine's current task count (processes + threads).
 * prlimit --nproc is enforced per real user id, so the admission policy's
 * per-worker process cap must sit ABOVE the live total or the worker child
 * dies at its own boot. The composition test overrides the default with this
 * machine-honest value (the same discipline as the chunk-2 kernel suite).
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
    return 4_096;
  }
}

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

interface ComposeOptions {
  workerHarness?: { file: string; args?: readonly string[] };
  workerAdmissionPolicy?: Record<string, number>;
  workerPolicy?: Partial<TaskWorkerSupervisorPolicy>;
}

async function composeOn(dbPath: string, options: ComposeOptions = {}): Promise<RunningRuntime> {
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    ...(options.workerHarness ? { workerHarness: options.workerHarness } : {}),
    ...(options.workerAdmissionPolicy
      ? { workerAdmissionPolicy: options.workerAdmissionPolicy }
      : {}),
    ...(options.workerPolicy ? { workerPolicy: options.workerPolicy } : {}),
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

/** Bounded poll until the reader yields a value (the S12/S13 suite style). */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

/** Create one Operation + one named run through the REAL composed HTTP stack. */
async function createOperationAndRun(
  origin: string,
  runId: string,
): Promise<{ operationId: string; runId: string }> {
  const created = await postJson(origin, "/v1/operations", {
    workspace_id: WORKSPACE,
    definition_ref: null,
    name: `Worker Op ${runId}`,
    roster_agent_ids: [RESEARCHER, CITATION],
    coordinator_agent_id: GENERAL,
  });
  expect(created.status).toBe(201);
  const operationId = (created.body as { operation_id: string }).operation_id;
  const run = await postJson(origin, `/v1/operations/${operationId}/runs`, {
    workspace_id: WORKSPACE,
    run_id: runId,
  });
  expect(run.status).toBe(201);
  return { operationId, runId };
}

async function runStateOf(origin: string, operationId: string, runId: string): Promise<string> {
  const detail = await getJson(
    origin,
    `/v1/operations/${operationId}/runs/${runId}?workspace_id=${WORKSPACE}`,
  );
  expect(detail.status).toBe(200);
  return detail.body["state"] as string;
}

interface JournalRow {
  type: string;
  payload: Record<string, unknown>;
}

/** The worker.* journal events of one run stream, read straight off the rows. */
function readRunJournal(dbPath: string, runId: string): JournalRow[] {
  const conn = openDatabase(dbPath);
  try {
    const rows = conn.db
      .prepare(
        `SELECT event_type, payload FROM event_journal
         WHERE workspace_id = ? AND stream_id = ? ORDER BY sequence`,
      )
      .all(WORKSPACE, runId) as Array<{ event_type: string; payload: string }>;
    return rows.map((row) => ({ type: row.event_type, payload: JSON.parse(row.payload) }));
  } finally {
    conn.close();
  }
}

interface WorkerRowRead {
  run_id: string;
  worker_id: string;
  pid: number | null;
  state: string;
}

/** Every task_workers row (all workspaces), read straight off the rows. */
function readWorkerRows(dbPath: string): WorkerRowRead[] {
  const conn = openDatabase(dbPath);
  try {
    return conn.db
      .prepare(`SELECT run_id, worker_id, pid, state FROM task_workers ORDER BY started_at`)
      .all() as unknown as WorkerRowRead[];
  } finally {
    conn.close();
  }
}

/** A pid that is (almost) certainly gone: spawn a child and wait for its exit. */
async function collectDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolveExit) => child.on("exit", () => resolveExit()));
  return child.pid!;
}

// ---------------------------------------------------------------------------
// 1. The REAL run seam: resolve a run's operation from the run row
// ---------------------------------------------------------------------------

describe("S16 run seam (OperationsRunSeam over the real OperationsService)", () => {
  const WS_A = "ws-seam-a";
  const WS_B = "ws-seam-b";
  const AGENT = "agent_seam_test";

  const FAKE_SEED: PackAgentSeed = {
    agent_id: AGENT,
    display_name: "Seam Test Agent",
    role_description: "seam tests",
    default_provider: { provider_id: "fake", model: "fake-model" },
    skills: [],
    tools: [],
    connectors: [],
    ui_identity: { avatar_hue: 3, initial_glyph: "S" },
    home_operation_id: null,
  };

  interface SeamHarness {
    conn: SqliteConnection;
    ops: OperationsService;
    seam: OperationsRunSeam;
  }

  function makeSeamHarness(): SeamHarness {
    const dir = makeTempDir("shera-s16-seam-");
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const ops = new OperationsService({
      operations: new OperationsRepository(tx),
      tx,
      packCatalog: {
        pack_id: "pack_seam_test",
        pack_version: "1.0.0",
        agents: [FAKE_SEED],
        locateAgentPack: (agentId) => (agentId === AGENT ? "pack_seam_test" : null),
      },
    });
    trackConnection({ close: () => conn.close() });
    return { conn, ops, seam: new OperationsRunSeam(ops) };
  }

  function seedRuns(harness: SeamHarness, workspaceId: string, runIds: string[]): void {
    const operation = harness.ops.createOperation(workspaceId, {
      definition_ref: null,
      name: `Seam Op ${workspaceId}`,
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    });
    for (const runId of runIds) {
      harness.ops.createRun(workspaceId, operation.operation_id, { run_id: runId });
    }
  }

  it("resolves the run's operation from the run row for reads and writes", () => {
    const harness = makeSeamHarness();
    seedRuns(harness, WS_A, ["run-shared"]);
    seedRuns(harness, WS_B, ["run-shared"]);

    // Reads resolve per-workspace: the SAME run id in two workspaces is two
    // independent rows (E12), and the seam lands on the right one each time.
    expect(harness.seam.runState(WS_A, "run-shared")).toBe("CREATED");
    expect(harness.seam.runState(WS_B, "run-shared")).toBe("CREATED");

    harness.seam.applyRunState(WS_A, "run-shared", "RUNNING");
    expect(harness.seam.runState(WS_A, "run-shared")).toBe("RUNNING");
    expect(harness.seam.runState(WS_B, "run-shared")).toBe("CREATED");
  });

  it("refuses a cross-workspace run with a typed error (E12)", () => {
    const harness = makeSeamHarness();
    seedRuns(harness, WS_B, ["run-only-in-b"]);

    expect(harness.seam.runState(WS_A, "run-only-in-b")).toBeNull();
    expect(() => harness.seam.applyRunState(WS_A, "run-only-in-b", "RUNNING")).toThrowError(
      /WORKER_NOT_FOUND/,
    );
    expect(harness.seam.runState(WS_B, "run-only-in-b")).toBe("CREATED");
  });

  it("answers null for a run that does not exist at all", () => {
    const harness = makeSeamHarness();
    expect(harness.seam.runState(WS_A, "run-missing")).toBeNull();
    expect(() => harness.seam.applyRunState(WS_A, "run-missing", "RUNNING")).toThrowError(
      /WORKER_NOT_FOUND/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The harness-configured composition: worker per run, end to end
// ---------------------------------------------------------------------------

describe("S16 run wiring (harness-configured composition)", () => {
  let runtime: RunningRuntime;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("starts a worker on the RUNNING transition and lands the run SUCCEEDED (real spawn adapter)", async () => {
    runtime = await composeOn(join(makeTempDir("shera-s16-wiring-"), "runtime.db"), {
      workerHarness: FAKE_WORKER_HARNESS,
      workerAdmissionPolicy: { maxWorkerProcesses: totalTaskUpperBound() + 1_024 },
      workerPolicy: MS_POLICY,
    });
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run-worker-e2e");

    // The composition exposes the worker system when (and only when) the
    // harness is configured.
    expect(runtime.runtime.workers).toBeDefined();

    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");

    // The fake worker (harness command) runs its two steps and completes:
    // done → worker.completed + run SUCCEEDED through the seam.
    await until(async () =>
      (await runStateOf(runtime.origin, operationId, runId)) === "SUCCEEDED" ? true : undefined,
    );

    const rows = readWorkerRows(runtime.dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: runId, state: "exited" });

    const events = readRunJournal(runtime.dbPath, runId);
    const types = events.map((event) => event.type);
    expect(types).toContain("worker.started");
    expect(types).toContain("worker.completed");
    expect(types).not.toContain("worker.crashed");
  }, 30_000);

  it("stops the worker on the CANCELLING transition (escalation observed)", async () => {
    runtime = await composeOn(join(makeTempDir("shera-s16-cancel-"), "runtime.db"), {
      workerHarness: FAKE_WORKER_HARNESS,
      workerAdmissionPolicy: { maxWorkerProcesses: totalTaskUpperBound() + 1_024 },
      workerPolicy: MS_POLICY,
    });
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run-worker-cancel");

    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");
    await until(async () =>
      readWorkerRows(runtime.dbPath).some((row) => row.run_id === runId && row.state === "running")
        ? true
        : undefined,
    );

    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "CANCELLING");
    await until(async () =>
      readWorkerRows(runtime.dbPath).some((row) => row.run_id === runId && row.state === "killed")
        ? true
        : undefined,
    );

    const events = readRunJournal(runtime.dbPath, runId);
    const stopped = events.find((event) => event.type === "worker.stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.payload["reason"]).toBe("requested");
    expect(events.map((event) => event.type)).not.toContain("worker.completed");
  }, 30_000);

  it("queues the run durably when the admission gate is full, and re-admits when capacity frees", async () => {
    runtime = await composeOn(join(makeTempDir("shera-s16-queue-"), "runtime.db"), {
      workerHarness: FAKE_WORKER_HARNESS,
      workerAdmissionPolicy: {
        maxConcurrentWorkers: 1,
        maxWorkerProcesses: totalTaskUpperBound() + 1_024,
      },
      workerPolicy: MS_POLICY,
    });
    const op = await createOperationAndRun(runtime.origin, "run-queue-first");
    const second = await postJson(runtime.origin, `/v1/operations/${op.operationId}/runs`, {
      workspace_id: WORKSPACE,
      run_id: "run-queue-second",
    });
    expect(second.status).toBe(201);

    // First run: admitted, its worker goes live.
    runtime.runtime.operations.applyRunState(WORKSPACE, op.operationId, op.runId, "RUNNING");
    await until(async () =>
      readWorkerRows(runtime.dbPath).some(
        (row) => row.run_id === op.runId && row.state === "running",
      )
        ? true
        : undefined,
    );

    // Second run: the gate is full → the run is durably QUEUED, with the
    // machine-readable reason on its stream.
    runtime.runtime.operations.applyRunState(
      WORKSPACE,
      op.operationId,
      "run-queue-second",
      "RUNNING",
    );
    expect(await runStateOf(runtime.origin, op.operationId, "run-queue-second")).toBe("QUEUED");
    const queuedEvents = readRunJournal(runtime.dbPath, "run-queue-second").filter(
      (event) => event.type === "worker.queued",
    );
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0]!.payload["reason"]).toMatchObject({
      code: "worker_limit_reached",
      limit: 1,
      current: 1,
    });

    // The read endpoint reports the queue honestly while it waits.
    const readout = await getJson(
      runtime.origin,
      `/v1/workers/admission?workspace_id=${WORKSPACE}`,
    );
    expect(readout.status).toBe(200);
    expect(readout.body).toMatchObject({ configured: true, live_workers: 1 });
    const queuedRuns = readout.body["queued_runs"] as Array<Record<string, unknown>>;
    expect(queuedRuns).toHaveLength(1);
    expect(queuedRuns[0]).toMatchObject({ run_id: "run-queue-second" });
    expect((queuedRuns[0]!["reason"] as Record<string, unknown>)["code"]).toBe(
      "worker_limit_reached",
    );

    // Capacity frees (the first run is cancelled) → the queue re-admits the
    // second run oldest-first; its worker completes → SUCCEEDED.
    runtime.runtime.operations.applyRunState(WORKSPACE, op.operationId, op.runId, "CANCELLING");
    await until(async () =>
      (await runStateOf(runtime.origin, op.operationId, "run-queue-second")) === "SUCCEEDED"
        ? true
        : undefined,
    );
    const drained = await getJson(
      runtime.origin,
      `/v1/workers/admission?workspace_id=${WORKSPACE}`,
    );
    expect(drained.body).toMatchObject({ live_workers: 0 });
    expect(drained.body["queued_runs"]).toHaveLength(0);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// 3. G4: without the harness knob the runs behave exactly as before
// ---------------------------------------------------------------------------

describe("S16 worker-less composition (G4 fallback)", () => {
  let runtime: RunningRuntime;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("keeps run transitions worker-free: no rows, no worker events, readout says not configured", async () => {
    runtime = await composeOn(join(makeTempDir("shera-s16-g4-"), "runtime.db"));
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run-no-harness");

    expect(runtime.runtime.workers).toBeUndefined();

    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");
    expect(await runStateOf(runtime.origin, operationId, runId)).toBe("RUNNING");

    expect(readWorkerRows(runtime.dbPath)).toHaveLength(0);
    expect(readRunJournal(runtime.dbPath, runId).map((event) => event.type)).toEqual([]);

    const readout = await getJson(
      runtime.origin,
      `/v1/workers/admission?workspace_id=${WORKSPACE}`,
    );
    expect(readout.status).toBe(200);
    expect(readout.body).toEqual({
      configured: false,
      limits: null,
      live_workers: 0,
      queued_runs: [],
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. Restart reconciliation
// ---------------------------------------------------------------------------

describe("S16 restart reconciliation (dead pids reaped, QUEUED re-queued, RECOVERY_REQUIRED untouched)", () => {
  const AGENT = "agent_reconcile_test";

  const FAKE_SEED: PackAgentSeed = {
    agent_id: AGENT,
    display_name: "Reconcile Test Agent",
    role_description: "reconciliation tests",
    default_provider: { provider_id: "fake", model: "fake-model" },
    skills: [],
    tools: [],
    connectors: [],
    ui_identity: { avatar_hue: 4, initial_glyph: "R" },
    home_operation_id: null,
  };

  interface ReconcileHarness {
    conn: SqliteConnection;
    tx: SqliteTransactions;
    workersRepo: TaskWorkersRepository;
    ops: OperationsService;
    operationId: string;
    supervisor: TaskWorkerSupervisor;
    gate: TaskWorkerAdmissionGate;
    spawns: FakeTaskWorkerHandle[];
    dbPath: string;
  }

  /** The run rows the harness seeded, by short name. */
  interface SeededRuns {
    running: string;
    queued: string;
    recovery: string;
    live: string;
  }

  async function makeHarness(options: {
    maxConcurrentWorkers: number;
  }): Promise<{ harness: ReconcileHarness; runs: SeededRuns; deadPid: number }> {
    const dir = makeTempDir("shera-s16-reconcile-");
    const dbPath = join(dir, "runtime.db");
    const conn = openDatabase(dbPath);
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const journal = new EventJournalRepository(tx);
    const events = new EventsService(journal, tx);
    const workersRepo = new TaskWorkersRepository(tx);
    const ops = new OperationsService({
      operations: new OperationsRepository(tx),
      tx,
      packCatalog: {
        pack_id: "pack_reconcile_test",
        pack_version: "1.0.0",
        agents: [FAKE_SEED],
        locateAgentPack: (agentId) => (agentId === AGENT ? "pack_reconcile_test" : null),
      },
    });

    const operation = ops.createOperation("ws-reconcile", {
      definition_ref: null,
      name: "Reconcile Op",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    });
    const operationId = operation.operation_id;
    const runs: SeededRuns = {
      running: "run-reconcile-running",
      queued: "run-reconcile-queued",
      recovery: "run-reconcile-recovery",
      live: "run-reconcile-live",
    };
    for (const runId of Object.values(runs)) {
      ops.createRun("ws-reconcile", operationId, { run_id: runId });
    }
    ops.applyRunState("ws-reconcile", operationId, runs.running, "RUNNING");
    ops.applyRunState("ws-reconcile", operationId, runs.queued, "QUEUED");
    ops.applyRunState("ws-reconcile", operationId, runs.recovery, "RECOVERY_REQUIRED");
    ops.applyRunState("ws-reconcile", operationId, runs.live, "RUNNING");

    const deadPid = await collectDeadPid();

    // Pre-seeded rows from BEFORE the restart:
    // - runs.running carries a LIVE-state row whose pid is gone (reap me);
    // - runs.live carries a live row whose pid is THIS process (keep me);
    // - runs.queued and runs.recovery carry no worker rows at all.
    const stamp = new Date().toISOString();
    workersRepo.insertWorker({
      workspace_id: "ws-reconcile",
      run_id: runs.running,
      worker_id: "wk-dead-running",
      pid: deadPid,
      state: "running",
      heartbeat_at: stamp,
      lease_expires_at: stamp,
      last_progress_json: null,
      started_at: stamp,
    });
    workersRepo.insertWorker({
      workspace_id: "ws-reconcile",
      run_id: runs.live,
      worker_id: "wk-still-alive",
      pid: process.pid,
      state: "running",
      heartbeat_at: stamp,
      lease_expires_at: stamp,
      last_progress_json: null,
      started_at: stamp,
    });

    const spawns: FakeTaskWorkerHandle[] = [];
    const gate = new TaskWorkerAdmissionGate(
      {
        maxConcurrentWorkers: options.maxConcurrentWorkers,
        maxWorkerMemoryBytes: 2 * 1024 * 1024 * 1024,
        maxTotalWorkersMemoryBytes: 8 * 1024 * 1024 * 1024,
        minFreeDiskBytes: 0,
        maxConcurrentRunsPerProvider: 4,
        maxWorkerProcesses: 4_096,
      },
      { liveWorkerCount: () => workersRepo.listLiveAll().length },
    );
    const supervisor = new TaskWorkerSupervisor({
      events,
      tx,
      taskWorkers: workersRepo,
      runControl: new OperationsRunSeam(ops),
      admission: gate,
      spawnChild: (request) => {
        const handle = spawnFakeTaskWorker({
          runId: request.run_id,
          workerId: request.worker_id,
          heartbeatMs: request.heartbeat_interval_ms,
          steps: 1,
          stepDelayMs: 10,
        });
        spawns.push(handle);
        const child: TaskWorkerChild = {
          onLine: (listener) => handle.onFrame((entry) => listener(entry.line)),
          onStderr: () => () => {},
          send: (frame) => handle.send(frame),
          kill: (signal) => handle.kill(signal ?? "SIGKILL"),
          waitForExit: () => handle.waitForExit(),
        };
        return child;
      },
      policy: {
        heartbeatIntervalMs: 40,
        missedHeartbeatLimit: 3,
        leaseWindowMs: 150,
        handshakeTimeoutMs: 4_000,
        shutdownGraceMs: 200,
        killGraceMs: 200,
      },
    });

    return {
      harness: {
        conn,
        tx,
        workersRepo,
        ops,
        operationId,
        supervisor,
        gate,
        spawns,
        dbPath,
      },
      runs,
      deadPid,
    };
  }

  function readJournalEvents(dbPath: string, runId: string): JournalRow[] {
    const conn = openDatabase(dbPath);
    try {
      const rows = conn.db
        .prepare(
          `SELECT event_type, payload FROM event_journal
           WHERE workspace_id = 'ws-reconcile' AND stream_id = ? ORDER BY sequence`,
        )
        .all(runId) as Array<{ event_type: string; payload: string }>;
      return rows.map((row) => ({ type: row.event_type, payload: JSON.parse(row.payload) }));
    } finally {
      conn.close();
    }
  }

  afterEach(async () => {
    await cleanupTempResources();
  });

  it("reaps dead-pid rows, re-queues the QUEUED run when the gate is full, and leaves RECOVERY_REQUIRED alone", async () => {
    const { harness, runs, deadPid } = await makeHarness({ maxConcurrentWorkers: 1 });
    try {
      const report: WorkerReconciliationReport = await reconcileTaskWorkersAfterRestart({
        taskWorkers: harness.workersRepo,
        events: new EventsService(new EventJournalRepository(harness.tx), harness.tx),
        runs: new OperationsRepository(harness.tx),
        supervisor: harness.supervisor,
      });

      // The dead row: reaped — row killed + worker.reaped on its run stream.
      expect(report.reaped).toEqual([
        {
          workspace_id: "ws-reconcile",
          run_id: runs.running,
          worker_id: "wk-dead-running",
          pid: deadPid,
          previous_state: "running",
        },
      ]);
      const deadRow = harness.workersRepo.getWorker(
        "ws-reconcile",
        runs.running,
        "wk-dead-running",
      );
      expect(deadRow?.state).toBe("killed");
      const reapedEvent = readJournalEvents(harness.dbPath, runs.running).find(
        (event) => event.type === "worker.reaped",
      );
      expect(reapedEvent).toBeDefined();
      expect(reapedEvent!.payload).toMatchObject({
        worker_id: "wk-dead-running",
        pid: deadPid,
        previous_state: "running",
        cause: "gateway_restart",
      });

      // The live-pid row is left alone (the kill(pid,0) probe is real).
      expect(
        harness.workersRepo.getWorker("ws-reconcile", runs.live, "wk-still-alive")?.state,
      ).toBe("running");
      expect(report.kept).toBe(1);

      // The QUEUED run re-entered the admission queue — the gate is full (the
      // live row counts), so it queued AGAIN (fresh worker.queued evidence)
      // and no worker was spawned for it.
      expect(report.requeued).toEqual([
        { workspace_id: "ws-reconcile", run_id: runs.queued, queued: true },
      ]);
      expect(harness.spawns).toHaveLength(0);
      expect(harness.ops.getRun("ws-reconcile", harness.operationId, runs.queued).state).toBe(
        "QUEUED",
      );
      expect(
        readJournalEvents(harness.dbPath, runs.queued).filter(
          (event) => event.type === "worker.queued",
        ),
      ).toHaveLength(1);

      // RECOVERY_REQUIRED: untouched — no events, no re-queue.
      expect(harness.ops.getRun("ws-reconcile", harness.operationId, runs.recovery).state).toBe(
        "RECOVERY_REQUIRED",
      );
      expect(readJournalEvents(harness.dbPath, runs.recovery)).toEqual([]);
    } finally {
      await harness.supervisor.stopAll();
      harness.conn.close();
    }
  }, 30_000);

  it("re-drives a QUEUED run into a real worker when the gate admits", async () => {
    const { harness, runs } = await makeHarness({ maxConcurrentWorkers: 2 });
    try {
      const report = await reconcileTaskWorkersAfterRestart({
        taskWorkers: harness.workersRepo,
        events: new EventsService(new EventJournalRepository(harness.tx), harness.tx),
        runs: new OperationsRepository(harness.tx),
        supervisor: harness.supervisor,
      });

      expect(report.requeued).toEqual([
        { workspace_id: "ws-reconcile", run_id: runs.queued, queued: false },
      ]);
      expect(harness.spawns).toHaveLength(1);

      // The re-driven run completes end-to-end: done → SUCCEEDED.
      await until(async () =>
        harness.ops.getRun("ws-reconcile", harness.operationId, runs.queued).state === "SUCCEEDED"
          ? true
          : undefined,
      );
    } finally {
      await harness.supervisor.stopAll();
      harness.conn.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. The env knob (SHERA_WORKER_HARNESS_COMMAND/_ARGS)
// ---------------------------------------------------------------------------

describe("S16 worker harness env knob", () => {
  it("parses the command and whitespace-split args next to the session knobs", () => {
    const config = runtimeConfigFromEnv({
      SHERA_WORKER_HARNESS_COMMAND: "/opt/shera/bin/task-worker",
      SHERA_WORKER_HARNESS_ARGS: "--queue main --run-id {run_id}",
    });
    expect(config.workerHarness).toEqual({
      file: "/opt/shera/bin/task-worker",
      args: ["--queue", "main", "--run-id", "{run_id}"],
    });
  });

  it("defaults to null (workers disabled) and lets a programmatic override win", () => {
    expect(runtimeConfigFromEnv({}).workerHarness).toBeNull();
    const override = { file: "/explicit/worker" };
    expect(
      runtimeConfigFromEnv(
        { SHERA_WORKER_HARNESS_COMMAND: "/env/worker" },
        { workerHarness: override },
      ).workerHarness,
    ).toEqual(override);
  });
});

afterAll(async () => {
  await cleanupTempResources();
});
