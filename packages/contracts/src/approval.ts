/**
 * ApprovalRequest + Grant (S02 #7, D9, PRD §8): scoped, expiring, revocable
 * grants checked deterministically; prompts cannot create grants (G6); an
 * agent cannot approve its own action (D9).
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, RiskClass, WorkspaceId } from "./primitives.ts";

/** PRD §8: the five fixed choices, verbatim. */
export const APPROVAL_CHOICES = [
  "approve-this-execution-only",
  "always-approve-this-tool",
  "always-approve-this-tool-for-this-agent",
  "reject-this-action",
  "cancel-the-task",
] as const;
export const ApprovalChoice = z.enum(APPROVAL_CHOICES);
export type ApprovalChoice = z.infer<typeof ApprovalChoice>;

/** Only the three approve choices create grants; reject/cancel do not. */
export const APPROVAL_GRANT_SOURCE_CHOICES = [
  "approve-this-execution-only",
  "always-approve-this-tool",
  "always-approve-this-tool-for-this-agent",
] as const;
export const GrantSourceChoice = z.enum(APPROVAL_GRANT_SOURCE_CHOICES);
export type GrantSourceChoice = z.infer<typeof GrantSourceChoice>;

/** PRD §8 reminder schedule: immediate, 15 min, 45 min, 3 h, 24 h; none after. */
export const APPROVAL_REMINDER_SCHEDULE_SECONDS = [0, 900, 2700, 10800, 86400] as const;

export const ApprovalRequest = z.strictObject({
  approval_id: Id,
  workspace_id: WorkspaceId,
  task_id: Id,
  conversation_id: Id,
  tool_id: Id,
  tool_version: z.string().min(1).max(64),
  capability: z.string().min(1).max(128),
  risk_class: RiskClass,
  /** Explicit resource scope (D9: resource scope must be explicit). */
  resource_scope: z.string().min(1).max(512),
  /** Digest of the arguments — raw arguments never enter approval records (G3). */
  args_digest: z.string().min(1).max(128),
  /** What the tool would do; the UI shows exact tool, target, side effect (D9). */
  side_effect_summary: z.string().min(1).max(500),
  requested_by: Actor,
  requested_at: IsoDateTime,
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  resolved_at: IsoDateTime.optional(),
  resolved_by_choice: ApprovalChoice.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/**
 * D9 grant record — field list from the decision record:
 * grant_id, principal_type, principal_id, tool_id, capability, resource_scope,
 * conversation_scope, workspace_scope, expires_at, created_by, approved_at,
 * revoked_at. Plus workspace_id (E12), the pinned tool version (a changed tool
 * version invalidates a one-time approval), and the choice that created it.
 */
export const ApprovalGrant = z.strictObject({
  grant_id: Id,
  workspace_id: WorkspaceId,
  source_choice: GrantSourceChoice,
  principal_type: z.enum(["user", "agent", "task"]),
  principal_id: Id,
  tool_id: Id,
  tool_version: z.string().min(1).max(64),
  capability: z.string().min(1).max(128),
  resource_scope: z.string().min(1).max(512),
  /** "any" or a specific conversation id. */
  conversation_scope: z.union([z.literal("any"), Id]),
  workspace_scope: WorkspaceId,
  /** Grants are expiring; null means bounded by the prototype container lifetime. */
  expires_at: IsoDateTime.nullable(),
  one_time: z.boolean(),
  created_by: Actor,
  approved_at: IsoDateTime,
  revoked_at: IsoDateTime.nullable(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrant>;
