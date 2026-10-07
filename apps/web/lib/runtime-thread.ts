import { compareThreadItems, type ThreadItem } from "@/lib/fixtures";
import type { RuntimeEvent } from "@/lib/runtime-client";

/**
 * Real journal events → thread items (S09 chunk 1).
 *
 * The General Assistant direct chat's REAL backing: the conversation stream's
 * durable journal events render as thread content. In this slice the stream
 * carries `conversation.created` / `conversation.renamed` (message sends and
 * the live stream are chunk 2/3), so the honest thread starts with a system
 * record of the conversation's real lifecycle — nothing is invented to make
 * it look populated (G4: no fabricated completion, no fabricated history).
 *
 * A conversation is never empty once created (the created event is always
 * journaled), and no event type is ever silently dropped: anything that is
 * not a conversation lifecycle event surfaces verbatim by type.
 */

export function threadItemsFromEvents(events: RuntimeEvent[]): ThreadItem[] {
  const items: ThreadItem[] = events.map((event) => ({
    kind: "system" as const,
    at: event.occurred_at,
    text: systemTextForEvent(event),
  }));
  return items.sort(compareThreadItems);
}

/** The honest system record for one journal event (verbatim for unknown types). */
export function systemTextForEvent(event: RuntimeEvent): string {
  if (event.type === "conversation.created") {
    const title =
      typeof event.payload["title"] === "string" ? (event.payload["title"] as string) : null;
    return title
      ? `This conversation started in your workspace as “${title}”.`
      : "This conversation started in your workspace.";
  }
  if (event.type === "conversation.renamed") {
    const title =
      typeof event.payload["title"] === "string" ? (event.payload["title"] as string) : null;
    return title ? `Renamed to “${title}”.` : "This conversation was renamed.";
  }
  return `Event ${event.type} recorded.`;
}
