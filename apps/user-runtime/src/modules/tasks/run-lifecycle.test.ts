/**
 * Row-lifecycle forward-walk tests (S28 chunk 3; PRD §8, D8, D11): the shared
 * row-lifecycle applier serves the runtime scheduler's autonomous-task walk —
 * queue_task / start_task / complete_task / request_approval join the failure
 * and cancellation commands as first-class commands over the SAME
 * TASK_TRANSITIONS table (never a second state machine). Every step journals
 * one contract lifecycle envelope on the run's task stream and advances the
 * row through the seam — the same discipline the S22 decisions follow.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { applyRowLifecycleTransition } from "./run-lifecycle.ts";
import { taskStreamId } from "./task-events.ts";

const WS = "ws-forward";
const AGENT = "agent_forward_test";

const PACK_CATALOG = {
  pack_id: "pack_forward_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Forward Test Agent",
      role_description: "walks forward",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 7, initial_glyph: "F" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_forward_test" : null),
  skills: [],
  connectors: [],
};

interface ForwardHarness {
  dir: string;
  conn: SqliteConnection;
  journal: EventJournalRepository;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  operationId: string;
  seamWrites: Array<{ run_id: string; state: string }>;
}

const harnesses: ForwardHarness[] = [];

function makeHarness(): ForwardHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-forward-"));
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
  const operationId = ops
    .createOperation(WS, {
      definition_ref: null,
      name: "Forward Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    })
    .operation_id;
  const seamWrites: ForwardHarness["seamWrites"] = [];
  const harness: ForwardHarness = {
    dir,
    conn,
    journal,
    ops,
    operationsRepo,
    operationId,
    seamWrites,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

function lifecycleDeps(harness: ForwardHarness) {
  // ONE shared transaction primitive: the journal append joins the open
  // atomic unit (AC2) — two wrappers over one database would nest SQLite
  // transactions and fail.
  const tx = new SqliteTransactions(harness.conn.db);
  return {
    tx,
    journal: harness.journal,
    events: new EventsService(harness.journal, tx),
    operations: harness.operationsRepo,
    runControl: {
      runState: (workspaceId: string, runId: string) => {
        const opId = harness.operationsRepo.findRunOperation(workspaceId, runId);
        if (opId === null) return null;
        try {
          return harness.ops.getRun(workspaceId, opId, runId).state;
        } catch {
          return null;
        }
      },
      applyRunState: (workspaceId: string, runId: string, state: never) => {
        const opId = harness.operationsRepo.findRunOperation(workspaceId, runId);
        if (opId === null) throw new Error(`run ${runId} not found`);
        harness.seamWrites.push({ run_id: runId, state });
        harness.ops.applyRunState(workspaceId, opId, runId, state);
      },
    },
    now: () => "2026-10-31T12:00:00.000Z",
  };
}

describe("the row-lifecycle forward walk (the scheduler's D8 walk)", () => {
  it("walks CREATED -> QUEUED -> RUNNING -> SUCCEEDED with one envelope per step", () => {
    const harness = makeHarness();
    const runId = `run_forward_${1}`;
    harness.ops.createRun(WS, harness.operationId, { run_id: runId });
    const deps = lifecycleDeps(harness);

    const queued = applyRowLifecycleTransition(deps, {
      workspaceId: WS,
      runId,
      command: "queue_task",
      actor: { type: "runtime", id: "scheduler" },
    });
    expect(queued).toMatchObject({ ok: true, toState: "QUEUED" });
    const started = applyRowLifecycleTransition(deps, {
      workspaceId: WS,
      runId,
      command: "start_task",
      actor: { type: "runtime", id: "scheduler" },
    });
    expect(started).toMatchObject({ ok: true, toState: "RUNNING" });
    const completed = applyRowLifecycleTransition(deps, {
      workspaceId: WS,
      runId,
      command: "complete_task",
      actor: { type: "runtime", id: "scheduler" },
    });
    expect(completed).toMatchObject({ ok: true, toState: "SUCCEEDED" });

    // The row is SUCCEEDED through the seam.
    expect(harness.ops.getRun(WS, harness.operationId, runId).state).toBe("SUCCEEDED");
    expect(harness.seamWrites.map((write) => write.state)).toEqual([
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
    ]);

    // One contract lifecycle envelope per step, in order, on the run's stream.
    const stream = harness.journal.readFrom(WS, taskStreamId(runId), 0, 100);
    const lifecycle = stream.filter((row) => row.event_type.startsWith("task."));
    expect(lifecycle.map((row) => row.event_type)).toEqual([
      "task.queued",
      "task.started",
      "task.succeeded",
    ]);
  });

  it("refuses an illegal forward step (complete from CREATED) as a typed failure", () => {
    const harness = makeHarness();
    const runId = "run_forward_illegal";
    harness.ops.createRun(WS, harness.operationId, { run_id: runId });
    const result = applyRowLifecycleTransition(lifecycleDeps(harness), {
      workspaceId: WS,
      runId,
      command: "complete_task",
      actor: { type: "runtime", id: "scheduler" },
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("walks RUNNING -> WAITING_FOR_APPROVAL (the gated-plan pause)", () => {
    const harness = makeHarness();
    const runId = "run_forward_approval";
    harness.ops.createRun(WS, harness.operationId, { run_id: runId });
    const deps = lifecycleDeps(harness);
    applyRowLifecycleTransition(deps, {
      workspaceId: WS,
      runId,
      command: "queue_task",
      actor: { type: "runtime", id: "scheduler" },
    });
    applyRowLifecycleTransition(deps, {
      workspaceId: WS,
      runId,
      command: "start_task",
      actor: { type: "runtime", id: "scheduler" },
    });
    const paused = applyRowLifecycleTransition(deps, {
      workspaceId: WS,
      runId,
      command: "request_approval",
      actor: { type: "runtime", id: "scheduler" },
    });
    expect(paused).toMatchObject({ ok: true, toState: "WAITING_FOR_APPROVAL" });
    expect(harness.ops.getRun(WS, harness.operationId, runId).state).toBe("WAITING_FOR_APPROVAL");
  });
});
