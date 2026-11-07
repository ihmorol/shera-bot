/**
 * S33 restore → checkpoint resume integration (issue #34's AC: "a task
 * interrupted before the snapshot resumes from its semantic checkpoint after
 * restore"; issue #32's machinery — S31/D33/E41).
 *
 * The pin: a task interrupted BEFORE the snapshot (the run stays RUNNING
 * with a recorded semantic checkpoint — the crash window) has its checkpoint
 * survive the restore INTO A SCRATCH COPY, and the S31 RecoveryDriver over
 * the RESTORED database re-drives the run through the ONE D8 machinery —
 * the `recovery_auto_resume` transition, the `recovery.decided` marker
 * anchored to the recorded checkpoint version, the replayable basis — NOT a
 * restart from scratch and NOT a new path. The restore is S33's; the resume
 * is S31's own.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  openDatabase,
  vacuumIntoBackup,
  verifySnapshotIntegrity,
  type SqliteConnection,
} from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { RunCheckpointsRepository } from "../../adapters/sqlite/run-checkpoints-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  EventJournalRepository,
  type EventJournalRow,
} from "../../adapters/sqlite/event-journal-repository.ts";
import { BackupSnapshotsRepository } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { CheckpointService } from "../tasks/checkpoint.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { RecoveryDriver } from "../recovery/recovery-driver.service.ts";
import { BackupService } from "./backup-service.ts";
import { RestoreService } from "./restore-service.ts";

const WS = "ws_s33_restore_resume";
const AGENT = "agent_restore_resume_test";
const NOW = "2026-11-08T09:00:00.000Z";

const PACK_CATALOG = {
  pack_id: "pack_restore_resume_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Restore Resume Test Agent",
      role_description: "interrupted on cue",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_restore_resume_test" : null),
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
  journal: EventJournalRepository;
  ops: OperationsService;
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
  const checkpointService = new CheckpointService({
    tx,
    journal,
    events,
    checkpoints,
    now: () => NOW,
  });
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
    now: () => NOW,
  });
  return { conn, journal, ops, checkpoints, checkpointService, driver, resumeCalls };
}

describe("S33 restore → semantic checkpoint resume (the S31 machinery, E41)", () => {
  it("a task interrupted before the snapshot resumes from its semantic checkpoint after restore", async () => {
    // ── The LIVE side: the run, the boundary, the interruption. ──
    const parent = mkdtempSync(join(tmpdir(), "shera-s33-resume-"));
    tempDirs.push(parent);
    const liveDataDir = join(parent, "live", "data");
    mkdirSync(liveDataDir, { recursive: true });
    const live = buildRuntime(join(liveDataDir, "runtime.db"));

    const operationId = live.ops.createOperation(WS, {
      definition_ref: null,
      name: "Restore Resume Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    }).operation_id;
    const runId = "run_restore_resume_1";
    live.ops.createRun(WS, operationId, { run_id: runId });
    live.ops.applyRunState(WS, operationId, runId, "RUNNING");

    // The semantic checkpoint (the S21 executor's succeeded-tool boundary):
    // a READ_ONLY tool that declared `replayable` — the auto-resume class.
    const verdict = live.checkpointService.recordFromToolExecution({
      workspaceId: WS,
      taskId: runId,
      conversationId: operationId,
      executionId: "exec_restore_resume_1",
      toolId: "tool_document_parse",
      capabilities: ["read_only"],
      recovery: "replayable",
      riskClass: "READ_ONLY",
      argsDigest: "digest_restore_resume_1",
    });
    expect(verdict.ok).toBe(true);
    const liveCheckpoint = live.checkpoints.latestForTask(WS, runId);
    expect(liveCheckpoint).not.toBeNull();

    // The interruption: the run stays RUNNING (the crash window) — nothing
    // else is written. The snapshot now captures run + checkpoint.
    const snapshots = new BackupSnapshotsRepository(new SqliteTransactions(live.conn.db));
    const service = new BackupService({
      workspaceId: WS,
      dbPath: join(liveDataDir, "runtime.db"),
      snapshotRoot: join(parent, "live", "data.snapshots"),
      volumeRoots: [liveDataDir],
      exportDatabase: (target) => vacuumIntoBackup(live.conn.db, target),
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots,
      now: () => NOW,
    });
    const taken = await service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;

    // ── The RESTORE into the SCRATCH copy. ──
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
      now: () => NOW,
    });
    const restored = await restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(restored.restored).toBe(true);
    if (!restored.restored) return;

    // ── The RESTORED side: the SAME S31 machinery, the restored database. ──
    const restoredRuntime = buildRuntime(join(restoredDataDir, "runtime.db"));
    const restoredCheckpoint = restoredRuntime.checkpoints.latestForTask(WS, runId);
    expect(restoredCheckpoint).not.toBeNull();
    // The semantic checkpoint is THE checkpoint — version, step kind, the
    // pending action with its declared recovery class, and the resume
    // instructions survived the restore exactly.
    expect(restoredCheckpoint?.checkpoint_version).toBe(liveCheckpoint?.checkpoint_version);
    expect(restoredCheckpoint?.step_kind).toBe(liveCheckpoint?.step_kind);
    expect(restoredCheckpoint?.resume_instructions).toBe(liveCheckpoint?.resume_instructions);
    const pending = restoredCheckpoint?.pending_action_json
      ? (JSON.parse(restoredCheckpoint.pending_action_json) as Record<string, unknown>)
      : null;
    expect(pending).toMatchObject({
      kind: "tool_execution",
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });

    // The restored run is still the interrupted RUNNING run.
    expect(restoredRuntime.ops.getRun(WS, operationId, runId).state).toBe("RUNNING");

    // The S31 RecoveryDriver over the RESTORED database: the interrupted run
    // auto-resumes on the `replayable` basis — the semantic checkpoint is
    // the resume basis, not a restart from scratch.
    const scan = await restoredRuntime.driver.recoverInterruptedRuns();
    const visited = scan.visited.find((row) => row.runId === runId);
    expect(visited?.outcome.outcome).toBe("resumed");
    if (visited?.outcome.outcome !== "resumed") return;
    expect(visited.outcome.basis).toBe("replayable");
    expect(restoredRuntime.resumeCalls).toEqual([
      { runId, basis: "replayable", idempotencyKey: null },
    ]);

    // The D8 machinery walked: the runtime-actor `recovery_auto_resume`
    // transition (the run is RUNNING again with the recovery decision on its
    // stream) and the `recovery.decided` marker anchored to the checkpoint
    // version — the resume claim is checkpoint-anchored, never exact-restart.
    const stream = restoredRuntime.journal.readFrom(WS, taskStreamId(runId), 0, 1_000);
    const types = stream.map((row: EventJournalRow) => row.event_type);
    expect(types).toContain("recovery.decided");
    const decided = stream
      .filter((row: EventJournalRow) => row.event_type === "recovery.decided")
      .map((row: EventJournalRow) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(
      decided.some(
        (row) =>
          row["resume_from_checkpoint_version"] === restoredCheckpoint?.checkpoint_version &&
          row["basis"] === "replayable" &&
          row["replayed"] === true,
      ),
    ).toBe(true);
  });
});
