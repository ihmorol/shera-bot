/**
 * ToolDefinition (D38, E13): a runtime-owned executable capability. Agents
 * only propose tool calls; the runtime validates and executes them (G2, G6).
 * The E13 recovery class is data on the record — never prose inference.
 */
import { z } from "zod";

import { Id, IsoDateTime, JsonSchema, RiskClass, WorkspaceId } from "./primitives.ts";

/**
 * E13: per-tool recovery semantics for ambiguous external effects.
 * The default when a tool does not declare a class is needs_human.
 */
export const RECOVERY_CLASSES = ["replayable", "idempotent_retry", "needs_human"] as const;
export const RecoveryClass = z.enum(RECOVERY_CLASSES);
export type RecoveryClass = z.infer<typeof RecoveryClass>;

/** D35 ladder: read-only auto-executes; local mutations preview; risky gates. */
export const APPROVAL_POLICIES = [
  "auto_read_only",
  "preview_required",
  "approval_required",
] as const;
export const ToolApprovalPolicy = z.enum(APPROVAL_POLICIES);
export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicy>;

/** D27 resource limits on child execution. */
export const ResourceLimits = z.strictObject({
  max_memory_mb: z.number().int().min(1).max(65536),
  max_cpu_seconds: z.number().int().min(1).max(86400),
  max_processes: z.number().int().min(1).max(1024),
  max_disk_mb: z.number().int().min(1).max(1048576),
});
export type ResourceLimits = z.infer<typeof ResourceLimits>;

export const ToolDefinition = z.strictObject({
  tool_id: Id,
  workspace_id: WorkspaceId,
  version: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  owner: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("platform") }),
    z.strictObject({ kind: z.literal("agent"), agent_id: Id }),
  ]),
  /** E4: the creating agent selects private or shared inventory scope. */
  inventory_scope: z.enum(["private", "shared"]),
  /** JSON Schema documents describing input and output (D38). */
  input_schema: JsonSchema,
  output_schema: JsonSchema,
  capabilities: z.array(z.string().min(1).max(128)).max(50),
  risk_class: RiskClass,
  timeout_ms: z.number().int().min(1).max(600000),
  resource_limits: ResourceLimits,
  /** Redaction policy applied to the tool's history and logs (PRD §7/§16). */
  redaction_policy: z.enum(["standard", "strict"]),
  approval_policy: ToolApprovalPolicy,
  /** E13, defaulted safely: undeclared recovery class means needs_human. */
  recovery: RecoveryClass.default("needs_human"),
  created_at: IsoDateTime,
  updated_at: IsoDateTime.optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;
