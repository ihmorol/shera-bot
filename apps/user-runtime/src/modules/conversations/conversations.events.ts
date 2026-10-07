/**
 * Conversations module event surface (S07; D23 module shape).
 *
 * The payload SCHEMAS and the event-type registry live with the journal
 * (modules/events) because the journal validates stored rows at replay; this
 * file gives the conversations module its typed view of its own events and
 * owns the stream naming so no caller assembles stream ids by hand.
 */
import type { EventEnvelope } from "../events/events.types.ts";

export type ConversationCreatedEvent = EventEnvelope<"conversation.created">;
export type ConversationRenamedEvent = EventEnvelope<"conversation.renamed">;
export type ConversationEvent = ConversationCreatedEvent | ConversationRenamedEvent;

/** The journal stream that carries one conversation's history. */
export function conversationStreamFor(conversationId: string): string {
  return `conversation:${conversationId}`;
}
