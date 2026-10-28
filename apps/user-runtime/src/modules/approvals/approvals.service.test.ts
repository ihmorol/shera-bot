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
import type { ApprovalChoice, OperationRun, TaskPolicy, TaskRun } from "@shera-bot/contracts";

import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import {
  ApprovalsService,
  ApprovalsServiceError,
  type TypedToolProposal,
} from "./approvals.service.ts";

const WS = "ws_default_01";
const NOW = "2026-10-28T12:00:00.000Z";
const HASH = "a".repeat(64);

const POLICY: TaskPolicy = { max_retries: 3 };

const tempDirs: string[] = [];

function newRuntime(): {
  runtime: SqliteConnection;
  journal: EventJournalRepository;
  approvals: ApprovalsRepository;
  operations: OperationsRepository;
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
  const operations = new OperationsRepository(tx);
  const clock = { now: NOW };
  const service = new ApprovalsService({
    tx,
    journal,
    events,
    approvals,
    operations,
    clock: () => clock.now,
  });
  return {
    runtime,
    journal,
    approvals,
    operations,
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

function gatedProposal(overrides: Partial<TypedToolProposal> = {}): TypedToolProposal {
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
    const request = rows[0]!;
    expect(request.status).toBe("pending");
    expect(request.args_digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(request.tool_version).toBe("1.2.0");
    expect(request.risk_class).toBe("EXTERNAL_WRITE");
    expect(request.requested_by).toEqual({ type: "agent", id: "agent_general_assistant" });
    expect(request.resolved_at).toBeUndefined();
    expect(request.resolved_by_choice).toBeUndefined();
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
    expect(reminders.map((row) => row.reminder_index).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    for (const row of reminders) {
      expect(row.delivered_at).toBeNull();
      const offset = APPROVAL_REMINDER_SCHEDULE_SECONDS.at(row.reminder_index);
      if (offset === undefined) {
        throw new Error(`no reminder schedule slot ${row.reminder_index}`);
      }
      expect(row.due_at).toBe(new Date(new Date(NOW).getTime() + offset * 1000).toISOString());
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

// ---------------------------------------------------------------------------
// S20 chunk 2 — applying a decision (issue #21; D9, PRD §8, G5/G6)
// ---------------------------------------------------------------------------

const USER = { type: "user", id: "user_001" } as const;

/** Pause one run once and return the paused outcome plus the original run. */
function pauseOnce(env: ReturnType<typeof newRuntime>, run: TaskRun) {
  const result = env.service.createRequestFromTypedProposal({
    proposal: gatedProposal(),
    run,
    execute: () => {
      throw new Error("a gated proposal must not execute pre-decision");
    },
  });
  if (result.outcome !== "paused_for_approval") throw new Error("expected a paused outcome");
  return result;
}

function childRun(overrides: Partial<OperationRun> = {}): OperationRun {
  return {
    run_id: "run_child_001",
    workspace_id: WS,
    operation_id: "op_001",
    parent_task_id: "task_001",
    state: "RUNNING",
    events_seq_cursor: 0,
    credits: {},
    artifacts: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function catchCode(run: () => void): ApprovalsServiceError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApprovalsServiceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the decision to be refused with a typed error");
}

describe("approvals service: the five choices do exactly what they say (S20 chunk 2)", () => {
  it("approve-this-execution-only: one-time Agent-principal grant, run resumed via approval_granted, callback executed", () => {
    const env = newRuntime();
    const run = makeRun();
    const pause = pauseOnce(env, run);
    const sideEffect = { ran: false };

    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: pause.run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("approved");
    if (result.outcome !== "approved") throw new Error("expected an approved outcome");
    expect(sideEffect.ran).toBe(true);
    expect(result.run.state).toBe("RUNNING");
    expect(result.run.version).toBe(run.version + 2);

    // The one-time grant (D9): bound to the REQUESTER's own principal (the
    // proposing Agent), pinned to the exact tool version + digest.
    expect(env.approvals.listGrants(WS)).toHaveLength(1);
    const grant = env.approvals.listGrants(WS)[0]!;
    expect(result.grant).toEqual(grant);
    expect(grant.source_choice).toBe("approve-this-execution-only");
    expect(grant.one_time).toBe(true);
    expect(grant.principal_type).toBe("agent");
    expect(grant.principal_id).toBe("agent_general_assistant");
    expect(grant.tool_id).toBe("tool_repo_push");
    expect(grant.tool_version).toBe("1.2.0");
    expect(grant.capability).toBe("repo.push");
    expect(grant.resource_scope).toBe("workspace://notes/draft.md");
    expect(grant.conversation_scope).toBe("conv_001");
    expect(grant.workspace_scope).toBe(WS);
    expect(grant.created_by).toEqual(USER);
    expect(grant.approved_at).toBe(NOW);
    expect(grant.revoked_at).toBeNull();
    expect(grant.args_digest).toBe(`sha256:${"b".repeat(64)}`);

    // The request is resolved with the deciding choice.
    const request = env.approvals.getRequest(WS, pause.approval_id);
    expect(request?.status).toBe("approved");
    expect(request?.resolved_by_choice).toBe("approve-this-execution-only");
    expect(request?.resolved_at).toBe(NOW);

    // The resume went through the D8 machinery (G2), journalled with the
    // approval id in the payload.
    const stream = env.journal.listStream(`task:${run.task_id}`, WS);
    const granted = stream.find((row) => row.event_type === "task.approval_granted");
    expect(granted).toBeDefined();
    const envelope = JSON.parse(granted!.payload) as {
      payload: { approval_id?: string; to_state?: string; from_state?: string };
    };
    expect(envelope.payload.approval_id).toBe(pause.approval_id);
    expect(envelope.payload.from_state).toBe("WAITING_FOR_APPROVAL");
    expect(envelope.payload.to_state).toBe("RUNNING");
  });

  it("always-approve-this-tool: reusable grant scoped to the requesting TASK and the CURRENT conversation — 'any' is never implicit", () => {
    const env = newRuntime();
    const run = makeRun();
    const pause = pauseOnce(env, run);
    const sideEffect = { ran: false };

    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "always-approve-this-tool",
      decided_by: USER,
      run: pause.run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("approved");
    if (result.outcome !== "approved") throw new Error("expected an approved outcome");
    expect(sideEffect.ran).toBe(true);
    expect(result.run.state).toBe("RUNNING");

    expect(env.approvals.listGrants(WS)).toHaveLength(1);
    const grant = env.approvals.listGrants(WS)[0]!;
    expect(grant.source_choice).toBe("always-approve-this-tool");
    expect(grant.one_time).toBe(false);
    expect(grant.principal_type).toBe("task");
    expect(grant.principal_id).toBe("task_001");
    expect(grant.conversation_scope).toBe("conv_001");
    expect(grant.conversation_scope).not.toBe("any");
    // A reusable grant does not pin the arguments.
    expect(grant.args_digest).toBeNull();
  });

  it("always-approve-this-tool-for-this-agent: reusable grant bound to the requesting Agent", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());

    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "always-approve-this-tool-for-this-agent",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });

    expect(result.outcome).toBe("approved");
    const grant = env.approvals.listGrants(WS)[0]!;
    expect(grant.source_choice).toBe("always-approve-this-tool-for-this-agent");
    expect(grant.one_time).toBe(false);
    expect(grant.principal_type).toBe("agent");
    expect(grant.principal_id).toBe("agent_general_assistant");
    expect(grant.conversation_scope).toBe("conv_001");
  });

  it("reject-this-action: request rejected, run resumed via approval_rejected, the action NEVER executes, no grant", () => {
    const env = newRuntime();
    const run = makeRun();
    const pause = pauseOnce(env, run);
    const sideEffect = { ran: false };

    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "reject-this-action",
      decided_by: USER,
      run: pause.run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("action_rejected");
    if (result.outcome !== "action_rejected")
      throw new Error("expected an action_rejected outcome");
    // The denied action does not resume into execution.
    expect(sideEffect.ran).toBe(false);
    // "Reject this action" denies the ACTION, not the task (D8 vocabulary):
    // the run returns to RUNNING via the legal approval_rejected row.
    expect(result.run.state).toBe("RUNNING");
    expect(result.run.version).toBe(run.version + 2);

    const request = env.approvals.getRequest(WS, pause.approval_id);
    expect(request?.status).toBe("rejected");
    expect(request?.resolved_by_choice).toBe("reject-this-action");
    expect(request?.resolved_at).toBe(NOW);

    const stream = env.journal.listStream(`task:${run.task_id}`, WS);
    const rejected = stream.find((row) => row.event_type === "task.approval_rejected");
    expect(rejected).toBeDefined();
    const envelope = JSON.parse(rejected!.payload) as {
      payload: { approval_id?: string; to_state?: string };
    };
    expect(envelope.payload.approval_id).toBe(pause.approval_id);
    expect(envelope.payload.to_state).toBe("RUNNING");

    // Only the three approve choices create grants — a rejection creates none.
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
  });

  it("cancel-the-task: request cancelled, run CANCELLING -> CANCELLED, child runs cancelled in the same transaction", () => {
    const env = newRuntime();
    const run = makeRun();
    const pause = pauseOnce(env, run);
    env.operations.createRun(WS, childRun());
    env.operations.createRun(WS, childRun({ run_id: "run_child_002", state: "SUCCEEDED" }));
    const sideEffect = { ran: false };

    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "cancel-the-task",
      decided_by: USER,
      run: pause.run,
      execute: () => {
        sideEffect.ran = true;
      },
    });

    expect(result.outcome).toBe("task_cancelled");
    if (result.outcome !== "task_cancelled") throw new Error("expected a task_cancelled outcome");
    expect(sideEffect.ran).toBe(false);
    // A real cancelled state, not a silent failure: both D8 steps journalled.
    expect(result.run.state).toBe("CANCELLED");
    expect(result.run.version).toBe(run.version + 3);
    expect(result.cancelled_child_run_ids).toEqual(["run_child_001"]);

    const request = env.approvals.getRequest(WS, pause.approval_id);
    expect(request?.status).toBe("cancelled");
    expect(request?.resolved_by_choice).toBe("cancel-the-task");

    // The non-terminal child is cancelled; the already-terminal child is untouched.
    expect(env.operations.getRun(WS, "op_001", "run_child_001")?.state).toBe("CANCELLED");
    expect(env.operations.getRun(WS, "op_001", "run_child_002")?.state).toBe("SUCCEEDED");

    const stream = env.journal.listStream(`task:${run.task_id}`, WS);
    const types = stream.map((row) => row.event_type);
    expect(types).toContain("task.cancelling");
    expect(types).toContain("task.cancelled");

    expect(env.approvals.listGrants(WS)).toHaveLength(0);
  });
});

describe("approvals service: decision refusals (S20 chunk 2, D9/G6)", () => {
  it("an Agent cannot approve its own request — AGENT_CANNOT_SELF_APPROVE, and a prompt-shaped input creates NO grant", () => {
    const env = newRuntime();
    const run = makeRun();
    const pause = pauseOnce(env, run);

    const error = catchCode(() =>
      env.service.applyDecision({
        approval_id: pause.approval_id,
        choice: "approve-this-execution-only",
        decided_by: { type: "agent", id: "agent_general_assistant" },
        run: pause.run,
        execute: () => {},
      }),
    );

    expect(error.code).toBe("AGENT_CANNOT_SELF_APPROVE");

    // Nothing moved: the request is still pending, no grant exists (a prompt
    // cannot create a grant — G6), the run still waits, nothing journalled.
    expect(env.approvals.getRequest(WS, pause.approval_id)?.status).toBe("pending");
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
    expect(env.journal.listStream(`task:${run.task_id}`, WS)).toHaveLength(2);
  });

  it("an Agent that is NOT the requester still cannot decide — AGENT_CANNOT_DECIDE_APPROVAL", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());

    const error = catchCode(() =>
      env.service.applyDecision({
        approval_id: pause.approval_id,
        choice: "approve-this-execution-only",
        decided_by: { type: "agent", id: "agent_other_observer" },
        run: pause.run,
        execute: () => {},
      }),
    );

    expect(error.code).toBe("AGENT_CANNOT_DECIDE_APPROVAL");
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
    expect(env.approvals.getRequest(WS, pause.approval_id)?.status).toBe("pending");
  });

  it("a decision on an already-resolved request is refused — APPROVAL_ALREADY_RESOLVED, no duplicate grant", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());

    const first = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });
    expect(first.outcome).toBe("approved");

    env.setNow("2026-10-28T13:00:00.000Z");
    const error = catchCode(() =>
      env.service.applyDecision({
        approval_id: pause.approval_id,
        choice: "reject-this-action",
        decided_by: USER,
        run: pause.run,
        execute: () => {},
      }),
    );

    expect(error.code).toBe("APPROVAL_ALREADY_RESOLVED");
    // The first decision stands untouched — decisions are immutable (D9).
    expect(env.approvals.listGrants(WS)).toHaveLength(1);
    const request = env.approvals.getRequest(WS, pause.approval_id);
    expect(request?.status).toBe("approved");
    expect(request?.resolved_at).toBe(NOW);
  });

  it("an unknown choice is refused typed — APPROVAL_DECISION_INVALID, nothing persisted", () => {
    const env = newRuntime();
    const run = makeRun();
    const pause = pauseOnce(env, run);

    const error = catchCode(() =>
      env.service.applyDecision({
        approval_id: pause.approval_id,
        // Raw API input can carry anything; the enum guards it typed.
        choice: "approve-everything" as ApprovalChoice,
        decided_by: USER,
        run: pause.run,
        execute: () => {},
      }),
    );

    expect(error.code).toBe("APPROVAL_DECISION_INVALID");
    expect(env.approvals.getRequest(WS, pause.approval_id)?.status).toBe("pending");
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
    expect(env.journal.listStream(`task:${run.task_id}`, WS)).toHaveLength(2);
  });

  it("a run projection that can no longer take the resume (double-apply) surfaces the typed transition rejection and persists NOTHING", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());

    // The caller's projection says the run already moved on from
    // WAITING_FOR_APPROVAL (a retried decision call after a crashed first
    // apply): approving it again must be refused typed with nothing written.
    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: { ...pause.run, state: "RUNNING", version: pause.run.version + 1 },
      execute: () => {},
    });

    expect(result.outcome).toBe("transition_rejected");
    if (result.outcome !== "transition_rejected") throw new Error("expected a typed rejection");
    expect(result.rejection.kind).toBe("illegal_transition");
    expect(env.approvals.getRequest(WS, pause.approval_id)?.status).toBe("pending");
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
  });

  it("a decision naming an unknown approval id is refused — APPROVAL_REQUEST_NOT_FOUND", () => {
    const env = newRuntime();

    const error = catchCode(() =>
      env.service.applyDecision({
        approval_id: "apr_does_not_exist",
        choice: "approve-this-execution-only",
        decided_by: USER,
        run: makeRun(),
        execute: () => {},
      }),
    );

    expect(error.code).toBe("APPROVAL_REQUEST_NOT_FOUND");
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
  });

  it("a decision run that does not belong to the request's task is refused — APPROVAL_REQUEST_RUN_MISMATCH", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());

    const error = catchCode(() =>
      env.service.applyDecision({
        approval_id: pause.approval_id,
        choice: "approve-this-execution-only",
        decided_by: USER,
        run: makeRun({ task_id: "task_other_001" }),
        execute: () => {},
      }),
    );

    expect(error.code).toBe("APPROVAL_REQUEST_RUN_MISMATCH");
    expect(env.approvals.getRequest(WS, pause.approval_id)?.status).toBe("pending");
    expect(env.approvals.listGrants(WS)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S20 chunk 2 — the deterministic grant lookup (issue #21; D9, PRD §8)
// ---------------------------------------------------------------------------

const APPROVED_TOOL = {
  toolId: "tool_repo_push",
  toolVersion: "1.2.0",
  capability: "repo.push",
  resourceScope: "workspace://notes/draft.md",
} as const;
const ARGS = `sha256:${"b".repeat(64)}`;

function lookup(
  env: ReturnType<typeof newRuntime>,
  overrides: Partial<{
    workspaceId: string;
    principal: { type: "user" | "agent" | "task"; id: string };
    toolId: string;
    toolVersion: string;
    capability: string;
    resourceScope: string;
    argsDigest: string;
  }> = {},
) {
  return env.service.findActiveGrant(
    overrides.workspaceId ?? WS,
    overrides.principal ?? { type: "agent", id: "agent_general_assistant" },
    overrides.toolId ?? APPROVED_TOOL.toolId,
    overrides.toolVersion ?? APPROVED_TOOL.toolVersion,
    overrides.capability ?? APPROVED_TOOL.capability,
    overrides.resourceScope ?? APPROVED_TOOL.resourceScope,
    overrides.argsDigest ?? ARGS,
  );
}

describe("approvals service: findActiveGrant matches deterministically (S20 chunk 2)", () => {
  it("returns the one-time grant on the exact tool, version, capability, scope, and digest", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());
    const result = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });
    if (result.outcome !== "approved") throw new Error("expected an approved outcome");

    const lookupResult = lookup(env);
    expect(lookupResult.ok).toBe(true);
    if (lookupResult.ok !== true) throw new Error("expected a match");
    expect(lookupResult.grant.grant_id).toBe(result.grant.grant_id);
    expect(lookupResult.grant.one_time).toBe(true);
  });

  it("a CHANGED tool version invalidates a one-time approval — typed miss", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());
    env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });

    const miss = lookup(env, { toolVersion: "1.3.0" });
    expect(miss.ok).toBe(false);
    if (miss.ok !== false) throw new Error("expected a typed miss");
    expect(miss.reason).toBe("no_active_grant");
  });

  it("a CHANGED argument set invalidates a one-time approval — typed miss", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());
    env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });

    const miss = lookup(env, { argsDigest: `sha256:${"c".repeat(64)}` });
    expect(miss.ok).toBe(false);
    if (miss.ok !== false) throw new Error("expected a typed miss");
    expect(miss.reason).toBe("no_active_grant");
  });

  it("a reusable grant matches with DIFFERENT arguments but still not a different tool version", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());
    env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "always-approve-this-tool",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });

    // "Always approve this tool" is deliberately argument-agnostic...
    const hit = lookup(env, {
      principal: { type: "task", id: "task_001" },
      argsDigest: `sha256:${"d".repeat(64)}`,
    });
    expect(hit.ok).toBe(true);

    // ...but the tool VERSION is pinned for every grant (D9).
    const miss = lookup(env, {
      principal: { type: "task", id: "task_001" },
      toolVersion: "2.0.0",
    });
    expect(miss.ok).toBe(false);
  });

  it("a grant NEVER matches a different principal — a child cannot widen its parent's permissions (D9)", () => {
    const env = newRuntime();

    // The always-approve-this-tool grant belongs to the requesting TASK.
    const toolPause = pauseOnce(env, makeRun());
    env.service.applyDecision({
      approval_id: toolPause.approval_id,
      choice: "always-approve-this-tool",
      decided_by: USER,
      run: toolPause.run,
      execute: () => {},
    });
    const childMiss = lookup(env, { principal: { type: "task", id: "task_child_001" } });
    expect(childMiss.ok).toBe(false);

    // The for-this-agent grant belongs to the requesting AGENT.
    const agentPause = pauseOnce(env, makeRun());
    env.service.applyDecision({
      approval_id: agentPause.approval_id,
      choice: "always-approve-this-tool-for-this-agent",
      decided_by: USER,
      run: agentPause.run,
      execute: () => {},
    });
    const otherAgentMiss = lookup(env, { principal: { type: "agent", id: "agent_other_001" } });
    expect(otherAgentMiss.ok).toBe(false);
  });

  it("a revoked grant no longer matches", () => {
    const env = newRuntime();
    const pause = pauseOnce(env, makeRun());
    const decision = env.service.applyDecision({
      approval_id: pause.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: pause.run,
      execute: () => {},
    });
    if (decision.outcome !== "approved") throw new Error("expected an approved outcome");

    expect(lookup(env).ok).toBe(true);
    expect(env.approvals.revokeGrant(WS, decision.grant.grant_id, "2026-10-28T12:05:00.000Z")).toBe(
      true,
    );
    expect(lookup(env).ok).toBe(false);
  });

  it("an expired grant no longer matches — compared on the injected clock", () => {
    const env = newRuntime();
    env.approvals.insertGrant({
      grant_id: "grt_expiring_001",
      workspace_id: WS,
      source_choice: "always-approve-this-tool",
      principal_type: "task",
      principal_id: "task_001",
      tool_id: APPROVED_TOOL.toolId,
      tool_version: APPROVED_TOOL.toolVersion,
      capability: APPROVED_TOOL.capability,
      resource_scope: APPROVED_TOOL.resourceScope,
      conversation_scope: "conv_001",
      workspace_scope: WS,
      expires_at: "2026-10-28T12:30:00.000Z",
      one_time: false,
      created_by: USER,
      approved_at: NOW,
      revoked_at: null,
      args_digest: null,
    });

    // NOW (12:00) is before expiry: the grant is active.
    expect(lookup(env, { principal: { type: "task", id: "task_001" } }).ok).toBe(true);

    env.setNow("2026-10-28T12:31:00.000Z");
    const expired = lookup(env, { principal: { type: "task", id: "task_001" } });
    expect(expired.ok).toBe(false);
    if (expired.ok !== false) throw new Error("expected a typed miss");
    expect(expired.reason).toBe("no_active_grant");
  });
});
