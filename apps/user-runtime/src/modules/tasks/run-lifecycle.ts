/**
 * Row-lifecycle transition applier (S22) — the ONE piece of shared machinery
 * for applying a D8 transition to a ROW-based run (an OperationRun row created
 * through the operations seam, which has no journal-rebuildable TaskRun
 * projection). Consumers: the RetryCoordinator (transient/permanent/ambiguous
 * failure decisions) and the RunCancellationService (the user cancel path).
 *
 * Discipline (identical for every caller — never a second state machine):
 *  - transition legality: (from-state, command, actor) is validated against
 *    the SAME TASK_TRANSITIONS table the pure transition function serves
 *    (the table as data, D23 rule 5) — including the actor vocabulary and
 *    the retry-policy attempt bound;
 *  - optimistic version: 1 + the journalled lifecycle count on the run's
 *    task stream (task:<run_id>) — the approvals rebuild discipline — baked
 *    into a DETERMINISTIC event id, so a lost concurrent race deduplicates
 *    at the journal append (the winner's row is the contract);
 *  - ONE transaction (D10): the contract lifecycle envelope (built through
 *    the SAME buildTaskTransitionEvent the approvals path journals through)
 *    plus the caller's optional audit record commit together;
 *  - journal-first, then the row write through the run-control seam (the
 *    composed applyRunState drives the worker lifecycle from it) — a
 *    seam-write failure leaves the evidence committed and is contained (the
 *    E27 aftermath ordering), never rolled into silence;
 *  - post-commit live fanout through the injected publish hook (contained).
 *
 * Governing records: D8, D23 rule 5, D10, E27; PRD §8.
 */
import { TASK_LIFECYCLE_EVENT_TYPES, type RunState } from "@shera-bot/contracts";

import type {
  EventJournalRepository,
  EventJournalRow,
} from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
import { buildTaskTransitionEvent, taskStreamId } from "./task-events.ts";
import { TASK_TRANSITIONS, type TaskTransitionRow } from "./task-transitions.ts";

/** The lifecycle commands this applier serves (closed set). S28: the
 * runtime scheduler's autonomous-task walk joins the failure and
 * cancellation commands — the forward D8 walk (queue/start/complete) and
 * the gated-plan pause ride the SAME applier and the SAME TASK_TRANSITIONS
 * table as every S22 decision (never a second state machine). */
export type RowLifecycleCommand =
  | "queue_task"
  | "start_task"
  | "complete_task"
  | "request_approval"
  | "schedule_retry"
  | "retry_attempt"
  | "retry_task"
  | "pause_retry_exhausted"
  | "pause_insufficient_credits"
  | "fail_task"
  | "recovery_required"
  | "cancel_task"
  | "cancel_complete";

/** The runtime audit record appended alongside the lifecycle envelope. */
export interface RowLifecycleAudit {
  decision: "retry" | "pause" | "fail" | "pause_for_review" | "cancelled";
  failureCode: string;
  reason: string;
  attempt: number | null;
  delayMs: number | null;
}

export interface RowLifecycleDeps {
  tx: SqliteTransactions;
  journal: Pick<EventJournalRepository, "nextSequence" | "readFrom" | "findById">;
  events: Pick<EventsService, "appendEvent">;
  operations: Pick<OperationsRepository, "findRunOperation" | "findChat">;
  runControl: TaskRunOperationsSeam;
  now?: (() => string) | undefined;
  publish?: ((event: EventEnvelope) => void) | undefined;
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export interface RowTransitionInput {
  workspaceId: string;
  runId: string;
  command: RowLifecycleCommand;
  actor: { type: string; id: string };
  /** The retry attempt (retry-class commands); null otherwise. */
  attempt?: number | null;
  /** The recorded failure event the transition references; null otherwise. */
  failureEventId?: string | null;
  /** The runtime audit record (run.failure_decided) to append alongside. */
  audit?: RowLifecycleAudit | null;
  /** The policy bound for retry-class commands (PRD §8); default 3. */
  maxRetries?: number | undefined;
}

export type RowTransitionResult =
  { ok: true; toState: RunState; version: number } | { ok: false; reason: string };

/** The lifecycle event types that ARE transitions (task.created is not — it
 * is the version-1 creation the count starts from; the same exclusion the
 * approvals rebuild records). */
const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  TASK_LIFECYCLE_EVENT_TYPES.filter((type) => type !== "task.created"),
);

const RETRY_COMMANDS: ReadonlySet<string> = new Set([
  "schedule_retry",
  "retry_attempt",
  "retry_task",
]);

/** Internal: the deterministic event id already exists (a concurrent
 * duplicate decision lost the race) — the winner's row is the contract. */
class TransitionDuplicateError extends Error {
  constructor() {
    super("transition already applied");
    this.name = "TransitionDuplicateError";
  }
}

/**
 * Apply ONE D8 transition to a row-based run. Purity boundary: this touches
 * the journal + the run row only; the caller owns its own seams (worker stop,
 * executor cancel, leases) around the two cancellation steps.
 */
export function applyRowLifecycleTransition(
  deps: RowLifecycleDeps,
  input: RowTransitionInput,
): RowTransitionResult {
  const { workspaceId, runId, command, actor } = input;
  const currentState = deps.runControl.runState(workspaceId, runId);
  if (currentState === null) {
    return { ok: false, reason: "run_not_found" };
  }
  const row: TaskTransitionRow | undefined = TASK_TRANSITIONS.find(
    (candidate) => candidate.from === currentState && candidate.command === command,
  );
  if (row === undefined) {
    return { ok: false, reason: `illegal transition ${currentState} --${command}--> ?` };
  }
  if (!row.actors.includes(actor.type as "user" | "admin" | "agent" | "runtime")) {
    return { ok: false, reason: `actor ${actor.type} is not allowed for ${command}` };
  }
  if (RETRY_COMMANDS.has(command)) {
    if (typeof input.attempt !== "number" || input.attempt < 1) {
      return { ok: false, reason: "retry authorization requires an attempt number" };
    }
    if (input.attempt > (input.maxRetries ?? 3)) {
      return { ok: false, reason: "retry bound exceeded; the task must pause instead" };
    }
  }

  const streamId = taskStreamId(runId);
  const operationId = deps.operations.findRunOperation(workspaceId, runId);
  if (operationId === null) {
    return { ok: false, reason: "run_not_found" };
  }
  const conversationId = deps.operations.findChat(workspaceId, operationId) ?? operationId;
  const now = deps.now ? deps.now() : new Date().toISOString();
  const publishedEvents: EventEnvelope[] = [];
  let appliedVersion = 0;

  try {
    deps.tx.transaction((exec) => {
      // Optimistic version: 1 + every journalled lifecycle transition on
      // this stream. The version is baked into the DETERMINISTIC event id,
      // so a lost concurrent race deduplicates at the journal append.
      const version =
        1 +
        deps.journal
          .readFrom(workspaceId, streamId, 0, 10_000, exec)
          .filter((candidate: EventJournalRow) => LIFECYCLE_EVENT_TYPES.has(candidate.event_type))
          .length;
      const commandId = `cmd_${command}_${runId}_v${version}`;
      if (deps.journal.findById(workspaceId, `evt_${commandId}`, exec) !== null) {
        throw new TransitionDuplicateError();
      }
      const sequence = deps.journal.nextSequence(streamId, workspaceId, exec);
      const envelope = buildTaskTransitionEvent({
        run: { task_id: runId, conversation_id: conversationId },
        command: { command_id: commandId, actor },
        eventType: row.event,
        payload: {
          from_state: row.from,
          to_state: row.to,
          reason: row.reason,
          correlation_id: commandId,
          ...(typeof input.attempt === "number" ? { attempt: input.attempt } : {}),
          ...(typeof input.failureEventId === "string"
            ? { failure_event_id: input.failureEventId }
            : {}),
        },
        clock: { now, next_sequence: sequence },
      });
      deps.events.appendEvent({
        event_id: envelope.event_id,
        stream_id: envelope.stream_id,
        type: envelope.event_type,
        payload: envelope,
        workspace_id: workspaceId,
        correlation_id: commandId,
      });
      if (input.audit) {
        const decisionEnvelope = deps.events.appendEvent({
          event_id: `evt_failure_decision_v${version}_${runId}`,
          stream_id: streamId,
          type: "run.failure_decided",
          payload: {
            workspace_id: workspaceId,
            run_id: runId,
            decision: input.audit.decision,
            failure_code: input.audit.failureCode,
            reason: input.audit.reason,
            attempt: input.audit.attempt,
            delay_ms: input.audit.delayMs,
          },
          workspace_id: workspaceId,
          correlation_id: commandId,
        });
        publishedEvents.push(decisionEnvelope);
      }
      appliedVersion = version;
    });
  } catch (error) {
    if (error instanceof TransitionDuplicateError) {
      return { ok: false, reason: "already_applied" };
    }
    deps.logFault?.("row_lifecycle_transition_failed", {
      workspace_id: workspaceId,
      run_id: runId,
      command,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "transition_failed" };
  }

  // Post-commit: the row write through the seam (flow hooks fire from it —
  // the composed applyRunState drives the worker lifecycle), then fanout.
  try {
    deps.runControl.applyRunState(workspaceId, runId, row.to);
  } catch (error) {
    deps.logFault?.("row_lifecycle_row_state_failed", {
      workspace_id: workspaceId,
      run_id: runId,
      target: row.to,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (publishedEvents.length > 0 && deps.publish) {
    for (const event of publishedEvents) {
      try {
        deps.publish(event);
      } catch (error) {
        deps.logFault?.("row_lifecycle_publish_failed", {
          workspace_id: workspaceId,
          run_id: runId,
          name: error instanceof Error ? error.name : "Error",
        });
      }
    }
  }
  return { ok: true, toState: row.to, version: appliedVersion };
}

/** The retry bound default (PRD §8: at most three attempts). */
export const DEFAULT_MAX_RETRIES = 3;
