/**
 * Operation contracts (S02 #4): the reusable OperationDefinition template and
 * the persistent Operation workspace/chat instance (D31, D41, D42, D49).
 *
 * - OperationDefinition — a versioned collaboration template in a Pack.
 * - Operation — a persistent user-visible collaborative chat created from a
 *   definition or ad hoc; holds multiple independently tracked task runs.
 */
import { z } from "zod";

import {
  Actor,
  Id,
  IsoDateTime,
  JsonObject,
  Sha256Hex,
  SemVer,
  WorkspaceId,
} from "./primitives.ts";
import { RunState } from "./state-vocabulary.ts";
import { ProviderSnapshot } from "./snapshots.ts";

export const OperationDefinition = z.strictObject({
  operation_id: Id,
  version: SemVer,
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  /** Agents that participate; each specialist belongs to exactly one (D46). */
  roster: z.array(Id).min(1).max(50),
  /**
   * D42: `coordinator` names a coordinator Agent or "none". Absent means the
   * pack default coordinator (the General Assistant) coordinates. The
   * coordinator role is not a roster assignment (D46).
   */
  coordinator: z.union([Id, z.literal("none")]).optional(),
  skills: z.array(Id).max(200),
  connectors: z.array(Id).max(100),
  /** Content hash of the definition, recorded by the pack loader (D28/D29). */
  content_hash: Sha256Hex,
});
export type OperationDefinition = z.infer<typeof OperationDefinition>;

export const OPERATION_STATUSES = ["active", "archived"] as const;

/** The persistent Operation workspace/chat instance (D31, D41). */
export const Operation = z.strictObject({
  /** Instance id of the Operation chat (the definition id is in `definition`). */
  operation_id: Id,
  workspace_id: WorkspaceId,
  /** The Operation chat is a conversation; task runs hang off it (D31). */
  conversation_id: Id,
  /** Template reference with version pinning (D29: ad-hoc Operations omit this). */
  definition: z
    .strictObject({
      operation_id: Id,
      version: SemVer,
      hash: Sha256Hex,
    })
    .nullable(),
  title: z.string().min(1).max(200),
  /** Current roster; user-controlled, runtime-validated (D36). */
  roster: z.array(Id).min(1).max(50),
  /**
   * Current coordinator: an agent id, or null after removal (D49 — removal is
   * allowed at any time; work continues peer-to-peer through D7).
   */
  coordinator: Id.nullable(),
  status: z.enum(OPERATION_STATUSES),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type Operation = z.infer<typeof Operation>;

// ---------------------------------------------------------------------------
// S13 chunk 1 — Operation chat record, roster-change commands, operation runs,
// and the D7 collaboration event union.
//
// Governing decisions: D7 (typed collaboration protocol), D31 (the three
// Operation objects), D34/D46 (delegation creates task runs; parent link),
// D36 (user controls the roster; runtime validates), D42/D49 (coordinator
// default GA, removable, "none" afterwards), D46 (one home Operation;
// subagents are delegated runs, not a new object type).
// Vocabulary: Pack → Operations → Agents ("Agent", "Operation" — never
// "Expert", never "Scene"). Zod-first (D25); strictObject everywhere.
// ---------------------------------------------------------------------------

/**
 * S13 lifecycle of the persisted Operation chat record: active while the chat
 * is open, completed/failed as the user-visible outcome. Kept separate from
 * the S02 `OPERATION_STATUSES` (active/archived wire summary above) so the
 * S02 surface does not silently change under existing consumers.
 */
export const OPERATION_RECORD_STATUSES = ["active", "completed", "failed"] as const;
export const OperationRecordStatus = z.enum(OPERATION_RECORD_STATUSES);
export type OperationRecordStatus = z.infer<typeof OperationRecordStatus>;

/**
 * D42/D49: the coordinator is a concrete Agent id, or the literal "none" once
 * removed (work continues peer-to-peer through D7; the runtime stays the
 * safety and lifecycle authority, D4).
 */
export const OperationCoordinatorRef = z.union([Id, z.literal("none")]);
export type OperationCoordinatorRef = z.infer<typeof OperationCoordinatorRef>;

/**
 * D29/D31 pinning snapshot: what the Operation was launched with. pack_id/
 * pack_version pin the Pack (D28); roster_agent_ids pin the participating
 * Agents (one home Operation per Agent, D46); capabilities bound what the
 * roster may reach (D38 layered intersection starts here); the provider
 * snapshot stays placeholder-typed (free-form JSON object) until the provider
 * slice owns a real per-Operation catalog.
 */
export const OperationPinning = z.strictObject({
  pack_id: Id,
  pack_version: SemVer,
  roster_agent_ids: z.array(Id).max(50),
  capabilities: z.array(z.string().min(1).max(128)).max(200),
  provider_snapshot: JsonObject,
});
export type OperationPinning = z.infer<typeof OperationPinning>;

/**
 * The persisted Operation chat record (D31 workspace/chat object; E12
 * workspace scoping). This is the authoritative record chunk 2's repository
 * persists; the S02 `Operation` above remains the conversation-summary wire
 * shape. `definition_ref` is null for ad-hoc Operations (D41, D29).
 */
/** One cap for every user-authored Operation name (create AND rename) — a name created at any length must stay re-saveable through rename. */
export const OPERATION_NAME_MAX_LENGTH = 120;

export const OperationRecord = z.strictObject({
  operation_id: Id,
  workspace_id: WorkspaceId,
  definition_ref: z.string().min(1).max(512).nullable(),
  name: z.string().min(1).max(OPERATION_NAME_MAX_LENGTH),
  status: OperationRecordStatus,
  /** D42/D49: coordinator Agent id, or "none" after removal. */
  coordinator_agent_id: OperationCoordinatorRef,
  pinning: OperationPinning,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type OperationRecord = z.infer<typeof OperationRecord>;

/**
 * D36 roster-change commands. The user changes the roster directly; Agents
 * (the coordinator) only propose; the runtime verifies pack membership,
 * policy, permissions, cost, and connector impact before applying. Every add
 * command carries the risk classification the runtime gates on:
 *
 * - same-pack low-risk addition   → may proceed without approval
 *                                   (`requires_approval: false`),
 * - cost/access-increasing        → `requires_approval` must be true
 *                                   (typed refusal otherwise:
 *                                   cost-increase-needs-approval),
 * - foreign-pack                  → REFUSED outright at the contract boundary
 *                                   (typed refusal code
 *                                   foreign-pack-refused); never expressible
 *                                   as a command.
 *
 * `agent-not-in-pack` (candidate not a member of the pinned pack) is enforced
 * by the service — the pack catalog is runtime data — and emitted as the same
 * typed refusal shape.
 */
export const ROSTER_REFUSAL_CODES = [
  "agent-not-in-pack",
  "foreign-pack-refused",
  "cost-increase-needs-approval",
] as const;
export const RosterRefusalCode = z.enum(ROSTER_REFUSAL_CODES);
export type RosterRefusalCode = z.infer<typeof RosterRefusalCode>;

/** Typed refusal the service returns instead of applying a roster change. */
export const RosterRefusal = z.strictObject({
  refusal_code: RosterRefusalCode,
  message: z.string().min(1).max(2000),
  agent_id: Id.optional(),
  pack_id: Id.optional(),
});
export type RosterRefusal = z.infer<typeof RosterRefusal>;

/** Risk classification carried by every roster-change add command (D36). */
export const RosterRiskClassification = z
  .strictObject({
    /** The candidate Agent belongs to the Operation's pinned Pack. */
    same_pack: z.boolean(),
    /** The addition increases cost, access, or external capability. */
    cost_or_access_increasing: z.boolean(),
    /** User approval is required before the runtime applies the change. */
    requires_approval: z.boolean(),
  })
  .superRefine((risk, ctx) => {
    if (!risk.same_pack) {
      ctx.addIssue({
        code: "custom",
        message: "foreign-pack-refused",
        params: { refusal_code: "foreign-pack-refused" as const },
      });
    }
    if (risk.cost_or_access_increasing && !risk.requires_approval) {
      ctx.addIssue({
        code: "custom",
        message: "cost-increase-needs-approval",
        params: { refusal_code: "cost-increase-needs-approval" as const },
      });
    }
  });
export type RosterRiskClassification = z.infer<typeof RosterRiskClassification>;

/** Command envelope — the contracts command shape (D23 rule 6: idempotent). */
const OperationRosterCommandBase = {
  command_id: Id,
  idempotency_key: Id,
  workspace_id: WorkspaceId,
  operation_id: Id,
  actor: Actor,
  issued_at: IsoDateTime,
} as const;

export const AddRosterAgentCommand = z.strictObject({
  ...OperationRosterCommandBase,
  type: z.literal("operation.add_roster_agent"),
  agent_id: Id,
  /** Pack the candidate comes from — must be the pinned Pack (D36). */
  pack_id: Id,
  pack_version: SemVer,
  risk: RosterRiskClassification,
});
export type AddRosterAgentCommand = z.infer<typeof AddRosterAgentCommand>;

export const RemoveRosterAgentCommand = z.strictObject({
  ...OperationRosterCommandBase,
  type: z.literal("operation.remove_roster_agent"),
  agent_id: Id,
});
export type RemoveRosterAgentCommand = z.infer<typeof RemoveRosterAgentCommand>;

/**
 * S14 — rename one Operation (user-owned field, D41: ad-hoc Operations are
 * created nameless with the auto-label and renamed by the user afterwards).
 * The rename is a durable row update on the Operation record, NOT a journaled
 * event: the record has no event stream of its own beyond the D7
 * collaboration events (the chat conversation's journal belongs to the chat),
 * so idempotency is carried by the command receipt (D23 rule 6), not by a
 * stream append. `name` is 1-120 characters and must stay non-empty once
 * trimmed; the runtime persists the trimmed value.
 */
export const OperationRenameCommand = z.strictObject({
  ...OperationRosterCommandBase,
  type: z.literal("operation.rename_operation"),
  name: z
    .string()
    .min(1)
    .max(OPERATION_NAME_MAX_LENGTH)
    .refine((value) => value.trim().length > 0, {
      message: "name must be non-empty once trimmed",
    }),
});
export type OperationRenameCommand = z.infer<typeof OperationRenameCommand>;

export const OPERATION_ROSTER_COMMAND_TYPES = [
  "operation.add_roster_agent",
  "operation.remove_roster_agent",
] as const;
export type OperationRosterCommandType = (typeof OPERATION_ROSTER_COMMAND_TYPES)[number];

/**
 * D31 "Operation task/run" — one concrete execution inside the Operation chat
 * (each run keeps its own state machine, event stream, provider snapshot,
 * credits, artifacts — D31). `state` REUSES the D8 vocabulary (RunState,
 * shared with TaskRun) — never a second state machine. `parent_task_id` is
 * the D34/D46 delegation link: null for a top-level Operation run, the
 * delegating task's id for subagent work.
 */
export const OperationRun = z.strictObject({
  run_id: Id,
  workspace_id: WorkspaceId,
  operation_id: Id,
  parent_task_id: Id.nullable(),
  /** D8 state vocabulary, shared with TaskRun — no second state machine. */
  state: RunState,
  /** D26 per-run event sequence cursor (last applied sequence; 0 = none yet). */
  events_seq_cursor: z.number().int().min(0),
  /** D20/D22 provider snapshot recorded when the run started. */
  provider_snapshot: ProviderSnapshot.optional(),
  /** Placeholder until the credits slice owns a per-run usage shape. */
  credits: JsonObject,
  /** Artifact ids published by this run (ArtifactRef holds the full shape). */
  artifacts: z.array(Id).max(100),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type OperationRun = z.infer<typeof OperationRun>;

/**
 * D7 collaboration events, Operation-scoped (S13). The 11 D7 categories are
 * verbatim — mirrors collaboration.ts COLLABORATION_MESSAGE_TYPES. Each event
 * is a strict envelope plus a per-type strict payload; natural language is
 * allowed only inside payload fields (G2). `recipient_agent_ids` empty means
 * Operation-wide broadcast (D7); `run_id` null means the Operation chat
 * itself, set ties the event to one operation run. `correlation_id` groups
 * the propose/accept/delegate/complete chain (D34).
 */
export const OPERATION_COLLABORATION_EVENT_TYPES = [
  "TaskProposed",
  "TaskAccepted",
  "TaskDelegated",
  "ProgressReported",
  "ArtifactPublished",
  "ApprovalRequested",
  "QuestionRaised",
  "TaskBlocked",
  "TaskFailed",
  "TaskCompleted",
  "HandoffRequested",
] as const;
export type OperationCollaborationEventType = (typeof OPERATION_COLLABORATION_EVENT_TYPES)[number];

const OperationCollaborationEventEnvelope = {
  event_id: Id,
  workspace_id: WorkspaceId,
  operation_id: Id,
  run_id: Id.nullable(),
  sender_agent_id: Id,
  /** Empty array = Operation-wide broadcast (D7). */
  recipient_agent_ids: z.array(Id).max(50),
  correlation_id: Id,
  issued_at: IsoDateTime,
} as const;

// Same const-generic helper as agent.ts so the literal `type` keeps its
// identity in the inferred shape.
function operationCollaborationEvent<const T extends string, const E extends z.ZodRawShape>(
  type: T,
  payload: E,
) {
  return z.strictObject({
    ...OperationCollaborationEventEnvelope,
    type: z.literal(type),
    payload: z.strictObject(payload),
  });
}

const TASK_PROPOSED_EVENT = operationCollaborationEvent("TaskProposed", {
  task_description: z.string().min(1).max(4000),
  proposed_assignee_agent_id: Id,
});
const TASK_ACCEPTED_EVENT = operationCollaborationEvent("TaskAccepted", {
  proposal_event_id: Id,
});
const TASK_DELEGATED_EVENT = operationCollaborationEvent("TaskDelegated", {
  task_description: z.string().min(1).max(4000),
});
const PROGRESS_REPORTED_EVENT = operationCollaborationEvent("ProgressReported", {
  progress_text: z.string().min(1).max(4000),
});
const ARTIFACT_PUBLISHED_EVENT = operationCollaborationEvent("ArtifactPublished", {
  artifact_ref: Id,
});
const APPROVAL_REQUESTED_EVENT = operationCollaborationEvent("ApprovalRequested", {
  approval_request_ref: Id,
});
const QUESTION_RAISED_EVENT = operationCollaborationEvent("QuestionRaised", {
  question_text: z.string().min(1).max(2000),
});
const TASK_BLOCKED_EVENT = operationCollaborationEvent("TaskBlocked", {
  blocked_reason: z.string().min(1).max(2000),
});
const TASK_FAILED_EVENT = operationCollaborationEvent("TaskFailed", {
  failure_class: z.string().min(1).max(128),
});
const TASK_COMPLETED_EVENT = operationCollaborationEvent("TaskCompleted", {
  completion_summary: z.string().min(1).max(4000),
});
const HANDOFF_REQUESTED_EVENT = operationCollaborationEvent("HandoffRequested", {
  handoff_reason: z.string().min(1).max(2000),
});

/** The discriminated union every D7 Operation collaboration event parses as. */
export const OperationCollaborationEvent = z.discriminatedUnion("type", [
  TASK_PROPOSED_EVENT,
  TASK_ACCEPTED_EVENT,
  TASK_DELEGATED_EVENT,
  PROGRESS_REPORTED_EVENT,
  ARTIFACT_PUBLISHED_EVENT,
  APPROVAL_REQUESTED_EVENT,
  QUESTION_RAISED_EVENT,
  TASK_BLOCKED_EVENT,
  TASK_FAILED_EVENT,
  TASK_COMPLETED_EVENT,
  HANDOFF_REQUESTED_EVENT,
]);
export type OperationCollaborationEvent = z.infer<typeof OperationCollaborationEvent>;
