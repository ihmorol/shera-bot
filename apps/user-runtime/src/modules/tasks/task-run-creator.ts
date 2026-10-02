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
  type Pack,
  type PackSnapshot,
  type ProviderSnapshot,
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
   * S10 (D29 reproducibility): the pinned pack's DEFINITIONS, from which the
   * creation-time skill/connector/provider snapshots resolve. Optional for
   * direct creator callers (older tests); the runtime composition always
   * supplies it, and every runtime-created run stamps all resolvable fields.
   */
  pack_content?: Pack;
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

  // Creation-time snapshots (S10; D19/D29): what the run was created with is
  // recorded and never retroactively changed by a pack upgrade (D19 — pack
  // changes affect NEW tasks only). The Operation confirmation carries the
  // Operation pin itself; skills/connectors/provider resolve from the pinned
  // pack's definitions.
  const operationSnapshot =
    event.event_type === "operation.confirmed"
      ? {
          operation_id: event.payload.operation_id,
          version: event.payload.operation_version,
          hash: event.payload.operation_hash,
        }
      : undefined;
  const definition =
    operationSnapshot && deps.pack_content
      ? deps.pack_content.operations.find(
          (operation) =>
            operation.operation_id === operationSnapshot.operation_id &&
            operation.version === operationSnapshot.version,
        )
      : undefined;
  const skill_snapshot = deps.pack_content ? (definition ? [...definition.skills] : []) : undefined;
  const connector_snapshot = deps.pack_content
    ? definition
      ? [...definition.connectors]
      : []
    : undefined;
  // PROTOTYPE default (S10): the coordinating Agent's default provider is the
  // run's provider snapshot — the confirmed Operation's named coordinator when
  // it has one (D42), else the pack-wide default coordinator. Without pack
  // content nothing is invented: the field is simply absent.
  const provider_snapshot = resolveProviderSnapshot(deps.pack_content, definition);

  const run: TaskRun = {
    task_id,
    workspace_id: deps.workspace_id,
    conversation_id: event.conversation_id,
    created_from: { trigger_event_type: trigger.event_type, trigger_event_id: event.event_id },
    pack_snapshot: deps.pinned_pack,
    ...(operationSnapshot ? { operation_snapshot: operationSnapshot } : {}),
    roster,
    ...(provider_snapshot ? { provider_snapshot } : {}),
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
    snapshots: {
      pack_snapshot: deps.pinned_pack,
      ...(operationSnapshot ? { operation_snapshot: operationSnapshot } : {}),
      roster,
      ...(skill_snapshot ? { skill_snapshot } : {}),
      ...(connector_snapshot ? { connector_snapshot } : {}),
      ...(provider_snapshot ? { provider_snapshot } : {}),
    },
  });

  return { ok: true, run, creation_event };
}

/**
 * The provider/model snapshot (D20/D22) recorded at creation: the Operation's
 * named coordinator's default provider, else the pack default coordinator's.
 * Pack data only — never a credential (D22; the provider reference names the
 * container-resident configuration, G3).
 */
function resolveProviderSnapshot(
  packContent: Pack | undefined,
  definition: Pack["operations"][number] | undefined,
): ProviderSnapshot | undefined {
  if (!packContent) {
    return undefined;
  }
  const coordinatorId =
    definition?.coordinator && definition.coordinator !== "none"
      ? definition.coordinator
      : packContent.default_coordinator_agent_id;
  const agent = packContent.agents.find((candidate) => candidate.agent_id === coordinatorId) ??
    packContent.agents.find(
      (candidate) => candidate.agent_id === packContent.default_coordinator_agent_id,
    );
  return agent
    ? {
        provider_id: agent.default_provider.provider_id,
        model: agent.default_provider.model,
      }
    : undefined;
}
