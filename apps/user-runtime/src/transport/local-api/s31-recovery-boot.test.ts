/**
 * S31 chunk 3 — the composed boot walk (PRD §13, AC19/AC25; issue #32).
 *
 * The restart-recovery composition, END TO END over the composed runtime:
 * the gateway boots over a store a crashed previous gateway left behind
 * (interrupted runs, dead worker rows, checkpoints), and the boot sequence —
 * the S16 worker reconciliation FIRST, then the S31 recovery scan — decides
 * every recovery-owned run from the recorded checkpoints:
 *
 *  - the interrupted `replayable` run re-drives through the REAL supervisor
 *    (the fake worker child spawns; the run's stream shows the new worker);
 *  - the interrupted `needs_human` run lands RECOVERY_REQUIRED with the
 *    honest no-replay marker — and no worker ever spawns for it;
 *  - the run a pending approval is waiting on is untouched;
 *  - no WS client (no browser) is attached for ANY of it — the AC25
 *    browser-closure survival leg.
 *
 * The `recovery` handle's bootPass is the awaited boot entry (tests and
 * operators); the composition runs it exactly once, after reconciliation.
 *
 * Governing records: PRD §13, D8, D32, D33, E13; AC19/AC25.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { RunCheckpointsRepository } from "../../adapters/sqlite/run-checkpoints-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { CheckpointService } from "../../modules/tasks/checkpoint.service.ts";
import { taskStreamId } from "../../modules/tasks/task-events.ts";
import { EventsService } from "../../modules/events/events.service.ts";
import { OperationsService } from "../../modules/operations/operations.service.ts";
import { composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const WS = "ws_s31_boot";
const AGENT = "agent_boot_test";
const NOW = "2026-11-04T13:00:00.000Z";

const tempDirs: string[] = [];
const runtimes: RuntimeHandle[] = [];

afterAll(() => {
  for (const runtime of runtimes.splice(0)) {
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

/** Pre-seed the crashed state through the raw repositories (the previous
 * gateway's rows), BEFORE the new gateway composes over the same file. */
function seedCrashedState(dbPath: string): {
  operationId: string;
  replayable: string;
  ambiguous: string;
  approvalRun: string;
} {
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const taskWorkers = new TaskWorkersRepository(tx);
  const checkpoints = new RunCheckpointsRepository(tx);
  const checkpointService = new CheckpointService({ tx, journal, events, checkpoints, now: () => NOW });
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: {
      pack_id: "pack_student",
      pack_version: "1.0.0",
      agents: [
        {
          agent_id: AGENT,
          display_name: "Boot Test Agent",
          role_description: "crashed mid-run",
          default_provider: { provider_id: "fake", model: "fake-model" },
          skills: [],
          tools: [],
          connectors: [],
          ui_identity: { avatar_hue: 17, initial_glyph: "B" },
          home_operation_id: null,
        },
      ],
      locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_student" : null),
      skills: [],
      connectors: [],
    },
  });

  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Boot Recovery Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const replayable = "run_boot_replayable";
  const ambiguous = "run_boot_ambiguous";
  const approvalRun = "run_boot_approval";
  for (const [runId, state] of [
    [replayable, "RUNNING"],
    [ambiguous, "RUNNING"],
    [approvalRun, "WAITING_FOR_APPROVAL"],
  ] as const) {
    ops.createRun(WS, operationId, { run_id: runId });
    ops.applyRunState(WS, operationId, runId, state);
  }

  const take = (runId: string, stepId: string, pending: Record<string, unknown>): void => {
    const verdict = checkpointService.record({
      workspaceId: WS,
      taskId: runId,
      conversationId: operationId,
      stepId,
      stepKind: "completed_search",
      completedActions: [{ kind: "tool_execution", summary: "the crashed boundary" }],
      pendingAction: pending as never,
      artifactRefs: [],
      resumeInstructions: `Resume ${runId} from ${stepId}.`,
    });
    if (!verdict.ok) throw new Error(`checkpoint refused: ${verdict.safeMessage}`);
  };
  take(replayable, "step_boot_1", {
    kind: "tool_execution",
    summary: "parse the document",
    recovery_class: "replayable",
  });
  take(ambiguous, "step_boot_2", {
    kind: "tool_execution",
    summary: "send the external request",
    recovery_class: "needs_human",
  });

  // The dead worker rows the crash left behind — a real dead pid (a process
  // that already exited), so the reaper's probe is honest.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid ?? 1;
  const stamp = NOW;
  for (const runId of [replayable, ambiguous]) {
    taskWorkers.insertWorker({
      workspace_id: WS,
      run_id: runId,
      worker_id: `wk_dead_${runId}`,
      pid: deadPid,
      state: "running",
      heartbeat_at: stamp,
      lease_expires_at: stamp,
      last_progress_json: null,
      started_at: stamp,
    });
  }

  return { operationId, replayable, ambiguous, approvalRun };
}

describe("S31 composed boot walk — recovery decisions at gateway start", () => {
  it("resumes the replayable run through the real supervisor, pauses the ambiguous run, and touches nothing waiting on an approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s31-boot-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "runtime.db");
    const seeded = seedCrashedState(dbPath);

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
      report!.visited.map((entry: { runId: string; outcome: unknown }) => [entry.runId, entry.outcome]),
    );
    expect(visited.get(seeded.replayable)).toMatchObject({ outcome: "resumed" });
    expect(visited.get(seeded.ambiguous)).toMatchObject({ outcome: "paused_for_review" });
    // The waiting run never enters the scan's remit at all.
    expect(visited.has(seeded.approvalRun)).toBe(false);

    // The stream evidence: the TASK stream (task:<run_id>) holds the
    // lifecycle + checkpoint + recovery markers; the RAW run stream holds
    // the worker events (the S13 run-stream semantics the supervisor and
    // the reaper journal on).
    const conn = openDatabase(dbPath);
    const journal = new EventJournalRepository(new SqliteTransactions(conn.db));
    const taskStreamOf = (runId: string): string[] =>
      journal
        .readFrom(WS, taskStreamId(runId), 0, 1_000)
        .map((row) => row.event_type);
    const workerStreamOf = (runId: string): string[] =>
      journal.readFrom(WS, runId, 0, 1_000).map((row) => row.event_type);
    const replayableTask = taskStreamOf(seeded.replayable);
    const replayableWorkers = workerStreamOf(seeded.replayable);
    const ambiguousTask = taskStreamOf(seeded.ambiguous);
    const ambiguousWorkers = workerStreamOf(seeded.ambiguous);
    conn.close();

    expect(replayableTask).toContain("checkpoint.taken");
    expect(replayableWorkers).toContain("worker.reaped");
    expect(replayableTask).toContain("recovery.decided");
    expect(replayableWorkers).toContain("worker.started");
    // The ambiguous run: paused, honest marker, and NO worker ever spawned.
    expect(ambiguousTask).toContain("recovery.decided");
    expect(ambiguousTask).toContain("task.recovery_required");
    expect(ambiguousWorkers).not.toContain("worker.started");
  }, 30_000);
});
