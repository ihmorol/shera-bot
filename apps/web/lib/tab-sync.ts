/**
 * S30 — the multi-tab sync hint layer (E15 embed: BroadcastChannel), LAYERED
 * UNDER the S07 server-cursor replay.
 *
 * The recorded posture (issue #31 leverage section; PRD §14): the SERVER
 * cursor replay stays the truth — a second tab replays missed events through
 * S07's cursor, never through another tab's memory. This channel carries
 * CLIENT CONVENIENCE hints ONLY: a closed vocabulary of invalidation events
 * ("something changed, re-read the server") that make the other tabs'
 * polls converge immediately instead of waiting for the next 5s tick. No
 * conversation history, no approval content, no notification bodies EVER
 * ride this channel — the payload vocabulary has no content fields at all
 * (G3, and the layered-under rule by construction).
 */

/** The closed event vocabulary. Extending it is a recorded-slice change. */
export const TAB_SYNC_EVENT = [
  "notifications-changed",
  "approvals-changed",
  "settings-changed",
] as const;

export type TabSyncEvent =
  | { kind: "notifications-changed" }
  | { kind: "approvals-changed" }
  | { kind: "settings-changed"; section: string };

/** The channel name all tabs of this app share. */
export const TAB_SYNC_CHANNEL = "shera-tab-sync";

const TabSyncEventSchema = [
  { kind: "notifications-changed" },
  { kind: "approvals-changed" },
  { kind: "settings-changed" },
] as const;

/** Serialize one event (a tiny explicit boundary so the channel stays typed). */
export function tabSyncEventBody(event: TabSyncEvent): string {
  return JSON.stringify(event);
}

/** Parse one channel message; a foreign payload is refused (null). */
export function parseTabSyncEvent(raw: string): TabSyncEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    for (const shape of TabSyncEventSchema) {
      if (candidate["kind"] === shape.kind) {
        if (shape.kind === "settings-changed") {
          if (typeof candidate["section"] === "string") {
            return { kind: "settings-changed", section: candidate["section"] };
          }
          return null;
        }
        return { kind: shape.kind } as TabSyncEvent;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** A minimal surface both the browser BroadcastChannel and tests satisfy. */
export interface TabSyncChannel {
  postMessage(message: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data?: unknown }) => void): void;
}

/** Open the shared channel (null where BroadcastChannel does not exist). */
export function openTabSyncChannel(): TabSyncChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(TAB_SYNC_CHANNEL) as unknown as TabSyncChannel;
}

/** Publish one hint; failures are silent by design (the polls converge anyway). */
export function broadcastTabEvent(channel: TabSyncChannel | null, event: TabSyncEvent): void {
  try {
    channel?.postMessage(tabSyncEventBody(event));
  } catch {
    // A closed channel is not an error state: the server truth converges.
  }
}

/** Subscribe to the hints; returns the unsubscribe function. */
export function subscribeTabEvents(
  channel: TabSyncChannel | null,
  handler: (event: TabSyncEvent) => void,
): () => void {
  if (!channel) {
    return () => undefined;
  }
  const listener = (event: { data?: unknown }) => {
    if (typeof event.data === "string") {
      const parsed = parseTabSyncEvent(event.data);
      if (parsed) {
        handler(parsed);
      }
    }
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
