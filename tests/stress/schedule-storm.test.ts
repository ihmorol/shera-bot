/**
 * Stress scenario 6: the schedule/watcher storm — many due schedules firing
 * simultaneously, with single-fire semantics (no double execution).
 *
 * What is REAL here: the real SchedulerService firing pipeline (the ledger
 * claim whose PK IS the idempotency key, the reservation consult, the typed
 * trigger event journalled as the run stream's origin, the deterministic
 * run id derived from the key, the autonomous D8 walk through the shared
 * row-lifecycle applier), the real TriggersRepository ledger, real SQLite,
 * and the real watcher signature machinery over real workspace files. What
 * is faked: the reservation seam (the honest recorded S24 posture — a
 * consult that allows) and the wall clock (injected).
 *
 * The storm:
 *   T1  SAME-OCCURRENCE DELUGE — 8 concurrent fireOccurrence calls for ONE
 *       due occurrence (the tick loop and the boot reconciliation and N
 *       manual deliveries all racing): exactly ONE run is created, exactly
 *       one non-deduplicated outcome, the ledger holds exactly ONE firing
 *       row for the key, and the run stream carries exactly ONE trigger
 *       event — no double execution;
 *   T2  MANY DUE TRIGGERS AT ONCE — 12 schedule triggers, every occurrence
 *       due at the same instant, all fired concurrently: each trigger gets
 *       exactly one run, every firing settles 'fired' with its run linkage,
 *       every D8 walk completes (the no-op plan walk through the shared
 *       applier), and the per-run streams are single-trigger-origin;
 *   T3  THE TICK RACING MANUAL DELIVERIES — tick() runs concurrently with
 *       manual fireOccurrence calls carrying the SAME occurrence keys: the
 *       ledger dedupes; each occurrence still lands exactly one run;
 *   T4  THE WATCHER SIGNATURE HOLDS UNDER REPEATED TICKS — a workspace file
 *       change fires exactly once; repeated ticks over unchanged content
 *       fire nothing; a content change fires once more. Watcher storms
 *       cannot manufacture a second firing (the signature is the dedup
 *       authority).
 *
 * Governing records: PRD §8/§13, E5 (at-least-once with dedup), D11 (the
 * runtime owns its clocks and queues), D20/D48 (reservation consult), D23
 * rule 6 (the ledger's PK claim), D34 (typed trigger origin), AC2/AC6/AC8.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openDatabase,
  type SqliteConnection,
} from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../apps/user-runtime/src/adapters/sqlite/operations-repository.ts";
import { TriggersRepository } from "../../apps/user-runtime/src/adapters/sqlite/triggers-repository.ts";
import { WriteLeasesRepository } from "../../apps/user-runtime/src/adapters/sqlite/write-leases-repository.ts";
import { WorkspaceFilesRepository } from "../../apps/user-runtime/src/adapters/sqlite/workspace-files-repository.ts";
import { ArtifactsRepository } from "../../apps/user-runtime/src/adapters/sqlite/artifacts-repository.ts";
import { ProjectsRepository } from "../../apps/user-runtime/src/adapters/sqlite/projects-repository.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { OperationsService } from "../../apps/user-runtime/src/modules/operations/operations.service.ts";
import { SchedulesService } from "../../apps/user-runtime/src/modules/schedules/schedules.service.ts";
import {
  SchedulerService,
  type ReservationPort,
} from "../../apps/user-runtime/src/modules/schedules/scheduler.service.ts";
import { taskStreamId } from "../../apps/user-runtime/src/modules/tasks/task-events.ts";

const WS = "ws-stress-schedule";
const AGENT = "agent_stress_schedule";
const USER_ACTOR = { type: "user" as const, id: "user_stress" };
const DUE_AT = "2026-11-02T09:00:00.000Z";

const PACK_CATALOG = {
  pack_id: "pack_stress_schedule",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Schedule Storm Agent",
      role_description: "runs scheduled work",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 34, initial_glyph: "W" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_stress_schedule" : null),
  skills: [],
  connectors: [],
};

interface StormHarness {
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  triggers: TriggersRepository;
  files: WorkspaceFilesRepository;
  schedules: SchedulesService;
  scheduler: SchedulerService;
  operationId: string;
  clock: { value: string };
  dir: string;
}

const openHarnesses: StormHarness[] = [];

function makeHarness(): StormHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-stress-schedule-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const triggers = new TriggersRepository(tx);
  const writeLeases = new WriteLeasesRepository(tx);
  const files = new WorkspaceFilesRepository(tx, writeLeases);
  const artifacts = new ArtifactsRepository(tx);
  const projects = new ProjectsRepository(tx);
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });
  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Schedule Storm Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;
  const clock = { value: "2026-11-01T12:00:00.000Z" };
  const reservations: ReservationPort = {
    reserveForRun: () => ({ ok: true, reservation_id: "res_stress" }),
  };
  const scheduler = new SchedulerService({
    workspaceId: WS,
    triggers,
    operations: operationsRepo,
    ops,
    journal,
    events,
    tx,
    reservations,
    now: () => clock.value,
    logFault: () => {},
    watcherSources: {
      files,
      artifacts,
      projects,
      agentFilesRoot: join(dir, "agent-files"),
      workspaceId: WS,
    },
  });
  const harness: StormHarness = {
    conn,
    tx,
    journal,
    ops,
    operationsRepo,
    triggers,
    files,
    schedules: new SchedulesService({
      triggers,
      operations: operationsRepo,
      tx,
      now: () => clock.value,
    }),
    scheduler,
    operationId,
    clock,
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

function createScheduleTrigger(harness: StormHarness, name: string): string {
  return harness.schedules.createTrigger(WS, {
    kind: "schedule",
    name,
    target_operation_id: harness.operationId,
    config: {
      cron: "0 9 * * 1",
      plan: { prompt: `Storm plan for ${name}.` },
      provider: { provider_id: "prov_fake", model: "fake-model" },
    },
    catch_up_policy: "skip",
    actor: USER_ACTOR,
  }).trigger_id;
}

describe("stress: the schedule/watcher storm (single-fire under concurrent deliveries)", () => {
  it("8 concurrent deliveries of ONE due occurrence create exactly one run, one firing row, and one trigger event", async () => {
    const harness = makeHarness();
    const triggerId = createScheduleTrigger(harness, "deluge trigger");
    const key = `schedule:${triggerId}:${DUE_AT}`;

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.scheduler.fireOccurrence(WS, triggerId, {
          idempotencyKey: key,
          dueAt: DUE_AT,
          detail: { due_at: DUE_AT },
        }),
      ),
    );
    const fired = outcomes.filter((outcome) => outcome.outcome !== "deduplicated");
    expect(
      fired.length,
      `exactly one delivery must execute; got ${JSON.stringify(outcomes.map((o) => o.outcome))}`,
    ).toBe(1);
    expect(outcomes.filter((o) => o.outcome === "deduplicated").length).toBe(7);
    const winner = fired[0];
    if (winner === undefined || winner.outcome !== "fired" || winner.runId === null) {
      throw new Error(`the winning delivery did not fire: ${JSON.stringify(winner)}`);
    }

    // Exactly ONE run exists, linked from the single firing row.
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs.length).toBe(1);
    expect(runs[0]?.run_id).toBe(winner.runId);
    const firings = harness.triggers.listRecentFirings(WS, triggerId, 100);
    expect(
      firings.filter((row) => row.idempotency_key === key).length,
      "the ledger must hold exactly one row for the occurrence key",
    ).toBe(1);
    expect(firings[0]?.outcome).toBe("fired");
    expect(firings[0]?.run_id).toBe(winner.runId);

    // The run stream carries exactly ONE trigger event (the G2 origin).
    const stream = harness.journal.listStream(taskStreamId(winner.runId), WS);
    expect(stream.filter((row) => row.event_type === "trigger.scheduled").length).toBe(1);
    // The no-op plan walk settles the run SUCCEEDED through the shared D8
    // applier — and exactly once (no duplicated lifecycle terminal).
    expect(runs[0]?.state).toBe("SUCCEEDED");
    expect(stream.filter((row) => row.event_type === "task.succeeded").length).toBe(1);
  }, 60_000);

  it("12 schedule triggers due simultaneously all fire exactly once with settled runs", async () => {
    const harness = makeHarness();
    const triggerIds = Array.from({ length: 12 }, (_, index) =>
      createScheduleTrigger(harness, `storm trigger ${index + 1}`),
    );

    // Every occurrence due at the SAME instant, fired concurrently.
    const outcomes = await Promise.all(
      triggerIds.map((triggerId) =>
        harness.scheduler.fireOccurrence(WS, triggerId, {
          idempotencyKey: `schedule:${triggerId}:${DUE_AT}`,
          dueAt: DUE_AT,
          detail: { due_at: DUE_AT },
        }),
      ),
    );
    expect(outcomes.every((outcome) => outcome.outcome === "fired")).toBe(true);

    // Exactly 12 runs, each trigger's firing settled 'fired' with its run.
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs.length).toBe(12);
    const runIds = new Set(runs.map((run) => run.run_id));
    expect(runIds.size).toBe(12);
    for (const triggerId of triggerIds) {
      const firings = harness.triggers.listRecentFirings(WS, triggerId, 100);
      expect(firings.length).toBe(1);
      const firing = firings[0];
      expect(firing?.outcome).toBe("fired");
      expect(firing?.run_id).not.toBeNull();
      expect(runIds.has(firing?.run_id ?? "")).toBe(true);
      // Each run's stream: exactly one trigger origin, exactly one terminal.
      const stream = harness.journal.listStream(taskStreamId(firing?.run_id ?? ""), WS);
      expect(
        stream.filter((row) => row.event_type === "trigger.scheduled").length,
        `run ${firing?.run_id} stream: ${stream.map((row) => row.event_type).join(",") || "EMPTY"}`,
      ).toBe(1);
      expect(stream.filter((row) => row.event_type === "task.succeeded").length).toBe(1);
    }
    // Cross-trigger isolation: no run carries two trigger origins.
    for (const run of runs) {
      const stream = harness.journal.listStream(taskStreamId(run.run_id), WS);
      expect(stream.filter((row) => row.event_type.startsWith("trigger.")).length).toBe(1);
    }
  }, 60_000);

  it("a scheduler tick racing manual deliveries of the same occurrences still fires each exactly once", async () => {
    const harness = makeHarness();
    const triggerIds = Array.from({ length: 12 }, (_, index) =>
      createScheduleTrigger(harness, `race trigger ${index + 1}`),
    );
    // Arm every trigger's next occurrence at the harness clock's due instant
    // (the tick fires whatever is due at now).
    harness.clock.value = DUE_AT;

    // tick() (the production path — it derives the SAME occurrence keys)
    // races one manual delivery per trigger with the identical key.
    const manual = triggerIds.map((triggerId) =>
      harness.scheduler.fireOccurrence(WS, triggerId, {
        idempotencyKey: `schedule:${triggerId}:${DUE_AT}`,
        dueAt: DUE_AT,
        detail: { due_at: DUE_AT },
      }),
    );
    const [tickOutcomes, manualOutcomes] = await Promise.all([
      harness.scheduler.tick().then(() => "tick-done"),
      Promise.all(manual),
    ]);
    expect(tickOutcomes).toBe("tick-done");

    // Each trigger: exactly ONE run, exactly ONE firing row — the 24 racing
    // deliveries collapse to 12 executions. (Which delivery wins the ledger
    // claim is event-loop ordering, not an invariant.)
    const runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs.length).toBe(12);
    expect(manualOutcomes.length).toBe(12);
    for (const triggerId of triggerIds) {
      const firings = harness.triggers.listRecentFirings(WS, triggerId, 100);
      expect(firings.length, `trigger ${triggerId} must hold exactly one firing row`).toBe(1);
      const stream = harness.journal.listStream(taskStreamId(firings[0]?.run_id ?? ""), WS);
      expect(
        stream.filter((row) => row.event_type === "trigger.scheduled").length,
        `trigger ${triggerId} firing: outcome=${firings[0]?.outcome} run=${firings[0]?.run_id} stream=${stream.map((row) => row.event_type).join(",") || "EMPTY"}`,
      ).toBe(1);
    }
  }, 60_000);

  it("a workspace-file watcher fires exactly once per real change and never for repeated ticks over the same content", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "file_watch",
      name: "stress dataset watch",
      target_operation_id: harness.operationId,
      config: {
        scope: "workspace",
        path_uri: "workspace://datasets/report.md",
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });

    // First tick: the baseline adoption (a boot never replays history).
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);

    // THE WATCHER STORM: many rapid writes to the watched path between
    // ticks — the signature machinery collapses them into ONE firing on the
    // next tick (once per real change, never per intermediate write).
    for (let version = 1; version <= 12; version += 1) {
      harness.files.write(
        WS,
        "workspace://datasets/report.md",
        USER_ACTOR,
        Buffer.from(`storm version ${version}`),
        "text/markdown",
      );
    }
    await harness.scheduler.tick();
    let runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs.length, "twelve intermediate writes must collapse into ONE firing").toBe(1);

    // Repeated ticks over the UNCHANGED content: no double execution.
    for (let i = 0; i < 5; i += 1) {
      await harness.scheduler.tick();
    }
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);

    // One real content change: exactly one more firing.
    harness.files.write(
      WS,
      "workspace://datasets/report.md",
      USER_ACTOR,
      Buffer.from("final version"),
      "text/markdown",
    );
    await harness.scheduler.tick();
    runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs.length).toBe(2);
    // And the second firing's stream is single-origin too.
    const second = runs[1];
    const stream = harness.journal.listStream(taskStreamId(second?.run_id ?? ""), WS);
    expect(stream.filter((row) => row.event_type.startsWith("trigger.")).length).toBe(1);
  }, 60_000);
});
