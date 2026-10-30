/**
 * S28 chunk 2 — the schedule clock and the schedules service (PRD §8, E5,
 * D11, G2): the cron math is a pure UTC-deterministic wrapper over the
 * adopted cron-parser (MIT, exact-pinned — recorded in E37), and the service
 * owns the declarative trigger records' typed create/list/pause/resume/edit
 * surface. Every configuration is per-kind TYPED data (G2: a prose-only body
 * is a typed refusal, never a trigger); the target Operation is validated at
 * create (the writer-validates discipline); the schedule's next occurrence is
 * computed from the injected clock at create/edit/resume so the record's
 * bookkeeping is truthful from the first read (AC9).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { SchedulesService, SchedulesServiceError } from "./schedules.service.ts";
import { scheduleClock } from "./schedule-clock.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

function newService(now: () => string = () => "2026-10-31T12:00:00.000Z"): {
  service: SchedulesService;
  tx: SqliteTransactions;
} {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-schedules-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const triggers = new TriggersRepository(tx);
  const operations = new OperationsRepository(tx);
  const service = new SchedulesService({ triggers, operations, tx, ...(now ? { now } : {}) });
  return { service, tx };
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
const OP = "op_research";
const USER = { type: "user" as const, id: "emon" };

function seedOperation(tx: SqliteTransactions, operationId = OP): void {
  const operations = new OperationsRepository(tx);
  operations.createOperation(WS, {
    operation_id: operationId,
    workspace_id: WS,
    definition_ref: null,
    name: "Research",
    status: "active",
    coordinator_agent_id: "agent_researcher",
    pinning: {
      pack_id: "pack_default",
      pack_version: "0.1.0",
      roster_agent_ids: ["agent_researcher"],
      capabilities: [],
      provider_snapshot: {},
    },
    created_at: "2026-10-30T00:00:00.000Z",
    updated_at: "2026-10-30T00:00:00.000Z",
  });
}

describe("schedule-clock (pure, UTC-deterministic)", () => {
  it("validates cron expressions with a typed refusal", () => {
    expect(scheduleClock.validate("0 9 * * 1")).toEqual({ ok: true });
    const bad = scheduleClock.validate("not a cron");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("SCHEDULE_CRON_INVALID");
      expect(bad.safe_message).not.toContain("not a cron");
    }
  });

  it("computes the next occurrence strictly AFTER the reference instant (UTC)", () => {
    const next = scheduleClock.nextOccurrence(
      "0 9 * * 1",
      new Date("2026-10-31T12:00:00.000Z"),
    );
    expect(next?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });

  it("enumerates missed occurrences in the half-open (from, to] window", () => {
    const missed = scheduleClock.missedOccurrences(
      "*/30 * * * *",
      new Date("2026-10-31T11:00:00.000Z"),
      new Date("2026-10-31T12:00:00.000Z"),
      50,
    );
    // 11:30 and 12:00 — 11:00 itself is excluded (half-open window).
    expect(missed.map((date) => date.toISOString())).toEqual([
      "2026-10-31T11:30:00.000Z",
      "2026-10-31T12:00:00.000Z",
    ]);
  });

  it("bounds the missed-occurrence enumeration", () => {
    const missed = scheduleClock.missedOccurrences(
      "* * * * *",
      new Date("2026-10-31T10:00:00.000Z"),
      new Date("2026-10-31T12:00:00.000Z"),
      5,
    );
    expect(missed).toHaveLength(5);
  });
});

describe("schedules service (typed declarative records)", () => {
  it("creates a schedule trigger with a computed next occurrence", () => {
    const { service, tx } = newService();
    seedOperation(tx);
    const created = service.createTrigger(WS, {
      kind: "schedule",
      name: "weekly literature sweep",
      target_operation_id: OP,
      config: {
        cron: "0 9 * * 1",
        plan: { prompt: "Compile the weekly literature sweep." },
      },
      catch_up_policy: "catch_up",
      actor: USER,
    });
    expect(created.trigger_id).toMatch(/^trg_/);
    const view = service.getTriggerView(WS, created.trigger_id);
    expect(view?.name).toBe("weekly literature sweep");
    expect(view?.kind).toBe("schedule");
    expect(view?.state).toBe("active");
    expect(view?.next_occurrence_at).toBe("2026-11-02T09:00:00.000Z");
    expect(view?.config).toMatchObject({ cron: "0 9 * * 1" });
  });

  it("refuses a schedule whose target Operation does not exist (writer validates)", () => {
    const { service } = newService();
    expect(() =>
      service.createTrigger(WS, {
        kind: "schedule",
        name: "ghost target",
        target_operation_id: "op_missing",
        config: { cron: "0 9 * * 1", plan: { prompt: "x" } },
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TRIGGER_TARGET_OPERATION_NOT_FOUND" }),
    );
  });

  it("refuses an invalid cron and a prose-only body with typed rejections (G2)", () => {
    const { service, tx } = newService();
    seedOperation(tx);
    expect(() =>
      service.createTrigger(WS, {
        kind: "schedule",
        name: "bad cron",
        target_operation_id: OP,
        config: { cron: "whenever", plan: { prompt: "x" } },
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEDULE_CRON_INVALID" }));
    // A prose-only body (no typed config) is a validation refusal — never a
    // trigger, never a run (G2).
    expect(() =>
      service.createTrigger(WS, {
        kind: "schedule",
        name: "just words",
        target_operation_id: OP,
        config: { prose: "please sweep the literature every week" } as never,
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_CONFIG_INVALID" }));
  });

  it("refuses a plan prompt outside the bounded vocabulary", () => {
    const { service, tx } = newService();
    seedOperation(tx);
    expect(() =>
      service.createTrigger(WS, {
        kind: "schedule",
        name: "empty prompt",
        target_operation_id: OP,
        config: { cron: "0 9 * * 1", plan: { prompt: "" } },
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_CONFIG_INVALID" }));
    expect(() =>
      service.createTrigger(WS, {
        kind: "schedule",
        name: "overlong prompt",
        target_operation_id: OP,
        config: { cron: "0 9 * * 1", plan: { prompt: "x".repeat(2001) } },
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_CONFIG_INVALID" }));
  });

  it("validates per-kind config for every watcher kind", () => {
    const { service, tx } = newService();
    seedOperation(tx);
    // file_watch: the D6 scopes — a workspace path or the watcher's own agent folder.
    const fileWatch = service.createTrigger(WS, {
      kind: "file_watch",
      name: "dataset folder watch",
      target_operation_id: OP,
      config: { scope: "workspace", path_uri: "workspace://datasets" },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(fileWatch.trigger_id).toMatch(/^trg_/);
    expect(() =>
      service.createTrigger(WS, {
        kind: "file_watch",
        name: "bad uri",
        target_operation_id: OP,
        config: { scope: "workspace", path_uri: "/etc/passwd" },
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_CONFIG_INVALID" }));
    // git_watch: project + branch.
    const gitWatch = service.createTrigger(WS, {
      kind: "git_watch",
      name: "thesis main watch",
      target_operation_id: OP,
      config: { project_id: "proj_thesis", branch: "main" },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(gitWatch.trigger_id).toMatch(/^trg_/);
    expect(() =>
      service.createTrigger(WS, {
        kind: "git_watch",
        name: "no branch",
        target_operation_id: OP,
        config: { project_id: "proj_thesis" } as never,
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_CONFIG_INVALID" }));
    // webhook: source + a create-only secret stored as a DIGEST only (G3).
    const webhook = service.createTrigger(WS, {
      kind: "webhook",
      name: "intake hook",
      target_operation_id: OP,
      config: { source: "form-service", secret: "shera-hook-secret-0123456789" },
      catch_up_policy: "skip",
      actor: USER,
    });
    const webhookView = service.getTriggerView(WS, webhook.trigger_id);
    expect(webhookView?.config).toMatchObject({ source: "form-service" });
    expect(JSON.stringify(webhookView?.config)).not.toContain("shera-hook-secret");
    expect((webhookView?.config as { secret_digest?: string }).secret_digest).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    // task_completion: outcome vocabulary.
    const completion = service.createTrigger(WS, {
      kind: "task_completion",
      name: "follow-up after sweep",
      target_operation_id: OP,
      config: { outcomes: ["succeeded"] },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(completion.trigger_id).toMatch(/^trg_/);
    // condition: typed predicates only.
    const condition = service.createTrigger(WS, {
      kind: "condition",
      name: "dataset ready",
      target_operation_id: OP,
      config: {
        predicate: { kind: "workspace_file_exists", path_uri: "workspace://datasets/ready.flag" },
        parent_task_id: null,
      },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(condition.trigger_id).toMatch(/^trg_/);
    expect(() =>
      service.createTrigger(WS, {
        kind: "condition",
        name: "prose condition",
        target_operation_id: OP,
        config: { predicate: "when the data looks ready" } as never,
        catch_up_policy: "skip",
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_CONFIG_INVALID" }));
    // external_event: typed source.
    const external = service.createTrigger(WS, {
      kind: "external_event",
      name: "form intake",
      target_operation_id: OP,
      config: { source: "form-service" },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(external.trigger_id).toMatch(/^trg_/);
  });

  it("pauses and resumes with truthful bookkeeping; resume recomputes the next occurrence", () => {
    const { service, tx } = newService();
    seedOperation(tx);
    const created = service.createTrigger(WS, {
      kind: "schedule",
      name: "weekly sweep",
      target_operation_id: OP,
      config: { cron: "0 9 * * 1", plan: { prompt: "Sweep." } },
      catch_up_policy: "skip",
      actor: USER,
    });
    service.pauseTrigger(WS, created.trigger_id, USER);
    let view = service.getTriggerView(WS, created.trigger_id);
    expect(view?.state).toBe("paused");
    expect(view?.pause_reason).toBeNull();
    service.resumeTrigger(WS, created.trigger_id, USER);
    view = service.getTriggerView(WS, created.trigger_id);
    expect(view?.state).toBe("active");
    expect(view?.next_occurrence_at).toBe("2026-11-02T09:00:00.000Z");
  });

  it("edits name, config, and policy; the next occurrence recomputes (AC10 edit)", () => {
    const { service, tx } = newService();
    seedOperation(tx);
    const created = service.createTrigger(WS, {
      kind: "schedule",
      name: "weekly sweep",
      target_operation_id: OP,
      config: { cron: "0 9 * * 1", plan: { prompt: "Sweep." } },
      catch_up_policy: "skip",
      actor: USER,
    });
    service.editTrigger(WS, created.trigger_id, {
      name: "weekly sweep (later)",
      config: { cron: "30 10 * * 1", plan: { prompt: "Sweep later." } },
      actor: USER,
    });
    const view = service.getTriggerView(WS, created.trigger_id);
    expect(view?.name).toBe("weekly sweep (later)");
    expect(view?.next_occurrence_at).toBe("2026-11-02T10:30:00.000Z");
    expect(() =>
      service.editTrigger(WS, created.trigger_id, {
        config: { cron: "bogus", plan: { prompt: "x" } },
        actor: USER,
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEDULE_CRON_INVALID" }));
  });

  it("lists triggers oldest-first with their recent firings", () => {
    let tick = 0;
    const { service, tx } = newService(() =>
      new Date(Date.parse("2026-10-31T12:00:00.000Z") + tick++ * 1000).toISOString(),
    );
    seedOperation(tx);
    const first = service.createTrigger(WS, {
      kind: "schedule",
      name: "first",
      target_operation_id: OP,
      config: { cron: "0 9 * * 1", plan: { prompt: "A" } },
      catch_up_policy: "skip",
      actor: USER,
    });
    service.createTrigger(WS, {
      kind: "webhook",
      name: "second",
      target_operation_id: OP,
      config: { source: "svc" },
      catch_up_policy: "skip",
      actor: USER,
    });
    const list = service.listTriggers(WS);
    expect(list).toHaveLength(2);
    expect(list[0]?.trigger_id).toBe(first.trigger_id);
    expect(service.getTriggerView(WS, first.trigger_id)?.recent_firings).toEqual([]);
  });

  it("refuses an unknown trigger on pause/resume/edit with a typed state error", () => {
    const { service } = newService();
    expect(() => service.pauseTrigger(WS, "trg_missing", USER)).toThrowError(
      expect.objectContaining({ code: "TRIGGER_NOT_FOUND" }),
    );
    expect(() => service.resumeTrigger(WS, "trg_missing", USER)).toThrowError(
      expect.objectContaining({ code: "TRIGGER_NOT_FOUND" }),
    );
    expect(() =>
      service.editTrigger(WS, "trg_missing", { name: "x", actor: USER }),
    ).toThrowError(expect.objectContaining({ code: "TRIGGER_NOT_FOUND" }));
  });
});
