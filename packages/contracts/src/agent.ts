/**
 * Agent contract (S02 #3): a persistent, reusable AI identity inside a Pack
 * (D18, D29, D39, D44 — "Agent" everywhere; "Expert" is a historical alias).
 * The Agent references skills, tools, and connectors; it never embeds
 * implementations (D38: a pack references capabilities).
 */
import { z } from "zod";

import { Id, IsoDateTime, SemVer } from "./primitives.ts";

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
  /** Reserved for profile provenance (pack version that declared the Agent). */
  declared_in_pack_version: SemVer.optional(),
  created_at: IsoDateTime.optional(),
  updated_at: IsoDateTime.optional(),
});
export type Agent = z.infer<typeof Agent>;
