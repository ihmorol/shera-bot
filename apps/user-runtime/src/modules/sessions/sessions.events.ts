/**
 * Sessions module event surface (S12 chunk 2; D23 module shape).
 *
 * Mirrors conversations.events.ts: the payload SCHEMAS and the event-type
 * registry live with the journal (modules/events) because the journal
 * validates stored rows at replay; this file gives the sessions module its
 * typed view of its own events and owns the stream naming so no caller
 * assembles stream ids by hand.
 *
 * Governing records: D14, D32, E17.
 */
import type { EventEnvelope } from "../events/events.types.ts";

export type SessionHibernateEvent = EventEnvelope<"session.hibernate">;
export type SessionCrashedEvent = EventEnvelope<"session.crashed">;
export type SessionRestartedEvent = EventEnvelope<"session.restarted">;
export type SessionProtocolFailureEvent = EventEnvelope<"session.protocol_failure">;
export type SessionFailedEvent = EventEnvelope<"session.failed">;

export type SessionEvent =
  | SessionHibernateEvent
  | SessionCrashedEvent
  | SessionRestartedEvent
  | SessionProtocolFailureEvent
  | SessionFailedEvent;

/**
 * The journal stream that carries one Agent session's supervision history.
 * Sessions are addressed by (workspace_id, agent_id) — the same scoping as
 * the Agent identity itself (E12) — so the stream id is derived from both.
 */
export function sessionStreamFor(workspaceId: string, agentId: string): string {
  return `session:${workspaceId}:${agentId}`;
}
