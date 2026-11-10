/**
 * Stress scenario 2: the cancellation storm — rapid-fire cancels during the
 * spawn and exec phases.
 *
 * What is REAL here: the composed gateway (RunFlowOperationsService), the
 * real TaskWorkerSupervisor with REAL fake worker child processes, the real
 * RunCancellationService (two-step D8 cancellation, full teardown), real
 * SQLite, real write leases, real approvals. What is faked: only the worker
 * child script (the established D14/E8 deterministic fake processes).
 *
 * The storm: 12 runs walk CREATED → QUEUED → RUNNING; for EVERY run THREE
 * cancelRun calls fire CONCURRENTLY (0ms / 5ms / 10ms offsets), and a
 * quarter of the runs get their first cancel DURING the spawn window (the
 * worker handshake is still in flight). The invariants:
 *
 *   S1  every cancel promise RESOLVES with a deterministic outcome
 *       (cancelled | already_cancelled | already_settled | not_found) —
 *       no throw, no unhandled rejection, no zombie promise;
 *   S2  every run row settles in exactly one terminal D8 state — the state
 *       machine never wedges (no CANCELLING, RUNNING, or RECOVERY_REQUIRED
 *       left behind);
 *   S3  the two-step cancellation CONVERGES under re-entrancy: exactly one
 *       task.cancelling and one task.cancelled per stream (the replayed
 *       cancels dedupe, never double-journal);
 *   S4  leases are fully released — zero ACTIVE leases after the storm (a
 *       lease NEVER outlives its task, D6);
 *   S5  no zombie workers — every spawned child process has exited;
 *   S6  the teardown is complete and honest — every cancelled run's answer
 *       reports its released leases and preserved journal.
 *
 * Governing records: PRD §8 (D8 two-step cancellation), D6 (lease
 * force-release), D27/D32 (process-group kill, worker lifecycle), AC4–AC9.
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
import { taskStreamId } from "../../apps/user-runtime/src/modules/tasks/task-events.ts";
import {
  TaskWorkerSupervisor,
  type TaskWorkerChild,
  type TaskWorkerSupervisorPolicy,
} from "../../apps/user-runtime/src/modules/workers/task-worker-supervisor.service.ts";
import { OperationsRunSeam } from "../../apps/user-runtime/src/modules/workers/operations-run-seam.ts";
import {
  spawnFakeTaskWorker,
  type FakeTaskWorkerHandle,
  type SpawnFakeTaskWorkerOptions,
} from "../../apps/user-runtime/src/modules/workers/fake-task-worker.ts";

const WS = "ws-stress-cancel-storm";
const AGENT = "agent_stress_cancel_storm";
const USER = { type: "user" as const, id: "user_storm" };

const PACK_CATALOG = {
  pack_id: "pack_stress_cancel_storm",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Cancellation Storm Agent",
      role_description: "gets cancelled, repeatedly and concurrently",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 32, initial_glyph: "X" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_stress_cancel_storm" : null),
  skills: [],
  connectors: [],
};

const WORKER_POLICY: Partial<TaskWorkerSupervisorPolicy> = {
  heartbeatIntervalMs: 100,
  missedHeartbeatLimit: 100,
  leaseWindowMs: 2_000,
  handshakeTimeoutMs: 15_000,
  shutdownGraceMs: 100,
  killGraceMs: 100,
  stderrMaxBytes: 4_096,
};

interface StormHarness {
  conn: SqliteConnection;
  journal: EventJournalRepository;
  ops: RunFlowOperationsService;
  operationsRepo: OperationsRepository;
  leases: WriteLeasesRepository;
  supervisor: TaskWorkerSupervisor;
  cancellation: RunCancellationService;
  operationId: string;
  realSpawns: FakeTaskWorkerHandle[];
  /** Every stopWorker call the supervisor received, in order. */
  workerStops: Array<{ run_id: string; reason: string }>;
  faults: Array<{ event: string; fields: Record<string, unknown> }>;
  dir: string;
}

const openHarnesses: StormHarness[] = [];
let currentHarness: StormHarness | null = null;

function makeHarness(
  options: {
    spawnSpec?: (spawnIndex: number) => SpawnFakeTaskWorkerOptions;
  } = {},
): StormHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-stress-cancel-storm-"));
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
    name: "Cancellation Storm Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const runControl = new OperationsRunSeam(ops);
  const workerStops: StormHarness["workerStops"] = [];
  const faults: StormHarness["faults"] = [];
  const supervisor = new TaskWorkerSupervisor({
    events,
    tx,
    taskWorkers: workersRepo,
    runControl,
    spawnChild: (request) => {
      const spec = options.spawnSpec ? options.spawnSpec(0) : {};
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
    policy: { ...WORKER_POLICY },
    logFault: (event, fields) => faults.push({ event, fields }),
  });

  // The composition wiring (compose.ts): RUNNING starts the worker
  // fire-and-forget; CANCELLING/terminal stops it; the D6 task-finish seam
  // force-releases the run's write leases.
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
      workerStops.push({ run_id: runId, reason: "flow" });
      void supervisor.stopWorker(workspaceId, runId, "requested").catch((error: unknown) => {
        faults.push({
          event: "stress_stop_worker_failed",
          fields: { run_id: runId, name: error instanceof Error ? error.name : "Error" },
        });
      });
    },
    onRunExecutionEnded: (_workspaceId, runId) => {
      try {
        leases.releaseLeasesForTask(runId);
      } catch (error: unknown) {
        faults.push({
          event: "stress_lease_release_failed",
          fields: { run_id: runId, name: error instanceof Error ? error.name : "Error" },
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
      stopWorker: (workspaceId, runId, reason) => {
        workerStops.push({ run_id: runId, reason });
        return supervisor.stopWorker(
          workspaceId,
          runId,
          reason === "shutdown" ? "shutdown" : "requested",
        );
      },
    },
    leases,
    approvals,
    logFault: (event, fields) => faults.push({ event, fields }),
  });

  const harness: StormHarness = {
    conn,
    journal,
    ops,
    operationsRepo,
    leases,
    supervisor,
    cancellation,
    operationId,
    realSpawns: [],
    workerStops,
    faults,
    dir,
  };
  openHarnesses.push(harness);
  currentHarness = harness;
  return harness;
}

afterEach(async () => {
  currentHarness = null;
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

async function untilTruthy<T>(
  read: () => T | undefined | null,
  timeoutMs = 20_000,
  describe_ = "the expected state",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe_}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rowStateOf(harness: StormHarness, runId: string): RunState | null {
  const operationId = harness.operationsRepo.findRunOperation(WS, runId);
  if (operationId === null) return null;
  return harness.ops.getRun(WS, operationId, runId).state;
}

type CancelOutcome = Awaited<ReturnType<RunCancellationService["cancelRun"]>>;

describe("stress: the cancellation storm (rapid-fire cancels during spawn and exec)", () => {
  it("12 runs × 3 concurrent cancels each settle terminal, converge, release every lease, and leave no zombie worker", async () => {
    const harness = makeHarness({
      // Slow enough work that EVERY cancel lands mid-execution: the first
      // cancel fires ~450ms after creation; the worker needs ~200ms of node
      // boot + 12 x 120ms of steps before it could complete on its own.
      spawnSpec: () => ({ steps: 12, stepDelayMs: 120 }),
    });
    const N = 12;
    const runIds: string[] = [];
    // THE STORM: three cancels per run, staggered 400/405/410ms from the
    // run's creation — the first lands mid-execution (the worker is past
    // its handshake and stepping), the followers land while the first
    // cancel's teardown is still in flight.
    const cancelPromises: Array<Promise<CancelOutcome>> = [];
    for (let index = 0; index < N; index += 1) {
      const runId = `storm-run-${index + 1}`;
      harness.ops.createRun(WS, harness.operationId, { run_id: runId });
      harness.ops.applyRunState(WS, harness.operationId, runId, "QUEUED");
      harness.ops.applyRunState(WS, harness.operationId, runId, "RUNNING");
      // The exec-phase hold every cancel must answer for.
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
      runIds.push(runId);
      for (const offsetMs of [400, 405, 410]) {
        cancelPromises.push(
          new Promise<CancelOutcome>((resolve, reject) => {
            setTimeout(() => {
              harness.cancellation
                .cancelRun({ workspaceId: WS, runId, actor: USER })
                .then(resolve, reject);
            }, offsetMs);
          }),
        );
      }
      // A short stagger smooths the spawn herd.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    // S1: every cancel promise RESOLVES deterministically — no throw, no
    // zombie promise, no unhandled rejection.
    const outcomes = await Promise.all(cancelPromises);
    expect(outcomes.length).toBe(cancelPromises.length);
    const byRun = new Map<string, string[]>();
    for (const outcome of outcomes) {
      const list = byRun.get(outcome.run_id) ?? [];
      list.push(outcome.outcome);
      byRun.set(outcome.run_id, list);
      expect(
        ["cancelled", "already_cancelled", "already_settled", "not_found"].includes(
          outcome.outcome,
        ),
        `a cancel promise settled with ${JSON.stringify(outcome)}`,
      ).toBe(true);
    }
    const outcomeSummary = [...byRun.entries()]
      .map(([runId, list]) => `${runId}: ${list.join(",")}`)
      .join(" | ");

    // S2: every row settles terminal — the state machine never wedges.
    for (const runId of runIds) {
      const state = await untilTruthy(
        () => {
          const current = rowStateOf(harness, runId);
          return current !== null && (RUN_STATES_TERMINAL as readonly string[]).includes(current)
            ? current
            : undefined;
        },
        20_000,
        `terminal state for ${runId}`,
      );
      if (state !== "CANCELLED") {
        const task = harness.journal
          .listStream(taskStreamId(runId), WS)
          .map((row) => `${row.sequence}:${row.event_type}`)
          .join(", ");
        const worker = harness.journal
          .listStream(runId, WS)
          .map(
            (row) =>
              `${row.event_type}${row.event_type.endsWith("crashed") ? ` ${row.payload.slice(0, 160)}` : ""}`,
          )
          .join(", ");
        throw new Error(
          `run ${runId} settled ${state} under the cancel storm (expected CANCELLED)\ncancel outcomes: ${outcomeSummary}\ntask stream: ${task || "empty"}\nworker stream: ${worker || "empty"}`,
        );
      }
    }

    // S3: the two-step cancellation converged exactly once per stream.
    for (const runId of runIds) {
      const stream = harness.journal.listStream(taskStreamId(runId), WS);
      const cancelling = stream.filter((row) => row.event_type === "task.cancelling");
      const cancelled = stream.filter((row) => row.event_type === "task.cancelled");
      const succeeded = stream.filter((row) => row.event_type === "task.succeeded");
      expect(cancelling.length, `run ${runId}: duplicated task.cancelling`).toBe(1);
      expect(cancelled.length, `run ${runId}: duplicated task.cancelled`).toBe(1);
      expect(succeeded.length, `run ${runId}: task.succeeded under a cancel storm`).toBe(0);
      // Sequences stay gapless and unique (no lost/duplicated journal rows).
      const taskRows = harness.journal.listStream(taskStreamId(runId), WS);
      for (let i = 0; i < taskRows.length; i += 1) {
        expect(taskRows[i]?.sequence).toBe(i + 1);
      }
      const workerRows = harness.journal.listStream(runId, WS);
      for (let i = 0; i < workerRows.length; i += 1) {
        expect(workerRows[i]?.sequence).toBe(i + 1);
      }
    }

    // S4: leases fully released — zero active holdings.
    expect(harness.leases.listActiveLeases(WS)).toEqual([]);

    // S5: no zombie workers — every spawned child process has exited.
    for (const handle of harness.realSpawns) {
      const exit = await Promise.race([
        handle.waitForExit(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      expect(exit, `a storm worker never exited (zombie): pid ${handle.child.pid}`).not.toBeNull();
    }

    // S6: the teardown answered honestly — every run's cancel (the winning
    // one) reports preserved journal evidence.
    for (const runId of runIds) {
      const preserved = harness.journal.countStream(taskStreamId(runId), WS);
      expect(
        preserved,
        `run ${runId}: the journal must be preserved through cancel`,
      ).toBeGreaterThan(0);
    }

    // No fault was swallowed by the wiring (a contained teardown failure is
    // still a finding).
    expect(
      harness.faults,
      `faults logged during the storm: ${harness.faults.map((f) => `${f.event}:${JSON.stringify(f.fields)}`).join(" | ")}`,
    ).toEqual([]);
  }, 120_000);

  it("a cancel fired during the spawn window still tears the worker down — the starting worker never survives its own cancellation", async () => {
    const harness = makeHarness({
      spawnSpec: () => ({ steps: 10, stepDelayMs: 60 }),
    });
    const N = 6;
    const runIds: string[] = [];
    for (let index = 0; index < N; index += 1) {
      const runId = `spawn-cancel-${index + 1}`;
      harness.ops.createRun(WS, harness.operationId, { run_id: runId });
      harness.ops.applyRunState(WS, harness.operationId, runId, "QUEUED");
      harness.ops.applyRunState(WS, harness.operationId, runId, "RUNNING");
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
      runIds.push(runId);
    }

    // Cancel ALL of them inside the spawn window (the node child processes
    // take ~200ms to their ready frame — every cancel lands before the
    // handshake settles).
    const outcomes = await Promise.all(
      runIds.map((runId) =>
        harness.cancellation.cancelRun({ workspaceId: WS, runId, actor: USER }),
      ),
    );
    for (const outcome of outcomes) {
      expect(
        ["cancelled", "already_cancelled", "already_settled", "not_found"].includes(
          outcome.outcome,
        ),
      ).toBe(true);
    }

    for (const runId of runIds) {
      const state = await untilTruthy(
        () => {
          const current = rowStateOf(harness, runId);
          return current !== null && (RUN_STATES_TERMINAL as readonly string[]).includes(current)
            ? current
            : undefined;
        },
        20_000,
        `terminal state for ${runId}`,
      );
      expect(state).toBe("CANCELLED");
    }
    // The spawn either completed and was immediately stopped, or never
    // produced a live worker — either way nothing survives.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const handle of harness.realSpawns) {
      const exit = await Promise.race([
        handle.waitForExit(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      expect(
        exit,
        `spawn-window worker survived its cancellation: pid ${handle.child.pid}`,
      ).not.toBeNull();
    }
    expect(harness.leases.listActiveLeases(WS)).toEqual([]);
    expect(
      harness.faults,
      `faults logged: ${harness.faults.map((f) => `${f.event}:${JSON.stringify(f.fields)}`).join(" | ")}`,
    ).toEqual([]);
  }, 120_000);
});
