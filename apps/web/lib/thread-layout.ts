import type { ChatMessage, ThreadItem } from "@/lib/fixtures";
import { compareThreadItems } from "@/lib/fixtures";

/**
 * Presentation helpers for the chat thread (UI_DESIGN S3): day separators,
 * jump-to-unread anchoring, and merging locally-sent messages into the seeded
 * thread. Pure functions — the fixture-event ingestion and replay-boundary
 * rules live in lib/fixtures (§6.2); this layer only shapes the timeline.
 */

/** A thread item or a day-separator row inserted between calendar days. */
export type TimelineItem = ThreadItem | { kind: "day_separator"; at: string; label: string };

const DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
});

export function dayLabel(iso: string): string {
  return DAY_FORMATTER.format(new Date(iso));
}

export function timeLabel(iso: string): string {
  return `${TIME_FORMATTER.format(new Date(iso))} UTC`;
}

/** UTC calendar-day key of an ISO timestamp (all fixture/local stamps are Z). */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** S3 scrollback: insert a day separator wherever the calendar day changes. */
export function insertDaySeparators(items: readonly ThreadItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let currentDay: string | null = null;
  for (const item of items) {
    const key = dayKey(item.at);
    if (key !== currentDay) {
      currentDay = key;
      result.push({ kind: "day_separator", at: item.at, label: dayLabel(item.at) });
    }
    result.push(item);
  }
  return result;
}

/**
 * Append locally-sent messages (composer demo state) to the seeded thread and
 * re-apply the single ordering. Local messages are live by definition — they
 * are produced in this browser, never replayed (§6.2).
 */
export function withSentMessages(
  items: readonly ThreadItem[],
  sent: readonly ChatMessage[],
): ThreadItem[] {
  if (sent.length === 0) {
    return [...items];
  }
  const merged: ThreadItem[] = [...items];
  for (const message of sent) {
    merged.push({ kind: "message", at: message.sent_at, message });
  }
  return merged.sort(compareThreadItems);
}

/**
 * The message that anchors "jump to unread": the last `unreadCount` messages
 * of the seeded thread (§S3). Computed from the seeded thread only, so locally
 * sent messages never shift the anchor — unread is a runtime-owned property,
 * not something the demo UI mutates.
 */
export function firstUnreadMessageId(
  items: readonly ThreadItem[],
  unreadCount: number,
): string | null {
  if (unreadCount <= 0) {
    return null;
  }
  const messages = items.filter(
    (item): item is Extract<ThreadItem, { kind: "message" }> => item.kind === "message",
  );
  const first = messages.length - unreadCount;
  const target = first >= 0 ? messages[first] : undefined;
  return target?.message.message_id ?? null;
}

/**
 * The replay handoff (§6.2): after a reconnect completes, the queued missed
 * messages enter the thread as a replayed batch closed by the batch boundary
 * ("N missed events replayed") — never silently interleaved as live. The
 * boundary carries the last replayed timestamp so day separators and ordering
 * stay intact.
 */
export function flushReplayed(
  items: readonly ThreadItem[],
  replayed: readonly ChatMessage[],
): ThreadItem[] {
  if (replayed.length === 0) {
    return [...items];
  }
  const merged: ThreadItem[] = [...items];
  for (const message of replayed) {
    merged.push({ kind: "message", at: message.sent_at, message });
  }
  const lastReplayed = replayed[replayed.length - 1]!;
  merged.push({
    kind: "replay_boundary",
    at: lastReplayed.sent_at,
    count: replayed.length,
  });
  return merged.sort(compareThreadItems);
}
