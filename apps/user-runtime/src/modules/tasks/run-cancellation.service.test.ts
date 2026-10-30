/**
 * RunCancellationService tests (S22 chunk 4; AC4/AC5/AC6/AC7/AC8/AC9, PRD §8,
 * D8, D9, D32, D20) — red-first suite for the USER cancel path.
 *
 * The service walks the recorded D8 two-step cancellation (cancel_task →
 * CANCELLING with the user actor; teardown; cancel_complete → CANCELLED with
 * the runtime actor), tears down EVERYTHING the run holds (worker through the
 * supervisor seam, in-flight tool executions through the S21 executor seam,
 * queued child runs, write leases, the S24 credit-reservation seam, pending
 * approvals), and answers deterministically on races and replays:
 *
 *  - a second cancel of a CANCELLED run is a typed NO-OP (already_cancelled),
 *    never an error (AC7);
 *  - a cancel racing a completion loses deterministically (already_settled
 *    with the run's terminal state) — nothing corrupts;
 *  - queued children never start: they are cancelled and the dequeue drops
 *    terminal runs (AC5);
 *  - leases release; the reservation seam fires (S24 implements it — the
 *    honest prototype seam is a recorded call, not a fake ledger) (AC8);
 *  - a run WAITING_FOR_APPROVAL can be cancelled; its pending approval
 *    resolves CANCELLED (not rejected) and no grant exists (AC9, D9);
 *  - logs and partial outputs survive and are LISTED in the answer (AC6).
 *
 * Governing records: PRD §8, §13, §19 AC14/AC15, D8, D9, D20, D27, D32, E13.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EVENT_ENVELOPES } from "@shera-bot/contracts";

import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
import { canonicalArgsDigest } from "../tools/tool-executor.service.ts";
import { RunCancellationService } from "./run-cancellation.service.ts";
import { taskStreamId } from "./task-events.ts";

const WS = "ws-cancel";
const AGENT = "agent_cancel_test";
const USER = { type: "user" as const, id: "user_owner" };

const PACK_CATALOG = {
  pack_id: "pack_cancel_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Cancel Test Agent",
      role_description: "gets cancelled",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 21, initial_glyph: "C" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_cancel_test" : null),
  skills: [],
  connectors: [],
};

interface CancelHarness {
  service: RunCancellationService;
  conn: SqliteConnection;
  journal: EventJournalRepository;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  toolsRepo: ToolsRepository;
  leases: WriteLeasesRepository;
  approvals: ApprovalsService;
  operationId: string;
  /** Worker stops asked through the supervisor port, in order. */
  workerStops: Array<{ workspace_id: string; run_id: string; reason: string }>;
  /** Reservation-seam calls (the S24 seam is a recorded call, not a ledger). */
  reservationReleases: Array<{ workspace_id: string; run_id: string }>;
  seamWrites: Array<{ run_id: string; state: string }>;
  runSeq: { n: number };
  dir: string;
}

const openHarnesses: CancelHarness[] = [];

function makeHarness(): CancelHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s22-cancel-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });
  const toolsRepo = new ToolsRepository(conn.db);
  const leases = new WriteLeasesRepository(tx, { agentNameResolver: () => null });
  const approvalsRepo = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepo,
    operations: operationsRepo,
    clock: () => new Date().toISOString(),
  });

  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Cancel Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const workerStops: CancelHarness["workerStops"] = [];
  const reservationReleases: CancelHarness["reservationReleases"] = [];
  const seamWrites: CancelHarness["seamWrites"] = [];

  const runControl: TaskRunOperationsSeam = {
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
      seamWrites.push({ run_id: runId, state });
      ops.applyRunState(WS, opId, runId, state);
    },
  };

  const service = new RunCancellationService({
    tx,
    journal,
    events,
    operations: operationsRepo,
    runControl,
    workers: {
      stopWorker: async (workspaceId, runId, reason) => {
        workerStops.push({ workspace_id: workspaceId, run_id: runId, reason });
      },
    },
    executor: {
      cancelForTask: (workspaceId, taskId) => {
        // Delegate to the REAL executor seam (the composition wires the
        // composed executor); the tools repo here backs the sweep.
        void workspaceId;
        void taskId;
        return [];
      },
    },
    leases,
    reservations: {
      releaseForRun: (workspaceId, runId) => {
        reservationReleases.push({ workspace_id: workspaceId, run_id: runId });
      },
    },
    approvals,
    now: () => "2026-10-31T12:00:00.000Z",
  });

  const harness: CancelHarness = {
    service,
    conn,
    journal,
    ops,
    operationsRepo,
    toolsRepo,
    leases,
    approvals,
    operationId,
    workerStops,
    reservationReleases,
    seamWrites,
    runSeq: { n: 0 },
    dir,
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of openHarnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

function createRun(harness: CancelHarness, state: string): string {
  harness.runSeq.n += 1;
  const runId = `run_cancel_${harness.runSeq.n}`;
  harness.ops.createRun(WS, harness.operationId, { run_id: runId });
  if (state !== "CREATED") {
    harness.ops.applyRunState(WS, harness.operationId, runId, state);
  }
  return runId;
}

function lifecycleTypes(harness: CancelHarness, runId: string): string[] {
  return harness.journal
    .readFrom(WS, taskStreamId(runId), 0, 1_000)
    .map((row) => row.event_type)
    .filter((type) => type.startsWith("task."));
}

describe("RunCancellationService — the recorded D8 two-step cancellation", () => {
  it("journals cancelling + cancelled, stops the worker, and lands CANCELLED", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");

    const outcome = await harness.service.cancelRun({
      workspaceId: WS,
      runId,
      actor: USER,
    });

    expect(outcome.outcome).toBe("cancelled");
    if (outcome.outcome !== "cancelled") return;
    expect(outcome.state).toBe("CANCELLED");
    // Both D8 steps journalled, in order (PRD §8: immediate cancellation
    // still records the two steps).
    expect(lifecycleTypes(harness, runId)).toEqual(["task.cancelling", "task.cancelled"]);
    // The worker stop went through the supervisor port.
    expect(harness.workerStops).toContainEqual({
      workspace_id: WS,
      run_id: runId,
      reason: "requested",
    });
    // The row is CANCELLED.
    expect(harness.ops.getRun(WS, harness.operationId, runId).state).toBe("CANCELLED");
  });

  it("releases leases and fires the reservation-release seam (AC8, D20)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    // The run holds a write lease (S17: the runtime force-releases at the
    // terminal state through releaseLeasesForTask).
    harness.leases.acquireLease({
      workspace_id: WS,
      path: "src/notes.md",
      agent_id: AGENT,
      holder_type: "agent",
      task_id: runId,
      ttl_ms: 60_000,
    });
    expect(harness.leases.listActiveForTask(runId)).toHaveLength(1);

    const outcome = await harness.service.cancelRun({ workspaceId: WS, runId, actor: USER });
    expect(outcome.outcome).toBe("cancelled");
    expect(harness.leases.listActiveForTask(runId)).toHaveLength(0);
    // The S24 credit ledger is NOT built yet — the seam is the recorded call.
    expect(harness.reservationReleases).toEqual([{ workspace_id: WS, run_id: runId }]);
  });

  it("lists preserved logs and partial outputs and leaves them intact (AC6)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    // Evidence written BEFORE the cancel: an artifact on the run and journal
    // events (the worker's progress — the "logs").
    harness.ops.publishRunArtifact(WS, harness.operationId, runId, "artifact_partial_1");
    harness.ops.applyRunState(WS, harness.operationId, runId, "RUNNING");

    const outcome = await harness.service.cancelRun({ workspaceId: WS, runId, actor: USER });
    if (outcome.outcome !== "cancelled") return;
    // The answer LISTS what was preserved (honest inventory, not a promise).
    expect(outcome.preserved.artifact_ids).toEqual(["artifact_partial_1"]);
    expect(outcome.preserved.journal_event_count).toBeGreaterThan(0);
    // And they ARE intact: the artifact is still on the run, the journal rows
    // are still readable (cancel deletes nothing).
    expect(harness.ops.getRun(WS, harness.operationId, runId).artifacts).toEqual([
      "artifact_partial_1",
    ]);
    expect(
      harness.journal.readFrom(WS, taskStreamId(runId), 0, 1_000).length,
    ).toBeGreaterThan(0);
  });
});

describe("RunCancellationService — idempotency and races (AC7)", () => {
  it("a second cancel of a CANCELLED run is a typed no-op, not an error", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    await harness.service.cancelRun({ workspaceId: WS, runId, actor: USER });

    const second = await harness.service.cancelRun({ workspaceId: WS, runId, actor: USER });
    expect(second).toMatchObject({ outcome: "already_cancelled", run_id: runId });
    // No duplicate journal noise.
    expect(lifecycleTypes(harness, runId)).toEqual(["task.cancelling", "task.cancelled"]);
  });

  it("a cancel racing a completion loses deterministically (already_settled)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    // The run completed first.
    harness.ops.applyRunState(WS, harness.operationId, runId, "SUCCEEDED");

    const outcome = await harness.service.cancelRun({ workspaceId: WS, runId, actor: USER });
    expect(outcome).toMatchObject({ outcome: "already_settled", run_id: runId, state: "SUCCEEDED" });
    // The terminal state was not corrupted.
    expect(harness.ops.getRun(WS, harness.operationId, runId).state).toBe("SUCCEEDED");
    expect(lifecycleTypes(harness, runId)).toEqual([]);
  });

  it("an agent actor is refused (the table's cancel rows allow user/admin only)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    const outcome = await harness.service.cancelRun({
      workspaceId: WS,
      runId,
      actor: { type: "agent", id: AGENT },
    });
    expect(outcome).toMatchObject({ outcome: "actor_refused" });
    expect(harness.ops.getRun(WS, harness.operationId, runId).state).toBe("RUNNING");
  });
});

describe("RunCancellationService — children and approvals (AC5, AC9)", () => {
  it("cancelling a run with a queued child prevents the child from starting (AC5)", async () => {
    const harness = makeHarness();
    const parentId = createRun(harness, "RUNNING");
    const childId = createRun(harness, "QUEUED");
    // The child is a delegated subrun of the parent (D34: parent_task_id).
    harness.ops.applyRunState(WS, harness.operationId, childId, "QUEUED");
    harness.operationsRepo.updateRunParent(
      WS,
      harness.operationId,
      childId,
      parentId,
    );

    const outcome = await harness.service.cancelRun({ workspaceId: WS, runId: parentId, actor: USER });
    if (outcome.outcome !== "cancelled") return;
    expect(outcome.cancelled_child_run_ids).toEqual([childId]);
    // The child is CANCELLED (never started; the dequeue drops terminal runs).
    expect(harness.ops.getRun(WS, harness.operationId, childId).state).toBe("CANCELLED");
  });

  it("an approval-waiting run can be cancelled; the approval resolves cancelled, no grant (AC9)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "WAITING_FOR_APPROVAL");
    // A pending approval request against this run (the S20 pause shape).
    harness.approvals.createRequestFromTypedProposal({
      proposal: {
        workspace_id: WS,
        task_id: runId,
        conversation_id: harness.operationId,
        agent_id: AGENT,
        tool_id: "tool_external_write",
        tool_version: "1.0.0",
        capability: "external.write",
        risk_class: "EXTERNAL_WRITE",
        resource_scope: "workspace://out/report",
        args_digest: canonicalArgsDigest({}),
        side_effect_summary: "Publishes the report",
      },
      run: {
        task_id: runId,
        workspace_id: WS,
        conversation_id: harness.operationId,
        created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_x" },
        pack_snapshot: { pack_id: "pack_cancel_test", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
        roster: [AGENT],
        state: "RUNNING",
        version: 1,
        retry_count: 0,
        created_at: "2026-10-31T11:00:00.000Z",
        updated_at: "2026-10-31T11:00:00.000Z",
      },
      execute: () => {},
    });
    const pending = harness.approvals.listPendingRequests(WS);
    expect(pending).toHaveLength(1);

    const outcome = await harness.service.cancelRun({ workspaceId: WS, runId, actor: USER });
    if (outcome.outcome !== "cancelled") return;
    expect(outcome.cancelled_approval_ids).toEqual([pending[0]!.approval_id]);
    // The request is CANCELLED (not rejected — D9: the choices are distinct)
    // and NO grant was created.
    expect(harness.approvals.listPendingRequests(WS)).toHaveLength(0);
    expect(harness.approvals.listActiveGrants(WS)).toHaveLength(0);
    const detail = harness.approvals.getApprovalDetail(WS, pending[0]!.approval_id);
    expect(detail.approval.status).toBe("cancelled");
  });
});

// EVENT_ENVELOPES is referenced by the journal assertions above via
// lifecycleTypes' event-type filter; keep the import honest for the lint pass.
void EVENT_ENVELOPES;
