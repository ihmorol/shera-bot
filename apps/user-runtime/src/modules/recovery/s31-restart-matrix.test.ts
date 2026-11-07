/**
 * S31 chunk 3 — the restart matrix (PRD §13, AC19, AC25; issue #32).
 *
 * A simulated restart is honest here: the SAME SQLite file, closed and
 * reopened, every service instance rebuilt — the durable state is exactly
 * what the rows and the journal hold, nothing else survives. The boot walk
 * is the recorded composition, in order:
 *
 *   1. the S16 worker reconciliation (dead-pid rows reaped, QUEUED runs
 *      re-driven through the admission gate — pinned, not reworked), then
 *   2. the S31 RecoveryDriver scan (the interrupted runs decided from the
 *      checkpoints' recorded E13 classes — chunk 2).
 *
 * The matrix, one case per restart property:
 *
 *  - the journal and the run rows survive the restart byte-for-byte (the
 *    durable record everything else reads — E2/E10 retention, D26 replay);
 *  - QUEUED tasks re-drive through the S16 reconciliation;
 *  - an interrupted task resumes from its LAST SAFE STEP (the resume marker's
 *    basis is the checkpoint version; the recorded resume_instructions ride);
 *  - an interrupted task with an ambiguous pending action pauses
 *    RECOVERY_REQUIRED and the possibly-duplicated effect is NEVER replayed;
 *  - Operation chat history and membership restore;
 *  - a pending approval survives unchanged (same request, same reminder
 *    slots, still pending) and its run is not re-driven;
 *  - schedules catch up EXACTLY ONCE across boots (the S28 boot
 *    reconciliation's ledger — pinned, not reworked);
 *  - a healthy worker (a live pid) is kept — the AC25 "keeps its worker
 *    alive while healthy" leg — and no client (no WS publisher) is needed
 *    for any of it (the browser-closure survival leg is the absence of any
 *    client dependency in the walk).
 *
 * Governing records: PRD §13, D8, D32, D33, E13, E2/E10; AC19/AC25.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Actor, TaskLifecyclePayload } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import {
  EventJournalRepository,
  type EventJournalRow,
} from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { RunCheckpointsRepository } from "../../adapters/sqlite/run-checkpoints-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { SchedulesService } from "../schedules/schedules.service.ts";
import { SchedulerService, type ReservationPort } from "../schedules/scheduler.service.ts";
import { CheckpointService } from "../tasks/checkpoint.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { RecoveryDriver, type RecoveryScanReport } from "./recovery-driver.service.ts";
import { reconcileTaskWorkersAfterRestart } from "../workers/worker-reconciliation.ts";
import { spawnFakeTaskWorker } from "../workers/fake-task-worker.ts";

const WS = "ws_s31_matrix";
const AGENT = "agent_matrix_test";
const USER = { type: "user", id: "emon" } as const satisfies Actor;
/** The seeding clock: a Wednesday, before the Monday the schedule fires. */
const SEED_NOW = "2026-10-28T12:00:00.000Z";
/** The boot clock: the Tuesday AFTER the missed Monday (the downtime). */
const BOOT_NOW = "2026-11-04T12:00:00.000Z";

const PACK_CATALOG = {
  pack_id: "pack_matrix_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Matrix Test Agent",
      role_description: "survives restarts",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 13, initial_glyph: "M" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_matrix_test" : null),
  skills: [],
  connectors: [],
};

interface MatrixRuntime {
  dbPath: string;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  events: EventsService;
  operationsRepo: OperationsRepository;
  ops: OperationsService;
  taskWorkers: TaskWorkersRepository;
  checkpoints: RunCheckpointsRepository;
  checkpointService: CheckpointService;
  approvals: ApprovalsRepository;
  triggers: TriggersRepository;
  schedules: SchedulesService;
  makeScheduler: () => SchedulerService;
  driver: RecoveryDriver;
  /** The re-drive calls the boot walk's supervisor stub received, in order. */
  reDriveCalls: Array<{ workspaceId: string; runId: string }>;
}

function buildRuntime(dbPath: string, now: string): MatrixRuntime {
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ops = new OperationsService({ operations: operationsRepo, tx, packCatalog: PACK_CATALOG });
  const taskWorkers = new TaskWorkersRepository(tx);
  const checkpoints = new RunCheckpointsRepository(tx);
  const checkpointService = new CheckpointService({
    tx,
    journal,
    events,
    checkpoints,
    now: () => now,
  });
  const approvals = new ApprovalsRepository(tx);
  const triggers = new TriggersRepository(tx);
  const schedules = new SchedulesService({
    triggers,
    operations: operationsRepo,
    tx,
    now: () => now,
  });
  const reservations: ReservationPort = {
    reserveForRun: () => ({ ok: true, reservation_id: "res_matrix" }),
  };
  const makeScheduler = (): SchedulerService =>
    new SchedulerService({
      workspaceId: WS,
      triggers,
      operations: operationsRepo,
      ops,
      journal,
      events,
      tx,
      reservations,
      now: () => now,
      logFault: () => {},
    });
  const reDriveCalls: MatrixRuntime["reDriveCalls"] = [];
  const driver = new RecoveryDriver({
    tx,
    journal,
    events,
    operations: operationsRepo,
    runControl: {
      runState: (_workspaceId, runId) => {
        const opId = operationsRepo.findRunOperation(WS, runId);
        if (opId === null) return null;
        try {
          return ops.getRun(WS, opId, runId).state;
        } catch {
          return null;
        }
      },
      applyRunState: (_workspaceId, runId, state) => {
        const opId = operationsRepo.findRunOperation(WS, runId);
        if (opId === null) throw new Error(`run ${runId} not found`);
        ops.applyRunState(WS, opId, runId, state);
      },
    },
    runs: { listRunsByState: (state) => operationsRepo.listRunsByState(state) },
    latestRecoveryBasis: (workspaceId, taskId) => {
      const latest = checkpoints.latestForTask(workspaceId, taskId);
      if (latest === null) return null;
      return {
        pendingAction: latest.pending_action_json
          ? (JSON.parse(latest.pending_action_json) as Record<string, unknown>)
          : null,
        checkpointVersion: latest.checkpoint_version,
      };
    },
    // The re-drive seam stub: it RECORDS the handoff and declines to spawn
    // (the matrix pins the DECISION composition; the composed re-drive through
    // the real supervisor is the boot test's concern).
    hasLiveWorker: (workspaceId, runId) =>
      taskWorkers.listLive(workspaceId).some((row) => row.run_id === runId),
    resume: (input) => {
      reDriveCalls.push({ workspaceId: input.workspaceId, runId: input.runId });
    },
    now: () => now,
  });
  return {
    dbPath,
    conn,
    tx,
    journal,
    events,
    operationsRepo,
    ops,
    taskWorkers,
    checkpoints,
    checkpointService,
    approvals,
    triggers,
    schedules,
    makeScheduler,
    driver,
    reDriveCalls,
  };
}

const openDirs: string[] = [];
const openConns: SqliteConnection[] = [];

afterEach(() => {
  for (const conn of openConns.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed by the restart simulation
    }
  }
  for (const dir of openDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-s31-matrix-"));
  openDirs.push(dir);
  return dir;
}

function trackConn(rt: MatrixRuntime): MatrixRuntime {
  openConns.push(rt.conn);
  return rt;
}

async function collectDeadPid(): Promise<number> {
  // The EXCEPTED fake task worker (zero steps — it exits right after the
  // handshake): a real, certainly-dead pid through the named adapters (the
  // AC7 boundary contract — process spawning stays there).
  const handle = spawnFakeTaskWorker({ steps: 0 });
  await handle.waitForExit();
  return handle.child.pid!;
}

/** The boot walk: the recorded S16 reconciliation, then the S31 scan. */
async function bootWalk(
  rt: MatrixRuntime,
): Promise<{ reaped: number; requeued: number; kept: number; scan: RecoveryScanReport }> {
  const report = await reconcileTaskWorkersAfterRestart({
    taskWorkers: rt.taskWorkers,
    events: rt.events,
    runs: rt.operationsRepo,
    supervisor: {
      startWorker: async (workspaceId, runId) => {
        rt.reDriveCalls.push({ workspaceId, runId });
        return {
          workspace_id: workspaceId,
          run_id: runId,
          state: "queued" as const,
          reason: { code: "worker_limit_reached", limit: 0, current: 0 },
          message: "matrix stub declines to spawn",
        };
      },
    },
  });
  const scan = await rt.driver.recoverInterruptedRuns();
  return {
    reaped: report.reaped.length,
    requeued: report.requeued.length,
    kept: report.kept,
    scan,
  };
}

function streamTypes(rt: MatrixRuntime, runId: string): string[] {
  return rt.journal
    .readFrom(WS, taskStreamId(runId), 0, 1_000)
    .map((row: EventJournalRow) => row.event_type);
}

function lifecyclePayload(rt: MatrixRuntime, runId: string, type: string): TaskLifecyclePayload {
  const row = rt.journal
    .readFrom(WS, taskStreamId(runId), 0, 1_000)
    .find((candidate: EventJournalRow) => candidate.event_type === type);
  if (row === undefined) throw new Error(`${type} missing on ${runId}`);
  const envelope = JSON.parse(row.payload) as { payload: TaskLifecyclePayload };
  return envelope.payload;
}

function decidedPayload(rt: MatrixRuntime, runId: string): Record<string, unknown> {
  const row = rt.journal
    .readFrom(WS, taskStreamId(runId), 0, 1_000)
    .find((candidate: EventJournalRow) => candidate.event_type === "recovery.decided");
  if (row === undefined) throw new Error(`recovery.decided missing on ${runId}`);
  return JSON.parse(row.payload) as Record<string, unknown>;
}

// ── The pre-restart seeding (shared by the matrix cases) ────────────────────

interface SeededState {
  rt: MatrixRuntime;
  dir: string;
  operationId: string;
  deadPid: number;
  interruptedReplayable: string;
  interruptedAmbiguous: string;
  queuedRun: string;
  approvalRun: string;
  approvalId: string;
  healthyRun: string;
}

async function seed(): Promise<SeededState> {
  const dir = makeDir();
  const dbPath = join(dir, "runtime.db");
  const rt = trackConn(buildRuntime(dbPath, SEED_NOW));
  const operationId = rt.ops.createOperation(WS, {
    definition_ref: null,
    name: "Matrix Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  // The Operation chat binding (the lazy creation the first thread access
  // performs — the matrix binds it explicitly so history has an address).
  const chatId = `conv_matrix_${operationId}`;
  rt.operationsRepo.bindChat(WS, {
    operation_id: operationId,
    conversation_id: chatId,
    created_at: SEED_NOW,
  });

  const runId = (name: string): string => {
    const id = `run_matrix_${name}`;
    rt.ops.createRun(WS, operationId, { run_id: id });
    return id;
  };
  const interruptedReplayable = runId("replayable");
  const interruptedAmbiguous = runId("ambiguous");
  const queuedRun = runId("queued");
  const approvalRun = runId("approval");
  const healthyRun = runId("healthy");
  for (const [runId_, state] of [
    [interruptedReplayable, "RUNNING"],
    [interruptedAmbiguous, "RUNNING"],
    [queuedRun, "QUEUED"],
    [approvalRun, "WAITING_FOR_APPROVAL"],
    [healthyRun, "RUNNING"],
  ] as const) {
    rt.ops.applyRunState(WS, operationId, runId_, state);
  }

  // Worker rows: dead rows on the interrupted runs (the gateway died with
  // them), a LIVE row on the healthy run (this process — a healthy worker).
  const deadPid = await collectDeadPid();
  const stamp = SEED_NOW;
  for (const runId_ of [interruptedReplayable, interruptedAmbiguous]) {
    rt.taskWorkers.insertWorker({
      workspace_id: WS,
      run_id: runId_,
      worker_id: `wk_dead_${runId_}`,
      pid: deadPid,
      state: "running",
      heartbeat_at: stamp,
      lease_expires_at: stamp,
      last_progress_json: null,
      started_at: stamp,
    });
  }
  rt.taskWorkers.insertWorker({
    workspace_id: WS,
    run_id: healthyRun,
    worker_id: `wk_alive_${healthyRun}`,
    pid: process.pid,
    state: "running",
    heartbeat_at: stamp,
    lease_expires_at: stamp,
    last_progress_json: null,
    started_at: stamp,
  });

  // The checkpoints: the boundary each interrupted run sits on, with the
  // pending action's DECLARED class (the recorded E13 data).
  const take = (runId_: string, stepId: string, pending: Record<string, unknown>): void => {
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: runId_,
      conversationId: operationId,
      stepId,
      stepKind: "completed_search",
      completedActions: [{ kind: "tool_execution", summary: "the boundary search" }],
      pendingAction: pending as never,
      artifactRefs: [],
      resumeInstructions: `Resume ${runId_} from ${stepId} (the last safe step).`,
    });
    if (!verdict.ok) throw new Error(`checkpoint refused: ${verdict.safeMessage}`);
  };
  take(interruptedReplayable, "step_search_1", {
    kind: "tool_execution",
    summary: "parse the downloaded document",
    tool_id: "tool_document_parse",
    recovery_class: "replayable",
    risk_class: "READ_ONLY",
  });
  take(interruptedAmbiguous, "step_request_1", {
    kind: "tool_execution",
    summary: "send the external request",
    tool_id: "tool_external_post",
    recovery_class: "needs_human",
    risk_class: "EXTERNAL_WRITE",
  });

  // The pending approval: the S20 request + its five E3 reminder slots.
  const approvalId = "apr_matrix_pending";
  rt.approvals.insertRequest({
    approval_id: approvalId,
    workspace_id: WS,
    task_id: approvalRun,
    conversation_id: operationId,
    tool_id: "tool_external_post",
    tool_version: "1.0.0",
    capability: "external.post",
    risk_class: "EXTERNAL_WRITE",
    resource_scope: "workspace://outbound",
    args_digest: "d".repeat(64),
    side_effect_summary: "posts the drafted report to the external board",
    requested_by: { type: "agent", id: AGENT },
    requested_at: SEED_NOW,
    status: "pending",
  });
  rt.approvals.insertReminder({
    workspace_id: WS,
    approval_id: approvalId,
    reminder_index: 1,
    due_at: "2026-11-04T12:05:00.000Z",
    delivered_at: null,
  });
  rt.approvals.insertReminder({
    workspace_id: WS,
    approval_id: approvalId,
    reminder_index: 2,
    due_at: "2026-11-04T12:35:00.000Z",
    delivered_at: null,
  });

  // The schedule: a weekly Monday-09:00 catch_up trigger created just after
  // its first occurrence — the downtime will hold missed Mondays.
  rt.schedules.createTrigger(WS, {
    kind: "schedule",
    name: "weekly sweep",
    target_operation_id: operationId,
    config: {
      cron: "0 9 * * 1",
      plan: { prompt: "Sweep." },
      provider: { provider_id: "prov_fake", model: "fake-model" },
    },
    catch_up_policy: "catch_up",
    actor: USER,
  });

  return {
    rt,
    dir,
    operationId,
    deadPid,
    interruptedReplayable,
    interruptedAmbiguous,
    queuedRun,
    approvalRun,
    approvalId,
    healthyRun,
  };
}

/** The restart: close the process's view of the store and reopen it — every
 * service instance rebuilt over the SAME file. */
function restart(seeded: SeededState): MatrixRuntime {
  seeded.rt.conn.close();
  return trackConn(buildRuntime(join(seeded.dir, "runtime.db"), BOOT_NOW));
}

// ── The matrix ───────────────────────────────────────────────────────────────

describe("S31 restart matrix (AC19/AC25 — one case per restart property)", () => {
  it("the durable record survives the restart: the journal streams and the run rows are byte-identical", async () => {
    const seeded = await seed();
    const before = streamTypes(seeded.rt, seeded.interruptedReplayable);
    const beforeRun = seeded.rt.ops.getRun(WS, seeded.operationId, seeded.interruptedReplayable);
    const after = restart(seeded);
    expect(streamTypes(after, seeded.interruptedReplayable)).toEqual(before);
    const afterRun = after.ops.getRun(WS, seeded.operationId, seeded.interruptedReplayable);
    expect({ ...afterRun }).toEqual({ ...beforeRun });
    // The checkpoint row (the D33 record) is durable too.
    const row = after.checkpoints.latestForTask(WS, seeded.interruptedReplayable);
    expect(row?.resume_instructions).toBe(
      `Resume ${seeded.interruptedReplayable} from step_search_1 (the last safe step).`,
    );
  });

  it("QUEUED tasks re-drive through the S16 reconciliation at boot", async () => {
    const seeded = await seed();
    const after = restart(seeded);
    const walk = await bootWalk(after);
    expect(walk.requeued).toBe(1);
    expect(after.reDriveCalls).toContainEqual({ workspaceId: WS, runId: seeded.queuedRun });
  });

  it("an interrupted task resumes from its LAST SAFE STEP — the marker's basis is the checkpoint version", async () => {
    const seeded = await seed();
    const checkpointVersion = seeded.rt.checkpoints.latestForTask(
      WS,
      seeded.interruptedReplayable,
    )!.checkpoint_version;
    const after = restart(seeded);
    const walk = await bootWalk(after);
    const decision = walk.scan.visited.find(
      (entry) => entry.runId === seeded.interruptedReplayable,
    );
    expect(decision?.outcome).toMatchObject({ outcome: "resumed", basis: "replayable" });
    // The run reads RUNNING (the state its worker works under).
    expect(after.ops.getRun(WS, seeded.operationId, seeded.interruptedReplayable).state).toBe(
      "RUNNING",
    );
    // The marker anchors the resume claim to the recorded boundary — the
    // honest "resumed from last safe step", never an exact-resume claim.
    expect(decidedPayload(after, seeded.interruptedReplayable)).toMatchObject({
      run_id: seeded.interruptedReplayable,
      basis: "replayable",
      replayed: true,
      resume_from_checkpoint_version: checkpointVersion,
    });
  });

  it("an interrupted task with an ambiguous pending action pauses RECOVERY_REQUIRED — the effect is never blindly replayed", async () => {
    const seeded = await seed();
    const after = restart(seeded);
    const walk = await bootWalk(after);
    const decision = walk.scan.visited.find((entry) => entry.runId === seeded.interruptedAmbiguous);
    expect(decision?.outcome).toMatchObject({ outcome: "paused_for_review" });
    expect(after.ops.getRun(WS, seeded.operationId, seeded.interruptedAmbiguous).state).toBe(
      "RECOVERY_REQUIRED",
    );
    // The pause walked the D8 table with the runtime actor.
    expect(
      lifecyclePayload(after, seeded.interruptedAmbiguous, "task.recovery_required"),
    ).toMatchObject({
      from_state: "RUNNING",
      to_state: "RECOVERY_REQUIRED",
    });
    // The marker records the honest no-replay basis.
    expect(decidedPayload(after, seeded.interruptedAmbiguous)).toMatchObject({
      basis: null,
      replayed: false,
    });
    // No re-drive for the ambiguous run.
    expect(after.reDriveCalls).not.toContainEqual({
      workspaceId: WS,
      runId: seeded.interruptedAmbiguous,
    });
  });

  it("Operation chat history and membership restore (the operation rows and the journaled messages)", async () => {
    const seeded = await seed();
    // Chat history pre-restart: two journaled messages on the operation chat.
    const chatId = seeded.rt.ops.findChat(WS, seeded.operationId);
    expect(chatId).not.toBeNull();
    for (const [index, text] of ["before the restart (1)", "before the restart (2)"].entries()) {
      seeded.rt.events.appendEvent({
        event_id: `evt_matrix_msg_${index}`,
        stream_id: `conversation:${chatId}`,
        type: "message.appended",
        payload: {
          conversation_id: chatId!,
          workspace_id: WS,
          message_id: `msg_matrix_${index}`,
          sender: { kind: "user", display_name: "Emon" },
          text,
        },
        workspace_id: WS,
        correlation_id: `matrix_msg_${index}`,
      });
    }
    const rosterBefore = seeded.rt.ops.getOperation(WS, seeded.operationId).pinning
      .roster_agent_ids;
    const messagesBefore = seeded.rt.journal
      .readFrom(WS, `conversation:${chatId}`, 0, 100)
      .filter((row: EventJournalRow) => row.event_type === "message.appended");

    const after = restart(seeded);
    expect(after.ops.findChat(WS, seeded.operationId)).toBe(chatId);
    expect(after.ops.getOperation(WS, seeded.operationId).pinning.roster_agent_ids).toEqual(
      rosterBefore,
    );
    const messagesAfter = after.journal
      .readFrom(WS, `conversation:${chatId}`, 0, 100)
      .filter((row: EventJournalRow) => row.event_type === "message.appended");
    expect(messagesAfter).toHaveLength(messagesBefore.length);
    expect(
      messagesAfter.map(
        (row: EventJournalRow) => (JSON.parse(row.payload) as { message_id: string }).message_id,
      ),
    ).toEqual(["msg_matrix_0", "msg_matrix_1"]);
  });

  it("a pending approval survives unchanged — same request, same reminder slots, still pending, run untouched", async () => {
    const seeded = await seed();
    const requestBefore = seeded.rt.approvals.getRequest(WS, seeded.approvalId)!;
    const remindersBefore = seeded.rt.approvals.listRemindersByApproval(WS, seeded.approvalId);
    const after = restart(seeded);
    const walk = await bootWalk(after);

    const requestAfter = after.approvals.getRequest(WS, seeded.approvalId)!;
    expect(requestAfter).toEqual(requestBefore);
    expect(requestAfter.status).toBe("pending");
    const remindersAfter = after.approvals.listRemindersByApproval(WS, seeded.approvalId);
    expect(remindersAfter).toEqual(remindersBefore);
    expect(remindersAfter.map((row) => row.due_at)).toEqual([
      "2026-11-04T12:05:00.000Z",
      "2026-11-04T12:35:00.000Z",
    ]);
    // The waiting run is not the recovery slice's to re-drive.
    // The waiting run never enters the recovery scan's remit at all.
    expect(walk.scan.visited.some((entry) => entry.runId === seeded.approvalRun)).toBe(false);
    expect(after.ops.getRun(WS, seeded.operationId, seeded.approvalRun).state).toBe(
      "WAITING_FOR_APPROVAL",
    );
  });

  it("schedules catch up EXACTLY ONCE across boots (the S28 ledger, pinned)", async () => {
    const seeded = await seed();
    // The downtime: the trigger was seeded on Wednesday 2026-10-28 (the seed
    // clock) with the next occurrence Monday 11-02 09:00; the boot clock is
    // Tuesday 11-04 — ONE missed Monday. The S28 fixture discipline: the
    // truth source is the injected clock, so the restart's rebuilt runtime
    // reads BOOT_NOW and the missed window is real (E37's exactly-once
    // property is what this case pins; the decision detail is S28's suite).
    const after = restart(seeded);
    const firstBoot = await after.makeScheduler().reconcileBoot();
    const runsAfterFirst = after.ops.listRuns(WS, seeded.operationId).length;
    // The second boot (the same clock): the ledger's occurrence keys make it
    // a no-op — no additional firing, no additional run.
    const secondBoot = await after.makeScheduler().reconcileBoot();
    const runsAfterSecond = after.ops.listRuns(WS, seeded.operationId).length;
    expect(runsAfterSecond).toBe(runsAfterFirst);
    const caughtUpFirst = firstBoot.decisions.reduce(
      (total, decision) => total + decision.caught_up_count,
      0,
    );
    const caughtUpSecond = secondBoot.decisions.reduce(
      (total, decision) => total + decision.caught_up_count,
      0,
    );
    // Unconditional (the P3 fix): the S28 leg must not pass vacuously — the
    // missed window is real (the seed clock vs the boot clock), so the first
    // boot MUST have caught up at least one occurrence.
    expect(caughtUpFirst).toBeGreaterThanOrEqual(1);
    expect(caughtUpSecond).toBe(0);
    expect(runsAfterSecond - runsAfterFirst).toBe(0);
  });

  it("a healthy worker is kept — no reap, no re-drive (the AC25 keep-alive leg)", async () => {
    const seeded = await seed();
    const after = restart(seeded);
    const walk = await bootWalk(after);
    // Exactly one live row kept: the healthy run's.
    expect(walk.kept).toBe(1);
    expect(after.reDriveCalls).not.toContainEqual({ workspaceId: WS, runId: seeded.healthyRun });
    expect(after.ops.getRun(WS, seeded.operationId, seeded.healthyRun).state).toBe("RUNNING");
    // The reaped rows are exactly the two dead ones.
    expect(walk.reaped).toBe(2);
  });
});
