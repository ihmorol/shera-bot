/**
 * S31 chunk 3 — the composed boot walk (PRD §13, AC19/AC25; issue #32).
 *
 * The restart-recovery composition, END TO END over the composed runtime —
 * and the checkpoints are written by the PRODUCTION WRITER (the P1 fix): the
 * first gateway REALLY executes each tool through the ONE executor path (the
 * S21 executor's succeeded-execution hook → the real CheckpointService
 * recordFromToolExecution), so the recovery basis is runtime data from the
 * resolved definition, never a hand-seeded pendingAction:
 *
 *  - the interrupted READ_ONLY tool that declares `replayable` auto-resumes
 *    through the REAL supervisor seam (the fake worker child spawns; the
 *    run's stream shows the new worker);
 *  - the interrupted EXTERNAL_WRITE tool that DECLARES `replayable` — the
 *    untrusted declaration exactly as tools-inventory stores it — pauses
 *    RECOVERY_REQUIRED with reason `risk_class_caps_recovery` (the trust
 *    boundary: agents never self-approve recovery, G6); no worker ever
 *    spawns for it;
 *  - the run a pending approval is waiting on is untouched;
 *  - no WS client (no browser) is attached for ANY of it — the AC25
 *    browser-closure survival leg.
 *
 * The `recovery` handle's bootPass is the awaited boot entry (tests and
 * operators); the composition runs it exactly once, after reconciliation.
 *
 * Governing records: PRD §13, D8, D32, D33, E13; AC19/AC25.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { taskStreamId } from "../../modules/tasks/task-events.ts";
import { spawnFakeTaskWorker } from "../../modules/workers/fake-task-worker.ts";
import { canonicalArgsDigest } from "../../modules/tools/tool-executor.service.ts";
import { composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const WS = "ws_s31_boot";
const AGENT = "agent_researcher"; // a pinned-pack agent (the composed gateway validates against the REAL pack)
const NOW = "2026-11-04T13:00:00.000Z";

const tempDirs: string[] = [];
const runtimes: RuntimeHandle[] = [];
/** The first gateway closes itself mid-test (the second composes over the
 * same file); afterAll skips it — a double close is a raw adapter error. */
const closedRuntimes = new WeakSet<RuntimeHandle>();

afterAll(() => {
  for (const runtime of runtimes.splice(0)) {
    if (closedRuntimes.has(runtime)) continue;
    try {
      runtime.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function track(runtime: RuntimeHandle): RuntimeHandle {
  runtimes.push(runtime);
  return runtime;
}

/** The run projection the proposal rides (the caller-held D5 projection). */
function runProjection(taskId: string): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: "conv_s31_boot",
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s31_boot" },
    pack_snapshot: { pack_id: "student", pack_version: "1.0.0", pack_hash: "0".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 3,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** The first gateway: create the operation, the runs, the two agent tools,
 * and drive BOTH tool executions through the real executor — the
 * succeeded-execution hook writes the production checkpoints. The dead
 * worker rows are the full-crash variant; `withDeadWorkerRows: false` is the
 * narrower crash window (the gateway died AFTER the checkpoint but BEFORE
 * the run's worker row existed — a RUNNING run with no worker row at all). */
async function executeCrashedWorkload(
  dbPath: string,
  opts: { withDeadWorkerRows?: boolean } = { withDeadWorkerRows: true },
): Promise<{
  operationId: string;
  replayable: string;
  capped: string;
  approvalRun: string;
}> {
  const firstGateway = track(
    composeRuntime({ dbPath, packsRoot: PACKS_ROOT, workspaceId: WS, now: () => NOW }),
  );
  // The first gateway's own boot pass visits an empty store; await it so the
  // workload below is created AFTER the scan (the pass is once-per-boot).
  await firstGateway.recovery.bootPass;

  const operationId = firstGateway.operations.createOperation(WS, {
    definition_ref: null,
    name: "Boot Recovery Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const replayable = "run_boot_replayable";
  const capped = "run_boot_capped";
  const approvalRun = "run_boot_approval";
  for (const [runId, state] of [
    [replayable, "RUNNING"],
    [capped, "RUNNING"],
    [approvalRun, "WAITING_FOR_APPROVAL"],
  ] as const) {
    firstGateway.operations.createRun(WS, operationId, { run_id: runId });
    firstGateway.operations.applyRunState(WS, operationId, runId, state);
  }

  // The dead worker rows the crash left behind — a real dead pid via the
  // EXCEPTED fake task worker (zero steps: it exits right after the
  // handshake), so the reaper's probe is honest and process spawning stays
  // inside the named adapters (the AC7 boundary contract).
  const deadHandle = spawnFakeTaskWorker({ steps: 0 });
  await deadHandle.waitForExit();
  const deadPid = deadHandle.child.pid ?? 1;
  const taskWorkers = new TaskWorkersRepository(firstGateway.tx);
  for (const runId of opts.withDeadWorkerRows ? [replayable, capped] : []) {
    taskWorkers.insertWorker({
      workspace_id: WS,
      run_id: runId,
      worker_id: `wk_dead_${runId}`,
      pid: deadPid,
      state: "running",
      heartbeat_at: NOW,
      lease_expires_at: NOW,
      last_progress_json: null,
      started_at: NOW,
    });
  }

  // The two agent-created tools, created through the runtime's OWN inventory
  // (the D38 intersection against the loaded pack's allow-list): a READ_ONLY
  // tool honestly declaring `replayable`, and an EXTERNAL_WRITE tool
  // declaring `replayable` — the untrusted declaration the risk-class cap
  // exists for (tools-inventory stores agent declarations verbatim).
  firstGateway.toolsApi.createTool({
    workspace_id: WS,
    requested_by: { type: "agent", id: AGENT },
    actor: { type: "user", id: "user_owner" },
    tool: {
      tool_id: "tool_boot_read_replayable",
      name: "Read the crash-recovery note",
      purpose: "The boot leg's READ_ONLY tool declaring replayable (auto-activates, E4).",
      input_schema: { type: "object", properties: {}, required: [] },
      output_schema: { type: "object" },
      capabilities: ["file.read"],
      risk_class: "READ_ONLY",
      inventory_scope: "shared",
      recovery: "replayable",
    },
  });
  firstGateway.toolsApi.createTool({
    workspace_id: WS,
    requested_by: { type: "agent", id: AGENT },
    actor: { type: "user", id: "user_owner" },
    tool: {
      tool_id: "tool_boot_write_declares_replayable",
      name: "Post the external update",
      purpose: "The boot leg's EXTERNAL_WRITE tool declaring replayable (the capped leg).",
      input_schema: { type: "object", properties: {}, required: [] },
      output_schema: { type: "object" },
      capabilities: ["file.write"],
      risk_class: "EXTERNAL_WRITE",
      inventory_scope: "shared",
      recovery: "replayable",
    },
  });
  // The risky tool's E4 activation is a USER decision (G6 — the agent can
  // never grant, even to itself).
  firstGateway.toolsApi.activateTool({
    workspace_id: WS,
    tool_id: "tool_boot_write_declares_replayable",
    version: "1.0.0",
    target: { kind: "agent", id: AGENT },
    actor: { type: "user", id: "user_owner" },
  });
  // The D35 gate's grant fast-path (AC26 — the grant skips the prompt, never
  // the policy check): the task-principal "always approve this tool" grant,
  // recorded in the one runtime place exactly as a user decision would.
  new ApprovalsRepository(firstGateway.tx).insertGrant({
    grant_id: "grant_s31_boot_write",
    workspace_id: WS,
    source_choice: "always-approve-this-tool",
    principal_type: "task",
    principal_id: capped,
    tool_id: "tool_boot_write_declares_replayable",
    tool_version: "1.0.0",
    capability: "file.write",
    resource_scope: `workspace:${WS}`,
    conversation_scope: "any",
    workspace_scope: WS,
    expires_at: null,
    one_time: false,
    created_by: { type: "user", id: "user_owner" },
    approved_at: NOW,
    revoked_at: null,
    args_digest: null,
    consumed_at: null,
  });

  // The two REAL executions — each settles through the executor, and each
  // settled execution's hook writes the production checkpoint (the recovery
  // basis is the resolved definition's data, never a fixture).
  const execute = (runId: string, toolId: string, capability: string): void => {
    const rawArgs = {};
    const outcome = firstGateway.tools.executeProposal({
      proposal: {
        workspace_id: WS,
        task_id: runId,
        conversation_id: "conv_s31_boot",
        tool_id: toolId,
        tool_version: "1.0.0",
        capability,
        args_digest: canonicalArgsDigest(rawArgs),
        proposal_summary: `the boot leg's ${toolId} execution`,
      },
      run: runProjection(runId),
      agent_id: AGENT,
      rawArgs,
      resource_scope: `workspace:${WS}`,
    });
    if (outcome.outcome !== "executed") {
      throw new Error(`the ${toolId} leg did not execute (got ${outcome.outcome})`);
    }
  };
  execute(replayable, "tool_boot_read_replayable", "file.read");
  execute(capped, "tool_boot_write_declares_replayable", "file.write");

  // The production-writer evidence BEFORE the restart: both checkpoints carry
  // the DECLARED class AND the runtime-verified risk class.
  const replayableRow = firstGateway.checkpoints.latestForTask(WS, replayable);
  const cappedRow = firstGateway.checkpoints.latestForTask(WS, capped);
  expect(replayableRow).not.toBeNull();
  expect(cappedRow).not.toBeNull();
  const replayablePending = JSON.parse(replayableRow!.pending_action_json!) as Record<
    string,
    unknown
  >;
  const cappedPending = JSON.parse(cappedRow!.pending_action_json!) as Record<string, unknown>;
  expect(replayablePending).toMatchObject({
    kind: "tool_execution",
    tool_id: "tool_boot_read_replayable",
    recovery_class: "replayable",
    risk_class: "READ_ONLY",
  });
  expect(cappedPending).toMatchObject({
    kind: "tool_execution",
    tool_id: "tool_boot_write_declares_replayable",
    recovery_class: "replayable",
    risk_class: "EXTERNAL_WRITE",
  });

  closedRuntimes.add(firstGateway);
  firstGateway.close();
  return { operationId, replayable, capped, approvalRun };
}

describe("S31 composed boot walk — recovery decisions at gateway start", () => {
  it("resumes the READ_ONLY replayable run through the real supervisor, pauses the WRITE tool that declared replayable, and touches nothing waiting on an approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s31-boot-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "runtime.db");
    const seeded = await executeCrashedWorkload(dbPath);

    // The NEW gateway composes over the crashed store — the fake worker
    // harness configured, exactly as the S16 wiring tests compose it. No WS
    // client is attached: the recovery walk owes nothing to a browser (the
    // AC25 browser-closure survival leg).
    const runtime = track(
      composeRuntime({
        dbPath,
        packsRoot: PACKS_ROOT,
        workspaceId: WS,
        now: () => NOW,
        workerHarness: {
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
        },
        workerPolicy: {
          heartbeatIntervalMs: 40,
          missedHeartbeatLimit: 25,
          leaseWindowMs: 150,
          handshakeTimeoutMs: 4_000,
          shutdownGraceMs: 200,
          killGraceMs: 200,
        },
      }),
    );

    // The boot pass ran after the S16 reconciliation; await it explicitly.
    const report = await runtime.recovery.bootPass;
    expect(report).not.toBeNull();
    const visited = new Map(
      report!.visited.map((entry: { runId: string; outcome: unknown }) => [
        entry.runId,
        entry.outcome,
      ]),
    );
    expect(visited.get(seeded.replayable)).toMatchObject({ outcome: "resumed" });
    // The trust boundary, composed: the WRITE tool's `replayable` declaration
    // pauses — the cap reason names the risk class, never the declaration.
    expect(visited.get(seeded.capped)).toMatchObject({
      outcome: "paused_for_review",
      reason: "risk_class_caps_recovery",
    });
    // The waiting run never enters the scan's remit at all.
    expect(visited.has(seeded.approvalRun)).toBe(false);

    // The stream evidence: the TASK stream (task:<run_id>) holds the
    // lifecycle + checkpoint + recovery markers; the RAW run stream holds
    // the worker events (the S13 run-stream semantics the supervisor and
    // the reaper journal on).
    const conn: SqliteConnection = openDatabase(dbPath);
    const journal = new EventJournalRepository(new SqliteTransactions(conn.db));
    const taskStreamOf = (runId: string): string[] =>
      journal.readFrom(WS, taskStreamId(runId), 0, 1_000).map((row) => row.event_type);
    const workerStreamOf = (runId: string): string[] =>
      journal.readFrom(WS, runId, 0, 1_000).map((row) => row.event_type);
    const replayableTask = taskStreamOf(seeded.replayable);
    const replayableWorkers = workerStreamOf(seeded.replayable);
    const cappedTask = taskStreamOf(seeded.capped);
    const cappedWorkers = workerStreamOf(seeded.capped);
    conn.close();

    expect(replayableTask).toContain("checkpoint.taken");
    expect(replayableWorkers).toContain("worker.reaped");
    expect(replayableTask).toContain("recovery.decided");
    expect(replayableWorkers).toContain("worker.started");
    // The capped run: paused with the honest marker, and NO worker ever
    // spawned — the declared-replayable WRITE effect is never re-executed.
    expect(cappedTask).toContain("recovery.decided");
    expect(cappedTask).toContain("task.recovery_required");
    expect(cappedWorkers).not.toContain("worker.started");
  }, 30_000);

  it("a runtime without a worker harness refuses the re-drive typed — resume_failed, never a fake resumed (P2 fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s31-boot-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "runtime.db");
    // The same REAL workload (the production writer wrote the checkpoints),
    // in the crash-window variant: NO worker row was ever written, so the
    // live-worker conservative rule has nothing to skip on.
    const seeded = await executeCrashedWorkload(dbPath, { withDeadWorkerRows: false });

    // NO workerHarness: the re-drive seam does not exist — the compose's
    // resume closure refuses typed and the driver records the honest outcome.
    const runtime = track(
      composeRuntime({ dbPath, packsRoot: PACKS_ROOT, workspaceId: WS, now: () => NOW }),
    );
    const report = await runtime.recovery.bootPass;
    expect(report).not.toBeNull();
    const visited = new Map(
      report!.visited.map((entry: { runId: string; outcome: unknown }) => [
        entry.runId,
        entry.outcome,
      ]),
    );
    // The resume-authorized run FAILED its re-drive honestly: the outcome says
    // resume_failed (the run stayed RUNNING with no worker), never "resumed".
    expect(visited.get(seeded.replayable)).toMatchObject({
      outcome: "resume_failed",
      reason: "resume_port_failed",
      state: "RUNNING",
    });
    // The capped run still pauses (the refusal never turns a pause into a
    // re-drive either).
    expect(visited.get(seeded.capped)).toMatchObject({ outcome: "paused_for_review" });

    // The marker records the honest no-replay accounting; the run row stayed
    // RUNNING (the interrupted state the next boot owns again).
    const conn: SqliteConnection = openDatabase(dbPath);
    const journal = new EventJournalRepository(new SqliteTransactions(conn.db));
    const decided = journal
      .readFrom(WS, taskStreamId(seeded.replayable), 0, 1_000)
      .filter((row) => row.event_type === "recovery.decided");
    expect(decided.length).toBeGreaterThan(0);
    const lastPayload = JSON.parse(decided[decided.length - 1]!.payload) as Record<string, unknown>;
    expect(lastPayload).toMatchObject({ basis: "replayable", replayed: false });
    const runState = runtime.operations.getRun(WS, seeded.operationId, seeded.replayable).state;
    expect(runState).toBe("RUNNING");
    conn.close();
  }, 30_000);
});
