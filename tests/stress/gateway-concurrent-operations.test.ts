/**
 * Stress scenario 1: concurrent operations through the runtime gateway.
 *
 * What is REAL here: the composed gateway (RunFlowOperationsService — the
 * committed D8 transition that drives the worker lifecycle), the real
 * TaskWorkerSupervisor, the real RunCancellationService (the two-step D8
 * cancellation with the full teardown), the real OperationsService /
 * OperationsRepository / EventJournalRepository / WriteLeasesRepository over
 * a real container-local SQLite database, and (storm test) REAL fake worker
 * child processes. What is faked: only the worker CHILD — for the storm, the
 * deterministic fake child script (the established D14/E8 pattern); for the
 * deterministic race repro, an in-process TaskWorkerChild double whose frames
 * are delivered at controlled moments (a real process race cannot be made
 * deterministic, and the frame seam is the supervisor's own contract).
 *
 * The invariants under mixed concurrent cancel/complete:
 *   I1  every run row reaches exactly one terminal D8 state and never stays
 *       wedged in CANCELLING/RUNNING;
 *   I2  per journal stream: sequences are gapless from 1 and event_ids are
 *       unique (no lost/duplicated journal rows);
 *   I3  journal/row agreement: a stream that journalled `task.cancelled`
 *       belongs to a CANCELLED row; a stream that journalled `task.succeeded`
 *       belongs to a SUCCEEDED row; NEVER both terminal markers on one
 *       stream; no duplicated lifecycle transition (each terminal marker at
 *       most once);
 *   I4  D8 legality: `CANCELLING` has exactly ONE exit (cancel_complete →
 *       CANCELLED). A run whose stream carries `task.cancelling` MUST end
 *       CANCELLED with `task.cancelled` journalled — no other writer may
 *       move the row out of CANCELLING;
 *   I5  a lease NEVER outlives its task (D6 force-release policy:
 *       completion, cancellation, failure — releaseLeasesForTask at the
 *       task-finish seam);
 *   I6  no zombie workers: every spawned child process has exited.
 *
 * Governing records: PRD §8, D8 (transition table), D6 (leases), D26/D23
 * rule 5 (journal atomicity), D32 (worker lifecycle); the S22 cancellation
 * ACs (AC4–AC9).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RUN_STATES_TERMINAL, type RunState } from "@shera-bot/contracts";

import {
  openDatabase,
  type SqliteConnection,
} from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../apps/user-runtime/src/adapters/sqlite/operations-repository.ts";
import { ApprovalsRepository } from "../../apps/user-runtime/src/adapters/sqlite/approvals-repository.ts";
import { WriteLeasesRepository } from "../../apps/user-runtime/src/adapters/sqlite/write-leases-repository.ts";
import { TaskWorkersRepository } from "../../apps/user-runtime/src/adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { ApprovalsService } from "../../apps/user-runtime/src/modules/approvals/approvals.service.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { RunFlowOperationsService } from "../../apps/user-runtime/src/modules/workers/task-run-flow.ts";
import { RunCancellationService } from "../../apps/user-runtime/src/modules/tasks/run-cancellation.service.ts";
import {
  applyRowLifecycleTransition,
  type RowLifecycleDeps,
} from "../../apps/user-runtime/src/modules/tasks/run-lifecycle.ts";
import { taskStreamId } from "../../apps/user-runtime/src/modules/tasks/task-events.ts";
import {
  TaskWorkerSupervisor,
  type TaskRunOperationsSeam,
  type TaskWorkerChild,
  type TaskWorkerSupervisorPolicy,
} from "../../apps/user-runtime/src/modules/workers/task-worker-supervisor.service.ts";
import { OperationsRunSeam } from "../../apps/user-runtime/src/modules/workers/operations-run-seam.ts";
import {
  spawnFakeTaskWorker,
  type FakeTaskWorkerHandle,
  type SpawnFakeTaskWorkerOptions,
} from "../../apps/user-runtime/src/modules/workers/fake-task-worker.ts";
import {
  encodeWorkerFrame,
  WORKER_PROTOCOL_VERSION,
} from "../../apps/user-runtime/src/modules/workers/worker-frames.ts";

const WS = "ws-stress-gateway";
const AGENT = "agent_stress_gateway";
const USER = { type: "user" as const, id: "user_stress" };

const PACK_CATALOG = {
  pack_id: "pack_stress_gateway",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Stress Gateway Agent",
      role_description: "runs under concurrent cancel/complete pressure",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 31, initial_glyph: "S" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_stress_gateway" : null),
  skills: [],
  connectors: [],
};

const WORKER_POLICY: Partial<TaskWorkerSupervisorPolicy> = {
  heartbeatIntervalMs: 40,
  missedHeartbeatLimit: 50,
  leaseWindowMs: 120,
  handshakeTimeoutMs: 2_000,
  shutdownGraceMs: 100,
  killGraceMs: 100,
  stderrMaxBytes: 4_096,
};

/** Poll until the reader returns a truthy value; bounded wait. */
async function untilTruthy<T>(
  read: () => T | undefined | null,
  timeoutMs = 8_000,
  onTimeout?: (partial: T | undefined | null) => never,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) {
      if (onTimeout) return onTimeout(value);
      throw new Error("timed out waiting for the expected state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Controllable in-process worker child (the deterministic race repro) ─────

export interface ControlledWorkerOptions {
  /** Heartbeat cadence (ms); 0 disables. */
  heartbeatMs?: number;
  /** When true, a shutdown frame is IGNORED (the child keeps running). */
  ignoresShutdown?: boolean;
}

/**
 * A TaskWorkerChild double fully controlled by the test: the supervisor sees
 * hello/ready/heartbeat frames on a timer; the test delivers further frames
 * (progress, done) at exact moments and controls exit.
 */
class ControlledWorkerChild implements TaskWorkerChild {
  readonly shutdownFrameCount = { value: 0 };
  private readonly lineListeners = new Set<(line: string) => void>();
  private exitResolve: ((exit: { code: number | null; signal: string | null }) => void) | null =
    null;
  private exited = false;
  private exit = { code: 0 as number | null, signal: null as string | null };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** The harness assigns the spawn identity before the supervisor subscribes. */
  workerId = "w_unassigned";
  pid = 0;

  constructor(private readonly options: ControlledWorkerOptions) {}

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    // The handshake begins as soon as the supervisor subscribes.
    setTimeout(() => {
      this.emit({ type: "hello", worker_version: 1, pid: this.pid });
      this.emit({ type: "ready", worker_id: this.workerId, pid: this.pid });
    }, 5);
    if ((this.options.heartbeatMs ?? 20) > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.emit({ type: "heartbeat", t: Date.now() });
      }, this.options.heartbeatMs ?? 20);
      this.heartbeatTimer.unref();
    }
    return () => this.lineListeners.delete(listener);
  }

  onStderr(): () => void {
    return () => {};
  }

  send(frame: { type: string }): void {
    if (frame.type === "shutdown") {
      this.shutdownFrameCount.value += 1;
      if (this.options.ignoresShutdown !== true) {
        // A well-behaved child exits promptly on shutdown.
        this.finish({ code: 0, signal: null });
      }
    }
  }

  kill(signal?: NodeJS.Signals): void {
    this.finish({ code: null, signal: signal ?? "SIGKILL" });
  }

  waitForExit(): Promise<{ code: number | null; signal: string | null }> {
    if (this.exited) return Promise.resolve(this.exit);
    return new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Deliver one child frame to the supervisor NOW (the test's lever). Works
   * even after exit: the frame simulates bytes already in the pipe whose
   * stdout data event races the exit notification.
   */
  deliver(frame: Record<string, unknown>): void {
    const line = encodeWorkerFrame({ v: WORKER_PROTOCOL_VERSION, ...frame } as never);
    for (const listener of this.lineListeners) listener(line);
  }

  /** Exit the child with the given exit record (the exit notification). */
  finish(exit: { code: number | null; signal: string | null }): void {
    if (this.exited) return;
    this.exited = true;
    this.exit = exit;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.exitResolve?.(exit);
  }

  private emit(frame: Record<string, unknown>): void {
    if (this.exited) return;
    const line = encodeWorkerFrame({ v: WORKER_PROTOCOL_VERSION, ...frame } as never);
    for (const listener of this.lineListeners) listener(line);
  }
}

// ── The composed harness ─────────────────────────────────────────────────────

interface StressHarness {
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  ops: RunFlowOperationsService;
  operationsRepo: OperationsRepository;
  leases: WriteLeasesRepository;
  supervisor: TaskWorkerSupervisor;
  cancellation: RunCancellationService;
  lifecycleDeps: RowLifecycleDeps;
  runControl: TaskRunOperationsSeam;
  operationId: string;
  /** The real worker child processes spawned through the harness seam. */
  realSpawns: FakeTaskWorkerHandle[];
  /** Every fault the harness wiring logged (diagnostics on failure). */
  faults: Array<{ event: string; fields: Record<string, unknown> }>;
  dir: string;
}

const openHarnesses: StressHarness[] = [];

interface HarnessOptions {
  /** Real fake worker processes with these spawn options (per spawn). */
  spawnSpec?: (spawnIndex: number) => SpawnFakeTaskWorkerOptions;
  /** When set, spawns the CONTROLLED in-process child instead of a process. */
  controlledSpawn?: (request: {
    workspace_id: string;
    run_id: string;
    worker_id: string;
  }) => ControlledWorkerChild;
  policy?: Partial<TaskWorkerSupervisorPolicy>;
}

function makeHarness(options: HarnessOptions = {}): StressHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-stress-gateway-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ops = new RunFlowOperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });
  const leases = new WriteLeasesRepository(tx, { agentNameResolver: () => null });
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: new ApprovalsRepository(tx),
    operations: operationsRepo,
    clock: () => new Date().toISOString(),
  });
  const workersRepo = new TaskWorkersRepository(tx);

  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Stress Gateway Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const faults: StressHarness["faults"] = [];
  const runControl = new OperationsRunSeam(ops);
  const supervisor = new TaskWorkerSupervisor({
    events,
    tx,
    taskWorkers: workersRepo,
    runControl,
    spawnChild: (request) => {
      if (options.controlledSpawn) {
        return options.controlledSpawn(request);
      }
      const spec = options.spawnSpec ? options.spawnSpec(openHarnesses.length) : {};
      const handle = spawnFakeTaskWorker({
        runId: request.run_id,
        workerId: request.worker_id,
        heartbeatMs: request.heartbeat_interval_ms,
        ...spec,
      });
      currentHarness?.realSpawns.push(handle);
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
    stderrSink: { write: () => {} },
    policy: { ...WORKER_POLICY, ...(options.policy ?? {}) },
    logFault: (event, fields) => faults.push({ event, fields }),
  });

  // The composition wiring (compose.ts): committed RUNNING starts the worker
  // fire-and-forget; CANCELLING/terminal stops it.
  ops.runFlow = {
    startRunWorker: (workspaceId, runId) => {
      void supervisor.startWorker(workspaceId, runId, {}).catch((error: unknown) => {
        faults.push({
          event: "stress_start_worker_failed",
          fields: { run_id: runId, name: error instanceof Error ? error.name : "Error" },
        });
      });
    },
    stopRunWorker: (workspaceId, runId) => {
      void supervisor.stopWorker(workspaceId, runId, "requested").catch((error: unknown) => {
        faults.push({
          event: "stress_stop_worker_failed",
          fields: { run_id: runId, name: error instanceof Error ? error.name : "Error" },
        });
      });
    },
    // The composition's D6 task-finish seam (the compose.ts wiring, mirrored).
    onRunExecutionEnded: (workspaceId, runId, state) => {
      try {
        leases.releaseLeasesForTask(runId);
      } catch (error: unknown) {
        faults.push({
          event: "stress_lease_release_failed",
          fields: {
            workspace_id: workspaceId,
            run_id: runId,
            state,
            name: error instanceof Error ? error.name : "Error",
          },
        });
      }
    },
    logFault: (event, fields) => faults.push({ event, fields }),
  };

  const cancellation = new RunCancellationService({
    tx,
    journal,
    events,
    operations: operationsRepo,
    runControl,
    workers: {
      stopWorker: (workspaceId, runId, reason) =>
        supervisor.stopWorker(workspaceId, runId, reason === "shutdown" ? "shutdown" : "requested"),
    },
    leases,
    approvals,
    logFault: (event, fields) => faults.push({ event, fields }),
  });

  const lifecycleDeps: RowLifecycleDeps = {
    tx,
    journal,
    events,
    operations: operationsRepo,
    runControl,
    logFault: (event, fields) => faults.push({ event, fields }),
  };

  const harness: StressHarness = {
    conn,
    tx,
    journal,
    ops,
    operationsRepo,
    leases,
    supervisor,
    cancellation,
    lifecycleDeps,
    runControl,
    operationId,
    realSpawns: [],
    faults,
    dir,
  };
  openHarnesses.push(harness);
  currentHarness = harness;
  return harness;
}

/** The harness most recently constructed (the spawn seam closes over it). */
let currentHarness: StressHarness | null = null;

afterEach(async () => {
  currentHarness = null;
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
    for (const handle of harness.realSpawns) {
      try {
        handle.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

// ── Shared drivers ───────────────────────────────────────────────────────────

/** Start one run through the composed gateway: CREATED → QUEUED → RUNNING. */
function startRun(harness: StressHarness, runId: string): void {
  harness.ops.createRun(WS, harness.operationId, { run_id: runId });
  harness.ops.applyRunState(WS, harness.operationId, runId, "QUEUED");
  harness.ops.applyRunState(WS, harness.operationId, runId, "RUNNING");
}

/** The gateway's complete path (journal-first lifecycle transition). */
function completeRun(harness: StressHarness, runId: string): { ok: boolean } {
  const verdict = applyRowLifecycleTransition(harness.lifecycleDeps, {
    workspaceId: WS,
    runId,
    command: "complete_task",
    actor: { type: "runtime", id: "stress-driver" },
  });
  return { ok: verdict.ok };
}

interface RunIntegrity {
  runId: string;
  rowState: RunState;
  taskStream: Array<{ sequence: number; event_id: string; event_type: string }>;
  workerStream: Array<{ sequence: number; event_id: string; event_type: string }>;
  /** Crash payloads from the worker stream (evidence on failure). */
  crashPayloads: string[];
}

/** Read one run's row state and both of its journal streams. */
function readRunIntegrity(harness: StressHarness, runId: string): RunIntegrity {
  const operationId = harness.operationsRepo.findRunOperation(WS, runId);
  if (operationId === null) throw new Error(`run ${runId} vanished`);
  const rowState = harness.ops.getRun(WS, operationId, runId).state;
  const toRow = (row: {
    sequence: number;
    event_id: string;
    event_type: string;
  }): { sequence: number; event_id: string; event_type: string } => ({
    sequence: row.sequence,
    event_id: row.event_id,
    event_type: row.event_type,
  });
  const taskStream = harness.journal.listStream(taskStreamId(runId), WS).map(toRow);
  const workerRows = harness.journal.listStream(runId, WS);
  const workerStream = workerRows.map(toRow);
  const crashPayloads = workerRows
    .filter((row) => row.event_type === "worker.crashed")
    .map((row) => row.payload.slice(0, 220));
  return { runId, rowState, taskStream, workerStream, crashPayloads };
}

/**
 * The shared invariant checker (I1–I4). I5/I6 are per-test (they need the
 * lease/child handles).
 */
function assertJournalRowIntegrity(states: RunIntegrity[]): void {
  const evidence = (state: RunIntegrity): string =>
    ` [task: ${state.taskStream.map((e) => `${e.sequence}:${e.event_type}`).join(", ") || "empty"}]` +
    ` [worker: ${state.workerStream.map((e) => e.event_type).join(", ") || "empty"}]` +
    state.crashPayloads.map((payload) => ` [crash payload: ${payload}]`).join("");
  const terminal = RUN_STATES_TERMINAL as readonly string[];
  for (const state of states) {
    // I1: terminal, never wedged.
    expect(
      terminal.includes(state.rowState),
      `run ${state.runId} ended in ${state.rowState}; expected a terminal D8 state${evidence(state)}`,
    ).toBe(true);

    // I2: both streams gapless from 1, unique event ids.
    for (const stream of [state.taskStream, state.workerStream]) {
      for (let index = 0; index < stream.length; index += 1) {
        const row = stream[index];
        if (row === undefined) throw new Error(`run ${state.runId}: stream row vanished`);
        expect(row.sequence, `run ${state.runId} stream sequence gap at index ${index}`).toBe(
          index + 1,
        );
      }
      const ids = new Set(stream.map((event) => event.event_id));
      expect(ids.size).toBe(stream.length);
    }

    const cancelled = state.taskStream.filter((event) => event.event_type === "task.cancelled");
    const cancelling = state.taskStream.filter((event) => event.event_type === "task.cancelling");
    const succeeded = state.taskStream.filter((event) => event.event_type === "task.succeeded");

    // I3: terminal markers agree with the row; never both; at most once each.
    if (cancelled.length > 0) {
      expect(state.rowState).toBe("CANCELLED");
    }
    if (succeeded.length > 0) {
      expect(state.rowState).toBe("SUCCEEDED");
    }
    expect(cancelled.length, `run ${state.runId}: duplicated task.cancelled`).toBeLessThanOrEqual(
      1,
    );
    expect(succeeded.length, `run ${state.runId}: duplicated task.succeeded`).toBeLessThanOrEqual(
      1,
    );
    expect(
      cancelled.length > 0 && succeeded.length > 0,
      `run ${state.runId}: both cancel and complete terminal markers journalled`,
    ).toBe(false);

    // I4: CANCELLING has exactly one exit (cancel_complete → CANCELLED).
    if (cancelling.length > 0) {
      expect(cancelling.length, `run ${state.runId}: duplicated task.cancelling`).toBe(1);
      expect(
        cancelled.length,
        `run ${state.runId}: task.cancelling journalled but task.cancelled never landed; row is ${state.rowState}`,
      ).toBe(1);
      expect(state.rowState).toBe("CANCELLED");
    }
  }
}

// ── Scenario 1a: the concurrent mixed cancel/complete storm ──────────────────

describe("stress: N concurrent operations through the composed runtime gateway", () => {
  it("12 in-flight runs under mixed concurrent cancel/complete keep journal, rows, leases, and workers integral", async () => {
    const harness = makeHarness({
      // Deterministic fake worker processes: enough work that every run is
      // still mid-execution when the storm fires (9 × 80ms ≈ 0.7s of steps
      // after ~0.2s of node startup). The policy windows are widened for the
      // 12-way spawn herd: 12 real node processes starting at once on a
      // loaded box can take seconds to their first frame, and the TEST-scale
      // 2s handshake must not manufacture failures that are the harness's
      // own startup cost.
      spawnSpec: () => ({ steps: 9, stepDelayMs: 80 }),
      policy: {
        heartbeatIntervalMs: 100,
        missedHeartbeatLimit: 100, // 10s stall window
        leaseWindowMs: 2_000,
        handshakeTimeoutMs: 15_000,
        shutdownGraceMs: 100,
        killGraceMs: 100,
      },
    });
    const N = 12;
    const runIds: string[] = [];
    for (let index = 0; index < N; index += 1) {
      const runId = `stress-run-${index + 1}`;
      startRun(harness, runId);
      // The exec-phase hold the D6 force-release must answer for: one lease
      // per run, taken while the run is live (a lease NEVER outlives its
      // task — I5 checks every terminal path, not only cancellation).
      harness.leases.acquireLease(
        WS,
        `workspace://notes/${runId}.md`,
        runId,
        { type: "user", id: USER.id },
        60_000,
      );
      runIds.push(runId);
      // A small stagger smooths the spawn herd (operations do not all start
      // on the same millisecond); the storm below still fires concurrently.
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    // The mixed storm, fired CONCURRENTLY: lanes overlap the workers' own
    // done frames, the cancel teardowns, and the gateway transitions.
    const lanes: Array<Promise<unknown>[]> = runIds.map((runId, index) => {
      const kind = index % 3;
      if (kind === 0) {
        // cancel-only: cancel mid-run while the worker executes.
        return [harness.cancellation.cancelRun({ workspaceId: WS, runId, actor: USER })];
      }
      if (kind === 1) {
        // complete-only: the gateway complete races the worker's own done.
        return [Promise.resolve().then(() => completeRun(harness, runId))];
      }
      // mixed: cancel and complete fired together.
      return [
        harness.cancellation.cancelRun({ workspaceId: WS, runId, actor: USER }),
        Promise.resolve().then(() => completeRun(harness, runId)),
      ];
    });
    const settled = await Promise.all(lanes.map((lane) => Promise.all(lane)));
    expect(settled.length).toBe(N);

    // The worker-done path also settles runs; wait for every run's row to be
    // terminal before asserting the invariants. A timeout here is itself a
    // finding (a wedged state machine) — the error carries the stuck rows.
    try {
      await untilTruthy(
        () => {
          const states = runIds.map((runId) => readRunIntegrity(harness, runId));
          const allTerminal = states.every((state) =>
            (RUN_STATES_TERMINAL as readonly string[]).includes(state.rowState),
          );
          return allTerminal
            ? states
            : states
                .filter(
                  (state) => !(RUN_STATES_TERMINAL as readonly string[]).includes(state.rowState),
                )
                .map((state) => `${state.runId}=${state.rowState}`)
                .join(",");
        },
        15_000,
        (partial) => {
          throw new Error(`runs wedged non-terminal after the storm: ${String(partial)}`);
        },
      );
    } catch (error) {
      const states = runIds.map((runId) => readRunIntegrity(harness, runId));
      const detail = states
        .map(
          (state) =>
            `${state.runId}: row=${state.rowState} task=[${state.taskStream.map((e) => `${e.sequence}:${e.event_type}`).join(" | ")}]`,
        )
        .join("\n  ");
      throw new Error(`${String(error)}\nrun evidence:\n  ${detail}`, { cause: error });
    }
    // Let the worker-exit observers drain (the done aftermath is async).
    await new Promise((resolve) => setTimeout(resolve, 250));

    const states = runIds.map((runId) => readRunIntegrity(harness, runId));
    assertJournalRowIntegrity(states);

    // I5: every lease died with its task — cancelled AND completed runs.
    const active = harness.leases.listActiveLeases(WS);
    expect(
      active,
      `leases outlived their tasks: ${active.map((lease) => `${lease.task_id}:${lease.path}`).join(", ")}`,
    ).toEqual([]);

    // I6: no zombie workers — every spawned child process has exited.
    for (const handle of harness.realSpawns) {
      const exit = await Promise.race([
        handle.waitForExit(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      expect(exit, `fake worker for a stress run never exited (zombie)`).not.toBeNull();
    }
  }, 60_000);

  // ── Scenario 1b: the deterministic done-during-cancel race ────────────────
  //
  // CANCELLING has exactly ONE exit in the D8 table: cancel_complete →
  // CANCELLED. The supervisor's done aftermath (markRunSucceeded) guards only
  // against TERMINAL rows, so a worker's `done` frame processed while the
  // cancellation is in flight moves the row CANCELLING → SUCCEEDED — an
  // illegal transition that also desynchronizes the journal (task.cancelling
  // journalled, no task.cancelled, no task.succeeded). The controlled child
  // holds the shutdown window open (it ignores shutdown), so the race is
  // delivered DETERMINISTICALLY: cancel first, wait for CANCELLING, then
  // deliver done.
  it("a worker done frame delivered during an in-flight cancellation never moves the row out of CANCELLING", async () => {
    const children: ControlledWorkerChild[] = [];
    const harness = makeHarness({
      controlledSpawn: (request) => {
        const child = new ControlledWorkerChild({
          heartbeatMs: 20,
          ignoresShutdown: true, // hold the cancellation teardown open
        });
        child.workerId = request.worker_id;
        child.pid = 41_000;
        children.push(child);
        return child;
      },
    });

    const runId = "stress-race-run";
    startRun(harness, runId);
    await untilTruthy(() =>
      harness.supervisor.presenceState(WS, runId) === "running" ? true : undefined,
    );
    harness.leases.acquireLease(
      WS,
      `workspace://notes/${runId}.md`,
      runId,
      { type: "user", id: USER.id },
      60_000,
    );

    // Fire the cancel; the two-step D8 cancellation commits CANCELLING and
    // then blocks in the teardown awaiting the worker stop (the child ignores
    // shutdown, so the window stays open).
    const cancelPromise = harness.cancellation.cancelRun({
      workspaceId: WS,
      runId,
      actor: USER,
    });
    await untilTruthy(() => {
      const stream = harness.journal.listStream(taskStreamId(runId), WS);
      return stream.some((row) => row.event_type === "task.cancelling") ? true : undefined;
    });

    // The race injection: the worker finishes DURING the cancellation.
    const raceChild = children[0];
    if (raceChild === undefined) throw new Error("the controlled child never spawned");
    raceChild.deliver({ type: "done", summary: "work finished mid-cancel" });

    const outcome = await cancelPromise;

    // I4: the cancellation CONVERGES — CANCELLING → CANCELLED, never
    // hijacked to SUCCEEDED by the done aftermath.
    const integrity = readRunIntegrity(harness, runId);
    expect(
      integrity.rowState,
      "a done frame during cancellation must not move the row out of CANCELLING",
    ).toBe("CANCELLED");
    expect(outcome.outcome, "the cancel must complete, not lose to the worker's done").toBe(
      "cancelled",
    );
    expect(integrity.taskStream.some((event) => event.event_type === "task.cancelled")).toBe(true);
    expect(
      integrity.taskStream.some((event) => event.event_type === "task.succeeded"),
      "no task.succeeded may ride a cancelled run's stream",
    ).toBe(false);

    // I5: the lease died with the task.
    expect(harness.leases.listActiveLeases(WS)).toEqual([]);
  }, 30_000);

  // ── Scenario 1c: the deterministic lease force-release repro ──────────────
  //
  // D6's recorded force-release policy: the runtime releases a task's leases
  // through releaseLeasesForTask when the task reaches a terminal state —
  // "completion, cancellation, failure, or process death (the gateway calls
  // it from the task-finish seam)". A lease NEVER outlives its task. The
  // cancellation path releases (RunCancellationService teardown), but the
  // gateway's task-finish seam for COMPLETION (and failure) releases nothing:
  // the composed RunFlowOperationsService drives only the worker lifecycle
  // from committed terminal transitions, so a completed run's leases stay
  // ACTIVE until TTL expiry. This repro walks one run to SUCCEEDED through
  // the journal-first gateway transitions (no cancellation anywhere) and
  // asserts the lease died with the task — deterministically red pre-fix.
  it("a run that reaches SUCCEEDED through the gateway takes its write leases with it (D6)", async () => {
    const children: ControlledWorkerChild[] = [];
    const harness = makeHarness({
      controlledSpawn: (request) => {
        const child = new ControlledWorkerChild({ heartbeatMs: 20 });
        child.workerId = request.worker_id;
        child.pid = 42_000 + children.length;
        children.push(child);
        return child;
      },
    });

    const runId = "stress-lease-run";
    // CREATED → QUEUED → RUNNING → SUCCEEDED entirely through the
    // journal-first lifecycle applier (the gateway's own transition path —
    // the same walk the scheduler and retry machinery take).
    harness.ops.createRun(WS, harness.operationId, { run_id: runId });
    const queued = applyRowLifecycleTransition(harness.lifecycleDeps, {
      workspaceId: WS,
      runId,
      command: "queue_task",
      actor: { type: "runtime", id: "stress-driver" },
    });
    expect(queued.ok).toBe(true);
    const started = applyRowLifecycleTransition(harness.lifecycleDeps, {
      workspaceId: WS,
      runId,
      command: "start_task",
      actor: { type: "runtime", id: "stress-driver" },
    });
    expect(started.ok).toBe(true);
    await untilTruthy(() =>
      harness.supervisor.presenceState(WS, runId) === "running" ? true : undefined,
    );

    // The exec-phase hold.
    harness.leases.acquireLease(
      WS,
      `workspace://notes/${runId}.md`,
      runId,
      {
        type: "user",
        id: USER.id,
      },
      60_000,
    );
    expect(
      harness.leases.listActiveLeases(WS).length,
      "the lease must be active while the run executes",
    ).toBe(1);

    // The gateway's task-finish seam: complete_task commits SUCCEEDED.
    const completed = applyRowLifecycleTransition(harness.lifecycleDeps, {
      workspaceId: WS,
      runId,
      command: "complete_task",
      actor: { type: "runtime", id: "stress-driver" },
    });
    expect(completed.ok).toBe(true);
    expect(readRunIntegrity(harness, runId).rowState).toBe("SUCCEEDED");

    // D6: the lease NEVER outlives its task — completion included.
    const active = harness.leases.listActiveLeases(WS);
    expect(
      active,
      `lease outlived its completed task: ${active.map((lease) => `${lease.task_id}:${lease.path}`).join(", ")}`,
    ).toEqual([]);
  }, 30_000);

  // ── Scenario 1d: the clean-exit/done-frame race ───────────────────────────
  //
  // The child's exit notification and the pending stdout data event are
  // independent loop events. When the exit event wins the queue, the old
  // observer unsubscribed the line listeners FIRST and classified the clean
  // exit (code 0, no signal) as `unexpected_exit` — an honest completion
  // whose done frame was already in the pipe became a crash, wedging the run
  // in RECOVERY_REQUIRED under load (observed repeatedly in the storm: exit
  // code 0, last_percent 100, all progress journalled, then worker.crashed).
  // The bounded clean-exit drain lets the in-flight done frame be processed
  // before any unsubscription; this repro delivers the race DETERMINISTICALLY
  // (exit resolves first, the done frame arrives inside the drain window).
  it("a clean exit whose done frame is still in flight completes the run (never classified as a crash)", async () => {
    const children: ControlledWorkerChild[] = [];
    const harness = makeHarness({
      controlledSpawn: (request) => {
        const child = new ControlledWorkerChild({ heartbeatMs: 20 });
        child.workerId = request.worker_id;
        child.pid = 43_000 + children.length;
        children.push(child);
        return child;
      },
    });

    const runId = "stress-clean-exit-run";
    startRun(harness, runId);
    await untilTruthy(() =>
      harness.supervisor.presenceState(WS, runId) === "running" ? true : undefined,
    );

    const child = children[0];
    if (child === undefined) throw new Error("the controlled child never spawned");

    // The race, in the losing order: the exit notification resolves first;
    // the done frame's data event lands moments later (bytes in the pipe).
    child.finish({ code: 0, signal: null });
    setTimeout(() => child.deliver({ type: "done", summary: "work completed" }), 5);

    // The completion must win: the row reaches SUCCEEDED through the done
    // aftermath, the worker.completed event is journalled, and NO crash is
    // classified for the clean exit.
    const integrity = await untilTruthy(() => {
      const state = readRunIntegrity(harness, runId);
      return state.rowState === "SUCCEEDED" ? state : undefined;
    }, 5_000);
    expect(
      integrity.workerStream.some((event) => event.event_type === "worker.completed"),
      "the in-flight done frame must be journalled as a completion",
    ).toBe(true);
    expect(
      integrity.workerStream.some((event) => event.event_type === "worker.crashed"),
      "a clean exit with an in-flight done frame must never be classified as a crash",
    ).toBe(false);
  }, 30_000);
});
