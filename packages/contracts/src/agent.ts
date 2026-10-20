/**
 * Agent contract (S02 #3): a persistent, reusable AI identity inside a Pack
 * (D18, D29, D39, D44 — "Agent" everywhere; "Expert" is a historical alias).
 * The Agent references skills, tools, and connectors; it never embeds
 * implementations (D38: a pack references capabilities).
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, JsonObject, SemVer, WorkspaceId } from "./primitives.ts";

/** A versioned reference to a runtime-owned tool (D38). */
export const ToolRef = z.strictObject({
  tool_id: Id,
  version: SemVer,
});
export type ToolRef = z.infer<typeof ToolRef>;

/** A versioned provider/model default (PRD §9; overrides live per conversation). */
export const ProviderDefault = z.strictObject({
  provider_id: Id,
  model: z.string().min(1).max(256),
});
export type ProviderDefault = z.infer<typeof ProviderDefault>;

/**
 * D18 UI identity metadata. Presentation data only — NEVER a capability: it
 * grants no skill, tool, connector, or permission, and the runtime ignores it
 * for every authorization decision (D38, D28).
 *
 * Optional so a Pack written before identity authoring still validates; when
 * absent the client derives a stable per-Agent appearance from `agent_id`, so
 * one Agent always looks the same everywhere (D39).
 */
export const UiIdentity = z.strictObject({
  /** Base hue in degrees; drives the Agent's whole color identity. */
  avatar_hue: z.number().int().min(0).max(360),
  /** Exactly one code point, rendered as the avatar's glyph. */
  initial_glyph: z
    .string()
    .refine((glyph) => [...glyph].length === 1, "expected exactly one code point"),
});
export type UiIdentity = z.infer<typeof UiIdentity>;

export const Agent = z.strictObject({
  agent_id: Id,
  display_name: z.string().min(1).max(200),
  /** The fixed role; user instructions are profile content layered above it. */
  role_description: z.string().min(1).max(2000),
  default_provider: ProviderDefault,
  /** Skill references (knowledge bundles, D38) — ids into the pack catalog. */
  skills: z.array(Id).max(200),
  /** Tool references — the pack names versions; the runtime owns execution. */
  tools: z.array(ToolRef).max(500),
  /** Connector references (authenticated integrations, D38). */
  connectors: z.array(Id).max(100),
  /**
   * D46: one home Operation per Agent. The General Assistant's cross-Operation
   * presence is the coordinator role specifically and does not count as
   * multi-Operation rostering, so the home Operation stays single.
   */
  home_operation_id: Id.nullable(),
  /**
   * D18 authored visual identity (hue + glyph). Presentation only. Omitted by
   * packs that do not author identity; clients then derive a stable appearance
   * from `agent_id` (D39).
   */
  ui_identity: UiIdentity.optional(),
  /** Reserved for profile provenance (pack version that declared the Agent). */
  declared_in_pack_version: SemVer.optional(),
  created_at: IsoDateTime.optional(),
  updated_at: IsoDateTime.optional(),
});
export type Agent = z.infer<typeof Agent>;

/**
 * S11 chunk 3 — the typed D16 Agent settings surface (D16: zero-configuration
 * start; onboarding and the settings editor use the SAME commands and schemas,
 * so S30 reuses this file verbatim). Three shapes live here:
 *
 * 1. `AgentSettingsCommand` — the idempotent command union (the ONLY mutation
 *    path for user-owned settings; D26). Pack-owned fields appear as read-only
 *    entries and are never command targets.
 * 2. `AgentSettingsSnapshot` — the read model: every setting as a typed entry
 *    carrying exactly what the D16 UI must show — display label, current
 *    value, recommended default, why it matters, risk/cost impact, editability,
 *    and the reset-to-default command.
 * 3. `AgentSettingsOverrides` — the validated shape the runtime persists for
 *    user-owned values that have no dedicated column; every write validates
 *    through it, so a malformed blob is a typed rejection, never silent data.
 *
 * Placeholder boundaries (S11): tool defaults are placeholder-typed until the
 * tool slices (S21+) own real config schemas; provider values are placeholder
 * strings until the providers slice (S23) owns real catalogs. The envelope is
 * the contracts command shape (task-commands.ts CommandBase) minus the task
 * aggregate's expected_version — settings are last-write-wins validated JSON
 * with no versioned aggregate, so an optimistic version check has no analogue
 * here. Settings mutations are NOT journaled in this slice: the runtime has no
 * agent-domain event stream yet, and inventing one here would pre-empt the
 * memory/task slices.
 */

/** Placeholder per-tool default until the tool slices own real config (S21+). */
export const AgentToolDefault = z.strictObject({
  tool_id: Id,
  /** Free-form tool config; the tool slice refines this per tool. */
  config: JsonObject,
});
export type AgentToolDefault = z.infer<typeof AgentToolDefault>;

/**
 * The Agent's private folder ROOT URI (`agent://<agent_id>/`) — what the
 * memory_link setting surfaces. The shared ResourceUri primitive requires a
 * path segment after the host; the folder root ends at the host slash, so the
 * read model pins its own precise shape instead of loosening the primitive.
 */
export const AgentFolderUri = z
  .string()
  .regex(/^agent:\/\/[a-z0-9_-]+\/$/, "expected an agent:// folder root URI");
export type AgentFolderUri = z.infer<typeof AgentFolderUri>;

/** The capabilities triple a pack declares for one Agent (mirrors Agent fields). */
export const AgentCapabilities = z.strictObject({
  skills: z.array(Id).max(200),
  tools: z.array(ToolRef).max(500),
  connectors: z.array(Id).max(100),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/**
 * The setting keys the snapshot carries. Read-only pack-owned/derived keys
 * (role, capabilities, ui_identity, memory_link) sit beside the user-editable
 * keys; EDITABLE_AGENT_SETTING_KEYS is the command-target subset.
 */
export const AGENT_SETTING_KEYS = [
  "role",
  "user_instructions",
  "memory_link",
  "default_provider",
  "tool_defaults",
  "capabilities",
  "ui_identity",
] as const;
export const AgentSettingKey = z.enum(AGENT_SETTING_KEYS);
export type AgentSettingKey = z.infer<typeof AgentSettingKey>;

/** The keys a settings command may target — never a pack-owned field (D16). */
export const EDITABLE_AGENT_SETTING_KEYS = [
  "user_instructions",
  "default_provider",
  "tool_defaults",
] as const;
export const EditableAgentSettingKey = z.enum(EDITABLE_AGENT_SETTING_KEYS);
export type EditableAgentSettingKey = z.infer<typeof EditableAgentSettingKey>;

/**
 * Metadata every settings entry carries (D16: the UI shows recommended
 * default, current value, why it matters, risk/cost impact, and
 * reset-to-default). `reset_command` names the per-setting reset command and
 * is null exactly when the entry is not user-resettable (pack-owned).
 */
const AgentSettingMeta = {
  display_label: z.string().min(1).max(200),
  /** Why the setting matters (D16 "why it matters"). */
  description: z.string().min(1).max(2000),
  /** Risk/cost impact the UI surfaces (D16); empty when there is none to flag. */
  risk_note: z.string().max(2000),
  editable: z.boolean(),
  resettable: z.boolean(),
  reset_command: z.literal("agent_settings.reset_setting").nullable(),
} as const;

export const AgentRoleSettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("role"),
  value: z.string(),
  recommended_default: z.null(),
});
export type AgentRoleSettingEntry = z.infer<typeof AgentRoleSettingEntry>;

export const AgentUserInstructionsSettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("user_instructions"),
  value: z.string().max(8000).nullable(),
  recommended_default: z.null(),
});
export type AgentUserInstructionsSettingEntry = z.infer<typeof AgentUserInstructionsSettingEntry>;

export const AgentMemoryLinkSettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("memory_link"),
  /** The Agent's private folder root URI; derived from agent_id, never set here. */
  value: AgentFolderUri,
  recommended_default: z.null(),
});
export type AgentMemoryLinkSettingEntry = z.infer<typeof AgentMemoryLinkSettingEntry>;

export const AgentDefaultProviderSettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("default_provider"),
  value: ProviderDefault,
  /** Null when no pack-supplied recommendation is loaded (placeholder until S23). */
  recommended_default: ProviderDefault.nullable(),
});
export type AgentDefaultProviderSettingEntry = z.infer<typeof AgentDefaultProviderSettingEntry>;

export const AgentToolDefaultsSettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("tool_defaults"),
  value: z.array(AgentToolDefault).max(500),
  recommended_default: z.array(AgentToolDefault).max(500),
});
export type AgentToolDefaultsSettingEntry = z.infer<typeof AgentToolDefaultsSettingEntry>;

export const AgentCapabilitiesSettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("capabilities"),
  value: AgentCapabilities,
  recommended_default: z.null(),
});
export type AgentCapabilitiesSettingEntry = z.infer<typeof AgentCapabilitiesSettingEntry>;

export const AgentUiIdentitySettingEntry = z.strictObject({
  ...AgentSettingMeta,
  key: z.literal("ui_identity"),
  value: UiIdentity,
  recommended_default: z.null(),
});
export type AgentUiIdentitySettingEntry = z.infer<typeof AgentUiIdentitySettingEntry>;

export const AgentSettingEntry = z.discriminatedUnion("key", [
  AgentRoleSettingEntry,
  AgentUserInstructionsSettingEntry,
  AgentMemoryLinkSettingEntry,
  AgentDefaultProviderSettingEntry,
  AgentToolDefaultsSettingEntry,
  AgentCapabilitiesSettingEntry,
  AgentUiIdentitySettingEntry,
]);
export type AgentSettingEntry = z.infer<typeof AgentSettingEntry>;

/** The read model behind GET agent settings: workspace-scoped (E12). */
export const AgentSettingsSnapshot = z.strictObject({
  workspace_id: WorkspaceId,
  agent_id: Id,
  entries: z.array(AgentSettingEntry),
});
export type AgentSettingsSnapshot = z.infer<typeof AgentSettingsSnapshot>;

/**
 * The persisted user-owned values with no dedicated agents-table column.
 * Every write validates through this schema BEFORE the blob is stored — a
 * non-conforming payload is a typed CONTRACT_VALIDATION_FAILED rejection,
 * never silently stored JSON (chunk-1's raw blob is gone).
 */
export const AgentSettingsOverrides = z.strictObject({
  tool_defaults: z.array(AgentToolDefault).max(500).optional(),
});
export type AgentSettingsOverrides = z.infer<typeof AgentSettingsOverrides>;

/** Envelope shared by every settings command — the contracts command shape. */
const AgentSettingsCommandBase = {
  command_id: Id,
  idempotency_key: Id,
  workspace_id: WorkspaceId,
  agent_id: Id,
  actor: Actor,
  issued_at: IsoDateTime,
} as const;

// Same const-generic helper as task-commands.ts so the literal `type` keeps
// its identity in the inferred shape.
function agentSettingsCommand<const T extends string, const E extends z.ZodRawShape>(
  type: T,
  extra: E,
) {
  return z.strictObject({ ...AgentSettingsCommandBase, type: z.literal(type), ...extra });
}

export const AGENT_SETTINGS_UPDATE_INSTRUCTIONS = agentSettingsCommand(
  "agent_settings.update_instructions",
  { user_instructions: z.string().min(1).max(8000).nullable() },
);
export const AGENT_SETTINGS_UPDATE_DEFAULT_PROVIDER = agentSettingsCommand(
  "agent_settings.update_default_provider",
  { default_provider: ProviderDefault },
);
export const AGENT_SETTINGS_UPDATE_TOOL_DEFAULTS = agentSettingsCommand(
  "agent_settings.update_tool_defaults",
  { tool_defaults: z.array(AgentToolDefault).max(500) },
);
export const AGENT_SETTINGS_RESET_SETTING = agentSettingsCommand("agent_settings.reset_setting", {
  setting_key: EditableAgentSettingKey,
});
export const AGENT_SETTINGS_RESET_ALL = agentSettingsCommand("agent_settings.reset_all", {});

export const AGENT_SETTINGS_COMMAND_TYPES = [
  "agent_settings.update_instructions",
  "agent_settings.update_default_provider",
  "agent_settings.update_tool_defaults",
  "agent_settings.reset_setting",
  "agent_settings.reset_all",
] as const;
export type AgentSettingsCommandType = (typeof AGENT_SETTINGS_COMMAND_TYPES)[number];

/** The discriminated union both the settings editor and S30 onboarding submit. */
export const AgentSettingsCommand = z.discriminatedUnion("type", [
  AGENT_SETTINGS_UPDATE_INSTRUCTIONS,
  AGENT_SETTINGS_UPDATE_DEFAULT_PROVIDER,
  AGENT_SETTINGS_UPDATE_TOOL_DEFAULTS,
  AGENT_SETTINGS_RESET_SETTING,
  AGENT_SETTINGS_RESET_ALL,
]);
export type AgentSettingsCommand = z.infer<typeof AgentSettingsCommand>;
