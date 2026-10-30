/**
 * The schedule clock (S28 chunk 2; PRD §8, E5, D11) — the pure UTC schedule
 * math over the adopted cron-parser (MIT, exact-pinned 5.10.2; recorded in
 * E37). The established semantics win over a hand-rolled variant (the
 * open-source leverage rule): standard 5-field cron expressions, the
 * half-open (from, to] window for missed occurrences, and a BOUNDED
 * enumeration so a catch-up replay can never be unbounded.
 *
 * Everything runs pinned to UTC (the prototype's schedule vocabulary is UTC;
 * recorded in E37) so the occurrence math is deterministic regardless of the
 * host timezone. The clock is pure: it never reads a wall clock on its own —
 * the caller supplies the instants (the injected-clock discipline every S28
 * test and the E27 reminders precedent keep).
 */
import { CronExpressionParser } from "cron-parser";

export type ScheduleValidation =
  | { ok: true }
  | { ok: false; code: "SCHEDULE_CRON_INVALID"; safe_message: string };

/** The catch-up replay bound: at most this many missed occurrences are
 * re-fired by one catch-up decision (E37); the remainder is recorded as
 * skipped in the same decision. */
export const CATCH_UP_MAX_OCCURRENCES = 50;

export function validateCronExpression(expression: string): ScheduleValidation {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return {
      ok: false,
      code: "SCHEDULE_CRON_INVALID",
      safe_message: "The schedule expression is empty. Use a 5-field cron expression.",
    };
  }
  try {
    CronExpressionParser.parse(expression, { tz: "UTC" });
    return { ok: true };
  } catch {
    return {
      ok: false,
      code: "SCHEDULE_CRON_INVALID",
      safe_message:
        "The schedule expression is not a valid 5-field cron expression (minute hour day month weekday).",
    };
  }
}

/** The next occurrence strictly AFTER `after` (UTC), or null for an invalid
 * expression (the service validates before this ever runs). */
export function nextOccurrence(expression: string, after: Date): Date | null {
  try {
    const parsed = CronExpressionParser.parse(expression, {
      currentDate: after,
      tz: "UTC",
    });
    return parsed.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Missed occurrences in the half-open (from, to] window, bounded at `limit`.
 * An invalid expression yields an empty list (the service never passes one).
 */
export function missedOccurrences(
  expression: string,
  from: Date,
  to: Date,
  limit: number,
): Date[] {
  const occurrences: Date[] = [];
  if (to.getTime() <= from.getTime()) {
    return occurrences;
  }
  try {
    const parsed = CronExpressionParser.parse(expression, {
      currentDate: from,
      tz: "UTC",
    });
    while (occurrences.length < limit) {
      const next = parsed.next().toDate();
      if (next.getTime() > to.getTime()) {
        break;
      }
      occurrences.push(next);
    }
    return occurrences;
  } catch {
    return occurrences;
  }
}

/** The composed clock (the only instance the runtime needs). */
export const scheduleClock = {
  validate: validateCronExpression,
  nextOccurrence,
  missedOccurrences,
};
