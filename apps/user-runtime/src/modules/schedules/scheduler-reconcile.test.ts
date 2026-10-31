/**
 * Scheduler catch-up + restart tests (S28 chunk 4; PRD §13, E5, AC3, AC4):
 * missed occurrences while the runtime is down are NOT blindly replayed —
 * the per-trigger catch-up-versus-skip policy applies and the decision is
 * RECORDED on the trigger's stream (AC3, fake clock); after a restart the
 * schedule fires no occurrence twice (AC4) and a crash between the ledger
 * claim and the run is re-driven exactly once (at-least-once).
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
import { SchedulerService, type ReservationPort } from "./scheduler.service.ts";

const WS = "ws-catchup";
const AGENT = "agent_catchup_test";

const PACK_CATALOG = {
  pack_id: "pack_catchup_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Catch-up Test Agent",
      role_description: "runs on schedule",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 21, initial_glyph: "C" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_catchup_test" : null),
  skills: [],
  connectors: [],
};

interface CatchupHarness {
  dir: string;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  ops: OperationsService;
  schedules: SchedulesService;
  makeScheduler: (now: () => string) => SchedulerService;
  operationId: string;
  clock: { value: string };
}

const harnesses: CatchupHarness[] = [];

function makeHarness(now: string): CatchupHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-catchup-"));
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
      name: "Catch-up Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    })
    .operation_id;
  const clock = { value: now };
  const reservations: ReservationPort = {
    reserveForRun: () => ({ ok: true, reservation_id: "res" }),
  };
  const makeScheduler = (nowFn: () => string): SchedulerService =>
    new SchedulerService({
      workspaceId: WS,
      triggers,
      operations: operationsRepo,
      ops,
      journal,
      events,
      tx,
      reservations,
      now: nowFn,
      logFault: () => {},
    });
  const harness: CatchupHarness = {
    dir,
    conn,
    tx,
    journal,
    ops,
    schedules: new SchedulesService({
      triggers,
      operations: operationsRepo,
      tx,
      now: () => clock.value,
    }),
    makeScheduler,
    operationId,
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

function createSchedule(
  harness: CatchupHarness,
  catchUpPolicy: "catch_up" | "skip",
): string {
  return harness.schedules.createTrigger(WS, {
    kind: "schedule",
    name: `weekly sweep (${catchUpPolicy})`,
    target_operation_id: harness.operationId,
    config: {
      cron: "0 9 * * 1",
      plan: { prompt: "Sweep." },
      provider: { provider_id: "prov_fake", model: "fake-model" },
    },
    catch_up_policy: catchUpPolicy,
    actor: { type: "user", id: "emon" },
  }).trigger_id;
}

describe("catch-up versus skip (AC3, fake clock — the decision is RECORDED)", () => {
  it("skips missed occurrences under the skip policy and records the decision", async () => {
    // T1: the trigger is created Monday 2026-11-02 just after 09:00 UTC.
    const harness = makeHarness("2026-11-02T09:05:00.000Z");
    const triggerId = createSchedule(harness, "skip");
    // Downtime: the runtime comes back two weeks later — TWO missed
    // Mondays (11-09, 11-16).
    harness.clock.value = "2026-11-16T12:00:00.000Z";
    const report = await harness.makeScheduler(() => harness.clock.value).reconcileBoot();
    expect(report.decisions).toHaveLength(1);
    const decision = report.decisions[0];
    expect(decision).toMatchObject({
      trigger_id: triggerId,
      policy: "skip",
      decision: "skipped",
      missed_count: 2,
      caught_up_count: 0,
    });
    // No run exists — nothing was blindly replayed (PRD §13).
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);
    // The bookkeeping jumped to the downtime's end; the next occurrence is
    // the following Monday.
    const view = harness.schedules.getTriggerView(WS, triggerId);
    expect(view?.last_occurrence_at).toBe("2026-11-16T09:00:00.000Z");
    expect(view?.next_occurrence_at).toBe("2026-11-23T09:00:00.000Z");
    // The decision is ON THE TRIGGER'S STREAM (recorded, visible).
    const stream = harness.journal.readFrom(WS, `trigger:${triggerId}`, 0, 100);
    const recorded = stream.find((row) => row.event_type === "trigger.catchup_decided");
    expect(recorded).toBeTruthy();
    // The decision record's row payload IS the raw payload (the runtime
    // registry's shape — the trigger stream events are not D26 envelopes).
    const payload = JSON.parse(String(recorded?.payload)) as {
      decision: string;
      missed_count: number;
    };
    expect(payload).toMatchObject({ decision: "skipped", missed_count: 2 });
  });

  it("catches up missed occurrences under the catch_up policy — once each, recorded", async () => {
    const harness = makeHarness("2026-11-02T09:05:00.000Z");
    const triggerId = createSchedule(harness, "catch_up");
    harness.clock.value = "2026-11-16T12:00:00.000Z";
    const report = await harness.makeScheduler(() => harness.clock.value).reconcileBoot();
    const decision = report.decisions[0];
    expect(decision).toMatchObject({
      trigger_id: triggerId,
      policy: "catch_up",
      decision: "caught_up",
      missed_count: 2,
      caught_up_count: 2,
    });
    // EXACTLY one run per missed occurrence, each with its own deterministic
    // occurrence key — never one run for two weeks, never two for one.
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs).toHaveLength(2);
    const stream = harness.journal.readFrom(WS, `trigger:${triggerId}`, 0, 100);
    const recorded = stream.find((row) => row.event_type === "trigger.catchup_decided");
    const payload = JSON.parse(String(recorded?.payload)) as {
      decision: string;
      caught_up_count: number;
    };
    expect(payload).toMatchObject({ decision: "caught_up", caught_up_count: 2 });
  });

  it("bounds the catch-up replay and records the remainder as skipped", async () => {
    const harness = makeHarness("2026-11-02T09:05:00.000Z");
    const triggerId = createSchedule(harness, "catch_up");
    // A minute-cron over ~2 days of downtime would hold thousands of
    // occurrences; the bound keeps one boot's replay finite (E37).
    const triggerRow = harness.schedules.getTriggerView(WS, triggerId);
    void triggerRow;
    // Re-point the trigger at a minute cron through the service edit.
    harness.schedules.editTrigger(WS, triggerId, {
      config: {
        cron: "* * * * *",
        plan: { prompt: "Sweep." },
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      actor: { type: "user", id: "emon" },
    });
    harness.clock.value = "2026-11-05T12:00:00.000Z";
    const report = await harness.makeScheduler(() => harness.clock.value).reconcileBoot();
    const decision = report.decisions[0];
    expect(decision).toBeDefined();
    if (decision === undefined) throw new Error("decision missing");
    expect(decision.policy).toBe("catch_up");
    expect(decision.caught_up_count).toBeLessThanOrEqual(50);
    expect(decision.missed_count).toBeGreaterThan(decision.caught_up_count);
    expect(harness.ops.listRuns(WS, harness.operationId).length).toBe(decision.caught_up_count);
  });
});

describe("restart without double-firing (AC4)", () => {
  it("re-fires nothing after a restart: the ledger and bookkeeping hold the truth", async () => {
    const harness = makeHarness("2026-11-02T09:05:00.000Z");
    const triggerId = createSchedule(harness, "skip");
    const schedulerA = harness.makeScheduler(() => harness.clock.value);
    // Week 1 fires normally.
    harness.clock.value = "2026-11-09T09:00:00.000Z";
    await schedulerA.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);

    // RESTART: a fresh scheduler over the SAME database (the gateway
    // process died; SQLite survived).
    const schedulerB = harness.makeScheduler(() => harness.clock.value);
    await schedulerB.reconcileBoot();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1); // no double-fire
    const viewA = harness.schedules.getTriggerView(WS, triggerId);

    // Week 2 fires exactly once from the restarted scheduler.
    harness.clock.value = "2026-11-16T09:00:00.000Z";
    await schedulerB.tick();
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs).toHaveLength(2);
    // And a SECOND boot at the same instant re-fires nothing.
    await harness.makeScheduler(() => harness.clock.value).reconcileBoot();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(2);
    void viewA;
  });

  it("re-drives a claimed firing whose run never landed (crash between claim and run)", async () => {
    const harness = makeHarness("2026-11-02T09:05:00.000Z");
    const triggerId = createSchedule(harness, "skip");
    // Simulate the crash: the claim exists, no run.
    const triggers = new TriggersRepository(harness.tx);
    triggers.recordFiring({
      workspace_id: WS,
      trigger_id: triggerId,
      idempotency_key: `schedule:${triggerId}:2026-11-09T09:00:00.000Z`,
      run_id: null,
      outcome: "claimed",
      detail_json: JSON.stringify({ due_at: "2026-11-09T09:00:00.000Z" }),
      fired_at: "2026-11-09T09:00:00.000Z",
    });
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);
    const report = await harness.makeScheduler(() => harness.clock.value).reconcileBoot();
    expect(report.redriven).toBe(1);
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
    // Reconciling again is a no-op (the firing settled; the deterministic
    // run id means the re-drive could never fork a duplicate).
    const report2 = await harness.makeScheduler(() => harness.clock.value).reconcileBoot();
    expect(report2.redriven).toBe(0);
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });
});
