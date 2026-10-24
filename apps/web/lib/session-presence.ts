/**
 * S12 chunk 4 — the chat header's honest session presence (D32 layer 3).
 *
 * The runtime's agent API reports `session.presence` on every Agent row (S12
 * chunks 1–3); there is deliberately NO WebSocket fanout for session events in
 * this slice, so the header POLLS the agent detail read on a fixed cadence and
 * pauses while the tab is hidden. This module holds the pure decision logic —
 * the polling interval, the chip-state vocabulary, and the once-per-browser-
 * session first-time note bookkeeping — so the honesty rules are directly
 * testable in the node component suites (apps/web/test/session-presence.test.ts).
 *
 * Governing records: D32 (on-demand sessions), D23 rule 4 (redaction), G4
 * (an absent or failed read is never rendered as a state).
 */

/** The D32 presence vocabulary exactly as the runtime reports it. */
export const AGENT_SESSION_PRESENCE_VALUES = [
  "none",
  "starting",
  "active",
  "hibernating",
  "restarting",
  "failed",
] as const;

export type AgentSessionPresence = (typeof AGENT_SESSION_PRESENCE_VALUES)[number];

/**
 * What the header's presence slot renders: a runtime-reported state, plus the
 * two LOCAL wrappers the client owns — "loading" (nothing known yet) and
 * "error" (the presence read failed). "none" and "error" render no chip at
 * all: a supervised-off runtime is not decorated, and a presence chip never
 * becomes an error surface.
 */
export type SessionPresenceChipState = "loading" | "error" | AgentSessionPresence;

/** D32 presence rides polling (no session WS fanout) — the 5s cadence. */
export const PRESENCE_POLL_MS = 5000;

/**
 * The polling decision: keep the default cadence while the tab is visible,
 * pause entirely while it is hidden (backstopped by react-query's
 * refetchIntervalInBackground: false). Safe without a document (SSR, node).
 */
export function presenceRefetchInterval(
  doc?: { visibilityState?: string } | undefined,
): typeof PRESENCE_POLL_MS | false {
  const visibility = (doc ?? globalThis.document)?.visibilityState;
  return visibility === "hidden" ? false : PRESENCE_POLL_MS;
}

/**
 * The first-time note (issue requirement): the first time an Agent's session
 * goes live in THIS browser session, a one-line muted explainer appears. It
 * dismisses itself after a few seconds (pinned constant) or on the next
 * message, and never animates (nothing to respect under reduced motion).
 */
export const SESSION_NOTE_TEXT =
  "Sessions start on demand when you address an Agent — they hibernate when idle.";

export const SESSION_NOTE_AUTO_DISMISS_MS = 8000;

const SESSION_NOTE_SEEN_KEY = "shera.session-presence.note-seen";

/** window.sessionStorage guarded — SSR and privacy modes have none. */
export function browserSessionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function hasSeenSessionNote(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(SESSION_NOTE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSessionNoteSeen(storage: Storage | undefined): void {
  try {
    storage?.setItem(SESSION_NOTE_SEEN_KEY, "1");
  } catch {
    // Storage unavailable (privacy mode): the note may show again next
    // session — honest and harmless; the note itself is the point.
  }
}

/**
 * The note fires only for a LIVE session, and only the first time. Without
 * storage the "once per browser session" promise cannot be kept — so nothing
 * shows at all (privacy modes and SSR stay note-free rather than nagging).
 */
export function shouldShowFirstTimeNote(
  state: SessionPresenceChipState,
  storage: Storage | undefined,
): boolean {
  if (state !== "starting" && state !== "active") {
    return false;
  }
  if (storage === undefined) {
    return false;
  }
  return !hasSeenSessionNote(storage);
}
