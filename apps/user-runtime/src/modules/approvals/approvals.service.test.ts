/**
 * S20 chunk 1 — the approval-pause contract (S20 issue #21; D9, PRD §8, E3,
 * G2/G3/G6). Red-first: these tests pin the chunk-1 behaviors before the
 * service exists.
 *
 *   1. A gated typed tool proposal records a pending ApprovalRequest, journals
 *      the typed `approval.requested` event through the same event path the
 *      runtime uses, and transitions the run RUNNING -> WAITING_FOR_APPROVAL
 *      via the D8 task machinery (G2 — never a second state machine).
 *   2. NOTHING executes pre-decision: the execute callback must not have run
 *      while the request is pending (the S20 AC: "no side effect pre-decision").
 *   3. A non-gated (READ_ONLY) proposal executes automatically and pauses
 *      nothing (G6: read-only tools run automatically).
 *   4. All five reminder rows are scheduled immediately on the injected clock
 *      (E3 schedule; delivery is chunk 3's concern).
 *   5. An illegal pause (run not in RUNNING) surfaces the typed transition
 *      rejection and persists nothing.
 *
 * G3: approval records carry args_digest, never raw arguments — the typed
 * proposal input has no raw-arguments field at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { APPROVAL_REMINDER_SCHEDULE_SECONDS } from "@shera-bot/contracts";
import type { TaskPolicy, TaskRun } from "@shera-bot/contracts";

import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { ApprovalsService } from "./approvals.service.ts";

const WS = "ws_default_01";
const NOW = "2026-10-28T12:00:00.000Z";
const HASH = "a".repeat(64);

const POLICY: TaskPolicy = { max_retries: 3 };

const tempDirs: string[] = [];

function newRuntime(): {
  runtime: SqliteConnection;
  journal: EventJournalRepository;
  approvals: ApprovalsRepository;
  service: ApprovalsService;
  setNow: (iso: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-approvals-"));
  tempDirs.push(dir);
  const runtime = openDatabase(join(dir, "runtime.db"));
  applyMigrations(runtime.db);
  const tx = new SqliteTransactions(runtime.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvals = new ApprovalsRepository(tx);
  const clock = { now: NOW };
  const service = new ApprovalsService({
    tx,
    journal,
    events,
    approvals,
    clock: () => clock.now,
  });
  return {
    runtime,
    journal,
    approvals,
    service,
    setNow: (iso: string) => {
      clock.now = iso;
    },
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    task_id: "task_001",
    workspace_id: WS,
    conversation_id: "conv_001",
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_001" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: ["agent_general_assistant"],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function gatedProposal(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: WS,
    task_id: "task_001",
    conversation_id: "conv_001",
    agent_id: "agent_general_assistant",
    tool_id: "tool_repo_push",
    tool_version: "1.2.0",
    capability: "repo.push",
    risk_class: "EXTERNAL_WRITE",
    resource_scope: "workspace://notes/draft.md",
    args_digest: `sha256:${"b".repeat(64)}`,
    side_effect_summary: "Pushes local commits to the configured remote repository.",
    ...overrides,
  };
}

describe("approvals service: a gated typed proposal pauses the run (S20 chunk 1)", () => {
  it("records a pending request, journals approval.requested, and waits in WAITING_FOR_APPROVAL without executing", () => {
    const env = newRuntime();
    const run = makeRun();
    const sideEffect = { ran: false };

    const result = env.service.createRequestFromTypedProposal({
      proposal: gatedProposal(),
      run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("paused_for_approval");
    if (result.outcome !== "paused_for_approval") throw new Error("expected a paused outcome");

    // The run advanced through the D8 machinery (G2): RUNNING -> WAITING_FOR_APPROVAL.
    expect(result.run.state).toBe("WAITING_FOR_APPROVAL");
    expect(result.run.version).toBe(run.version + 1);
    expect(result.reminders_scheduled).toBe(5);

    // The side-effect callback MUST NOT have run pre-decision (S20 AC).
    expect(sideEffect.ran).toBe(false);

    // The typed approval.requested event is in the journal on the task stream.
    const stream = env.journal.listStream(`task:${run.task_id}`, WS);
    const types = stream.map((row) => row.event_type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("task.waiting_for_approval");

    // The approval.requested journal payload carries the digest, never raw args (G3).
    const approvalEvent = stream.find((row) => row.event_type === "approval.requested");
    expect(approvalEvent).toBeDefined();
    const envelope = JSON.parse(approvalEvent!.payload) as {
      event_type: string;
      payload: { args_digest?: string; tool_id?: string; raw_args?: unknown };
    };
    expect(envelope.payload.args_digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(envelope.payload.tool_id).toBe("tool_repo_push");
    expect("raw_args" in envelope.payload).toBe(false);

    // The durable request row is pending and digest-only.
    const rows = env.approvals.listRequestsByTask(WS, run.task_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].args_digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(rows[0].tool_version).toBe("1.2.0");
    expect(rows[0].risk_class).toBe("EXTERNAL_WRITE");
    expect(rows[0].requested_by).toEqual({ type: "agent", id: "agent_general_assistant" });
    expect(rows[0].resolved_at).toBeUndefined();
    expect(rows[0].resolved_by_choice).toBeUndefined();
  });

  it("schedules all five reminder rows immediately on the injected clock (E3)", () => {
    const env = newRuntime();
    const result = env.service.createRequestFromTypedProposal({
      proposal: gatedProposal(),
      run: makeRun(),
      execute: () => {
        throw new Error("a gated proposal must not execute pre-decision");
      },
    });
    if (result.outcome !== "paused_for_approval") throw new Error("expected a paused outcome");

    const reminders = env.approvals.listRemindersByApproval(WS, result.approval_id);
    expect(reminders).toHaveLength(APPROVAL_REMINDER_SCHEDULE_SECONDS.length);
    expect(
      reminders.map((row) => row.reminder_index).sort((a, b) => a - b),
    ).toEqual([0, 1, 2, 3, 4]);
    for (const row of reminders) {
      expect(row.delivered_at).toBeNull();
      const expected = new Date(
        new Date(NOW).getTime() + APPROVAL_REMINDER_SCHEDULE_SECONDS[row.reminder_index] * 1000,
      ).toISOString();
      expect(row.due_at).toBe(expected);
    }
  });

  it("does NOT pause a non-gated (READ_ONLY) proposal — it executes automatically (G6)", () => {
    const env = newRuntime();
    const run = makeRun();
    const sideEffect = { ran: false };

    const result = env.service.createRequestFromTypedProposal({
      proposal: gatedProposal({ tool_id: "tool_file_read", risk_class: "READ_ONLY" }),
      run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("executed_automatically");
    expect(sideEffect.ran).toBe(true);

    // The run never left RUNNING and nothing was recorded or journalled.
    expect(env.approvals.listRequestsByTask(WS, run.task_id)).toHaveLength(0);
    expect(env.journal.listStream(`task:${run.task_id}`, WS)).toHaveLength(0);
  });

  it("surfaces the typed transition rejection and persists nothing when the run is not RUNNING", () => {
    const env = newRuntime();
    const run = makeRun({ state: "SUCCEEDED" });
    const sideEffect = { ran: false };

    const result = env.service.createRequestFromTypedProposal({
      proposal: gatedProposal(),
      run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("transition_rejected");
    if (result.outcome !== "transition_rejected") throw new Error("expected a typed rejection");
    expect(result.rejection.kind).toBe("illegal_transition");
    expect(sideEffect.ran).toBe(false);
    expect(env.approvals.listRequestsByTask(WS, run.task_id)).toHaveLength(0);
    expect(env.journal.listStream(`task:${run.task_id}`, WS)).toHaveLength(0);
  });
});
