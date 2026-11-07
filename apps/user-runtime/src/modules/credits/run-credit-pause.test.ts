/**
 * S24 chunk 1 — the D48 run-level credit pause contract test (AC1; D48, D20,
 * D21, E13, G5). THE pinning contract: a refused reservation puts the run in
 * the existing `paused` state with the explicit pause reason
 * `insufficient_credits` — a distinct, user-visible state with a recorded
 * notification — and it is EXPLICITLY NOT a `QUEUED` capacity placement (the
 * E1 resource queue is a different mechanism and never holds a credit pause)
 * and never a silent stall. The pause rides the SAME row-lifecycle applier
 * and the SAME TASK_TRANSITIONS table as every other D8 decision (never a
 * second state machine), through the `pause_insufficient_credits` row the
 * table has carried since S07.
 *
 * Real SQLite, real migrations, real journal — the same discipline as the
 * run-lifecycle tests. Vocabulary: Pack → Operations → Agents (G1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { CreditLedgerRepository } from "../../adapters/sqlite/credit-ledger-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { appliedMigrationVersions, applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { applyRowLifecycleTransition, type RowLifecycleDeps } from "../tasks/run-lifecycle.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { CreditLedgerService } from "./credit-ledger.service.ts";
import { pauseRunForInsufficientCredits } from "./run-credit-pause.ts";

const WS = "ws-credit-pause";
const AGENT = "agent_credit_pause_test";

const PACK_CATALOG = {
  pack_id: "pack_credit_pause_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Credit Pause Test Agent",
      role_description: "walks into a credit pause",
      default_provider: { provider_id: "prov_platform", model: "platform-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 7, initial_glyph: "C" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_credit_pause_test" : null),
  skills: [],
  connectors: [],
};

interface PauseHarness {
  dir: string;
  conn: SqliteConnection;
  journal: EventJournalRepository;
  ledger: CreditLedgerService;
  ops: OperationsService;
  operationId: string;
  deps: RowLifecycleDeps;
}

const harnesses: PauseHarness[] = [];

function makeHarness(): PauseHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s24-credit-pause-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ledgerRepo = new CreditLedgerRepository(tx);
  const ledger = new CreditLedgerService({ repository: ledgerRepo, tx });
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });
  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Credit Pause Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;
  const harness: PauseHarness = {
    dir,
    conn,
    journal,
    ledger,
    ops,
    operationId,
    deps: {
      tx,
      journal,
      events,
      operations: operationsRepo,
      runControl: {
        runState: (workspaceId: string, runId: string) => {
          const opId = operationsRepo.findRunOperation(workspaceId, runId);
          if (opId === null) return null;
          try {
            return ops.getRun(workspaceId, opId, runId).state;
          } catch {
            return null;
          }
        },
        applyRunState: (workspaceId: string, runId: string, state) => {
          const opId = operationsRepo.findRunOperation(workspaceId, runId);
          if (opId === null) throw new Error(`run ${runId} not found`);
          ops.applyRunState(workspaceId, opId, runId, state);
        },
      },
    },
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

/** A run walked to QUEUED through the shared applier (the pre-call state). */
function queuedRun(harness: PauseHarness, runId: string): void {
  harness.ops.createRun(WS, harness.operationId, { run_id: runId });
  const applied = applyRowLifecycleTransition(harness.deps, {
    workspaceId: WS,
    runId,
    command: "queue_task",
    actor: { type: "runtime", id: "scheduler" },
  });
  if (!applied.ok) throw new Error(`queue_task rejected: ${applied.reason}`);
}

function streamEvents(harness: PauseHarness, runId: string) {
  return harness.journal.readFrom(WS, taskStreamId(runId), 0, 10_000);
}

describe("D48 run-level credit pause (S24 AC1)", () => {
  it("appends the credit ledger as version 20 of the committed chain (v21 run-checkpoints, v22 memory, v23 backup-snapshots the head)", () => {
    const harness = makeHarness();
    expect(appliedMigrationVersions(harness.conn.db)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
  });

  it("a refused reservation pauses the run with reason insufficient_credits — explicitly not QUEUED", () => {
    const harness = makeHarness();
    const runId = "run_credit_pause_0001";
    queuedRun(harness, runId);
    // An exhausted account: no grant has ever landed, so the bounded
    // estimate cannot be reserved.
    harness.ledger.ensureAccount(WS);
    const before = harness.ledger.accountState(WS);
    expect(before?.available_units).toBe(0);

    const reservation = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: runId,
      estimate_units: 25,
    });
    expect(reservation).toEqual({
      ok: false,
      code: "insufficient_credits",
      available_units: 0,
      requested_units: 25,
    });

    // The runtime writes the D48 pause itself (never an agent, never a
    // silent stall): pause_insufficient_credits through the shared applier.
    const paused = pauseRunForInsufficientCredits(harness.deps, {
      workspaceId: WS,
      runId,
      requestedUnits: 25,
      availableUnits: 0,
    });
    expect(paused.ok).toBe(true);

    // The run is PAUSED — not QUEUED (a credit pause is never a capacity
    // placement) and not RUNNING (the model call never happened).
    const run = harness.ops.getRun(WS, harness.operationId, runId);
    expect(run.state).toBe("PAUSED");
    expect(run.state).not.toBe("QUEUED");

    // The pause reason is the recorded D48 vocabulary, visible on the run's
    // own stream: the task.paused envelope carries reason
    // insufficient_credits, the audit record names the decision, and the
    // typed run.credit_paused record is the user-visible notification.
    const events = streamEvents(harness, runId);
    const pausedEnvelope = events.find((row) => row.event_type === "task.paused");
    expect(pausedEnvelope).toBeDefined();
    const pausedPayload = JSON.parse(pausedEnvelope!.payload) as {
      payload?: { reason?: string };
    };
    expect(pausedPayload.payload?.reason).toBe("insufficient_credits");

    const audit = events.find((row) => row.event_type === "run.failure_decided");
    expect(audit).toBeDefined();
    // The journal row stores the BARE payload for non-contract-envelope
    // events (the task.* rows carry the full D26 envelope — hence the
    // nested read above; this one is flat).
    const auditPayload = JSON.parse(audit!.payload) as {
      failure_code?: string;
      decision?: string;
    };
    expect(auditPayload.failure_code).toBe("insufficient_credits");
    expect(auditPayload.decision).toBe("pause");

    const creditRecord = events.find((row) => row.event_type === "run.credit_paused");
    expect(creditRecord).toBeDefined();
    const creditPayload = JSON.parse(creditRecord!.payload) as {
      reason?: string;
      requested_units?: number;
      available_units?: number;
    };
    expect(creditPayload.reason).toBe("insufficient_credits");
    expect(creditPayload.requested_units).toBe(25);
    expect(creditPayload.available_units).toBe(0);
  });

  it("never uses the E1 capacity queue for a credit pause — no wait_for_resource placement", () => {
    const harness = makeHarness();
    const runId = "run_credit_pause_0002";
    queuedRun(harness, runId);
    harness.ledger.ensureAccount(WS);
    const reservation = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: runId,
      estimate_units: 10,
    });
    expect(reservation.ok).toBe(false);

    pauseRunForInsufficientCredits(harness.deps, {
      workspaceId: WS,
      runId,
      requestedUnits: 10,
      availableUnits: 0,
    });

    const run = harness.ops.getRun(WS, harness.operationId, runId);
    expect(run.state).not.toBe("QUEUED");
    expect(run.state).not.toBe("WAITING_FOR_RESOURCE");
    const events = streamEvents(harness, runId);
    expect(events.some((row) => row.event_type === "task.waiting_for_resource")).toBe(false);
  });

  it("the reservation refusal leaves the ledger untouched — no hold was taken", () => {
    const harness = makeHarness();
    const runId = "run_credit_pause_0003";
    queuedRun(harness, runId);
    harness.ledger.ensureAccount(WS);
    const refused = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: runId,
      estimate_units: 5,
    });
    expect(refused.ok).toBe(false);
    const state = harness.ledger.accountState(WS);
    expect(state).toEqual({
      workspace_id: WS,
      granted_units: 0,
      charged_units: 0,
      reserved_units: 0,
      available_units: 0,
      used_this_month_units: 0,
    });
  });
});
