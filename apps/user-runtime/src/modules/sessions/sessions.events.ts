/**
 * Sessions module event surface (S12 chunk 2; D23 module shape).
 *
 * The payload SCHEMAS and the event-type registry live with the journal
 * (modules/events) because the journal validates stored rows at replay;
 * sessions events are consumed there through the generic envelope surface.
 * This file owns the stream naming so no caller assembles stream ids by
 * hand.
 *
 * Governing records: D14, D32, E17.
 */

/**
 * The journal stream that carries one Agent session's supervision history.
 * Sessions are addressed by (workspace_id, agent_id) — the same scoping as
 * the Agent identity itself (E12) — so the stream id is derived from both.
 */
export function sessionStreamFor(workspaceId: string, agentId: string): string {
  return `session:${workspaceId}:${agentId}`;
}
