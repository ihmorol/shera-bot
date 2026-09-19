/**
 * TaskRun contract (S02 #5): the durable task-run record over the full D8
 * state vocabulary. The transition table itself is runtime data
 * (apps/user-runtime, D23 rule 5); this module owns the persisted shapes.
 */
import { z } from "zod";

import { Id, IsoDateTime, Sha256Hex, SemVer, WorkspaceId } from "./primitives.ts";
import { PauseReason, RunState } from "./state-vocabulary.ts";
import { TASK_TRIGGER_EVENT_TYPES, type TaskTriggerEventType } from "./events.ts";

/** Why the task run exists — always a typed protocol trigger (D34, G2). */
export const TaskOrigin = z.strictObject({
  trigger_event_type: z.enum(TASK_TRIGGER_EVENT_TYPES),
  trigger_event_id: Id,
});
export type TaskOrigin = z.infer<typeof TaskOrigin>;

/** Pack pinning per D28: a task keeps the pack version that created it. */
export const PackSnapshot = z.strictObject({
  pack_id: Id,
  pack_version: SemVer,
  pack_hash: Sha256Hex,
});
export type PackSnapshot = z.infer<typeof PackSnapshot>;

/** Operation pinning per D29 (present when the run belongs to an Operation). */
export const OperationSnapshot = z.strictObject({
  operation_id: Id,
  version: SemVer,
  hash: Sha256Hex,
});
export type OperationSnapshot = z.infer<typeof OperationSnapshot>;

/** Provider/model snapshot per D20/D22 (existing tasks keep their snapshot). */
export const ProviderSnapshot = z.strictObject({
  provider_id: Id,
  model: z.string().min(1).max(256),
});
export type ProviderSnapshot = z.infer<typeof ProviderSnapshot>;

/** Retry policy — PRD §8: bounded backoff, up to three times, then pause. */
export const TaskPolicy = z.strictObject({
  max_retries: z.number().int().min(0).max(10).default(3),
});
export type TaskPolicy = z.infer<typeof TaskPolicy>;

export const TaskRun = z.strictObject({
  task_id: Id,
  workspace_id: WorkspaceId,
  /** The direct Agent chat or Operation chat the run belongs to (D31, D34). */
  conversation_id: Id,
  /** Operation chat instance, when the run is inside one (D31). */
  operation_id: Id.optional(),
  created_from: TaskOrigin,
  pack_snapshot: PackSnapshot,
  operation_snapshot: OperationSnapshot.optional(),
  /** Roster at creation (D29 reproducibility). */
  roster: z.array(Id).max(50),
  provider_snapshot: ProviderSnapshot.optional(),
  state: RunState,
  /** Optimistic-concurrency version; starts at 1 and increments per transition. */
  version: z.number().int().min(1),
  retry_count: z.number().int().min(0),
  pause_reason: PauseReason.optional(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type TaskRun = z.infer<typeof TaskRun>;

/** The set of trigger event types that legitimately create task runs (D34). */
export type TaskRunTrigger = TaskTriggerEventType;
