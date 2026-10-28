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
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ApprovalRequest,
  APPROVAL_REMINDER_SCHEDULE_SECONDS,
  ArgsDigest,
  EVENT_ENVELOPES,
  Id,
  RISK_CLASSES,
  RiskClass,
  type TaskPolicy,
  type TaskRejection,
  type TaskRun,
} from "@shera-bot/contracts";

import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { evaluateTaskTransition } from "../tasks/task-transitions.ts";

/** Stable failure codes for the approvals boundary (SCREAMING_SNAKE). */
export type ApprovalsServiceFailureCode =
  | "APPROVAL_PROPOSAL_INVALID"
  | "APPROVAL_PROPOSAL_RUN_MISMATCH";

export class ApprovalsServiceError extends Error {
  readonly code: ApprovalsServiceFailureCode;
  readonly category: "validation" | "state";

  constructor(
    code: ApprovalsServiceFailureCode,
    category: "validation" | "state",
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
  createRequestFromTypedProposal(
    input: CreateRequestFromTypedProposalInput,
  ): ApprovalPauseResult {
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
}
