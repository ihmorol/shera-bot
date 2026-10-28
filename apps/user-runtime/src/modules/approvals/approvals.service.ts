/**
 * Approvals service (S20 chunk 1; D9, PRD §8, E3, G2/G3/G6) — the pause half
 * of the approval lifecycle: a TYPED tool proposal with a gated risk class
 * records a pending ApprovalRequest, journals the typed `approval.requested`
 * event on the run's D26 stream through the SAME event machinery every other
 * writer uses, and moves the run RUNNING -> WAITING_FOR_APPROVAL through the
 * D8 task transition table (G2 — never a second state machine, never a
 * natural-language classification; the input is typed contract data).
 *
 * NOTHING executes pre-decision (the S20 AC): the caller's `execute` callback
 * is invoked ONLY on the non-gated automatic path (G6: read-only tools run
 * automatically). While a request is pending the callback is never called —
 * there is deliberately no "run it and hope" fallback (G4).
 *
 * G3: the proposal input has NO raw-arguments field — it carries the sha256
 * args_digest only, and every persisted surface (request row, journal event)
 * stores exactly that digest. The side_effect_summary is bounded, UI-safe
 * text authored by the tool's typed definition — never tool arguments.
 *
 * Reminders (E3): all five slots of APPROVAL_REMINDER_SCHEDULE_SECONDS
 * [0, 900, 2700, 10800, 86400] are scheduled IMMEDIATELY at request time on
 * the injected clock, persisted as rows (durable, not in-memory timers — the
 * BullMQ/Redis route was rejected for this codebase, E27). Firing and
 * delivery are chunk 3's logic against these rows; delivery events never
 * change task state (E3).
 *
 * Atomicity (AC2): the request row, the five reminder rows, the
 * approval.requested journal append, and the D8 pause transition + its
 * journal event commit as ONE transaction — a mid-unit failure applies
 * nothing. A transition rejection persists NOTHING (the run is already
 * terminal or otherwise unpausable; the typed rejection is the answer).
 *
 * ---------------------------------------------------------------------------
 * Chunk 2 — applying a decision (S20; D9, PRD §8, G5/G6)
 *
 * `applyDecision` is the ONLY path that turns one of the five contract
 * choices into effects. Grants are created NOWHERE else — there is no public
 * "create grant" API, so a prompt-shaped input cannot create a grant (G6):
 * grant creation happens only inside this service's runtime transaction,
 * behind the typed actor refusals.
 *
 * The five choices, exactly as named (PRD §8):
 *  - approve-this-execution-only → a one_time grant bound to the requester's
 *    own principal (the proposing Agent), pinned to tool VERSION and
 *    args_digest — a changed argument set or tool version invalidates it.
 *  - always-approve-this-tool → a reusable grant whose principal is the
 *    requesting TASK run; conversation_scope defaults to the CURRENT
 *    conversation ("any" is never implicit).
 *  - always-approve-this-tool-for-this-agent → a reusable grant bound to the
 *    requesting Agent. This — not the choice name's breadth — is the explicit
 *    widening the user chose; a child task with a different principal cannot
 *    match a grant it did not ask for (D9: a child cannot widen its parent's
 *    permissions).
 *  - reject-this-action → the request is rejected and the run returns to
 *    RUNNING via the D8 approval_rejected row ("reject denies the action, not
 *    the task"); the withheld callback is NEVER invoked — the action ends as
 *    a typed denial, not an execution.
 *  - cancel-the-task → the request is cancelled and the run walks the D8
 *    cancellation path (CANCELLING → CANCELLED) with its DIRECT child runs
 *    (parent_task_id) cancelled in the SAME transaction — a real cancelled
 *    state, never a silent failure (G5).
 *
 * Ordering inside the transaction (D23 rule 5): typed refusals first (unknown
 * choice, missing request, run mismatch, agent actor, already resolved), then
 * the PURE transition evaluation — a transition rejection persists NOTHING,
 * so no grant can ever exist without its resumed run — then grant +
 * resolution + journal events as one commit. The withheld execute callback
 * runs ONLY on the approve path and ONLY after that commit.
 *
 * ---------------------------------------------------------------------------
 * Chunk 3 — the execution gate, consumption, reminders, mutes (S20; D9, D32,
 * E3, G3)
 *
 * `checkExecutionAllowed` is the AC26 gate EVERY execution consults — a grant
 * never skips the deterministic policy check. It layers the chunk-2
 * deterministic lookup (revocation, expiry, principal, tool identity, one-time
 * digest pin — all against the injected clock) with what only the recheck
 * layer knows: the ACTING conversation (a grant's conversation_scope is
 * applied on top of the returned grant — the lookup itself carries no
 * conversation parameter) and the one-time consumption state. A miss is a
 * typed reason, never a silent pass; when the first deterministic match fails
 * a later check the gate refuses (fail-closed, G5 — it never scans for a
 * "better" grant behind the deterministic pick).
 *
 * One-time consumption: the grant row carries a durable consumed_at stamp
 * (v11) written ONCE, after the approved execution's callback resolves — a
 * one-time grant can never authorize a second execution, and the stamp
 * survives a runtime restart. The gate consult INSIDE the approved execution
 * still passes: consumption marks COMPLETION, not the decision.
 *
 * Reminder firing (`dueReminders`) scans the durable v9 reminder rows
 * (delivered_at IS NULL, due_at <= now on the injected clock), enforces the
 * mute scopes, and stamps delivered_at — the durable delivery record. It
 * NEVER touches run state: no transition, no journal event, nothing but the
 * reminder rows themselves (E3; the D32 invariant — an approval waits
 * indefinitely, sibling runs are never killed while one waits — is preserved
 * by construction and pinned by test). NOTE: the contracts event vocabulary
 * has no approval-reminder event type (packages/contracts is untouchable), so
 * the delivery record IS the stamped reminder row, queryable via
 * listRemindersByApproval; delivery is not journalled as an event.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ApprovalChoice,
  ApprovalGrant,
  ApprovalRequest,
  APPROVAL_REMINDER_SCHEDULE_SECONDS,
  ArgsDigest,
  EVENT_ENVELOPES,
  Id,
  RISK_CLASSES,
  RiskClass,
  type Actor,
  type RunState,
  type TaskPolicy,
  type TaskRejection,
  type TaskRun,
} from "@shera-bot/contracts";

import {
  ApprovalsRepository,
  type ApprovalGrantRecord,
} from "../../adapters/sqlite/approvals-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { evaluateTaskTransition } from "../tasks/task-transitions.ts";

/** Stable failure codes for the approvals boundary (SCREAMING_SNAKE). */
export type ApprovalsServiceFailureCode =
  | "APPROVAL_PROPOSAL_INVALID"
  | "APPROVAL_PROPOSAL_RUN_MISMATCH"
  | "APPROVAL_DECISION_INVALID"
  | "APPROVAL_REQUEST_NOT_FOUND"
  | "APPROVAL_REQUEST_RUN_MISMATCH"
  | "APPROVAL_ALREADY_RESOLVED"
  | "APPROVAL_RECHECK_INVALID"
  | "APPROVAL_MUTE_INVALID"
  | "AGENT_CANNOT_SELF_APPROVE"
  | "AGENT_CANNOT_DECIDE_APPROVAL";

export class ApprovalsServiceError extends Error {
  readonly code: ApprovalsServiceFailureCode;
  readonly category: "validation" | "state" | "forbidden";

  constructor(
    code: ApprovalsServiceFailureCode,
    category: "validation" | "state" | "forbidden",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ApprovalsServiceError";
    this.code = code;
    this.category = category;
  }
}

/**
 * The typed tool proposal input (G2): contract data, not prose. There is
 * deliberately NO raw-arguments field — G3 keeps raw arguments out of
 * approval records, events, logs, and memory; the args_digest is the only
 * argument-derived value (the same sha256:<hex> discipline as the
 * tool.proposed payload).
 */
export const TypedToolProposal = z.strictObject({
  workspace_id: z.string().min(1).max(128),
  task_id: Id,
  conversation_id: Id,
  /** The proposing Agent (requested_by on the record; never the approver — D9). */
  agent_id: Id,
  tool_id: Id,
  tool_version: z.string().min(1).max(64),
  capability: z.string().min(1).max(128),
  risk_class: RiskClass,
  /** Explicit resource scope (D9: resource scope must be explicit). */
  resource_scope: z.string().min(1).max(512),
  args_digest: ArgsDigest,
  side_effect_summary: z.string().min(1).max(500),
});
export type TypedToolProposal = z.infer<typeof TypedToolProposal>;

/**
 * The gated set (G6, D35): READ_ONLY is the ladder's only automatic class —
 * read-only tools run automatically; every other D9 risk class pauses the run
 * for an approval decision. LOCAL_MUTATION's preview surface is the web gate's
 * concern (chunk 4); its EXECUTION is gated here like every other risky class.
 */
export const NON_GATED_RISK_CLASSES: ReadonlySet<RiskClass> = new Set<RiskClass>(["READ_ONLY"]);

export const GATED_RISK_CLASSES: readonly RiskClass[] = RISK_CLASSES.filter(
  (riskClass) => !NON_GATED_RISK_CLASSES.has(riskClass),
);

/**
 * The request_approval transition is not policy-guarded (no retry-class
 * command sits on its row), so this bound is never consulted; it exists only
 * to satisfy the pure transition function's input. The run's own policy is a
 * gateway concern that chunk 2's decision path does not need either.
 */
const DEFAULT_TASK_POLICY: TaskPolicy = { max_retries: 3 };

export interface ApprovalsServiceDeps {
  tx: SqliteTransactions;
  /** Sequence allocation for the run's D26 stream (gapless, in-transaction). */
  journal: Pick<EventJournalRepository, "nextSequence">;
  /** The journal-append authority the service journals BOTH events through. */
  events: Pick<EventsService, "appendEvent">;
  approvals: ApprovalsRepository;
  /**
   * The cancel-the-task cascade's run reads + cancellation (S20 chunk 2):
   * direct children by parent_task_id, cancelled inside the decision
   * transaction. Deliberately narrow — the approvals boundary never mutates
   * runs beyond this cascade.
   */
  operations: Pick<OperationsRepository, "listRunsByParentTaskId" | "updateRunState">;
  /** Injected clock (ISO strings); defaults to the system clock. */
  clock?: () => string;
}

export interface CreateRequestFromTypedProposalInput {
  proposal: TypedToolProposal;
  /** The run's current-state projection (D5), held by the caller. */
  run: TaskRun;
  /**
   * The gated action itself. NEVER invoked while a request is pending — the
   * S20 AC's "no side effect pre-decision" is enforced by construction here.
   */
  execute: () => void;
}

export type ApprovalPauseResult =
  | {
      outcome: "paused_for_approval";
      approval_id: string;
      /** The run at WAITING_FOR_APPROVAL, version advanced by the D8 machinery. */
      run: TaskRun;
      /** Always 5 (E3 schedule) on this outcome. */
      reminders_scheduled: number;
    }
  | {
      outcome: "executed_automatically";
      /** The run, untouched (never left RUNNING; nothing recorded or journalled). */
      run: TaskRun;
    }
  | {
      outcome: "transition_rejected";
      /** The typed D8 rejection; NOTHING was persisted or journalled. */
      rejection: TaskRejection;
    };

/** The journal payload type of an approval.requested append (the full envelope). */
type ApprovalRequestedEnvelope = z.infer<(typeof EVENT_ENVELOPES)["approval.requested"]>;

/** The journal payload type of a task.waiting_for_approval append (the full envelope). */
type WaitingForApprovalEnvelope = z.infer<(typeof EVENT_ENVELOPES)["task.waiting_for_approval"]>;

/**
 * The journal payload type of every D8 lifecycle transition append (the full
 * envelope): approval_granted, approval_rejected, cancelling and cancelled
 * share the TaskLifecyclePayload shape — each keeps its own event_type
 * literal, so the append sites pick the envelope by that literal.
 */
type LifecycleEnvelopeOf<
  T extends
    "task.approval_granted" | "task.approval_rejected" | "task.cancelling" | "task.cancelled",
> = z.infer<(typeof EVENT_ENVELOPES)[T]>;

/**
 * Run states a cancel-the-task cascade must NOT touch: an already-terminal
 * child keeps its outcome (a terminal child is never resurrected).
 */
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

/**
 * The decision input: one of the five contract choices, the deciding actor,
 * the paused run's current projection (held by the caller, D5), and the
 * callback withheld since the pause. The choice is re-validated typed at the
 * boundary — raw API input can carry anything.
 */
export interface ApplyDecisionInput {
  approval_id: string;
  choice: ApprovalChoice;
  decided_by: Actor;
  run: TaskRun;
  /**
   * The gated action withheld at pause time. Invoked ONLY by the three
   * approve choices, and only AFTER the decision transaction has committed.
   */
  execute: () => void;
}

export type ApprovalDecisionResult =
  | {
      outcome: "approved";
      approval_id: string;
      /** The request at its resolved (approved) shape. */
      request: ApprovalRequest;
      /** The grant the choice created (one_time for execution-only). */
      grant: ApprovalGrantRecord;
      /** The run back at RUNNING, version advanced by the D8 machinery. */
      run: TaskRun;
    }
  | {
      outcome: "action_rejected";
      approval_id: string;
      request: ApprovalRequest;
      /** The run back at RUNNING — the action was denied, not the task (D8). */
      run: TaskRun;
    }
  | {
      outcome: "task_cancelled";
      approval_id: string;
      request: ApprovalRequest;
      /** The run at CANCELLED (both D8 cancellation steps journalled). */
      run: TaskRun;
      /** Direct child runs cancelled in the same transaction. */
      cancelled_child_run_ids: string[];
    }
  | {
      outcome: "transition_rejected";
      /** The typed D8 rejection; NOTHING was persisted or journalled. */
      rejection: TaskRejection;
    };

export class ApprovalsService {
  constructor(private readonly deps: ApprovalsServiceDeps) {}

  private now(): string {
    return (this.deps.clock ?? (() => new Date().toISOString()))();
  }

  /**
   * Handle one typed tool proposal. Read-only risk classes execute
   * automatically (G6); gated classes pause the run and schedule the E3
   * reminders; a run that cannot legally pause answers the typed D8 rejection
   * with nothing persisted.
   */
  createRequestFromTypedProposal(input: CreateRequestFromTypedProposalInput): ApprovalPauseResult {
    const verdict = TypedToolProposal.safeParse(input.proposal);
    if (!verdict.success) {
      throw new ApprovalsServiceError(
        "APPROVAL_PROPOSAL_INVALID",
        "validation",
        "the tool proposal does not conform to the typed proposal contract",
      );
    }
    const proposal = verdict.data;

    // E12: the proposal must name the run it rides on — same workspace, same
    // task, same conversation. A mismatch is a composition fault, surfaced
    // typed before anything is written.
    if (
      proposal.workspace_id !== input.run.workspace_id ||
      proposal.task_id !== input.run.task_id ||
      proposal.conversation_id !== input.run.conversation_id
    ) {
      throw new ApprovalsServiceError(
        "APPROVAL_PROPOSAL_RUN_MISMATCH",
        "validation",
        "the proposal's workspace/task/conversation do not match the run",
      );
    }

    // G6: the ladder's only automatic class runs now — no request row, no
    // journal write, no pause. The callback IS the execution.
    if (NON_GATED_RISK_CLASSES.has(proposal.risk_class)) {
      input.execute();
      return { outcome: "executed_automatically", run: input.run };
    }

    return this.pauseForApproval(proposal, input.run);
  }

  /**
   * The gated path: request + pause + reminders as ONE atomic unit. The D8
   * transition is evaluated (pure) BEFORE any write; a rejection leaves the
   * journal, the request table, and the reminders untouched.
   */
  private pauseForApproval(proposal: TypedToolProposal, run: TaskRun): ApprovalPauseResult {
    const now = this.now();
    const approvalId = `apr_${randomUUID()}`;
    const commandId = `cmd_${randomUUID()}`;
    const stream = taskStreamId(run.task_id);

    return this.deps.tx.transaction((exec) => {
      // The approval.requested event takes the stream's next sequence; the
      // pause event takes the one after (the journal allocates both — the
      // writer allocates first, then builds the envelope with it).
      const requestSequence = this.deps.journal.nextSequence(stream, proposal.workspace_id, exec);
      const pauseSequence = requestSequence + 1;

      // Pure first (D23 rule 5): the transition decision reads no clock and
      // writes nothing, so a rejection here costs nothing and persists
      // nothing — the journal stays exactly as it was.
      const transition = evaluateTaskTransition({
        run,
        command: {
          type: "request_approval",
          command_id: commandId,
          idempotency_key: `approval-request:${approvalId}`,
          workspace_id: proposal.workspace_id,
          task_id: proposal.task_id,
          // The RUNTIME pauses the run (the transition row's actor); the
          // proposing Agent is recorded as the request's requested_by.
          actor: { type: "runtime", id: "runtime-gateway" },
          expected_version: run.version,
          issued_at: now,
        },
        policy: DEFAULT_TASK_POLICY,
        applied_idempotency_keys: [],
        clock: { now, next_sequence: pauseSequence },
      });
      if (!transition.ok) {
        return { outcome: "transition_rejected", rejection: transition.rejection };
      }

      // 1. The durable request row — contract-valid, digest-only (G3).
      const request = ApprovalRequest.parse({
        approval_id: approvalId,
        workspace_id: proposal.workspace_id,
        task_id: proposal.task_id,
        conversation_id: proposal.conversation_id,
        tool_id: proposal.tool_id,
        tool_version: proposal.tool_version,
        capability: proposal.capability,
        risk_class: proposal.risk_class,
        resource_scope: proposal.resource_scope,
        args_digest: proposal.args_digest,
        side_effect_summary: proposal.side_effect_summary,
        requested_by: { type: "agent", id: proposal.agent_id },
        requested_at: now,
        status: "pending",
      });
      this.deps.approvals.insertRequest(request, exec);

      // 2. The five E3 reminder slots, due on the injected clock. The rows are
      // the durable schedule (E27); firing is chunk 3's logic.
      for (const [index, offsetSeconds] of APPROVAL_REMINDER_SCHEDULE_SECONDS.entries()) {
        this.deps.approvals.insertReminder(
          {
            workspace_id: proposal.workspace_id,
            approval_id: approvalId,
            reminder_index: index,
            due_at: new Date(new Date(now).getTime() + offsetSeconds * 1000).toISOString(),
            delivered_at: null,
          },
          exec,
        );
      }

      // 3. The typed approval.requested event, journalled through the SAME
      // EventsService path every other writer uses (G2): the journal row
      // stores the FULL contract envelope as its payload.
      const requestEvent = EVENT_ENVELOPES["approval.requested"].parse({
        event_type: "approval.requested",
        event_version: 1,
        event_id: `evt_requested_${approvalId}`,
        stream_id: stream,
        sequence: requestSequence,
        actor: { type: "agent", id: proposal.agent_id },
        task_id: proposal.task_id,
        conversation_id: proposal.conversation_id,
        occurred_at: now,
        redaction_class: "public",
        payload: {
          tool_id: proposal.tool_id,
          tool_version: proposal.tool_version,
          capability: proposal.capability,
          risk_class: proposal.risk_class,
          args_digest: proposal.args_digest,
          resource_scope: proposal.resource_scope,
        },
      }) as ApprovalRequestedEnvelope;
      this.deps.events.appendEvent({
        event_id: requestEvent.event_id,
        stream_id: stream,
        type: "approval.requested",
        payload: requestEvent,
        workspace_id: proposal.workspace_id,
        correlation_id: commandId,
      });

      // 4. The D8 pause: RUNNING -> WAITING_FOR_APPROVAL, its event journalled
      // through the same path, the projection advanced by the transition's
      // own version increment (never a second state machine — G2).
      this.deps.events.appendEvent({
        event_id: transition.emitted_event.event_id,
        stream_id: stream,
        type: "task.waiting_for_approval",
        payload: transition.emitted_event as WaitingForApprovalEnvelope,
        workspace_id: proposal.workspace_id,
        correlation_id: commandId,
      });

      return {
        outcome: "paused_for_approval" as const,
        approval_id: approvalId,
        run: {
          ...run,
          state: "WAITING_FOR_APPROVAL",
          version: transition.next_version,
          updated_at: now,
        } satisfies TaskRun,
        reminders_scheduled: APPROVAL_REMINDER_SCHEDULE_SECONDS.length,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Decisions (S20 chunk 2; D9, PRD §8, G5/G6)
  // -------------------------------------------------------------------------

  /**
   * Apply one of the five contract choices to one pending approval request.
   * See the module doc for the per-choice semantics and the write ordering.
   *
   * Typed refusals (each its own error, nothing persisted):
   *  - APPROVAL_DECISION_INVALID        — the choice is not a contract choice;
   *  - APPROVAL_REQUEST_NOT_FOUND       — no such request in the workspace;
   *  - APPROVAL_REQUEST_RUN_MISMATCH    — the request does not ride this run;
   *  - AGENT_CANNOT_SELF_APPROVE        — the deciding Agent IS the requester;
   *  - AGENT_CANNOT_DECIDE_APPROVAL     — any other Agent actor (only user
   *    actors decide; a prompt-shaped input cannot create a grant — G6);
   *  - APPROVAL_ALREADY_RESOLVED        — the request was already decided.
   *
   * A D8 transition rejection (stale projection, wrong state, an admin trying
   * to approve — the approval rows allow user actors only) is answered as the
   * typed `transition_rejected` outcome with NOTHING persisted.
   */
  applyDecision(input: ApplyDecisionInput): ApprovalDecisionResult {
    const choiceVerdict = ApprovalChoice.safeParse(input.choice);
    if (!choiceVerdict.success) {
      throw new ApprovalsServiceError(
        "APPROVAL_DECISION_INVALID",
        "validation",
        "the decision choice is not one of the five contract choices",
      );
    }
    const choice = choiceVerdict.data;

    const committed = this.deps.tx.transaction((exec) =>
      this.decideInTransaction(
        input.approval_id,
        choice,
        input.decided_by,
        input.run,
        exec as SqliteExec,
      ),
    );

    // The withheld callback runs ONLY on the approve path and ONLY after the
    // decision transaction has COMMITTED: a callback failure can never roll
    // back an approval the user gave, and no side effect can precede its
    // durable grant + resume record (the S20 AC, on the decision side).
    //
    // One-time consumption (S20 chunk 3): when the approved execution
    // COMPLETES, the one-time grant is consumed durably — stamped once, after
    // the callback resolves, so the gate consult inside that execution still
    // passes but no second execution ever can (the stamp survives restarts; a
    // failed callback leaves the grant unconsumed — the user simply
    // re-decides). Reusable grants are never consumed.
    if (committed.outcome === "approved") {
      input.execute();
      if (committed.grant.one_time) {
        this.deps.approvals.consumeGrant(
          committed.grant.workspace_id,
          committed.grant.grant_id,
          this.now(),
        );
      }
    }
    return committed;
  }

  private decideInTransaction(
    approvalId: string,
    choice: ApprovalChoice,
    decidedBy: Actor,
    run: TaskRun,
    exec: SqliteExec,
  ): ApprovalDecisionResult {
    const request = this.deps.approvals.getRequest(run.workspace_id, approvalId, exec);
    if (request === null) {
      throw new ApprovalsServiceError(
        "APPROVAL_REQUEST_NOT_FOUND",
        "state",
        "no approval request with this id exists in the workspace",
      );
    }

    // E12/E-adjacent composition check: the decision's run projection must be
    // the run the request rides on (same workspace, task, conversation).
    if (
      request.workspace_id !== run.workspace_id ||
      request.task_id !== run.task_id ||
      request.conversation_id !== run.conversation_id
    ) {
      throw new ApprovalsServiceError(
        "APPROVAL_REQUEST_RUN_MISMATCH",
        "validation",
        "the request's workspace/task/conversation do not match the run",
      );
    }

    // G6 absolute invariants BEFORE any state check: an Agent never decides an
    // approval — not its own request (D9), and not anyone else's either. A
    // prompt-shaped input arriving as an agent actor therefore can never reach
    // grant creation (there is no other grant-creating path at all).
    if (decidedBy.type === "agent") {
      const self =
        request.requested_by.type === "agent" && request.requested_by.id === decidedBy.id;
      throw new ApprovalsServiceError(
        self ? "AGENT_CANNOT_SELF_APPROVE" : "AGENT_CANNOT_DECIDE_APPROVAL",
        "forbidden",
        self
          ? "an Agent cannot approve its own request"
          : "only user actors decide approvals; an Agent actor cannot decide",
      );
    }

    // Decisions are immutable (D9): a resolved request answers every further
    // decision with the typed already-resolved refusal.
    if (request.status !== "pending") {
      throw new ApprovalsServiceError(
        "APPROVAL_ALREADY_RESOLVED",
        "state",
        "this approval request was already resolved; decisions are immutable",
      );
    }

    const now = this.now();
    const commandId = `cmd_${randomUUID()}`;
    const stream = taskStreamId(run.task_id);
    // The first decision event takes the stream's next sequence; a second
    // (the cancel path's completion) takes the one after.
    const firstSequence = this.deps.journal.nextSequence(stream, run.workspace_id, exec);
    const ctx: DecisionContext = {
      request,
      run,
      decidedBy,
      choice,
      now,
      commandId,
      stream,
      firstSequence,
      exec,
    };

    if (choice === "reject-this-action") {
      return this.rejectAction(ctx);
    }
    if (choice === "cancel-the-task") {
      return this.cancelTask(ctx);
    }
    return this.approveAction(ctx);
  }

  private rejectAction(ctx: DecisionContext): ApprovalDecisionResult {
    const { request, run, decidedBy, choice, now, commandId, stream, firstSequence, exec } = ctx;

    // Pure first (D23 rule 5): the D8 vocabulary resumes the run via
    // approval_rejected ("reject denies the action, not the task" — PRD §8);
    // a rejection here persists nothing, the request stays pending.
    const denial = evaluateTaskTransition({
      run,
      command: {
        type: "approval_rejected",
        command_id: commandId,
        idempotency_key: `approval-decision:${request.approval_id}`,
        workspace_id: request.workspace_id,
        task_id: request.task_id,
        actor: decidedBy,
        expected_version: run.version,
        issued_at: now,
        approval_id: request.approval_id,
      },
      policy: DEFAULT_TASK_POLICY,
      applied_idempotency_keys: [],
      clock: { now, next_sequence: firstSequence },
    });
    if (!denial.ok) {
      return { outcome: "transition_rejected", rejection: denial.rejection };
    }

    this.deps.approvals.resolveRequest(
      request.workspace_id,
      request.approval_id,
      { status: "rejected", resolved_at: now, resolved_by_choice: choice },
      exec,
    );
    this.deps.events.appendEvent({
      event_id: denial.emitted_event.event_id,
      stream_id: stream,
      type: "task.approval_rejected",
      payload: denial.emitted_event as LifecycleEnvelopeOf<"task.approval_rejected">,
      workspace_id: request.workspace_id,
      correlation_id: commandId,
    });

    // The withheld callback is deliberately NEVER invoked on this path: the
    // denied action does not resume into execution — it ends as this typed
    // denial (the run itself is free to continue with other work).
    return {
      outcome: "action_rejected",
      approval_id: request.approval_id,
      request: { ...request, status: "rejected", resolved_at: now, resolved_by_choice: choice },
      run: { ...run, state: "RUNNING", version: denial.next_version, updated_at: now },
    };
  }

  private cancelTask(ctx: DecisionContext): ApprovalDecisionResult {
    const { request, run, decidedBy, choice, now, commandId, stream, firstSequence, exec } = ctx;

    // Step 1 of the D8 cancellation: WAITING_FOR_APPROVAL -> CANCELLING. The
    // deciding user is the actor (the table's cancel rows allow user/admin).
    const cancelling = evaluateTaskTransition({
      run,
      command: {
        type: "cancel_task",
        command_id: commandId,
        idempotency_key: `approval-decision:${request.approval_id}`,
        workspace_id: request.workspace_id,
        task_id: request.task_id,
        actor: decidedBy,
        expected_version: run.version,
        issued_at: now,
      },
      policy: DEFAULT_TASK_POLICY,
      applied_idempotency_keys: [],
      clock: { now, next_sequence: firstSequence },
    });
    if (!cancelling.ok) {
      return { outcome: "transition_rejected", rejection: cancelling.rejection };
    }

    // Step 2: CANCELLING -> CANCELLED, driven by the runtime gateway actor —
    // PRD §8 "immediate cancellation" still journals both D8 steps.
    const completed = evaluateTaskTransition({
      run: { ...run, state: "CANCELLING", version: cancelling.next_version, updated_at: now },
      command: {
        type: "cancel_complete",
        command_id: `cmd_${randomUUID()}`,
        idempotency_key: `approval-cancel-complete:${request.approval_id}`,
        workspace_id: request.workspace_id,
        task_id: request.task_id,
        actor: { type: "runtime", id: "runtime-gateway" },
        expected_version: cancelling.next_version,
        issued_at: now,
      },
      policy: DEFAULT_TASK_POLICY,
      applied_idempotency_keys: [],
      clock: { now, next_sequence: firstSequence + 1 },
    });
    if (!completed.ok) {
      return { outcome: "transition_rejected", rejection: completed.rejection };
    }

    this.deps.approvals.resolveRequest(
      request.workspace_id,
      request.approval_id,
      { status: "cancelled", resolved_at: now, resolved_by_choice: choice },
      exec,
    );
    this.deps.events.appendEvent({
      event_id: cancelling.emitted_event.event_id,
      stream_id: stream,
      type: "task.cancelling",
      payload: cancelling.emitted_event as LifecycleEnvelopeOf<"task.cancelling">,
      workspace_id: request.workspace_id,
      correlation_id: commandId,
    });
    this.deps.events.appendEvent({
      event_id: completed.emitted_event.event_id,
      stream_id: stream,
      type: "task.cancelled",
      payload: completed.emitted_event as LifecycleEnvelopeOf<"task.cancelled">,
      workspace_id: request.workspace_id,
      correlation_id: commandId,
    });

    // The cascade (S20 AC: "Cancel the task" cancels the run AND its children
    // rather than failing it silently): the direct children by parent_task_id,
    // cancelled in the SAME transaction. Already-terminal children keep their
    // outcome — a terminal child is not resurrected (G5: nothing is hidden;
    // the returned id list is the honest record of what was cancelled).
    const cancelledChildRunIds: string[] = [];
    for (const child of this.deps.operations.listRunsByParentTaskId(
      request.workspace_id,
      request.task_id,
      exec,
    )) {
      if (TERMINAL_RUN_STATES.has(child.state)) {
        continue;
      }
      this.deps.operations.updateRunState(
        request.workspace_id,
        child.operation_id,
        child.run_id,
        "CANCELLED",
        now,
        exec,
      );
      cancelledChildRunIds.push(child.run_id);
    }

    return {
      outcome: "task_cancelled",
      approval_id: request.approval_id,
      request: { ...request, status: "cancelled", resolved_at: now, resolved_by_choice: choice },
      run: { ...run, state: "CANCELLED", version: completed.next_version, updated_at: now },
      cancelled_child_run_ids: cancelledChildRunIds,
    };
  }

  private approveAction(ctx: DecisionContext): ApprovalDecisionResult {
    const { request, run, decidedBy, choice, now, commandId, stream, firstSequence, exec } = ctx;
    if (choice === "reject-this-action" || choice === "cancel-the-task") {
      throw new ApprovalsServiceError(
        "APPROVAL_DECISION_INVALID",
        "validation",
        "non-grant choices never reach the approve path",
      );
    }

    // Pure first (D23 rule 5): the D8 resume must be legal before ANY write —
    // a grant without a resumed run would be exactly the half-applied state
    // the S20 AC forbids (G5).
    const resume = evaluateTaskTransition({
      run,
      command: {
        type: "approval_granted",
        command_id: commandId,
        idempotency_key: `approval-decision:${request.approval_id}`,
        workspace_id: request.workspace_id,
        task_id: request.task_id,
        actor: decidedBy,
        expected_version: run.version,
        issued_at: now,
        approval_id: request.approval_id,
      },
      policy: DEFAULT_TASK_POLICY,
      applied_idempotency_keys: [],
      clock: { now, next_sequence: firstSequence },
    });
    if (!resume.ok) {
      return { outcome: "transition_rejected", rejection: resume.rejection };
    }

    // The grant (D9 field list). Principal = the requester's own: the TASK run
    // for "always-approve-this-tool", the requesting Agent for the other two
    // approve choices (the record's requested_by — never the deciding user,
    // never a parent run). conversation_scope defaults to the CURRENT
    // conversation; "any" is never implicit. Every grant pins the tool
    // VERSION; a one-time grant additionally pins the args_digest (a changed
    // argument set or tool version invalidates it). No expiry is invented
    // here: null = bounded by the prototype container lifetime (contract).
    const oneTime = choice === "approve-this-execution-only";
    const grant = ApprovalGrant.parse({
      grant_id: `grt_${randomUUID()}`,
      workspace_id: request.workspace_id,
      source_choice: choice,
      principal_type:
        choice === "always-approve-this-tool"
          ? "task"
          : request.requested_by.type === "user"
            ? "user"
            : "agent",
      principal_id:
        choice === "always-approve-this-tool" ? request.task_id : request.requested_by.id,
      tool_id: request.tool_id,
      tool_version: request.tool_version,
      capability: request.capability,
      resource_scope: request.resource_scope,
      conversation_scope: request.conversation_id,
      workspace_scope: request.workspace_id,
      expires_at: null,
      one_time: oneTime,
      created_by: decidedBy,
      approved_at: now,
      revoked_at: null,
    });
    const grantRecord: ApprovalGrantRecord = {
      ...grant,
      // G3: the digest, never raw arguments. Reusable grants are deliberately
      // argument-agnostic ("always approve this tool") and store NULL.
      args_digest: oneTime ? request.args_digest : null,
      // A fresh grant is unconsumed; the stamp lands only when a ONE-TIME
      // grant's approved execution completes (chunk 3).
      consumed_at: null,
    };

    // 1. The durable grant row — created here ONLY, inside the runtime
    //    transaction behind the typed refusals above (G6: no public
    //    "create grant" surface exists).
    this.deps.approvals.insertGrant(grantRecord, exec);

    // 2. The immutable request resolution.
    this.deps.approvals.resolveRequest(
      request.workspace_id,
      request.approval_id,
      { status: "approved", resolved_at: now, resolved_by_choice: choice },
      exec,
    );

    // 3. The D8 resume, journalled through the same path as every writer (G2).
    this.deps.events.appendEvent({
      event_id: resume.emitted_event.event_id,
      stream_id: stream,
      type: "task.approval_granted",
      payload: resume.emitted_event as LifecycleEnvelopeOf<"task.approval_granted">,
      workspace_id: request.workspace_id,
      correlation_id: commandId,
    });

    return {
      outcome: "approved",
      approval_id: request.approval_id,
      request: { ...request, status: "approved", resolved_at: now, resolved_by_choice: choice },
      grant: grantRecord,
      run: { ...run, state: "RUNNING", version: resume.next_version, updated_at: now },
    };
  }

  // -------------------------------------------------------------------------
  // Deterministic grant lookup (S20 chunk 2 — the check chunk 3 rechecks)
  // -------------------------------------------------------------------------

  /**
   * The deterministic grant check (D9: grants are "checked deterministically").
   * A grant matches when it is in the workspace, NOT revoked, NOT expired
   * (expiry compared on the injected clock), carries the SAME principal, and
   * pins exactly the requested tool_id, tool_version, capability, and
   * resource_scope. A ONE_TIME grant additionally requires the exact
   * args_digest — a changed argument set or a changed tool version invalidates
   * it (the S20 AC); a reusable grant is deliberately argument-agnostic
   * ("always approve this tool").
   *
   * Conversation scope is NOT part of this signature — grants record
   * conversation_scope ("any" is never implicit), and the chunk-3 recheck
   * layer, which knows the acting conversation, applies it on top of the
   * returned grant.
   *
   * The FIRST matching grant in (approved_at, grant_id) order wins — a
   * deterministic pick, never a silent conflict resolution (G5).
   */
  findActiveGrant(
    workspaceId: string,
    principal: { type: ApprovalGrant["principal_type"]; id: string },
    toolId: string,
    toolVersion: string,
    capability: string,
    resourceScope: string,
    argsDigest: string,
    exec?: SqliteExec,
  ): GrantLookupResult {
    const nowMs = new Date(this.now()).getTime();
    const match = this.deps.approvals.listGrants(workspaceId, exec).find((grant) => {
      if (grant.revoked_at !== null) {
        return false;
      }
      if (grant.principal_type !== principal.type || grant.principal_id !== principal.id) {
        return false;
      }
      if (grant.tool_id !== toolId || grant.tool_version !== toolVersion) {
        return false;
      }
      if (grant.capability !== capability || grant.resource_scope !== resourceScope) {
        return false;
      }
      // The one-time invalidation rule (D9): the grant holds only for the
      // exact argument set it was approved for.
      if (grant.one_time && grant.args_digest !== argsDigest) {
        return false;
      }
      if (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= nowMs) {
        return false;
      }
      return true;
    });
    return match === undefined
      ? { ok: false, reason: "no_active_grant" }
      : { ok: true, grant: match };
  }

  // -------------------------------------------------------------------------
  // The execution gate (S20 chunk 3 — AC26; D9, G5)
  // -------------------------------------------------------------------------

  /**
   * The AC26 gate EVERY execution consults: a matching reusable grant lets the
   * same action execute without another prompt WHILE STILL passing the full
   * deterministic policy check — a grant never skips it. A mid-flight
   * revocation, a changed tool version, a changed argument set, a foreign
   * conversation, or a consumed one-time grant each refuse the execution with
   * a typed reason (nothing throws for the state-based misses — the caller
   * branches on the result).
   *
   * Check order:
   *  (a) the deterministic policy fields are present and coherent — a
   *      malformed input (e.g. a non-digest args_digest) is a typed
   *      APPROVAL_RECHECK_INVALID refusal BEFORE any grant is consulted;
   *  (c) the chunk-2 deterministic lookup — principal + tool identity +
   *      capability + resource_scope exact match, NOT revoked, NOT expired
   *      (compared on the injected clock, (d)), and the one-time args_digest
   *      pin — a miss answers `no_active_grant`;
   *  (b) the acting-conversation check on top of the RETURNED grant (the
   *      lookup deliberately carries no conversation parameter — chunk 2): a
   *      grant scoped to one conversation is refused from any other; an
   *      explicit "any" passes everywhere;
   *  (c') the one-time consumption state — a consumed one-time grant answers
   *      `grant_consumed` even for identical arguments.
   *
   * Fail-closed (G5): the FIRST deterministic match decides — the gate never
   * rescans for a grant that would pass a later check, and it never widens a
   * grant. It also never mutates anything: the gate is a pure consult (the
   * consumption stamp is written by the decision path, after execution
   * completes).
   */
  checkExecutionAllowed(input: ExecutionRecheckInput): ExecutionRecheckResult {
    const verdict = ExecutionRecheckInput.safeParse(input);
    if (!verdict.success) {
      throw new ApprovalsServiceError(
        "APPROVAL_RECHECK_INVALID",
        "validation",
        "the execution recheck input is not coherent typed policy data",
      );
    }
    const query = verdict.data;

    const lookup = this.findActiveGrant(
      query.workspace_id,
      query.principal,
      query.tool_id,
      query.tool_version,
      query.capability,
      query.resource_scope,
      query.args_digest,
    );
    if (!lookup.ok) {
      return { allowed: false, reason: "no_active_grant" };
    }
    const grant = lookup.grant;

    if (grant.conversation_scope !== "any" && grant.conversation_scope !== query.acting_conversation_id) {
      return { allowed: false, reason: "conversation_scope_mismatch" };
    }

    if (grant.one_time && grant.consumed_at !== null) {
      return { allowed: false, reason: "grant_consumed" };
    }

    return { allowed: true, grant_id: grant.grant_id };
  }
}

/** The deterministic lookup's typed result: the matching grant or one typed miss. */
export type GrantLookupResult =
  { ok: true; grant: ApprovalGrantRecord } | { ok: false; reason: "no_active_grant" };

/**
 * The gate's input (G2): the same deterministic policy fields the proposal
 * carried, plus the ACTING principal and the conversation the execution runs
 * in. The resource_scope and args_digest are compared EXACTLY against the
 * recorded values — the recorded values are the redacted ones (the boundary
 * redaction pass is deterministic), so callers recheck with the scope as
 * recorded; a raw secret-bearing scope fails closed as a typed miss.
 */
export const ExecutionRecheckInput = z.strictObject({
  workspace_id: z.string().min(1).max(128),
  principal: z.strictObject({
    type: z.enum(["user", "agent", "task"]),
    id: z.string().min(1).max(256),
  }),
  tool_id: z.string().min(1).max(256),
  tool_version: z.string().min(1).max(64),
  capability: z.string().min(1).max(128),
  resource_scope: z.string().min(1).max(512),
  args_digest: ArgsDigest,
  acting_conversation_id: Id,
});
export type ExecutionRecheckInput = z.infer<typeof ExecutionRecheckInput>;

/**
 * The gate's typed answer: allowed (with the grant that authorizes it) or one
 * of the typed refusal reasons. No match / revoked / expired / one-time
 * digest mismatch fold into `no_active_grant` (the lookup's own answer); the
 * recheck layer adds the conversation and consumption reasons.
 */
export type ExecutionRecheckResult =
  | { allowed: true; grant_id: string }
  | {
      allowed: false;
      reason: "no_active_grant" | "conversation_scope_mismatch" | "grant_consumed";
    };

/** Everything one decision touches, passed from the transaction into a branch. */
interface DecisionContext {
  request: ApprovalRequest;
  run: TaskRun;
  decidedBy: Actor;
  choice: ApprovalChoice;
  now: string;
  commandId: string;
  stream: string;
  firstSequence: number;
  exec: SqliteExec;
}
