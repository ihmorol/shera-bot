/**
 * Task commands (S02 runtime core input, D23 rules 5/6): every side-effecting
 * command is idempotent — command_id, idempotency_key, actor, task_id,
 * expected_version — and drives the pure transition function
 * `(current_state, command, policy, version) -> accepted | typed rejection`.
 *
 * Commands are contract data (D25); the transition TABLE lives in
 * apps/user-runtime. Rejections are typed values, never thrown errors (D23
 * rule 5: the transaction checks version, applies the transition, appends the
 * event, updates the projection, and commits atomically — a rejection must
 * survive as data for the journal).
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, JsonObject, WorkspaceId } from "./primitives.ts";
import { RunState } from "./state-vocabulary.ts";

const CommandBase = {
  command_id: Id,
  idempotency_key: Id,
  workspace_id: WorkspaceId,
  task_id: Id,
  actor: Actor,
  /** Optimistic-concurrency check against the run's current version. */
  expected_version: z.number().int().min(1),
  issued_at: IsoDateTime,
} as const;

function command<const T extends string>(type: T) {
  return z.strictObject({ ...CommandBase, type: z.literal(type) });
}

// Separate helper with a const generic so the extra keys keep their literal
// identity in the inferred shape (a plain ZodRawShape spread would hide them
// behind an index signature and drop them from z.infer).
function commandWith<const T extends string, const E extends z.ZodRawShape>(type: T, extra: E) {
  return z.strictObject({ ...CommandBase, type: z.literal(type), ...extra });
}

export const PLAN_READY = command("plan_ready");
export const QUEUE_TASK = command("queue_task");
export const START_TASK = command("start_task");
export const WAIT_FOR_AGENT = command("wait_for_agent");
export const AGENT_RESPONDED = command("agent_responded");
export const REQUEST_APPROVAL = command("request_approval");
export const APPROVAL_GRANTED = commandWith("approval_granted", { approval_id: Id });
export const APPROVAL_REJECTED = commandWith("approval_rejected", { approval_id: Id });
export const WAIT_FOR_RESOURCE = command("wait_for_resource");
export const RESOURCE_AVAILABLE = command("resource_available");
export const SCHEDULE_RETRY = commandWith("schedule_retry", {
  failure_event_id: Id.optional(),
  attempt: z.number().int().min(1).optional(),
});
export const RETRY_ATTEMPT = commandWith("retry_attempt", {
  attempt: z.number().int().min(1).optional(),
});
export const RETRY_TASK = commandWith("retry_task", {
  failure_event_id: Id.optional(),
  attempt: z.number().int().min(1).optional(),
});
export const PAUSE_INSUFFICIENT_CREDITS = command("pause_insufficient_credits");
export const PAUSE_RETRY_EXHAUSTED = command("pause_retry_exhausted");
export const RESUME_TASK = command("resume_task");
export const RECOVERY_REQUIRED = command("recovery_required");
export const RECOVERY_RESUME = command("recovery_resume");
export const COMPLETE_TASK = command("complete_task");
export const FAIL_TASK = command("fail_task");
export const CANCEL_TASK = command("cancel_task");
export const CANCEL_COMPLETE = command("cancel_complete");

export const TASK_COMMAND_TYPES = [
  "plan_ready",
  "queue_task",
  "start_task",
  "wait_for_agent",
  "agent_responded",
  "request_approval",
  "approval_granted",
  "approval_rejected",
  "wait_for_resource",
  "resource_available",
  "schedule_retry",
  "retry_attempt",
  "retry_task",
  "pause_insufficient_credits",
  "pause_retry_exhausted",
  "resume_task",
  "recovery_required",
  "recovery_resume",
  "complete_task",
  "fail_task",
  "cancel_task",
  "cancel_complete",
] as const;
export type TaskCommandType = (typeof TASK_COMMAND_TYPES)[number];

export const TaskCommand = z.discriminatedUnion("type", [
  PLAN_READY,
  QUEUE_TASK,
  START_TASK,
  WAIT_FOR_AGENT,
  AGENT_RESPONDED,
  REQUEST_APPROVAL,
  APPROVAL_GRANTED,
  APPROVAL_REJECTED,
  WAIT_FOR_RESOURCE,
  RESOURCE_AVAILABLE,
  SCHEDULE_RETRY,
  RETRY_ATTEMPT,
  RETRY_TASK,
  PAUSE_INSUFFICIENT_CREDITS,
  PAUSE_RETRY_EXHAUSTED,
  RESUME_TASK,
  RECOVERY_REQUIRED,
  RECOVERY_RESUME,
  COMPLETE_TASK,
  FAIL_TASK,
  CANCEL_TASK,
  CANCEL_COMPLETE,
]);
export type TaskCommand = z.infer<typeof TaskCommand>;

/**
 * Typed rejections (D23 rule 5). `kind` is the machine-readable reason,
 * `code` the stable error code (D23 rule 4), `detail` carries redaction-safe
 * structured context for the journal.
 */
export const TASK_REJECTION_KINDS = [
  "illegal_transition",
  "version_conflict",
  "duplicate_command",
  "actor_not_allowed",
  "policy_violation",
  "malformed_command",
] as const;
export const TaskRejectionKind = z.enum(TASK_REJECTION_KINDS);
export type TaskRejectionKind = z.infer<typeof TaskRejectionKind>;

export const TaskRejection = z.strictObject({
  kind: TaskRejectionKind,
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_message: z.string().min(1).max(300),
  detail: JsonObject.nullable(),
});
export type TaskRejection = z.infer<typeof TaskRejection>;

/** Contract-level result shape for the runtime's command surface (D25 http). */
export const TaskCommandResult = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("accepted"),
    task_id: Id,
    from_state: RunState,
    to_state: RunState,
    version: z.number().int().min(1),
    event_id: Id,
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    task_id: Id,
    rejection: TaskRejection,
  }),
]);
export type TaskCommandResult = z.infer<typeof TaskCommandResult>;
