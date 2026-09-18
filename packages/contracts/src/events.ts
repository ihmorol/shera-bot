/**
 * TypedExecutionEvent (S02 #6): the D26 durable event envelope plus the typed
 * payload vocabulary. This is the ONLY input that can create a task run (G2;
 * D34) — never natural-language classification.
 *
 * Envelope (D26, exactly): event_id, stream_id, sequence, event_type,
 * event_version, actor, task_id, conversation_id, occurred_at, payload,
 * redaction_class. The slice issue text says "ten required fields"; D26 names
 * eleven (actor is the easily-miscounted one). D26 wins; the envelope test
 * asserts the full eleven.
 *
 * Every envelope member is strict (D25 unknown-field rejection). The one
 * explicitly extensible payload is the webhook trigger payload — external
 * systems send source-specific fields; the registry in registry.ts records
 * that exception with its rationale.
 */
import { z } from "zod";

import {
  Actor,
  Id,
  IsoDateTime,
  RedactionClass,
  ResourceUri,
  RiskClass,
  Sha256Hex,
  SemVer,
} from "./primitives.ts";
import { RunState } from "./state-vocabulary.ts";

/** D34 trigger categories that create task runs (G2). Closed set. */
export const TASK_TRIGGER_EVENT_TYPES = [
  "tool.proposed",
  "delegation.proposed",
  "approval.requested",
  "operation.confirmed",
  "trigger.scheduled",
  "trigger.webhook",
  "trigger.file_event",
] as const;
export type TaskTriggerEventType = (typeof TASK_TRIGGER_EVENT_TYPES)[number];

/** Runtime-emitted lifecycle events (one per D8 transition, plus creation). */
export const TASK_LIFECYCLE_EVENT_TYPES = [
  "task.created",
  "task.plan_ready",
  "task.queued",
  "task.started",
  "task.waiting_for_agent",
  "task.agent_responded",
  "task.waiting_for_approval",
  "task.approval_granted",
  "task.approval_rejected",
  "task.waiting_for_resource",
  "task.resource_acquired",
  "task.retry_scheduled",
  "task.retry_started",
  "task.paused",
  "task.resumed",
  "task.recovery_required",
  "task.recovery_resumed",
  "task.succeeded",
  "task.failed",
  "task.cancelling",
  "task.cancelled",
] as const;
export type TaskLifecycleEventType = (typeof TASK_LIFECYCLE_EVENT_TYPES)[number];

/** Non-trigger journal events emitted alongside execution. */
export const TASK_JOURNAL_EVENT_TYPES = [
  "progress.reported",
  "artifact.published",
  "checkpoint.taken",
] as const;
export type TaskJournalEventType = (typeof TASK_JOURNAL_EVENT_TYPES)[number];

export const EVENT_TYPES = [
  ...TASK_TRIGGER_EVENT_TYPES,
  ...TASK_LIFECYCLE_EVENT_TYPES,
  ...TASK_JOURNAL_EVENT_TYPES,
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** D23 rule 6: never deduplicate by message text — idempotency keys are data. */
export const ArgsDigest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expected a sha256:<hex> digest");

// ---------------------------------------------------------------------------
// Trigger payloads (D34: these create TaskRuns)
// ---------------------------------------------------------------------------

export const ToolProposedPayload = z.strictObject({
  tool_id: Id,
  tool_version: SemVer,
  args_digest: ArgsDigest,
  proposal_summary: z.string().min(1).max(2000),
});
export type ToolProposedPayload = z.infer<typeof ToolProposedPayload>;

export const DelegationProposedPayload = z.strictObject({
  from_agent_id: Id,
  to_agent_id: Id,
  goal_summary: z.string().min(1).max(2000),
  parent_task_id: Id,
});
export type DelegationProposedPayload = z.infer<typeof DelegationProposedPayload>;

export const ApprovalRequestedPayload = z.strictObject({
  tool_id: Id,
  tool_version: SemVer,
  capability: z.string().min(1).max(128),
  risk_class: RiskClass,
  args_digest: ArgsDigest,
  resource_scope: z.string().min(1).max(512),
});
export type ApprovalRequestedPayload = z.infer<typeof ApprovalRequestedPayload>;

export const OperationConfirmedPayload = z.strictObject({
  operation_id: Id,
  operation_version: SemVer,
  operation_hash: Sha256Hex,
  roster: z.array(Id).min(1).max(50),
});
export type OperationConfirmedPayload = z.infer<typeof OperationConfirmedPayload>;

export const ScheduledTriggerPayload = z.strictObject({
  schedule_id: Id,
  operation_id: Id.optional(),
  due_at: IsoDateTime,
});
export type ScheduledTriggerPayload = z.infer<typeof ScheduledTriggerPayload>;

/**
 * The ONLY explicitly extensible payload (D25 "unless explicitly marked
 * extensible"): webhook bodies vary by source. Bounded by transport limits;
 * consumers must not treat unknown fields as meaningful.
 */
export const TriggerWebhookPayload = z.looseObject({
  webhook_id: Id,
  source: z.string().min(1).max(128),
  body_summary: z.string().min(1).max(2000),
});
export type TriggerWebhookPayload = z.infer<typeof TriggerWebhookPayload>;

export const FileEventPayload = z.strictObject({
  watcher_id: Id,
  path_uri: ResourceUri,
  change_type: z.enum(["created", "modified", "deleted"]),
});
export type FileEventPayload = z.infer<typeof FileEventPayload>;

// ---------------------------------------------------------------------------
// Runtime-emitted payloads
// ---------------------------------------------------------------------------

/** task.created — emitted by the G2 task-run creator alongside the new run. */
export const TaskCreatedPayload = z.strictObject({
  trigger_event_type: z.enum(TASK_TRIGGER_EVENT_TYPES),
  trigger_event_id: Id,
  /** Correlation with the creating trigger event. */
  correlation_id: Id,
});
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayload>;

/**
 * Lifecycle transition payload (D8: actor and reason are part of every
 * transition; correlation_id links the event to the command that caused it).
 */
export const TaskLifecyclePayload = z.strictObject({
  from_state: RunState,
  to_state: RunState,
  reason: Id,
  failure_event_id: Id.optional(),
  attempt: z.number().int().min(1).optional(),
  approval_id: Id.optional(),
  correlation_id: Id,
});
export type TaskLifecyclePayload = z.infer<typeof TaskLifecyclePayload>;

export const ProgressPayload = z.strictObject({
  agent_id: Id.optional(),
  summary: z.string().min(1).max(2000),
  fraction: z.number().min(0).max(1).optional(),
});
export type ProgressPayload = z.infer<typeof ProgressPayload>;

export const ArtifactPublishedPayload = z.strictObject({
  artifact_id: Id,
  uri: ResourceUri,
  size_bytes: z.number().int().min(0),
});
export type ArtifactPublishedPayload = z.infer<typeof ArtifactPublishedPayload>;

/** Semantic checkpoint marker (D33); full checkpoint records are S31's concern. */
export const CheckpointPayload = z.strictObject({
  step_id: Id,
  checkpoint_version: z.number().int().min(1),
});
export type CheckpointPayload = z.infer<typeof CheckpointPayload>;

// ---------------------------------------------------------------------------
// Envelope construction: one strict envelope member per event type
// ---------------------------------------------------------------------------

const EventEnvelopeBase = {
  event_id: Id,
  /** Per-stream identity; task events stream as `task:<task_id>`. */
  stream_id: Id,
  /** Per-stream sequence, 1-based, gapless (D26 replay cursors depend on it). */
  sequence: z.number().int().positive(),
  event_version: z.number().int().positive(),
  actor: Actor,
  task_id: Id,
  conversation_id: Id,
  occurred_at: IsoDateTime,
  redaction_class: RedactionClass,
} as const;

function envelope<const E extends EventType, P extends z.ZodType>(eventType: E, payload: P) {
  return z.strictObject({ ...EventEnvelopeBase, event_type: z.literal(eventType), payload });
}

export const EVENT_ENVELOPES = {
  "tool.proposed": envelope("tool.proposed", ToolProposedPayload),
  "delegation.proposed": envelope("delegation.proposed", DelegationProposedPayload),
  "approval.requested": envelope("approval.requested", ApprovalRequestedPayload),
  "operation.confirmed": envelope("operation.confirmed", OperationConfirmedPayload),
  "trigger.scheduled": envelope("trigger.scheduled", ScheduledTriggerPayload),
  "trigger.webhook": envelope("trigger.webhook", TriggerWebhookPayload),
  "trigger.file_event": envelope("trigger.file_event", FileEventPayload),
  "task.created": envelope("task.created", TaskCreatedPayload),
  "progress.reported": envelope("progress.reported", ProgressPayload),
  "artifact.published": envelope("artifact.published", ArtifactPublishedPayload),
  "checkpoint.taken": envelope("checkpoint.taken", CheckpointPayload),
  "task.plan_ready": envelope("task.plan_ready", TaskLifecyclePayload),
  "task.queued": envelope("task.queued", TaskLifecyclePayload),
  "task.started": envelope("task.started", TaskLifecyclePayload),
  "task.waiting_for_agent": envelope("task.waiting_for_agent", TaskLifecyclePayload),
  "task.agent_responded": envelope("task.agent_responded", TaskLifecyclePayload),
  "task.waiting_for_approval": envelope("task.waiting_for_approval", TaskLifecyclePayload),
  "task.approval_granted": envelope("task.approval_granted", TaskLifecyclePayload),
  "task.approval_rejected": envelope("task.approval_rejected", TaskLifecyclePayload),
  "task.waiting_for_resource": envelope("task.waiting_for_resource", TaskLifecyclePayload),
  "task.resource_acquired": envelope("task.resource_acquired", TaskLifecyclePayload),
  "task.retry_scheduled": envelope("task.retry_scheduled", TaskLifecyclePayload),
  "task.retry_started": envelope("task.retry_started", TaskLifecyclePayload),
  "task.paused": envelope("task.paused", TaskLifecyclePayload),
  "task.resumed": envelope("task.resumed", TaskLifecyclePayload),
  "task.recovery_required": envelope("task.recovery_required", TaskLifecyclePayload),
  "task.recovery_resumed": envelope("task.recovery_resumed", TaskLifecyclePayload),
  "task.succeeded": envelope("task.succeeded", TaskLifecyclePayload),
  "task.failed": envelope("task.failed", TaskLifecyclePayload),
  "task.cancelling": envelope("task.cancelling", TaskLifecyclePayload),
  "task.cancelled": envelope("task.cancelled", TaskLifecyclePayload),
} as const;

export type EventEnvelope = (typeof EVENT_ENVELOPES)[keyof typeof EVENT_ENVELOPES];

export const TypedExecutionEvent = z.discriminatedUnion(
  "event_type",
  Object.values(EVENT_ENVELOPES) as unknown as [EventEnvelope, ...EventEnvelope[]],
);
export type TypedExecutionEvent = z.infer<typeof TypedExecutionEvent>;

/** Type guard: is this event one of the D34 triggers that create task runs? */
export function isTaskTriggerEvent(event: TypedExecutionEvent): boolean {
  return (TASK_TRIGGER_EVENT_TYPES as readonly string[]).includes(event.event_type);
}
