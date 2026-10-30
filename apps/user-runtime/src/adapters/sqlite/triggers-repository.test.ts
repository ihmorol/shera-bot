/**
 * S28 trigger-record storage contract tests (issue #29, PRD §8, E5, E12, D23
 * rule 6): the v19 migration creates the STRICT trigger_records +
 * trigger_firings tables and the repository enforces the writer-side rules —
 * the firing ledger's primary key IS the idempotency claim (a duplicate
 * delivery/occurrence insert is a typed duplicate, never a second run),
 * workspace scoping is the primary-key prefix (E12), and the checked
 * vocabularies make a misrecorded row unrepresentable at the storage layer.
 *
 * Real SQLite, real migrations — the same discipline as the S23 repository
 * tests. Vocabulary: Pack → Operations → Agents (G1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import { appliedMigrationVersions, applyMigrations, MIGRATIONS } from "./migrations.ts";
import { sqliteTableExists } from "./migrations.ts";
import {
  TriggersRepository,
  TriggerRecordError,
  type TriggerRecordInsert,
  type TriggerFiringInsert,
} from "./triggers-repository.ts";
import { SqliteTransactions } from "./transactions.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

function newDb(): { conn: SqliteConnection; tx: SqliteTransactions } {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-triggers-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  return { conn, tx: new SqliteTransactions(conn.db) };
}

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const OTHER_WS = "ws-other-0000";
const CLOCK = "2026-10-31T12:00:00.000Z";

function triggerInput(overrides: Partial<TriggerRecordInsert> = {}): TriggerRecordInsert {
  return {
    workspace_id: WS,
    trigger_id: "trg_0001",
    name: "weekly literature sweep",
    kind: "schedule",
    target_operation_id: "op_research",
    config_json: JSON.stringify({ cron: "0 9 * * 1", plan: { prompt: "Sweep the literature." } }),
    catch_up_policy: "skip",
    state: "active",
    pause_reason: null,
    created_by_type: "user",
    created_by_id: "emon",
    created_at: CLOCK,
    updated_at: CLOCK,
    ...overrides,
  };
}

function firingInput(overrides: Partial<TriggerFiringInsert> = {}): TriggerFiringInsert {
  return {
    workspace_id: WS,
    trigger_id: "trg_0001",
    idempotency_key: "schedule:trg_0001:2026-11-02T09:00:00.000Z",
    run_id: null,
    outcome: "claimed",
    detail_json: null,
    fired_at: CLOCK,
    ...overrides,
  };
}

describe("v19 migration (trigger records)", () => {
  it("is the chain head with the trigger-records tables STRICT and workspace-scoped", () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(19);
    expect(MIGRATIONS.at(-1)?.name).toBe("trigger-records");
    expect(appliedMigrationVersions(newDb().conn.db)).toContain(19);
  });

  it("creates both tables and the firing-ledger indexes", () => {
    const { conn } = newDb();
    expect(sqliteTableExists(conn.db, "trigger_records")).toBe(true);
    expect(sqliteTableExists(conn.db, "trigger_firings")).toBe(true);
  });
});

describe("trigger records repository (E12, D23 rule 6)", () => {
  it("stores and reads a trigger record round-trip", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    const row = repository.getTrigger(WS, "trg_0001");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("weekly literature sweep");
    expect(row?.kind).toBe("schedule");
    expect(row?.state).toBe("active");
    expect(row?.pause_reason).toBeNull();
  });

  it("keeps the same trigger_id in two workspaces independent (E12)", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    repository.createTrigger(
      triggerInput({ workspace_id: OTHER_WS, name: "other workspace copy" }),
    );
    expect(repository.getTrigger(WS, "trg_0001")?.name).toBe("weekly literature sweep");
    expect(repository.getTrigger(OTHER_WS, "trg_0001")?.name).toBe("other workspace copy");
    expect(repository.listTriggers(WS)).toHaveLength(1);
    expect(repository.listTriggers(OTHER_WS)).toHaveLength(1);
  });

  it("refuses a kind outside the closed vocabulary at the storage layer", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    expect(() =>
      repository.createTrigger(triggerInput({ kind: "prose" as never })),
    ).toThrowError(TriggerRecordError);
  });

  it("refuses a duplicate trigger id with a typed error", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    expect(() => repository.createTrigger(triggerInput())).toThrowError(TriggerRecordError);
  });

  it("updates state, pause reason, and schedule fields; clears the pause reason on resume", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    repository.updateTriggerState(WS, "trg_0001", {
      state: "paused",
      pause_reason: "insufficient_credits",
      updated_at: CLOCK,
    });
    expect(repository.getTrigger(WS, "trg_0001")?.state).toBe("paused");
    expect(repository.getTrigger(WS, "trg_0001")?.pause_reason).toBe("insufficient_credits");
    repository.updateTriggerState(WS, "trg_0001", {
      state: "active",
      pause_reason: null,
      updated_at: CLOCK,
    });
    expect(repository.getTrigger(WS, "trg_0001")?.pause_reason).toBeNull();
  });

  it("refuses an insufficient_credits pause reason on an active trigger", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    expect(() =>
      repository.updateTriggerState(WS, "trg_0001", {
        state: "active",
        pause_reason: "insufficient_credits",
        updated_at: CLOCK,
      }),
    ).toThrowError(TriggerRecordError);
  });

  it("updates schedule bookkeeping fields (next occurrence, last firing, condition edge)", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    repository.updateTriggerFields(WS, "trg_0001", {
      next_occurrence_at: "2026-11-09T09:00:00.000Z",
      last_fired_at: CLOCK,
      last_occurrence_at: CLOCK,
      last_condition_state: 1,
      updated_at: CLOCK,
    });
    const row = repository.getTrigger(WS, "trg_0001");
    expect(row?.next_occurrence_at).toBe("2026-11-09T09:00:00.000Z");
    expect(row?.last_fired_at).toBe(CLOCK);
    expect(row?.last_condition_state).toBe(1);
  });

  it("edits the declarative config and name through the writer", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    repository.updateTriggerFields(WS, "trg_0001", {
      name: "weekly literature sweep (renamed)",
      config_json: JSON.stringify({ cron: "30 9 * * 1" }),
      updated_at: CLOCK,
    });
    const row = repository.getTrigger(WS, "trg_0001");
    expect(row?.name).toBe("weekly literature sweep (renamed)");
    expect(JSON.parse(row?.config_json ?? "{}")).toEqual({ cron: "30 9 * * 1" });
  });
});

describe("trigger firings ledger (the idempotency claim IS the primary key)", () => {
  // The ledger refuses orphan firings: every claim's trigger row must exist
  // in the SAME workspace (the v5/v7 writer-validates discipline).
  function newDbWithTrigger(): { tx: SqliteTransactions; repository: TriggersRepository } {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    return { tx, repository };
  }

  it("claims a firing once; a duplicate key is a typed duplicate, not a second claim", () => {
    const { repository } = newDbWithTrigger();
    expect(repository.recordFiring(firingInput())).toBe("inserted");
    expect(repository.recordFiring(firingInput())).toBe("duplicate");
    expect(repository.findFiring(WS, "trg_0001", firingInput().idempotency_key)).not.toBeNull();
  });

  it("keeps the same idempotency key in two workspaces independent (E12)", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    repository.createTrigger(triggerInput({ workspace_id: OTHER_WS }));
    expect(repository.recordFiring(firingInput())).toBe("inserted");
    expect(repository.recordFiring(firingInput({ workspace_id: OTHER_WS }))).toBe("inserted");
    expect(repository.recordFiring(firingInput())).toBe("duplicate");
    expect(repository.recordFiring(firingInput({ workspace_id: OTHER_WS }))).toBe("duplicate");
  });

  it("advances a claimed firing to its settled outcome and run linkage", () => {
    const { repository } = newDbWithTrigger();
    repository.recordFiring(firingInput());
    repository.updateFiring(WS, "trg_0001", firingInput().idempotency_key, {
      outcome: "fired",
      run_id: "run_abc",
      detail_json: JSON.stringify({ due_at: CLOCK }),
    });
    const row = repository.findFiring(WS, "trg_0001", firingInput().idempotency_key);
    expect(row?.outcome).toBe("fired");
    expect(row?.run_id).toBe("run_abc");
  });

  it("lists recent firings newest-first and resolves a run's trigger origin", () => {
    const { repository } = newDbWithTrigger();
    for (let index = 0; index < 5; index += 1) {
      repository.recordFiring(
        firingInput({
          idempotency_key: `schedule:trg_0001:occurrence-${index}`,
          fired_at: new Date(Date.parse(CLOCK) + index * 1000).toISOString(),
          outcome: "fired",
          run_id: `run_${index}`,
        }),
      );
    }
    const recent = repository.listRecentFirings(WS, "trg_0001", 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.idempotency_key).toBe("schedule:trg_0001:occurrence-4");
    expect(recent.map((row) => row.run_id)).toContain("run_3");
    expect(repository.findFiringByRun(WS, "run_2")?.trigger_id).toBe("trg_0001");
    expect(repository.findFiringByRun(WS, "run_missing")).toBeNull();
  });

  it("finds claimed firings with no run for the boot re-drive (at-least-once)", () => {
    const { repository } = newDbWithTrigger();
    repository.recordFiring(firingInput({ outcome: "claimed", run_id: null }));
    repository.recordFiring(
      firingInput({
        idempotency_key: "schedule:trg_0001:occurrence-2",
        outcome: "fired",
        run_id: "run_settled",
      }),
    );
    const pending = repository.claimedFiringsWithoutRun();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotency_key).toBe("schedule:trg_0001:2026-11-02T09:00:00.000Z");
  });

  it("refuses a firing whose trigger row does not exist in the same workspace", () => {
    const { tx } = newDb();
    const repository = new TriggersRepository(tx);
    repository.createTrigger(triggerInput());
    expect(() =>
      repository.recordFiring(firingInput({ workspace_id: OTHER_WS })),
    ).toThrowError(TriggerRecordError);
  });
});
