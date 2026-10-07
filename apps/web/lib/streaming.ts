/**
 * Streaming render math (UI_DESIGN §6.1): `message_delta` tokens render
 * incrementally with a typing cursor, and DOM updates are throttled to the
 * ≥30fps budget. Pure functions only — the scripted stream supplies chunks
 * on its fixture cadence; the demo hook flushes state on one interval at
 * STREAM_THROTTLE_MS, so the DOM never updates faster than the budget
 * regardless of how fast chunks conceptually arrive.
 */

/** DOM update budget: ~30 updates/second (§6.1 "≥30fps budget"). */
export const STREAM_THROTTLE_MS = 33;

/**
 * Screen-reader announcement throttle (§2.3: aria-live="polite" with
 * throttled announcement) — the polite region snapshots less often than the
 * visible text mutates.
 */
export const STREAM_ANNOUNCE_MS = 600;

export interface StreamFrame {
  /** Chunks conceptually delivered by the fixture cadence. */
  deliveredChunks: number;
  /** Text the DOM should currently show (throttled). */
  visibleText: string;
  /** DOM updates the throttle allows up to elapsedMs (≤ 30fps budget). */
  domUpdates: number;
  /** Throttled polite-announcement snapshot (lags the visible text). */
  announcementText: string;
  done: boolean;
}

export function streamFrameAt(
  chunks: readonly string[],
  elapsedMs: number,
  cadenceMs: number,
): StreamFrame {
  const totalMs = chunks.length * cadenceMs;
  const clockMs = Math.max(0, elapsedMs);
  const deliveredChunks = Math.min(chunks.length, Math.floor(clockMs / cadenceMs));
  const isDone = clockMs >= totalMs;

  const visibleText = chunks.slice(0, deliveredChunks).join("");
  const domUpdates = Math.floor(Math.min(clockMs, totalMs) / STREAM_THROTTLE_MS);

  // The announcement snapshot advances on its own (slower) cadence and snaps
  // to the full text once the stream is done.
  const announceMs =
    Math.floor(Math.min(clockMs, totalMs) / STREAM_ANNOUNCE_MS) * STREAM_ANNOUNCE_MS;
  const announceChunks = isDone
    ? chunks.length
    : Math.min(chunks.length, Math.floor(announceMs / cadenceMs));
  const announcementText = chunks.slice(0, announceChunks).join("");

  return {
    deliveredChunks,
    visibleText,
    domUpdates,
    announcementText,
    done: isDone,
  };
}
