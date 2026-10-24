import { z } from "zod";

import {
  AgentSettingsCommand,
  AgentSettingsSnapshot,
  AgentToolDefault,
  EditableAgentSettingKey,
  ProviderDefault,
  type AgentSettingsCommand as AgentSettingsCommandType,
} from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";
import { AGENT_SESSION_PRESENCE_VALUES } from "@/lib/session-presence";

/**
 * Typed browser client for the S11 agent identity surfaces (chunk 4), reached
 * through the same-origin runtime proxy exactly like the conversation client
 * (lib/runtime-client.ts — the same transport idiom and typed failures):
 *
 *   GET  /v1/agents                                   workspace roster summaries
 *   GET  /v1/agents/:agent_id                         detail + direct_chat_id
 *                                                     (get-or-create — the UI
 *                                                     can always open the chat)
 *   GET  /v1/agents/:agent_id/settings                the D16 settings snapshot
 *   POST /v1/agents/:agent_id/settings/commands       the ONE mutation surface
 *                                                     (D16: onboarding and the
 *                                                     settings editor share the
 *                                                     same commands; D26)
 *
 * The chunk-2 PATCH routes exist on the local API but are deliberately NOT
 * exposed here (nor through the proxy): every settings mutation goes through
 * the contracts command union below.
 *
 * The command envelope is built CLIENT-SIDE (command_id + idempotency_key +
 * issued_at minted per submit) and validated through the SAME contracts schema
 * the runtime parses — a malformed command fails at build time, never as a
 * 400 on the wire. The actor is the S01 fixture user; the real signed-in
 * principal rides the authenticated transport in a later chunk and is
 * deliberately not faked here (G4).
 */

/**
 * S12: the supervised session read the runtime reports on EVERY Agent row
 * (roster and detail alike — the allowlisted payload proves it). Required:
 * the backend always includes it, and a strict object that ignored it would
 * throw on real responses.
 */
const AgentSessionStateSchema = z.strictObject({
  presence: z.enum(AGENT_SESSION_PRESENCE_VALUES),
});

/** Loose roster summary — the local API's strictly allowlisted identity payload. */
const AgentRosterSummarySchema = z.strictObject({
  agent_id: z.string().min(1),
  display_name: z.string().min(1),
  role_description: z.string(),
  avatar_hue: z.number().int().min(0).max(360),
  initial_glyph: z.string().min(1),
  has_user_instructions: z.boolean(),
  session: AgentSessionStateSchema,
});
export type AgentRosterSummary = z.infer<typeof AgentRosterSummarySchema>;

/** The detail payload: the summary plus what the settings UI edits + the direct chat. */
const AgentDetailSchema = AgentRosterSummarySchema.extend({
  user_instructions: z.string().nullable(),
  default_provider: ProviderDefault,
  direct_chat_id: z.string().min(1),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

const AgentRosterResponse = z.strictObject({
  agents: z.array(AgentRosterSummarySchema),
});

export function fetchAgentRoster(workspaceId: string): Promise<AgentRosterSummary[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/agents?${query.toString()}`,
    (payload) => AgentRosterResponse.parse(payload).agents,
  );
}

export function fetchAgentDetail(workspaceId: string, agentId: string): Promise<AgentDetail> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/agents/${encodeURIComponent(agentId)}?${query.toString()}`,
    (payload) => AgentDetailSchema.parse(payload),
  );
}

/** The D16 read model, validated through the contracts snapshot schema. */
export function fetchAgentSettings(
  workspaceId: string,
  agentId: string,
): Promise<AgentSettingsSnapshot> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/agents/${encodeURIComponent(agentId)}/settings?${query.toString()}`,
    (payload) => AgentSettingsSnapshot.parse(payload),
  );
}

/**
 * Submit one D16 settings command; the response is the runtime's
 * read-after-write snapshot (validated through the same contracts schema).
 */
export function submitAgentSettingsCommand(
  workspaceId: string,
  agentId: string,
  command: AgentSettingsCommandType,
): Promise<AgentSettingsSnapshot> {
  return requestRuntime(
    `/api/runtime/v1/agents/${encodeURIComponent(agentId)}/settings/commands`,
    (payload) => AgentSettingsSnapshot.parse(payload),
    {
      method: "POST",
      body: JSON.stringify(command),
    },
  );
}

// ---------------------------------------------------------------------------
// The D16 command envelope (built client-side, validated by the contracts)
// ---------------------------------------------------------------------------

/**
 * The fixture user actor (S01 fixture session, matching the local API's own
 * test envelopes and the chat demo's LOCAL_USER_NAME attribution). The real
 * principal-to-workspace binding arrives with the authenticated transport and
 * is deliberately not faked with a richer identity (G4).
 */
export const AGENT_SETTINGS_USER_ACTOR = { type: "user", id: "user_emon" } as const;

/** The envelope fields the caller supplies per submit (minted fresh each time). */
export interface AgentSettingsCommandEnvelope {
  command_id: string;
  idempotency_key: string;
  workspace_id: string;
  agent_id: string;
  issued_at: string;
}

/** Fresh envelope ids: each submit is its own idempotency unit (D23 rule 6). */
export function newAgentSettingsCommandIds(): {
  command_id: string;
  idempotency_key: string;
  issued_at: string;
} {
  return {
    command_id: `cmd_${globalThis.crypto.randomUUID()}`,
    idempotency_key: `idem_${globalThis.crypto.randomUUID()}`,
    issued_at: new Date().toISOString(),
  };
}

/** A semantic settings action minus the envelope the builder fills in. */
export type AgentSettingsAction =
  | { type: "agent_settings.update_instructions"; user_instructions: string | null }
  | { type: "agent_settings.update_default_provider"; default_provider: ProviderDefault }
  | { type: "agent_settings.update_tool_defaults"; tool_defaults: AgentToolDefault[] }
  | { type: "agent_settings.reset_setting"; setting_key: EditableAgentSettingKey }
  | { type: "agent_settings.reset_all" };

/**
 * Build one contracts-valid settings command: the action plus the envelope and
 * the user actor. Parsed through the runtime's own union, so an invalid action
 * (say, a reset targeting a pack-owned key) throws HERE — never a malformed
 * POST. Keep `z` in the loop only through the contracts schema; no local
 * re-typing that could drift.
 */
export function buildAgentSettingsCommand(
  action: AgentSettingsAction,
  envelope: AgentSettingsCommandEnvelope,
): AgentSettingsCommandType {
  return AgentSettingsCommand.parse({
    ...action,
    ...envelope,
    actor: AGENT_SETTINGS_USER_ACTOR,
  });
}

/**
 * Convenience for the live surface: envelope minted fresh per submit.
 * Unused ids are simply discarded on a failure — a retry mints a NEW key,
 * because these validated last-write-wins commands carry no receipt replay.
 */
export function agentSettingsCommand(
  workspaceId: string,
  agentId: string,
  action: AgentSettingsAction,
): AgentSettingsCommandType {
  return buildAgentSettingsCommand(action, {
    ...newAgentSettingsCommandIds(),
    workspace_id: workspaceId,
    agent_id: agentId,
  });
}
