/**
 * Task state machine (S02, D8 + D23 rule 5): the transition table as DATA and
 * the pure decision function.
 *
 *   (current_state, command, policy, version) -> accepted transition | typed rejection
 *
 * Design note — XState v5 was evaluated against this shape (E-note, recorded in
 * the S02 evidence pack per BUILD_MAP §8 "evaluate vs hand-rolled"): XState's
 * unhandled events are silent no-ops, guard failures are indistinguishable
 * from unhandled events, and it has no optimistic-version or idempotency
 * semantics — all three are first-class requirements here (typed rejections
 * that survive as journal data; version conflict; duplicate command). The
 * machine must remain a pure decision the gateway applies inside its SQLite
 * transaction (D23 rule 5), not a stateful actor. A flat data table with 35
 * rows is the cheaper, inspectable implementation; see the slice report.
 *
 * Purity: never throws, never mutates the input, never reads a clock. The
 * caller supplies `now` and the next per-stream sequence (fake clock in tests).
 */
import {
  type Actor,
  type EventType,
  type RunState,
  type TaskCommand,
  type TaskLifecyclePayload,
  type TaskPolicy,
  type TaskRejection,
  type TaskRun,
  type TypedExecutionEvent,
  TaskCommand as TaskCommandSchema,
} from "@shera-bot/contracts";

import { buildTaskTransitionEvent, type EnvelopeClock } from "./task-events.ts";

/** One legal D8 transition: source, target, command, allowed actors, reason, emitted event. */
export interface TaskTransitionRow {
  from: RunState;
  to: RunState;
  command: TaskCommand["type"];
  actors: readonly Actor["type"][];
  /** D8: every transition carries a reason from the closed vocabulary. */
  reason: string;
  /** D8: the event emitted when the transition is applied. */
  event: EventType;
}

const CANCEL_ACTORS: readonly Actor["type"][] = ["user", "admin"];

/**
 * The transition table — every legal D8 transition, as data. Terminal states
 * (SUCCEEDED, FAILED, CANCELLED) have no rows: any command targeting them is
 * rejected as an illegal transition.
 *
 * Modelling notes (from the decision records):
 * - cancel_task goes through CANCELLING; completion of cancellation is its own
 *   transition (D8 names both states; PRD §8 "immediate cancellation" still
 *   journals the two steps).
 * - approval_rejected returns to RUNNING: "Reject this action" denies the
 *   action, not the task — only "Cancel the task" cancels (PRD §8).
 * - QUEUED -> PAUSED (insufficient_credits) models D48: the reservation is
 *   checked before the model call, so the run never enters RUNNING unfunded.
 * - FAILED -> RETRYING is legal ONLY with retry authorization (the recorded
 *   failure event and an attempt inside the policy bound) — the row is guarded
 *   by policy, not by the table (phase0 plan §3 named this exact case).
 */
export const TASK_TRANSITIONS: readonly TaskTransitionRow[] = [
  {
    from: "CREATED",
    to: "PLANNED",
    command: "plan_ready",
    actors: ["agent", "runtime"],
    reason: "plan_ready",
    event: "task.plan_ready",
  },
  {
    from: "CREATED",
    to: "QUEUED",
    command: "queue_task",
    actors: ["runtime"],
    reason: "admitted_to_queue",
    event: "task.queued",
  },
  {
    from: "CREATED",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "PLANNED",
    to: "QUEUED",
    command: "queue_task",
    actors: ["runtime"],
    reason: "admitted_to_queue",
    event: "task.queued",
  },
  {
    from: "PLANNED",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "QUEUED",
    to: "RUNNING",
    command: "start_task",
    actors: ["runtime"],
    reason: "worker_acquired",
    event: "task.started",
  },
  {
    from: "QUEUED",
    to: "PAUSED",
    command: "pause_insufficient_credits",
    actors: ["runtime"],
    reason: "insufficient_credits",
    event: "task.paused",
  },
  {
    from: "QUEUED",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "RUNNING",
    to: "WAITING_FOR_AGENT",
    command: "wait_for_agent",
    actors: ["runtime"],
    reason: "agent_input_needed",
    event: "task.waiting_for_agent",
  },
  {
    from: "RUNNING",
    to: "WAITING_FOR_APPROVAL",
    command: "request_approval",
    actors: ["runtime"],
    reason: "approval_required",
    event: "task.waiting_for_approval",
  },
  {
    from: "RUNNING",
    to: "WAITING_FOR_RESOURCE",
    command: "wait_for_resource",
    actors: ["runtime"],
    reason: "resource_unavailable",
    event: "task.waiting_for_resource",
  },
  {
    from: "RUNNING",
    to: "RETRYING",
    command: "schedule_retry",
    actors: ["runtime"],
    reason: "transient_failure_scheduled",
    event: "task.retry_scheduled",
  },
  {
    from: "RUNNING",
    to: "PAUSED",
    command: "pause_insufficient_credits",
    actors: ["runtime"],
    reason: "insufficient_credits",
    event: "task.paused",
  },
  {
    from: "RUNNING",
    to: "PAUSED",
    command: "pause_retry_exhausted",
    actors: ["runtime"],
    reason: "retry_exhausted",
    event: "task.paused",
  },
  {
    from: "RUNNING",
    to: "RECOVERY_REQUIRED",
    command: "recovery_required",
    actors: ["runtime"],
    reason: "unprovable_external_effect",
    event: "task.recovery_required",
  },
  {
    from: "RUNNING",
    to: "SUCCEEDED",
    command: "complete_task",
    actors: ["runtime"],
    reason: "run_completed",
    event: "task.succeeded",
  },
  {
    from: "RUNNING",
    to: "FAILED",
    command: "fail_task",
    actors: ["runtime"],
    reason: "run_failed",
    event: "task.failed",
  },
  {
    from: "RUNNING",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "WAITING_FOR_AGENT",
    to: "RUNNING",
    command: "agent_responded",
    actors: ["agent", "runtime"],
    reason: "agent_responded",
    event: "task.agent_responded",
  },
  {
    from: "WAITING_FOR_AGENT",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "WAITING_FOR_APPROVAL",
    to: "RUNNING",
    command: "approval_granted",
    actors: ["user"],
    reason: "approval_granted",
    event: "task.approval_granted",
  },
  {
    from: "WAITING_FOR_APPROVAL",
    to: "RUNNING",
    command: "approval_rejected",
    actors: ["user"],
    reason: "approval_rejected",
    event: "task.approval_rejected",
  },
  {
    from: "WAITING_FOR_APPROVAL",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "WAITING_FOR_RESOURCE",
    to: "RUNNING",
    command: "resource_available",
    actors: ["runtime"],
    reason: "resource_available",
    event: "task.resource_acquired",
  },
  {
    from: "WAITING_FOR_RESOURCE",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "RETRYING",
    to: "RUNNING",
    command: "retry_attempt",
    actors: ["runtime"],
    reason: "retry_attempt_started",
    event: "task.retry_started",
  },
  {
    from: "RETRYING",
    to: "PAUSED",
    command: "pause_retry_exhausted",
    actors: ["runtime"],
    reason: "retry_exhausted",
    event: "task.paused",
  },
  {
    from: "RETRYING",
    to: "RECOVERY_REQUIRED",
    command: "recovery_required",
    actors: ["runtime"],
    reason: "unprovable_external_effect",
    event: "task.recovery_required",
  },
  {
    from: "RETRYING",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "PAUSED",
    to: "QUEUED",
    command: "resume_task",
    actors: ["user", "admin"],
    reason: "resumed_after_pause",
    event: "task.resumed",
  },
  {
    from: "PAUSED",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "RECOVERY_REQUIRED",
    to: "RUNNING",
    command: "recovery_resume",
    actors: ["user", "runtime"],
    reason: "recovery_approved",
    event: "task.recovery_resumed",
  },
  {
    from: "RECOVERY_REQUIRED",
    to: "CANCELLING",
    command: "cancel_task",
    actors: CANCEL_ACTORS,
    reason: "cancellation_requested",
    event: "task.cancelling",
  },

  {
    from: "CANCELLING",
    to: "CANCELLED",
    command: "cancel_complete",
    actors: ["runtime"],
    reason: "cancellation_completed",
    event: "task.cancelled",
  },

  // Guarded by retry policy (see module doc): needs failure_event_id + attempt.
  {
    from: "FAILED",
    to: "RETRYING",
    command: "retry_task",
    actors: ["user", "runtime"],
    reason: "manual_retry_scheduled",
    event: "task.retry_scheduled",
  },
];

const RETRY_COMMANDS: ReadonlySet<TaskCommand["type"]> = new Set([
  "schedule_retry",
  "retry_task",
  "retry_attempt",
]);

function rejection(
  kind: TaskRejection["kind"],
  code: string,
  safeMessage: string,
  detail: Record<string, unknown> | null,
): TaskRejection {
  return { kind, code, safe_message: safeMessage, detail };
}

export interface TaskTransitionInput {
  /** The persisted current-state projection of the run (D5). */
  run: TaskRun;
  /** A contract-valid command (parse raw input with parseTaskCommand first). */
  command: TaskCommand;
  policy: TaskPolicy;
  /** Idempotency keys already applied for this task (D23 rule 6). */
  applied_idempotency_keys: readonly string[];
  /** Caller-supplied clock + journal sequence (pure; deterministic tests). */
  clock: EnvelopeClock;
}

export type TaskTransitionResult =
  | {
      ok: true;
      from: RunState;
      to: RunState;
      actor: Actor;
      reason: string;
      /** The durable event to journal inside the same transaction (D23 rule 5). */
      emitted_event: TypedExecutionEvent;
      /** The run's next optimistic-concurrency version. */
      next_version: number;
    }
  | { ok: false; rejection: TaskRejection };

/**
 * The pure transition function. Order of checks (each matters for semantics):
 * 1. idempotency — a replayed command deduplicates even if the version moved on;
 * 2. optimistic version — the projection must still be at expected_version;
 * 3. transition existence — no row for (state, command) is illegal;
 * 4. actor authorization — the row's allowed principals;
 * 5. policy — retry authorization for retry-class commands.
 */
export function evaluateTaskTransition(input: TaskTransitionInput): TaskTransitionResult {
  const { run, command, policy, applied_idempotency_keys, clock } = input;

  if (applied_idempotency_keys.includes(command.idempotency_key)) {
    return {
      ok: false,
      rejection: rejection(
        "duplicate_command",
        "TASK_DUPLICATE_COMMAND",
        "This command was already applied.",
        { idempotency_key: command.idempotency_key },
      ),
    };
  }

  if (command.expected_version !== run.version) {
    return {
      ok: false,
      rejection: rejection(
        "version_conflict",
        "TASK_VERSION_CONFLICT",
        "This task was updated elsewhere. Reload and retry.",
        { expected_version: command.expected_version, actual_version: run.version },
      ),
    };
  }

  const row = TASK_TRANSITIONS.find((r) => r.from === run.state && r.command === command.type);
  if (!row) {
    return {
      ok: false,
      rejection: rejection(
        "illegal_transition",
        "TASK_ILLEGAL_TRANSITION",
        "This action is not allowed in the task's current state.",
        {
          state: run.state,
          allowed_commands: [
            ...new Set(TASK_TRANSITIONS.filter((r) => r.from === run.state).map((r) => r.command)),
          ].sort(),
        },
      ),
    };
  }

  if (!row.actors.includes(command.actor.type)) {
    return {
      ok: false,
      rejection: rejection(
        "actor_not_allowed",
        "TASK_ACTOR_NOT_ALLOWED",
        "This principal cannot perform this action on the task.",
        { command: command.type, actor_type: command.actor.type, allowed_actors: [...row.actors] },
      ),
    };
  }

  if (RETRY_COMMANDS.has(command.type)) {
    // Retry authorization is the retry event: the recorded failure and the
    // attempt number within the policy bound (PRD §8; phase0 plan §3).
    const rawAttempt: unknown = "attempt" in command ? command.attempt : undefined;
    const attempt = typeof rawAttempt === "number" ? rawAttempt : undefined;
    const rawFailureEventId: unknown =
      "failure_event_id" in command ? command.failure_event_id : undefined;
    const failureEventId = typeof rawFailureEventId === "string" ? rawFailureEventId : undefined;
    if (attempt === undefined || attempt < 1) {
      return {
        ok: false,
        rejection: rejection(
          "policy_violation",
          "TASK_RETRY_AUTHORIZATION_REQUIRED",
          "A retry needs the recorded failure event and attempt number.",
          { command: command.type, required: ["failure_event_id", "attempt"] },
        ),
      };
    }
    if (command.type !== "retry_attempt" && failureEventId === undefined) {
      return {
        ok: false,
        rejection: rejection(
          "policy_violation",
          "TASK_RETRY_AUTHORIZATION_REQUIRED",
          "A retry needs the recorded failure event and attempt number.",
          { command: command.type, required: ["failure_event_id", "attempt"] },
        ),
      };
    }
    if (attempt > policy.max_retries) {
      return {
        ok: false,
        rejection: rejection(
          "policy_violation",
          "TASK_RETRY_BOUND_EXCEEDED",
          "The retry bound was reached; the task must pause instead.",
          { attempt, max_retries: policy.max_retries },
        ),
      };
    }
  }

  const retryAttempt: unknown = "attempt" in command ? command.attempt : undefined;
  const retryFailureEventId: unknown =
    "failure_event_id" in command ? command.failure_event_id : undefined;

  const payload: TaskLifecyclePayload = {
    from_state: row.from,
    to_state: row.to,
    reason: row.reason,
    correlation_id: command.command_id,
    ...(command.type === "approval_granted" || command.type === "approval_rejected"
      ? { approval_id: command.approval_id }
      : {}),
    ...(typeof retryAttempt === "number" ? { attempt: retryAttempt } : {}),
    ...(typeof retryFailureEventId === "string" ? { failure_event_id: retryFailureEventId } : {}),
  };

  const emitted_event = buildTaskTransitionEvent({
    run,
    command,
    eventType: row.event,
    payload,
    clock,
  });

  return {
    ok: true,
    from: row.from,
    to: row.to,
    actor: command.actor,
    reason: row.reason,
    emitted_event,
    next_version: run.version + 1,
  };
}

export type ParseTaskCommandResult =
  { ok: true; command: TaskCommand } | { ok: false; rejection: TaskRejection };

/** Parse raw input into a contract-valid command; typed rejection on failure. */
export function parseTaskCommand(raw: unknown): ParseTaskCommandResult {
  const verdict = TaskCommandSchema.safeParse(raw);
  if (verdict.success) {
    return { ok: true, command: verdict.data };
  }
  return {
    ok: false,
    rejection: rejection(
      "malformed_command",
      "TASK_COMMAND_MALFORMED",
      "The command did not match the task command contract.",
      {
        issues: verdict.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    ),
  };
}
