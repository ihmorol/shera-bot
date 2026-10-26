/**
 * Operation launch preview contracts (S15): the READ MODEL the user confirms
 * before anything executes (D30) — the preview is a safety boundary where
 * NOTHING may run before confirmation, so this schema is read-model data
 * only: no command envelopes, no mutation shapes (D23 rule 2).
 *
 * The eight D30 groups, one schema field each:
 *   1. definition        — the Operation definition's purpose (pack-authored).
 *   2. roster            — recommended roster with per-Agent roles and the
 *                          coordinator marked (D42/D46; the coordinator role is
 *                          not a roster assignment, so the coordinator may sit
 *                          outside the roster).
 *   3. skills            — skills per Agent from the pinned pack (D38).
 *   4. connectors        — recommended connectors, ALWAYS `connected: false`
 *                          in the prototype (D38: an Operation recommends a
 *                          connector but never automatically authorizes or
 *                          installs one).
 *   5. providers         — provider/model per Agent (the effective saved
 *                          default) with `configured: false` until the
 *                          providers slice owns real wiring (S23; G3 — the
 *                          preview shows configuration, never credentials).
 *   6. estimated_credits — a RANGE with the D20 settlement note (an estimate
 *                          is a bounded placeholder, never a promise; Agents
 *                          on custom providers consume no Shera credits).
 *   7. approval_requirements — the D35 risk classes the Operation's plan can
 *                          reach and which pause for approval; classes are
 *                          NAMED without promising outcomes.
 *   8. expected_outputs  — from the definition when it declares outputs;
 *                          null, or an explicitly purpose-derived statement
 *                          with the reason, when it does not (honesty over
 *                          invention).
 *
 * `definition_ref` and the pinned pack identity (D29) ride at the top level.
 * Vocabulary: Pack → Operations → Agents. Zod-first (D25); strictObject.
 * Governing records: D30, D38, D20, D35, D29, PRD §19 AC6/AC23.
 */
import { z } from "zod";

import { Id, SemVer, WorkspaceId } from "./primitives.ts";
import { OperationCoordinatorRef } from "./operation.ts";

/** Where the preview's recommended roster came from (D30 co-planning). */
export const OPERATION_PREVIEW_ROSTER_SOURCES = [
  "pack_default",
  "definition_override",
  "request_override",
] as const;
export const OperationPreviewRosterSource = z.enum(OPERATION_PREVIEW_ROSTER_SOURCES);
export type OperationPreviewRosterSource = z.infer<typeof OperationPreviewRosterSource>;

/** Group 2 — one recommended Agent with its role and coordinator mark. */
export const OperationPreviewRosterAgent = z.strictObject({
  agent_id: Id,
  display_name: z.string().min(1).max(200),
  /** The pack's fixed role description (user instructions are NOT previewed). */
  role: z.string().min(1).max(2000),
  is_coordinator: z.boolean(),
});
export type OperationPreviewRosterAgent = z.infer<typeof OperationPreviewRosterAgent>;

export const OperationPreviewRoster = z.strictObject({
  agents: z.array(OperationPreviewRosterAgent).min(1).max(50),
  /** D42: a concrete Agent id, or "none" once removed (D49). */
  coordinator_agent_id: OperationCoordinatorRef,
  source: OperationPreviewRosterSource,
});
export type OperationPreviewRoster = z.infer<typeof OperationPreviewRoster>;

/** One skill reference with the pack catalog's display title (null when omitted). */
export const OperationPreviewSkillRef = z.strictObject({
  skill_id: Id,
  title: z.string().min(1).max(200).nullable(),
});
export type OperationPreviewSkillRef = z.infer<typeof OperationPreviewSkillRef>;

/** Group 3 — one Agent's skills, from the pinned pack (D38). */
export const OperationPreviewAgentSkills = z.strictObject({
  agent_id: Id,
  skills: z.array(OperationPreviewSkillRef).max(200),
});
export type OperationPreviewAgentSkills = z.infer<typeof OperationPreviewAgentSkills>;

export const OperationPreviewSkills = z.strictObject({
  /** The definition's own declared skill set (pack-authored, D38). */
  operation_skill_ids: z.array(Id).max(200),
  agents: z.array(OperationPreviewAgentSkills).max(50),
  /** Skills come from the pinned pack catalog only — nothing is invented. */
  source: z.literal("pack"),
});
export type OperationPreviewSkills = z.infer<typeof OperationPreviewSkills>;

/**
 * Group 4 — one recommended connector. `connected` is literally false: the
 * prototype has no connector runtime and D38 forbids auto-install, so the
 * wire shape cannot even express a connected connector (G2 — the read model
 * never claims a live connection that does not exist).
 */
export const OperationPreviewConnector = z.strictObject({
  connector_id: Id,
  title: z.string().min(1).max(200).nullable(),
  version: SemVer.nullable(),
  connected: z.literal(false),
  status: z.literal("not_connected"),
  note: z.string().min(1).max(500),
});
export type OperationPreviewConnector = z.infer<typeof OperationPreviewConnector>;

export const OperationPreviewConnectors = z.strictObject({
  items: z.array(OperationPreviewConnector).max(100),
});
export type OperationPreviewConnectors = z.infer<typeof OperationPreviewConnectors>;

/**
 * Group 5 — one Agent's effective provider/model pair. `configured` is
 * literally false until the providers slice (S23) owns real wiring: the pair
 * shown is the Agent's saved default (user-owned settings over the pack
 * seed), never a live provider and never a credential (G3).
 */
export const OperationPreviewAgentProvider = z.strictObject({
  agent_id: Id,
  provider_id: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  configured: z.literal(false),
  /** "agent_settings" (the workspace Agent row) or "pack_default" (the seed). */
  source: z.enum(["agent_settings", "pack_default"]),
  note: z.string().min(1).max(500),
});
export type OperationPreviewAgentProvider = z.infer<typeof OperationPreviewAgentProvider>;

export const OperationPreviewProviders = z.strictObject({
  agents: z.array(OperationPreviewAgentProvider).max(50),
});
export type OperationPreviewProviders = z.infer<typeof OperationPreviewProviders>;

/**
 * Group 6 — the D20 credits estimate: a BOUNDED RANGE with the settlement
 * note. Credits never authorize tools or external actions (D20); the estimate
 * is a policy placeholder until the providers slice owns real pricing.
 */
export const OperationPreviewCreditsEstimate = z.strictObject({
  currency: z.literal("shera_credits"),
  min_credits: z.number().int().min(0),
  max_credits: z.number().int().min(0),
  /** The documented placeholder formula (see the runtime preview builder). */
  formula: z.string().min(1).max(500),
  settlement_note: z.string().min(1).max(500),
  /** Agents on custom providers consume no Shera credits (D20). */
  custom_provider_agents: z.array(Id).max(50),
});
export type OperationPreviewCreditsEstimate = z.infer<typeof OperationPreviewCreditsEstimate>;

/**
 * Group 7 — the D35 risk ladder classes a preview can name. The runtime owns
 * tool definitions and their real risk classes (D38); these are the ladder
 * classes a plan can reach, mapped honestly from tool references (see the
 * runtime builder's documented default mapping).
 */
export const D35_RISK_CLASSES = [
  "read-only",
  "local-mutation",
  "code-execution",
  "repository-mutation",
  "external-write",
  "destructive-irreversible",
] as const;
export const D35RiskClass = z.enum(D35_RISK_CLASSES);
export type D35RiskClass = z.infer<typeof D35RiskClass>;

/** One ladder class with the tool ids that map to it and what it does. */
export const OperationPreviewApprovalClass = z.strictObject({
  risk_class: D35RiskClass,
  tool_ids: z.array(Id).max(100),
  behavior: z.enum(["auto_execute", "approval_required"]),
});
export type OperationPreviewApprovalClass = z.infer<typeof OperationPreviewApprovalClass>;

export const OperationPreviewApprovals = z.strictObject({
  /** Every D35 class the roster's tool references can reach (D35 ladder). */
  risk_classes: z.array(D35RiskClass).max(D35_RISK_CLASSES.length),
  /** The subset that pauses for approval before execution (D35). */
  classes_requiring_approval: z.array(D35RiskClass).max(D35_RISK_CLASSES.length),
  /** The per-class mapping with the tool ids behind it. */
  mapping: z.array(OperationPreviewApprovalClass).max(D35_RISK_CLASSES.length),
  /** Honest provenance of the mapping (the runtime re-derives at execution). */
  mapping_note: z.string().min(1).max(500),
});
export type OperationPreviewApprovals = z.infer<typeof OperationPreviewApprovals>;

/**
 * Group 8 — expected outputs, HONESTLY sourced: "definition" when the
 * definition declares them (none does today), "purpose_derived" when the
 * statement is derived from the definition's purpose (with the reason), or
 * the whole group is null when even that is not offered. Never invented.
 */
export const OperationPreviewExpectedOutputs = z.strictObject({
  statement: z.string().min(1).max(2000),
  source: z.enum(["definition", "purpose_derived"]),
  /** Set when (and only when) source is "purpose_derived". */
  reason: z.string().min(1).max(500).nullable(),
});
export type OperationPreviewExpectedOutputs = z.infer<typeof OperationPreviewExpectedOutputs>;

/** Group 1 — the definition identity block (pack-authored fields only). */
export const OperationPreviewDefinition = z.strictObject({
  operation_definition_id: Id,
  version: SemVer,
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
});
export type OperationPreviewDefinition = z.infer<typeof OperationPreviewDefinition>;

/**
 * THE Operation launch preview (D30): eight groups plus the pinned pack
 * identity (D29) and the definition reference the confirmation will launch
 * (chunk 3). Read model only — the runtime gateway owns the launch itself.
 */
export const OperationLaunchPreview = z.strictObject({
  workspace_id: WorkspaceId,
  /** The reference the confirmed launch creates the Operation from (D29/D41). */
  definition_ref: z.string().min(1).max(512),
  pack: z.strictObject({
    pack_id: Id,
    pack_version: SemVer,
    /** The preview reads the workspace's PINNED pack — always true (D28). */
    pinned: z.literal(true),
  }),
  definition: OperationPreviewDefinition,
  roster: OperationPreviewRoster,
  skills: OperationPreviewSkills,
  connectors: OperationPreviewConnectors,
  providers: OperationPreviewProviders,
  estimated_credits: OperationPreviewCreditsEstimate,
  approval_requirements: OperationPreviewApprovals,
  expected_outputs: OperationPreviewExpectedOutputs.nullable(),
});
export type OperationLaunchPreview = z.infer<typeof OperationLaunchPreview>;
