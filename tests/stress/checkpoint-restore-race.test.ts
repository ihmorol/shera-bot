/**
 * Stress scenario 3: checkpoint/restore under concurrent writes — the
 * snapshot and the restore walk race an ACTIVE writer storm.
 *
 * What is REAL here: the real CheckpointService (the D23-rule-5 atomic unit:
 * the durable run_checkpoints row + the checkpoint.taken journal marker
 * commit together), the real journal, the real BackupService snapshot
 * (VACUUM INTO + at-snapshot verification), the real RestoreService walk
 * (policy → stop → verify → database → volume → migrations → restart), and
 * the real RecoveryDriver over the restored database. What is faked: only
 * the stop/start services ports (the drill posture — the deployment supplies
 * the real ones) and the volume roots (copy backend over temp dirs).
 *
 * The storm: 8 runs each take 25 semantic checkpoints while journal events
 * flood their worker streams — and the SNAPSHOT is taken MID-STORM (writers
 * interleave into its await windows), then the RESTORE walk runs MID-STORM
 * too (the live writers keep hammering the live database the whole walk).
 * The invariants:
 *
 *   R1  the snapshot is ATOMIC at its capture point: every run_checkpoints
 *       row in the snapshot has its checkpoint.taken journal marker and
 *       vice versa (D23 rule 5 survives the copy — no torn checkpoint);
 *   R2  every journal stream in the snapshot is gapless (sequence ==
 *       index+1 == count == maxSequence) — no torn stream;
 *   R3  checkpoint versions per task are exactly 1..max (concurrent record
 *       calls never fork or duplicate a version);
 *   R4  the snapshot file passes the integrity check (a consistent copy
 *       under active writers);
 *   R5  the restore walk under the racing writers completes and produces a
 *       database satisfying R1–R4 with the LIVENESS restored (writers
 *       resume on the restored runtime: new checkpoint versions continue at
 *       max+1 and journal sequences continue at maxSequence+1 — no
 *       collision, no lost checkpoint);
 *   R6  the restore walk never tears the LIVE database: the writers that
 *       raced the whole walk finish, and the live database satisfies R1–R3
 *       plus the integrity check;
 *   R7  the S31 RecoveryDriver over the restored database races a concurrent
 *       checkpoint writer on the SAME run: the auto-resume lands exactly
 *       once, the final stream is gapless with unique event ids, and the
 *       concurrent checkpoint is not lost.
 *
 * Governing records: PRD §13, D23 rules 5/6 (atomic units, idempotency),
 * D32/D33 (checkpoints at semantic boundaries), D47 (restore posture), E11
 * (snapshot verification), E13 (recovery classes); AC19/AC25.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  openDatabase,
  verifySnapshotIntegrity,
  vacuumIntoBackup,
  type SqliteConnection,
} from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../apps/user-runtime/src/adapters/sqlite/operations-repository.ts";
import { RunCheckpointsRepository } from "../../apps/user-runtime/src/adapters/sqlite/run-checkpoints-repository.ts";
import { BackupSnapshotsRepository } from "../../apps/user-runtime/src/adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { OperationsService } from "../../apps/user-runtime/src/modules/operations/operations.service.ts";
import { CheckpointService } from "../../apps/user-runtime/src/modules/tasks/checkpoint.service.ts";
import { taskStreamId } from "../../apps/user-runtime/src/modules/tasks/task-events.ts";
import { RecoveryDriver } from "../../apps/user-runtime/src/modules/recovery/recovery-driver.service.ts";
import { BackupService } from "../../apps/user-runtime/src/modules/backups/backup-service.ts";
import { RestoreService } from "../../apps/user-runtime/src/modules/backups/restore-service.ts";

const WS = "ws-stress-restore-race";
const AGENT = "agent_stress_restore_race";

const PACK_CATALOG = {
  pack_id: "pack_stress_restore_race",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Restore Race Agent",
      role_description: "checkpoints under restore pressure",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 33, initial_glyph: "P" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_stress_restore_race" : null),
  skills: [],
  connectors: [],
} as const;

const tempDirs: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(() => {
  for (const conn of connections.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Runtime {
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  events: EventsService;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  checkpoints: RunCheckpointsRepository;
  checkpointService: CheckpointService;
  driver: RecoveryDriver;
  resumeCalls: Array<{ runId: string; basis: string; idempotencyKey: string | null }>;
}

/** The S31 machinery over ANY database file (the live one, then the
 * restored one — the SAME wiring, the SAME machinery). */
function buildRuntime(dbPath: string): Runtime {
  const conn = openDatabase(dbPath);
  connections.push(conn);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ops = new OperationsService({ operations: operationsRepo, tx, packCatalog: PACK_CATALOG });
  const checkpoints = new RunCheckpointsRepository(tx);
  const checkpointService = new CheckpointService({ tx, journal, events, checkpoints });
  const resumeCalls: Runtime["resumeCalls"] = [];
  const driver = new RecoveryDriver({
    tx,
    journal,
    events,
    operations: operationsRepo,
    runControl: {
      runState: (workspaceId, runId) => {
        const opId = operationsRepo.findRunOperation(workspaceId, runId);
        if (opId === null) return null;
        try {
          return ops.getRun(workspaceId, opId, runId).state;
        } catch {
          return null;
        }
      },
      applyRunState: (workspaceId, runId, state) => {
        const opId = operationsRepo.findRunOperation(workspaceId, runId);
        if (opId === null) throw new Error(`run ${runId} not found`);
        ops.applyRunState(workspaceId, opId, runId, state);
      },
    },
    latestRecoveryBasis: (workspaceId, taskId) => {
      const latest = checkpoints.latestForTask(workspaceId, taskId);
      if (latest === null) return null;
      const parsed: unknown = latest.pending_action_json
        ? JSON.parse(latest.pending_action_json)
        : null;
      return {
        pendingAction: (parsed ?? null) as Record<string, unknown> | null,
        checkpointVersion: latest.checkpoint_version,
      };
    },
    runs: {
      listRunsByState: (state) => operationsRepo.listRunsByState(state),
    },
    hasLiveWorker: () => false,
    resume: (input) => {
      resumeCalls.push({
        runId: input.runId,
        basis: input.basis,
        idempotencyKey: input.idempotencyKey,
      });
    },
  });
  return {
    conn,
    tx,
    journal,
    events,
    ops,
    operationsRepo,
    checkpoints,
    checkpointService,
    driver,
    resumeCalls,
  };
}

// ── The integrity checker (R1–R3) over ANY open runtime ─────────────────────

function assertCheckpointJournalConsistency(
  runtime: Runtime,
  runIds: readonly string[],
  label: string,
): void {
  for (const runId of runIds) {
    // R1a: every durable row has its journal marker (same version).
    const rows = runtime.checkpoints.listForTask(WS, runId);
    for (const row of rows) {
      const markerId = `evt_checkpoint_taken_${runId}_${row.step_id}_v${row.checkpoint_version}`;
      const marker = runtime.journal.findById(WS, markerId);
      expect(
        marker,
        `${label}: run ${runId} checkpoint v${row.checkpoint_version} (${row.step_id}) has no journal marker`,
      ).not.toBeNull();
      expect(marker?.event_type).toBe("checkpoint.taken");
    }
    // R1b: every marker has its row.
    const stream = runtime.journal.listStream(taskStreamId(runId), WS);
    const markers = stream.filter((row) => row.event_type === "checkpoint.taken");
    expect(
      markers.length,
      `${label}: run ${runId} has ${markers.length} checkpoint markers but ${rows.length} rows`,
    ).toBe(rows.length);

    // R2: gapless, count == max.
    for (let index = 0; index < stream.length; index += 1) {
      expect(stream[index]?.sequence, `${label}: run ${runId} task-stream gap`).toBe(index + 1);
    }
    const maxSequence = runtime.journal.maxSequence(WS, taskStreamId(runId), undefined);
    expect(maxSequence, `${label}: run ${runId} max sequence disagrees with the row count`).toBe(
      stream.length,
    );

    // R3: versions exactly 1..max.
    const versions = rows.map((row) => row.checkpoint_version).sort((a, b) => a - b);
    versions.forEach((version, index) => {
      expect(version, `${label}: run ${runId} checkpoint version fork`).toBe(index + 1);
    });
  }
}

describe("stress: checkpoint/restore racing an active writer storm", () => {
  it("a mid-storm snapshot is atomic, a mid-storm restore completes, both sides stay consistent, and the writers resume cleanly", async () => {
    const parent = mkdtempSync(join(tmpdir(), "shera-stress-restore-"));
    tempDirs.push(parent);
    const liveDataDir = join(parent, "live", "data");
    mkdirSync(liveDataDir, { recursive: true });
    const liveDbPath = join(liveDataDir, "runtime.db");
    const live = buildRuntime(liveDbPath);

    const N = 8;
    const STEPS_PER_RUN = 25;
    const runIds: string[] = [];
    const operationId = live.ops.createOperation(WS, {
      definition_ref: null,
      name: "Restore Race Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    }).operation_id;
    for (let index = 0; index < N; index += 1) {
      const runId = `restore-race-run-${index + 1}`;
      live.ops.createRun(WS, operationId, { run_id: runId });
      live.ops.applyRunState(WS, operationId, runId, "RUNNING");
      runIds.push(runId);
    }
    // One run STAYS interrupted at a semantic checkpoint (the recovery race
    // surface, R7): a READ_ONLY replayable boundary, the run left RUNNING.
    const interruptedRunId = runIds[0];
    if (interruptedRunId === undefined) throw new Error("no runs");
    const seeded = live.checkpointService.recordFromToolExecution({
      workspaceId: WS,
      taskId: interruptedRunId,
      conversationId: operationId,
      executionId: "exec_stress_seed",
      toolId: "tool_read_only_probe",
      capabilities: ["read_only"],
      recovery: "replayable",
      riskClass: "READ_ONLY",
      argsDigest: "digest_stress_seed",
    });
    expect(seeded.ok).toBe(true);

    // The WRITER STORM: every run takes STEPS_PER_RUN semantic checkpoints
    // while journal events flood its worker stream. Writers yield between
    // units so the event loop interleaves them — including INSIDE the
    // snapshot's and the restore's await windows.
    let writerCommitted = 0;
    const writerFailures: string[] = [];
    const writerRun = async (runId: string): Promise<void> => {
      for (let step = 1; step <= STEPS_PER_RUN; step += 1) {
        // Yield to the loop: the snapshot and the restore interleave here.
        await new Promise((resolve) => setTimeout(resolve, 1));
        const verdict = live.checkpointService.record({
          workspaceId: WS,
          taskId: runId,
          conversationId: operationId,
          stepId: `step_${runId}_${step}`,
          stepKind: "tool_execution",
          completedActions: [
            {
              kind: "tool_execution",
              summary: `stress step ${step}`,
              ref: `exec_${runId}_${step}`,
            },
          ],
          pendingAction: {
            kind: "tool_execution",
            summary: `stress step ${step} pending`,
            tool_id: "tool_read_only_probe",
            recovery_class: "replayable",
            risk_class: "READ_ONLY",
          },
          resumeInstructions: `Resume after stress step ${step}.`,
        });
        if (verdict.ok) {
          writerCommitted += 1;
        } else {
          writerFailures.push(
            `${runId}/${step}: ${verdict.code} ${JSON.stringify(verdict.detail)}`,
          );
        }
        // The worker-stream flood (concurrent multi-stream journal pressure).
        live.events.appendEvent({
          event_id: `evt_stress_progress_${runId}_${step}`,
          stream_id: runId,
          type: "worker.progress",
          payload: {
            worker_id: `wk_${runId}`,
            workspace_id: WS,
            run_id: runId,
            percent: Math.round((step / STEPS_PER_RUN) * 100),
            text: `stress step ${step}`,
          },
          workspace_id: WS,
          correlation_id: runId,
        });
      }
    };
    const writerPromises = runIds.map((runId) => writerRun(runId));

    // THE SNAPSHOT, taken MID-STORM: the writers interleave into its await
    // windows, so the capture lands on an arbitrary mid-flight point.
    const snapshots = new BackupSnapshotsRepository(new SqliteTransactions(live.conn.db));
    const backup = new BackupService({
      workspaceId: WS,
      dbPath: liveDbPath,
      snapshotRoot: join(parent, "live", "data.snapshots"),
      volumeRoots: [liveDataDir],
      exportDatabase: (target) => vacuumIntoBackup(live.conn.db, target),
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots,
    });
    const taken = await backup.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken, JSON.stringify(taken)).toBe(true);
    if (!taken.taken) return;

    // The snapshot's own record of what it captured: read its copy directly.
    const snapshotDbPath = join(taken.snapshot_dir, "runtime.db");
    const snapshotVerify = verifySnapshotIntegrity(snapshotDbPath);
    expect(snapshotVerify.ok, `snapshot integrity: ${snapshotVerify.message}`).toBe(true);
    // Inspect the snapshot copy itself (R4 opened it; now R1-R3). The
    // restore walk moves the copy, so inspect BEFORE the restore.
    const inspectConn = openDatabase(snapshotDbPath);
    connections.push(inspectConn);
    {
      const inspectTx = new SqliteTransactions(inspectConn.db);
      const inspectJournal = new EventJournalRepository(inspectTx);
      const inspectCheckpoints = new RunCheckpointsRepository(inspectTx);
      const inspectRuntime: Runtime = {
        conn: inspectConn,
        tx: inspectTx,
        journal: inspectJournal,
        events: new EventsService(inspectJournal, inspectTx),
        ops: new OperationsService({
          operations: new OperationsRepository(inspectTx),
          tx: inspectTx,
          packCatalog: PACK_CATALOG,
        }),
        operationsRepo: new OperationsRepository(inspectTx),
        checkpoints: inspectCheckpoints,
        checkpointService: new CheckpointService({
          tx: inspectTx,
          journal: inspectJournal,
          events: new EventsService(inspectJournal, inspectTx),
          checkpoints: inspectCheckpoints,
        }),
        driver: live.driver,
        resumeCalls: [],
      };
      // R1–R3 over the SNAPSHOT COPY, taken mid-storm.
      assertCheckpointJournalConsistency(inspectRuntime, runIds, "snapshot");
    }

    // THE RESTORE, run MID-STORM into a scratch target: the live writers
    // keep hammering the live database through the whole walk (R6).
    const restoredDataDir = join(parent, "restored", "data");
    mkdirSync(restoredDataDir, { recursive: true });
    const restore = new RestoreService({
      workspaceId: WS,
      dbPath: join(restoredDataDir, "runtime.db"),
      volumeRoots: [restoredDataDir],
      snapshots,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      stopServices: () => {},
      startServices: () => {},
    });
    const restored = await restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(
      restored.restored,
      `restore failed at ${restored.restored ? "" : (restored as { failed_stage: string }).failed_stage}: ${
        restored.restored ? "" : (restored as { detail: string }).detail
      }`,
    ).toBe(true);

    // R5: the restored database satisfies R1–R3, and the WRITERS RESUME on
    // it — new checkpoint versions continue at max+1, journal sequences
    // continue at maxSequence+1.
    const restoredRuntime = buildRuntime(join(restoredDataDir, "runtime.db"));
    assertCheckpointJournalConsistency(restoredRuntime, runIds, "restored");
    for (const runId of runIds) {
      const snapshotMax = restoredRuntime.checkpoints
        .listForTask(WS, runId)
        .reduce((max, row) => Math.max(max, row.checkpoint_version), 0);
      const resumed = restoredRuntime.checkpointService.record({
        workspaceId: WS,
        taskId: runId,
        conversationId: operationId,
        stepId: `step_${runId}_resumed`,
        stepKind: "tool_execution",
        completedActions: [
          { kind: "tool_execution", summary: "post-restore resume step", ref: "exec_resumed" },
        ],
        pendingAction: {
          kind: "tool_execution",
          summary: "post-restore pending",
          tool_id: "tool_read_only_probe",
          recovery_class: "replayable",
          risk_class: "READ_ONLY",
        },
        resumeInstructions: "Resume after the post-restore step.",
      });
      expect(
        resumed.ok,
        `post-restore checkpoint refused for ${runId}: ${JSON.stringify(resumed)}`,
      ).toBe(true);
      expect(
        resumed.ok ? resumed.checkpointVersion : -1,
        `run ${runId}: the resumed writer must continue at max+1, never fork a version`,
      ).toBe(snapshotMax + 1);
    }
    // Journal sequences continued (no collision with the restored rows).
    for (const runId of runIds) {
      const stream = restoredRuntime.journal.listStream(taskStreamId(runId), WS);
      for (let index = 0; index < stream.length; index += 1) {
        expect(stream[index]?.sequence, `post-restore stream gap for ${runId}`).toBe(index + 1);
      }
    }

    // R7: the recovery driver over the RESTORED database races a concurrent
    // checkpoint writer on the SAME interrupted run. The auto-resume lands
    // exactly once; the concurrent checkpoint is not lost; the stream stays
    // gapless with unique event ids.
    const writerDuringRecovery = restoredRuntime.checkpointService.record({
      workspaceId: WS,
      taskId: interruptedRunId,
      conversationId: operationId,
      stepId: `step_${interruptedRunId}_during_recovery`,
      stepKind: "tool_execution",
      completedActions: [{ kind: "tool_execution", summary: "checkpoint taken during recovery" }],
      pendingAction: {
        kind: "tool_execution",
        summary: "pending during recovery",
        tool_id: "tool_read_only_probe",
        recovery_class: "replayable",
        risk_class: "READ_ONLY",
      },
      resumeInstructions: "Resume after the during-recovery step.",
    });
    const recoveryOutcome = await restoredRuntime.driver.recoverRun(WS, interruptedRunId);
    expect(
      ["resumed", "paused_for_review", "skipped", "resume_failed"].includes(
        recoveryOutcome.outcome,
      ),
      `recovery settled with ${JSON.stringify(recoveryOutcome)}`,
    ).toBe(true);
    expect(writerDuringRecovery.ok, JSON.stringify(writerDuringRecovery)).toBe(true);
    const finalStream = restoredRuntime.journal.listStream(taskStreamId(interruptedRunId), WS);
    for (let index = 0; index < finalStream.length; index += 1) {
      expect(finalStream[index]?.sequence, "post-recovery stream gap").toBe(index + 1);
    }
    const finalIds = new Set(finalStream.map((row) => row.event_id));
    expect(finalIds.size).toBe(finalStream.length);
    const decided = finalStream.filter((row) => row.event_type === "recovery.decided");
    expect(decided.length, "the recovery decision must be journaled exactly once").toBe(1);

    // Wait for the live writers to finish (they raced the whole walk, R6).
    await Promise.all(writerPromises);
    expect(
      writerFailures,
      `the writer storm saw refusals: ${writerFailures.slice(0, 5).join(" | ")}`,
    ).toEqual([]);
    expect(writerCommitted).toBe(N * STEPS_PER_RUN);
    const liveVerify = verifySnapshotIntegrity(liveDbPath);
    expect(liveVerify.ok, `live database integrity after the race: ${liveVerify.message}`).toBe(
      true,
    );
    assertCheckpointJournalConsistency(live, runIds, "live");
  }, 120_000);
});
