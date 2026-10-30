/**
 * S22 chunk 3 — process-tree cancellation (AC15, D32, D27; the S19 recorded
 * pattern). Red-first: the production worker spawn adapter must give the
 * child its OWN process group (detached) and every stop must terminate the
 * WHOLE tree — a worker that exits gracefully on the shutdown frame must not
 * orphan its descendants (the exact S19 lesson: orphaned package managers
 * hold the stdio pipes; here orphaned tool processes outlive the cancelled
 * run). The test asserts the descendant is GONE with a real process probe
 * (kill(pid, 0) → ESRCH), not with a mock.
 *
 * Governing records: D32 (cancellation terminates the complete tree), D27
 * (process trees are terminated on cancellation), E32's validation-command
 * group-kill precedent; PRD §19 AC15.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { FAKE_TASK_WORKER_CHILD_SCRIPT } from "./fake-task-worker.ts";
import {
  TaskWorkerSupervisor,
  type TaskRunOperationsSeam,
} from "./task-worker-supervisor.service.ts";
import { createTaskWorkerSpawn, type TaskWorkerHarnessConfig } from "./worker-process-spawn.ts";

const WS = "ws-tree";

const PACK_CATALOG = {
  pack_id: "pack_tree_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: "agent_tree_test",
      display_name: "Tree Test Agent",
      role_description: "grows process trees",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 7, initial_glyph: "T" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === "agent_tree_test" ? "pack_tree_test" : null),
  skills: [],
  connectors: [],
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(read: () => T | undefined | null, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("S22 — process-tree cancellation (AC15)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancelling the worker kills the whole tree: no descendant survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s22-tree-"));
    dirs.push(dir);
    const markerPath = join(dir, "descendant.pid");
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const journal = new EventJournalRepository(tx);
    const events = new EventsService(journal, tx);
    const workersRepo = new TaskWorkersRepository(tx);
    const ops = new OperationsService({
      operations: new OperationsRepository(tx),
      tx,
      packCatalog: PACK_CATALOG,
    });
    const operationId = ops.createOperation(WS, {
      definition_ref: null,
      name: "Tree Operation",
      roster_agent_ids: ["agent_tree_test"],
      coordinator_agent_id: "agent_tree_test",
    }).operation_id;
    const runId = "run-tree-1";
    ops.createRun(WS, operationId, { run_id: runId });
    ops.applyRunState(WS, operationId, runId, "RUNNING");

    const runControl: TaskRunOperationsSeam = {
      runState: (_workspaceId, id) => {
        try {
          return ops.getRun(WS, operationId, id).state;
        } catch {
          return null;
        }
      },
      applyRunState: (_workspaceId, id, state) => {
        ops.applyRunState(WS, operationId, id, state);
      },
    };

    // The PRODUCTION spawn adapter (no admission policy → no prlimit wrapper),
    // driving the real fake worker child: it spawns a long-lived descendant
    // (`sleep`) after ready and records the descendant pid in the marker file.
    const harnessConfig: TaskWorkerHarnessConfig = {
      file: process.execPath,
      args: [
        FAKE_TASK_WORKER_CHILD_SCRIPT,
        "--run-id",
        "{run_id}",
        "--worker-id",
        "{worker_id}",
        "--heartbeat-ms",
        "{heartbeat_interval_ms}",
        "--steps",
        "500",
        "--step-delay-ms",
        "50",
        "--spawn-descendant",
        "--descendant-marker-file",
        markerPath,
      ],
    };
    const supervisor = new TaskWorkerSupervisor({
      events,
      tx,
      taskWorkers: workersRepo,
      runControl,
      spawnChild: createTaskWorkerSpawn(harnessConfig),
      policy: {
        heartbeatIntervalMs: 50,
        missedHeartbeatLimit: 100,
        leaseWindowMs: 500,
        handshakeTimeoutMs: 4_000,
        shutdownGraceMs: 200,
        killGraceMs: 200,
      },
    });

    try {
      await supervisor.startWorker(WS, runId);
      // The descendant exists: the marker file carries its pid.
      const descendantPid = await until(() => {
        if (!existsSync(markerPath)) return null;
        const raw = readFileSync(markerPath, "utf8").trim();
        const pid = Number(raw);
        return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
      });

      // Cancel: the escalation terminates the WHOLE group.
      await supervisor.stopWorker(WS, runId, "requested");
      await supervisor_stopSettled(supervisor, WS, runId);

      // AC15's bar: NO descendant process survives (a real process probe).
      expect(isAlive(descendantPid)).toBe(false);
    } finally {
      await supervisor.stopAll();
      conn.close();
    }
  });

  it("the spawn adapter gives the worker its own process group (the group kill can reach descendants)", async () => {
    // The detached-spawn contract: the child's process group id equals the
    // child's pid (it IS the group leader). Probed via the real adapter.
    const dir = mkdtempSync(join(tmpdir(), "shera-s22-tree-"));
    dirs.push(dir);
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const journal = new EventJournalRepository(tx);
    const events = new EventsService(journal, tx);
    const workersRepo = new TaskWorkersRepository(tx);
    const ops = new OperationsService({
      operations: new OperationsRepository(tx),
      tx,
      packCatalog: PACK_CATALOG,
    });
    const operationId = ops.createOperation(WS, {
      definition_ref: null,
      name: "Tree Operation 2",
      roster_agent_ids: ["agent_tree_test"],
      coordinator_agent_id: "agent_tree_test",
    }).operation_id;
    const runId = "run-tree-2";
    ops.createRun(WS, operationId, { run_id: runId });
    ops.applyRunState(WS, operationId, runId, "RUNNING");
    const groupProbePath = join(dir, "group.json");

    const runControl: TaskRunOperationsSeam = {
      runState: (_workspaceId, id) => {
        try {
          return ops.getRun(WS, operationId, id).state;
        } catch {
          return null;
        }
      },
      applyRunState: (_workspaceId, id, state) => {
        ops.applyRunState(WS, operationId, id, state);
      },
    };
    const harnessConfig: TaskWorkerHarnessConfig = {
      file: process.execPath,
      args: [
        FAKE_TASK_WORKER_CHILD_SCRIPT,
        "--run-id",
        "{run_id}",
        "--worker-id",
        "{worker_id}",
        "--heartbeat-ms",
        "{heartbeat_interval_ms}",
        "--steps",
        "3",
        "--step-delay-ms",
        "10",
        "--group-marker-file",
        groupProbePath,
      ],
    };
    const supervisor = new TaskWorkerSupervisor({
      events,
      tx,
      taskWorkers: workersRepo,
      runControl,
      spawnChild: createTaskWorkerSpawn(harnessConfig),
      policy: {
        heartbeatIntervalMs: 50,
        missedHeartbeatLimit: 100,
        leaseWindowMs: 500,
        handshakeTimeoutMs: 4_000,
        shutdownGraceMs: 200,
        killGraceMs: 200,
      },
    });

    try {
      await supervisor.startWorker(WS, runId);
      const probe = await until(() => {
        if (!existsSync(groupProbePath)) return null;
        return JSON.parse(readFileSync(groupProbePath, "utf8")) as {
          pid: number;
          pgid: number;
        };
      });
      // detached: the child LEADS its own group (pgid === pid).
      expect(probe.pgid).toBe(probe.pid);
    } finally {
      await supervisor.stopAll();
      conn.close();
    }
  });
});

/** Wait until the supervisor has no live incarnation left for the run. */
async function supervisor_stopSettled(
  supervisor: TaskWorkerSupervisor,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await until(() => (supervisor.presenceState(workspaceId, runId) === "none" ? true : null));
}

// The marker file writes go through the CHILD; keep an import reference for
// the lint pass (writeFileSync is used by the child script, not this suite).
void writeFileSync;
