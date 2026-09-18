/**
 * CollaborationMessage (S02, D7): the mandatory typed agent-to-agent protocol.
 * Natural language is allowed only as explanatory payload inside these
 * schemas — never as the message itself (G2).
 */
import { z } from "zod";

import { Id, IsoDateTime, RiskClass, WorkspaceId } from "./primitives.ts";

/** D7 categories, verbatim. */
export const COLLABORATION_MESSAGE_TYPES = [
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
export const CollaborationMessageType = z.enum(COLLABORATION_MESSAGE_TYPES);
export type CollaborationMessageType = z.infer<typeof CollaborationMessageType>;

export const COLLABORATION_STATUSES = [
  "proposed",
  "accepted",
  "declined",
  "in_progress",
  "completed",
  "failed",
] as const;

/**
 * D7 required fields, all present: task_id, parent_task_id, conversation_id,
 * sender_agent, recipient_agent, message_type, goal_or_summary, artifact_refs,
 * required_capabilities, risk_class, status, confidence, unresolved_questions,
 * created_at, idempotency_key — plus workspace_id (E12).
 * parent_task_id/recipient_agent are nullable: null means "top-level task" and
 * "Operation broadcast" respectively. Idempotency keys are data (D23 rule 6 —
 * never deduplicate by message text).
 */
export const CollaborationMessage = z.strictObject({
  workspace_id: WorkspaceId,
  task_id: Id,
  parent_task_id: Id.nullable(),
  conversation_id: Id,
  sender_agent: Id,
  recipient_agent: Id.nullable(),
  message_type: CollaborationMessageType,
  goal_or_summary: z.string().min(1).max(4000),
  /** Artifact references, never copied content (D6, D15). */
  artifact_refs: z.array(Id).max(100),
  required_capabilities: z.array(z.string().min(1).max(128)).max(50),
  risk_class: RiskClass,
  status: z.enum(COLLABORATION_STATUSES),
  confidence: z.number().min(0).max(1).nullable(),
  unresolved_questions: z.array(z.string().min(1).max(1000)).max(50),
  created_at: IsoDateTime,
  idempotency_key: Id,
});
export type CollaborationMessage = z.infer<typeof CollaborationMessage>;
