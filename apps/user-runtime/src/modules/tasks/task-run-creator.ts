/**
 * Task-run creator (S02, D34 + G2): a task run is created ONLY from a typed
 * execution event — one of the D34 trigger categories. Natural language, prose
 * objects, and non-trigger typed events are all rejected as typed values,
 * never classified and never thrown.
 *
 * The creator is pure: it derives a deterministic task_id from the creating
 * event, stamps the run in CREATED at version 1, and returns the task.created
 * event to journal in the same transaction.
 */
import {
  type Actor,
  type PackSnapshot,
  TASK_TRIGGER_EVENT_TYPES,
  type TaskRun,
  type TaskTriggerEventType,
  type TypedExecutionEvent,
  TypedExecutionEvent as TypedExecutionEventSchema,
} from "@shera-bot/contracts";

import { buildTaskCreatedEvent, type EnvelopeClock } from "./task-events.ts";

export interface CreateTaskRunDeps {
  /** The workspace's pinned pack (D19/D28) — recorded on the run. */
  pinned_pack: PackSnapshot;
  /**
   * E12: every product-state record carries workspace_id. The D26 envelope is
   * task-scoped and carries no workspace field, so the gateway (which owns the
   * container's single default workspace in the prototype) supplies it.
   */
  workspace_id: string;
  clock: EnvelopeClock;
}

export type CreateTaskRunResult =
  | { ok: true; run: TaskRun; creation_event: TypedExecutionEvent }
  | {
      ok: false;
      rejection: {
        kind: "not_a_typed_event" | "not_a_task_trigger";
        code: string;
        safe_message: string;
        detail: Record<string, unknown> | null;
      };
    };

function rejection(
  kind: "not_a_typed_event" | "not_a_task_trigger",
  code: string,
  safeMessage: string,
  detail: Record<string, unknown> | null,
): CreateTaskRunResult {
  return { ok: false, rejection: { kind, code, safe_message: safeMessage, detail } };
}

const TRIGGER_SET: ReadonlySet<string> = new Set(TASK_TRIGGER_EVENT_TYPES);

/**
 * Create a TaskRun from a typed execution event. Input is parsed against the
 * TypedExecutionEvent contract first: anything that is not a typed event is
 * `not_a_typed_event` (this is where natural language dies, per G2); a valid
 * event outside the trigger vocabulary is `not_a_task_trigger`.
 */
export function createTaskRunFromTypedEvent(
  raw: unknown,
  deps: CreateTaskRunDeps,
): CreateTaskRunResult {
  const verdict = TypedExecutionEventSchema.safeParse(raw);
  if (!verdict.success) {
    return rejection(
      "not_a_typed_event",
      "TASK_RUN_INPUT_NOT_TYPED_EVENT",
      "Task runs are created only from typed execution events.",
      {
        issues: verdict.error.issues
          .slice(0, 5)
          .map((issue) => ({ path: issue.path, message: issue.message })),
      },
    );
  }

  const event = verdict.data;
  if (!TRIGGER_SET.has(event.event_type)) {
    return rejection(
      "not_a_task_trigger",
      "TASK_RUN_INPUT_NOT_A_TRIGGER",
      "This typed event does not create a task run.",
      { event_type: event.event_type, trigger_types: [...TASK_TRIGGER_EVENT_TYPES] },
    );
  }

  const trigger = event as TypedExecutionEvent & { event_type: TaskTriggerEventType };
  const task_id = `task_${event.event_id}`;
  const now = deps.clock.now;
  // Roster at creation: the Operation confirmation carries it (D29); other
  // triggers start unrostered and the gateway enriches from the chat context.
  const roster = event.event_type === "operation.confirmed" ? [...event.payload.roster] : [];

  const run: TaskRun = {
    task_id,
    workspace_id: deps.workspace_id,
    conversation_id: event.conversation_id,
    created_from: { trigger_event_type: trigger.event_type, trigger_event_id: event.event_id },
    pack_snapshot: deps.pinned_pack,
    roster,
    state: "CREATED",
    version: 1,
    retry_count: 0,
    created_at: now,
    updated_at: now,
  };

  const creation_event = buildTaskCreatedEvent({
    run,
    trigger: { event_type: trigger.event_type, event_id: event.event_id },
    actor: event.actor as Actor,
    clock: deps.clock,
  });

  return { ok: true, run, creation_event };
}
