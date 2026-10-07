/**
 * Task event envelope construction (D26): builds the durable TypedExecutionEvent
 * members the runtime journals after a committed transition — per-stream
 * sequence, event version, correlation id. Pure: the clock and the next
 * sequence come from the caller (the gateway supplies them from the journal
 * transaction; tests supply a fake clock).
 *
 * Emitted events are validated against their contract envelope before being
 * returned — the runtime never journals an event its own schema rejects.
 * Governing records: D26, D23 rule 5, G2.
 */
import {
  EVENT_ENVELOPES,
  type OperationSnapshot,
  type PackSnapshot,
  type ProviderSnapshot,
  type TaskCreatedPayload,
  type TaskLifecyclePayload,
  type TaskRun,
  type TypedExecutionEvent,
} from "@shera-bot/contracts";

export const TASK_STREAM_PREFIX = "task:";

/** The event stream of a task run (D26 per-stream sequences). */
export function taskStreamId(taskId: string): string {
  return `${TASK_STREAM_PREFIX}${taskId}`;
}

export interface EnvelopeClock {
  /** Caller-supplied ISO timestamp (fake clock in tests; D23 testing strategy). */
  now: string;
  /** Next per-stream sequence from the journal (1-based, gapless). */
  next_sequence: number;
}

function assembleEnvelope(
  eventType: string,
  fields: {
    event_id: string;
    stream_id: string;
    sequence: number;
    actor: { type: string; id: string };
    task_id: string;
    conversation_id: string;
    occurred_at: string;
    redaction_class: "public" | "internal" | "restricted";
    payload: unknown;
  },
): TypedExecutionEvent {
  const envelopeSchema = EVENT_ENVELOPES[eventType as keyof typeof EVENT_ENVELOPES];
  if (!envelopeSchema) {
    throw new TypeError(`no envelope contract registered for event type ${eventType}`);
  }
  // Parse (not cast): the envelope that leaves this module is contract-valid.
  return envelopeSchema.parse({
    ...fields,
    event_type: eventType,
    event_version: 1,
  }) as TypedExecutionEvent;
}

/** The lifecycle event for one accepted transition (D8: emitted event). */
export function buildTaskTransitionEvent(input: {
  run: Pick<TaskRun, "task_id" | "conversation_id">;
  command: { command_id: string; actor: { type: string; id: string } };
  eventType: string;
  payload: TaskLifecyclePayload;
  clock: EnvelopeClock;
}): TypedExecutionEvent {
  return assembleEnvelope(input.eventType, {
    event_id: `evt_${input.command.command_id}`,
    stream_id: taskStreamId(input.run.task_id),
    sequence: input.clock.next_sequence,
    actor: input.command.actor,
    task_id: input.run.task_id,
    conversation_id: input.run.conversation_id,
    occurred_at: input.clock.now,
    redaction_class: "public",
    payload: input.payload,
  });
}

/** The task.created event emitted by the G2 task-run creator. */
export function buildTaskCreatedEvent(input: {
  run: Pick<TaskRun, "task_id" | "conversation_id">;
  trigger: { event_type: TaskCreatedPayload["trigger_event_type"]; event_id: string };
  actor: { type: string; id: string };
  clock: EnvelopeClock;
  /**
   * Creation-time snapshots (S10; D19/D29 reproducibility): the pack /
   * Operation / provider pins plus roster, skill, and connector snapshots,
   * embedded in the journal payload so the task.created row is the durable
   * record a pack upgrade cannot retroactively change. Omitted fields are
   * simply absent — nothing is invented (G4).
   */
  snapshots?: {
    pack_snapshot?: PackSnapshot;
    operation_snapshot?: OperationSnapshot;
    roster?: string[];
    skill_snapshot?: string[];
    connector_snapshot?: string[];
    provider_snapshot?: ProviderSnapshot;
  };
}): TypedExecutionEvent {
  const payload: TaskCreatedPayload = {
    trigger_event_type: input.trigger.event_type,
    trigger_event_id: input.trigger.event_id,
    correlation_id: input.trigger.event_id,
    ...(input.snapshots?.pack_snapshot ? { pack_snapshot: input.snapshots.pack_snapshot } : {}),
    ...(input.snapshots?.operation_snapshot
      ? { operation_snapshot: input.snapshots.operation_snapshot }
      : {}),
    ...(input.snapshots?.roster ? { roster: input.snapshots.roster } : {}),
    ...(input.snapshots?.skill_snapshot ? { skill_snapshot: input.snapshots.skill_snapshot } : {}),
    ...(input.snapshots?.connector_snapshot
      ? { connector_snapshot: input.snapshots.connector_snapshot }
      : {}),
    ...(input.snapshots?.provider_snapshot
      ? { provider_snapshot: input.snapshots.provider_snapshot }
      : {}),
  };
  return assembleEnvelope("task.created", {
    event_id: `evt_created_${input.run.task_id}`,
    stream_id: taskStreamId(input.run.task_id),
    sequence: input.clock.next_sequence,
    actor: input.actor,
    task_id: input.run.task_id,
    conversation_id: input.run.conversation_id,
    occurred_at: input.clock.now,
    redaction_class: "public",
    payload,
  });
}
