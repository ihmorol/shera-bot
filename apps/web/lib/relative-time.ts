"use client";

import { useSyncExternalStore } from "react";

/**
 * Relative chat timestamps (wave A chunk A1, D52; E43 §5 recipe, patterns
 * not pixels): "just now" under 45 seconds, whole minutes, whole hours,
 * "yesterday" inside two days, day counts under a week — relative only
 * while the stamp is <7 days old, then a short date. Labels are lowercase
 * (the sidebar copy voice) and the numerals render with `tabular-nums`
 * where the timestamp is placed.
 *
 * A stamp the record does not actually carry (0/NaN — e.g. a null
 * `last_activity` mapped to a zeroed sort key) renders nothing: a date
 * render never claims precision the record lacks (G4).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Below this elapsed time the row still reads "just now". */
const JUST_NOW_MS = 45_000;
/** Relative rendering window; beyond it the row shows a short date. */
const RELATIVE_WINDOW_MS = 7 * DAY_MS;
/** The label refresh cadence (E43 §2: tick while the tab is visible). */
const REFRESH_INTERVAL_MS = 30_000;

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const SHORT_DATE_WITH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * The sidebar row timestamp label for a recorded stamp (`atMs`, epoch ms)
 * against `nowMs`. Returns null when either stamp is absent or unusable —
 * the caller renders no timestamp rather than a wrong one. A zeroed `nowMs`
 * (the pre-mount clock state) renders nothing for the same reason.
 */
export function formatChatTimestamp(atMs: number, nowMs: number): string | null {
  if (!Number.isFinite(atMs) || atMs <= 0 || !Number.isFinite(nowMs) || nowMs <= 0) return null;
  const elapsed = Math.max(0, nowMs - atMs);
  if (elapsed < JUST_NOW_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  if (elapsed < 2 * DAY_MS) return "yesterday";
  if (elapsed < RELATIVE_WINDOW_MS) return `${Math.floor(elapsed / DAY_MS)} d ago`;
  const at = new Date(atMs);
  const sameYear = at.getFullYear() === new Date(nowMs).getFullYear();
  return (sameYear ? SHORT_DATE : SHORT_DATE_WITH_YEAR).format(at);
}

/**
 * The render clock for relative labels — a module-level external store read
 * through useSyncExternalStore (the same discipline as lib/interface-mode.ts:
 * one module-lifetime subscription surface, no per-mount timers):
 *
 * - 0 until the clock store starts (first subscribe, i.e. first mount), so
 *   server and first client renders agree — no hydration mismatch, and a
 *   static render never claims clock precision it cannot have.
 * - Refreshed every 30s (E43 §2's relative-now cadence). A zero clock makes
 *   the label render nothing instead of guessing (G4).
 */
let clockNow = 0;
const clockListeners = new Set<() => void>();
let clockInterval: ReturnType<typeof setInterval> | undefined;

function startClock(): void {
  if (clockInterval !== undefined) return;
  clockNow = Date.now();
  clockInterval = setInterval(() => {
    clockNow = Date.now();
    for (const listener of clockListeners) listener();
  }, REFRESH_INTERVAL_MS);
}

function subscribeClock(listener: () => void): () => void {
  startClock();
  clockListeners.add(listener);
  return () => {
    clockListeners.delete(listener);
    // The interval keeps running for the page's lifetime — the module lives
    // as long as the document, matching the interface-mode listener rule.
  };
}

export function useRelativeNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    // Server/static snapshot: no clock yet — timestamps mount with the app.
    () => 0,
  );
}
