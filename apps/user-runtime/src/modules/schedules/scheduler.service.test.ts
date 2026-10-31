/**
 * Scheduler fire-pipeline tests (S28 chunk 3; PRD §8, E5, D11, D17, D20/D48,
 * D23 rule 6, G2): the runtime scheduler's firing engine — the idempotency
 * claim, the reservation consult (the honest S24 seam), the D17 provider-gate
 * consult, the typed trigger event journalled as the run stream's origin
 * (G2), the run row with parent linkage (AC6), and the autonomous D8 walk —
 * all against real SQLite through the same machinery every other run uses.
 *
 * The clock is injected; the tests drive fireOccurrence directly (the tick
 * loop is the production convenience, not the test driver).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { SchedulesService } from "./schedules.service.ts";
import { SchedulerService, type ReservationPort, type SchedulerPlanRunner } from "./scheduler.service.ts";

const WS = "ws-scheduler";
const AGENT = "agent_scheduler_test";
const OP = "op_scheduled";

const PACK_CATALOG = {
  pack_id: "pack_scheduler_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Scheduler Test Agent",
      role_description: "runs on schedule",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 11, initial_glyph: "S" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_scheduler_test" : null),
  skills: [],
  connectors: [],
};

interface SchedulerHarness {
  dir: string;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  schedules: SchedulesService;
  scheduler: SchedulerService;
  operationId: string;
  reservations: { calls: number; allow: boolean };
  gate: { calls: number; allow: boolean; refusals: string[] };
  clock: { value: string };
}

const harnesses: SchedulerHarness[] = [];

function makeHarness(now = "2026-10-31T12:00:00.000Z"): SchedulerHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-scheduler-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const triggers = new TriggersRepository(tx);
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });
  const operationId = ops
    .createOperation(WS, {
      definition_ref: null,
      name: "Scheduled Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    })
    .operation_id;
  if (operationId !== OP) {
    // The tests address the operation through the service-created id.
  }
  const schedules = new SchedulesService({ triggers, operations: operationsRepo, tx, now: () => now });
  const reservations = { calls: 0, allow: true };
  const gate = { calls: 0, allow: true, refusals: [] as string[] };
  const clock = { value: now };
  const reservationPort: ReservationPort = {
    reserveForRun: (input) => {
      reservations.calls += 1;
      if (!reservations.allow) {
        return { ok: false, code: "insufficient_credits" as const };
      }
      return { ok: true as const, reservation_id: `res_${input.run_id}` };
    },
  };
  const scheduler = new SchedulerService({
    workspaceId: WS,
    triggers,
    operations: operationsRepo,
    ops,
    journal,
    events,
    tx,
    reservations: reservationPort,
    runGate: {
      checkRunStart: (_workspaceId, providerId) => {
        gate.calls += 1;
        if (!gate.allow) {
          gate.refusals.push(providerId);
          return {
            ok: false as const,
            code: "PROVIDER_CREDENTIAL_REVOKED",
            safe_message: "no credential",
          };
        }
        return { ok: true as const };
      },
    },
    now: () => clock.value,
    logFault: () => {},
  });
  const harness: SchedulerHarness = {
    dir,
    conn,
    tx,
    journal,
    ops,
    operationsRepo,
    schedules,
    scheduler,
    operationId,
    reservations,
    gate,
    clock,
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

function createScheduleTrigger(
  harness: SchedulerHarness,
  overrides: Record<string, unknown> = {},
): string {
  const created = harness.schedules.createTrigger(WS, {
    kind: "schedule",
    name: "weekly literature sweep",
    target_operation_id: harness.operationId,
    config: {
      cron: "0 9 * * 1",
      plan: { prompt: "Compile the weekly literature sweep." },
      provider: { provider_id: "prov_fake", model: "fake-model" },
    },
    catch_up_policy: "skip",
    actor: { type: "user", id: "emon" },
    ...overrides,
  });
  return created.trigger_id;
}

describe("the fire pipeline (at-least-once with the ledger claim)", () => {
  it("fires one occurrence into exactly one run with the typed trigger event as the run's origin", async () => {
    const harness = makeHarness();
    const triggerId = createScheduleTrigger(harness);
    const dueAt = "2026-11-02T09:00:00.000Z";

    const outcome = await harness.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: `schedule:${triggerId}:${dueAt}`,
      dueAt,
      detail: { due_at: dueAt },
    });
    expect(outcome).toMatchObject({ outcome: "fired" });
    if (outcome.outcome !== "fired") return;

    // Exactly one run row, CREATED -> ... -> SUCCEEDED.
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run_id).toBe(outcome.runId);
    expect(runs[0]?.state).toBe("SUCCEEDED");
    expect(runs[0]?.provider_snapshot).toMatchObject({ provider_id: "prov_fake" });

    // The typed trigger event is the run stream's FIRST event (G2 origin),
    // followed by the D8 walk envelopes.
    const stream = harness.journal.readFrom(WS, `task:${outcome.runId}`, 0, 100);
    expect(stream[0]?.event_type).toBe("trigger.scheduled");
    const lifecycle = stream.map((row) => row.event_type).filter((type) => type.startsWith("task."));
    expect(lifecycle).toEqual(["task.queued", "task.started", "task.succeeded"]);

    // The ledger settles: fired + run linkage + the trigger's bookkeeping.
    const firing = harness.journal;
    const view = harness.schedules.getTriggerView(WS, triggerId);
    expect(view?.last_fired_at).toBe("2026-10-31T12:00:00.000Z");
    expect(view?.last_occurrence_at).toBe(dueAt);
    expect(view?.next_occurrence_at).toBe("2026-11-09T09:00:00.000Z");
    expect(view?.recent_firings).toHaveLength(1);
    expect(view?.recent_firings[0]).toMatchObject({ outcome: "fired", run_id: outcome.runId });
    void firing;
  });

  it("answers a duplicate occurrence with the ledger's deduplicated outcome and creates NO second run", async () => {
    const harness = makeHarness();
    const triggerId = createScheduleTrigger(harness);
    const dueAt = "2026-11-02T09:00:00.000Z";
    const occurrence = {
      idempotencyKey: `schedule:${triggerId}:${dueAt}`,
      dueAt,
      detail: { due_at: dueAt },
    };
    const first = await harness.scheduler.fireOccurrence(WS, triggerId, occurrence);
    expect(first.outcome).toBe("fired");
    const duplicate = await harness.scheduler.fireOccurrence(WS, triggerId, occurrence);
    expect(duplicate).toMatchObject({ outcome: "deduplicated" });
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });

  it("pauses the trigger with the D48 reason when the reservation seam refuses (AC8)", async () => {
    const harness = makeHarness();
    harness.reservations.allow = false;
    const triggerId = createScheduleTrigger(harness);
    const outcome = await harness.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: "schedule:occ-paused",
      dueAt: "2026-11-02T09:00:00.000Z",
      detail: {},
    });
    expect(outcome).toMatchObject({ outcome: "paused_credits" });
    const view = harness.schedules.getTriggerView(WS, triggerId);
    expect(view?.state).toBe("paused");
    expect(view?.pause_reason).toBe("insufficient_credits");
    // NO run exists — nothing runs unfunded (D48: pause before the call).
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);
    // The pause is visible on the trigger's stream.
    const stream = harness.journal.readFrom(WS, `trigger:${triggerId}`, 0, 100);
    expect(stream.map((row) => row.event_type)).toContain("trigger.credit_paused");
    expect(harness.reservations.calls).toBe(1);
  });

  it("records the D17 provider refusal before any run exists (the configured proof run)", async () => {
    const harness = makeHarness();
    harness.gate.allow = false;
    const triggerId = createScheduleTrigger(harness);
    const outcome = await harness.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: "schedule:occ-refused",
      dueAt: "2026-11-02T09:00:00.000Z",
      detail: {},
    });
    expect(outcome).toMatchObject({ outcome: "refused_provider", code: "PROVIDER_CREDENTIAL_REVOKED" });
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);
    const view = harness.schedules.getTriggerView(WS, triggerId);
    expect(view?.state).toBe("active"); // a configuration state, not a pause
    expect(view?.recent_firings[0]).toMatchObject({ outcome: "refused_provider" });
    const stream = harness.journal.readFrom(WS, `trigger:${triggerId}`, 0, 100);
    expect(stream.map((row) => row.event_type)).toContain("provider.configuration_refused");
  });

  it("resumes a credit-paused trigger after top-up and fires the next occurrence (AC8)", async () => {
    const harness = makeHarness();
    const triggerId = createScheduleTrigger(harness);
    harness.reservations.allow = false;
    expect(
      (await harness.scheduler.fireOccurrence(WS, triggerId, {
        idempotencyKey: "schedule:occ-1",
        dueAt: "2026-11-02T09:00:00.000Z",
        detail: {},
      })).outcome,
    ).toBe("paused_credits");
    // The top-up: the port allows again; the scheduler's resume evaluation
    // clears the pause and the next occurrence fires.
    harness.reservations.allow = true;
    const resumed = harness.scheduler.resumeAfterTopUp(WS);
    expect(resumed.resumed).toContain(triggerId);
    const stream = harness.journal.readFrom(WS, `trigger:${triggerId}`, 0, 100);
    expect(stream.map((row) => row.event_type)).toContain("trigger.credit_resumed");
    expect(
      (await harness.scheduler.fireOccurrence(WS, triggerId, {
        idempotencyKey: "schedule:occ-2",
        dueAt: "2026-11-09T09:00:00.000Z",
        detail: {},
      })).outcome,
    ).toBe("fired");
  });

  it("links a task-completion trigger's run to its parent run (AC6)", async () => {
    const harness = makeHarness();
    // The parent run: a plain completed run in the same operation.
    harness.ops.createRun(WS, harness.operationId, { run_id: "run_parent" });
    harness.ops.applyRunState(WS, harness.operationId, "run_parent", "SUCCEEDED");
    const created = harness.schedules.createTrigger(WS, {
      kind: "task_completion",
      name: "follow-up after sweep",
      target_operation_id: harness.operationId,
      config: {
        outcomes: ["succeeded"],
        provider: { provider_id: "prov_fake", model: "fake-model" },
      } as never,
      catch_up_policy: "skip",
      actor: { type: "user", id: "emon" },
    });
    const outcome = await harness.scheduler.fireOccurrence(WS, created.trigger_id, {
      idempotencyKey: `task_completion:${created.trigger_id}:run_parent:succeeded`,
      dueAt: "2026-10-31T12:00:00.000Z",
      detail: { parent_task_id: "run_parent", outcome: "succeeded", completed_at: "2026-10-31T12:00:00.000Z" },
    });
    expect(outcome).toMatchObject({ outcome: "fired" });
    if (outcome.outcome !== "fired") return;
    const run = harness.ops.getRun(WS, harness.operationId, outcome.runId);
    expect(run.parent_task_id).toBe("run_parent");
    const stream = harness.journal.readFrom(WS, `task:${outcome.runId}`, 0, 100);
    expect(stream[0]?.event_type).toBe("trigger.task_completed");
  });

  it("drives the plan runner between start and complete; a failing plan fails the run", async () => {
    const harness = makeHarness();
    const walked: string[] = [];
    const failing = new SchedulerService({
      workspaceId: WS,
      triggers: new TriggersRepository(harness.tx),
      operations: harness.operationsRepo,
      ops: harness.ops,
      journal: harness.journal,
      events: new EventsService(harness.journal, harness.tx),
      tx: harness.tx,
      reservations: {
        reserveForRun: () => ({ ok: true as const, reservation_id: "res" }),
      },
      now: () => "2026-10-31T12:00:00.000Z",
      logFault: () => {},
      planRunner: {
        runPlan: async (input) => {
          walked.push(`${input.run_id}:${input.plan.prompt}`);
          return { ok: false as const, code: "PROVIDER_CALL_FAILED" };
        },
      } as SchedulerPlanRunner,
    });
    const triggerId = createScheduleTrigger(harness);
const outcome = await failing.fireOccurrence(WS, triggerId, {
      idempotencyKey: "schedule:occ-plan-fail",
      dueAt: "2026-11-02T09:00:00.000Z",
      detail: {},
    });
    expect(outcome).toMatchObject({ outcome: "failed", code: "PROVIDER_CALL_FAILED" });
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs[0]?.state).toBe("FAILED");
    const stream = harness.journal.readFrom(WS, `task:${runs[0]?.run_id}`, 0, 100);
    expect(stream.map((row) => row.event_type)).toContain("task.failed");
    expect(walked).toHaveLength(1);
  });
});
