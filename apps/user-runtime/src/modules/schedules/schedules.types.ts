/**
 * Schedules module types (S28 chunk 2; PRD §8, E5, G2, G3, D23 module shape).
 *
 * The declarative trigger records' typed configuration: one strict Zod
 * schema per kind. EVERY field is typed data — a prose-only body is a typed
 * refusal at this boundary, never a trigger and never a run (G2). Secrets
 * are refused at this layer too: a webhook's shared secret exists ONLY as
 * the sha256 digest the service stores (G3 — the plaintext is accepted once
 * at create and never persisted, the provider-credential posture at
 * webhook scale).
 */
import { z } from "zod";

import { ArgsDigest, Id, ResourceUri } from "@shera-bot/contracts";

/** The autonomous task plan a schedule (or event trigger) executes — typed
 * configuration the runtime validates at create time, never prose
 * classification (G2). The prompt is the task's INSTRUCTION payload (what a
 * scheduled task IS), bounded like every message. */
export const TriggerPlanSchema = z.strictObject({
  prompt: z.string().min(1).max(2000),
  tool: z
    .strictObject({
      tool_id: Id,
      tool_version: z.string().regex(/^\d+\.\d+\.\d+$/),
      capability: z.string().min(1).max(128),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  artifact: z
    .strictObject({
      name: z.string().min(1).max(200),
      artifact_type: z.string().min(1).max(100),
      mime_type: z.string().min(1).max(100),
    })
    .optional(),
});
export type TriggerPlan = z.infer<typeof TriggerPlanSchema>;

/** Schedule config: the cron expression (UTC) + the autonomous plan + the
 * optional explicit provider pair (the D17 gate consults it at fire time). */
export const ScheduleConfigSchema = z.strictObject({
  cron: z.string().min(1).max(128),
  plan: TriggerPlanSchema,
  provider: z
    .strictObject({
      provider_id: Id,
      model: z.string().min(1).max(256),
    })
    .optional(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

/** File-watch config: the D6 scopes. A workspace watcher follows the shared
 * workspace:// tree; an agent watcher follows ONE Agent's private folder
 * (the record names the agent — the service refuses a watcher on another
 * Agent's folder path). */
export const FileWatchConfigSchema = z.strictObject({
  scope: z.enum(["workspace", "agent"]),
  path_uri: ResourceUri,
  agent_id: Id.optional(),
});
export type FileWatchConfig = z.infer<typeof FileWatchConfigSchema>;

/** Git-watch config: one branch of one project (the sha is the signature). */
export const GitWatchConfigSchema = z.strictObject({
  project_id: Id,
  branch: z.string().min(1).max(256),
});
export type GitWatchConfig = z.infer<typeof GitWatchConfigSchema>;

/** Webhook config: a display source label and the OPTIONAL shared secret —
 * stored as its sha256 digest only (G3; the plaintext never persists). */
export const WebhookConfigSchema = z.strictObject({
  source: z.string().min(1).max(128),
  secret: z.string().min(8).max(256).optional(),
});
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

/** The STORED webhook config shape (secret_digest replaces the plaintext). */
export const WebhookStoredConfigSchema = z.strictObject({
  source: z.string().min(1).max(128),
  secret_digest: ArgsDigest.optional(),
});
export type WebhookStoredConfig = z.infer<typeof WebhookStoredConfigSchema>;

/** Task-completion config: which terminal outcomes fire the follow-up. */
export const TaskCompletionConfigSchema = z.strictObject({
  outcomes: z.array(z.enum(["succeeded", "failed", "cancelled"])).min(1).max(3).default([
    "succeeded",
  ]),
});
export type TaskCompletionConfig = z.infer<typeof TaskCompletionConfigSchema>;

/** Condition config: a TYPED predicate the runtime evaluates on its tick
 * (the agent-session-backed evaluator is the recorded seam — E37). */
export const ConditionPredicateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace_file_exists"), path_uri: ResourceUri }),
  z.strictObject({
    kind: z.literal("git_branch_exists"),
    project_id: Id,
    branch: z.string().min(1).max(256),
  }),
  z.strictObject({ kind: z.literal("artifact_count_at_least"), count: z.number().int().min(0) }),
]);
export type ConditionPredicate = z.infer<typeof ConditionPredicateSchema>;

export const ConditionConfigSchema = z.strictObject({
  predicate: ConditionPredicateSchema,
  /** The Agent whose condition this is (the evaluation's provenance). */
  evaluated_by_agent_id: Id.optional(),
  /** The parent run the fired run links to (AC6), when the condition is
   * declared in a run's context. */
  parent_task_id: Id.nullable().optional(),
});
export type ConditionConfig = z.infer<typeof ConditionConfigSchema>;

/** External-event config: the typed source label. */
export const ExternalEventConfigSchema = z.strictObject({
  source: z.string().min(1).max(128),
});
export type ExternalEventConfig = z.infer<typeof ExternalEventConfigSchema>;

export const TRIGGER_KIND_VALUES = [
  "schedule",
  "file_watch",
  "git_watch",
  "webhook",
  "task_completion",
  "condition",
  "external_event",
] as const;
export type TriggerKindValue = (typeof TRIGGER_KIND_VALUES)[number];

/** The per-kind configuration union (what the create command accepts). The
 * `kind` discriminator lives on the COMMAND (the record's kind column);
 * each config schema here is that kind's payload shape. */
export const TriggerConfigSchema = z.union([
  ScheduleConfigSchema,
  FileWatchConfigSchema,
  GitWatchConfigSchema,
  WebhookConfigSchema,
  TaskCompletionConfigSchema,
  ConditionConfigSchema,
  ExternalEventConfigSchema,
]);
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

/** The create command (the ONLY way a trigger record exists — G2). */
export interface TriggerCreateInput {
  kind: TriggerKindValue;
  name: string;
  target_operation_id: string;
  config: TriggerConfig;
  catch_up_policy: "catch_up" | "skip";
  actor: { type: string; id: string };
}

/** The edit command (name and/or config; the next occurrence recomputes). */
export interface TriggerEditInput {
  name?: string;
  config?: TriggerConfig;
  catch_up_policy?: "catch_up" | "skip";
  actor: { type: string; id: string };
}

/** The UI's truthful read model (AC9): the row's bookkeeping plus the typed
 * config and the recent firings. */
export interface TriggerView {
  trigger_id: string;
  name: string;
  kind: TriggerKindValue;
  target_operation_id: string;
  config: Record<string, unknown>;
  catch_up_policy: "catch_up" | "skip";
  state: "active" | "paused";
  pause_reason: string | null;
  last_fired_at: string | null;
  last_occurrence_at: string | null;
  next_occurrence_at: string | null;
  created_at: string;
  updated_at: string;
  recent_firings: TriggerFiringView[];
}

export interface TriggerFiringView {
  idempotency_key: string;
  run_id: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
  fired_at: string;
}
