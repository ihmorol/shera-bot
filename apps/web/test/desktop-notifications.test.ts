/**
 * S30 chunk 4 — the browser-notification decision (UI_DESIGN §S10; PRD §14,
 * E15 embed: the Web Notifications API) and the BroadcastChannel tab-sync
 * layer (E15 embed), LAYERED UNDER the S07 server-cursor replay.
 *
 * The recorded delivery rules, pinned here:
 *   - a browser notification fires ONLY when the tab is open but UNFOCUSED
 *     (document.hidden) AND permission is granted AND the workspace toggle
 *     is on — the FOCUSED case produces NO notification (the issue's AC);
 *   - permission denied is an honest state: the in-app center still works;
 *   - disabling the toggle stops the notifications;
 *   - the Notification body carries ONLY the runtime's bounded derived
 *     summary — never message content, never secret-shaped material (G3).
 *
 * The BroadcastChannel layer is a CLIENT CONVENIENCE: it carries
 * invalidation HINTS only — never conversation history, never approval
 * content (a second tab replays through the S07 server cursor, PRD §14; the
 * server cursor stays authoritative).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserNotificationDecision,
  deliveryTick,
  fireBrowserNotification,
  type BrowserNotificationInput,
  type DeliveryTickInput,
} from "../lib/desktop-notifications";
import {
  TAB_SYNC_EVENT,
  parseTabSyncEvent,
  tabSyncEventBody,
  type TabSyncEvent,
} from "../lib/tab-sync";

function decisionInput(
  overrides: Partial<BrowserNotificationInput> = {},
): BrowserNotificationInput {
  return {
    permission: "granted",
    browserEnabled: true,
    documentHidden: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Browser notification decision (PRD §14)", () => {
  it("the FOCUSED case produces NO notification — the tab is already showing the record", () => {
    const decision = browserNotificationDecision(decisionInput({ documentHidden: false }));
    expect(decision).toEqual({ action: "skip", reason: "tab_focused" });
  });

  it("fires only when the tab is unfocused AND permission granted AND the toggle is on", () => {
    expect(browserNotificationDecision(decisionInput())).toEqual({ action: "fire" });
  });

  it("permission denied never fires — the honest state the in-app center survives", () => {
    expect(browserNotificationDecision(decisionInput({ permission: "denied" }))).toEqual({
      action: "skip",
      reason: "permission_denied",
    });
    expect(browserNotificationDecision(decisionInput({ permission: "default" }))).toEqual({
      action: "skip",
      reason: "permission_default",
    });
  });

  it("disabling the toggle stops the notifications", () => {
    expect(browserNotificationDecision(decisionInput({ browserEnabled: false }))).toEqual({
      action: "skip",
      reason: "browser_disabled",
    });
  });
});

describe("fireBrowserNotification (G3 redaction posture)", () => {
  it("constructs the Notification with the runtime's bounded summary as the body", () => {
    const constructed: Array<{ title: string; options: unknown }> = [];
    class FakeNotification {
      constructor(title: string, options?: unknown) {
        constructed.push({ title, options });
      }
      static permission = "granted";
      static requestPermission = vi.fn();
    }
    vi.stubGlobal("Notification", FakeNotification);
    fireBrowserNotification({
      title: "Task failed",
      body: "Task run task_fail_1 failed — review the run timeline",
    });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({
      title: "Task failed",
      options: { body: "Task run task_fail_1 failed — review the run timeline" },
    });
  });
});

/**
 * The delivery HOST's schedule, extracted as the pure tick the host's
 * delivery effect runs once per poll cadence (the decision matrix above
 * stays the per-row rules; this pins the SEQUENCE invariant the review
 * round's F1 found broken):
 *
 *   - MOUNT-SEEN PASS: the first ready rows snapshot is seeded into the
 *     seen set WITHOUT deciding — a fresh page load (even a BACKGROUND tab
 *     holding the whole unread history) never fires the backlog, however
 *     large;
 *   - ticks before the first ready snapshot neither prime nor fire (a
 *     late-arriving backlog still cannot burst);
 *   - after the pass only ARRIVALS are decided, each exactly once — a
 *     re-render or a re-armed interval never re-fires (the AC5 host pin).
 */
describe("The host's delivery schedule (the mount-seen invariant)", () => {
  function candidate(
    notification_id: string,
    overrides: Partial<DeliveryTickInput["rows"][number]> = {},
  ): DeliveryTickInput["rows"][number] {
    return {
      notification_id,
      read_at: null,
      muted: false,
      title: `Task ${notification_id}`,
      summary: `Task run ${notification_id} completed`,
      ...overrides,
    };
  }

  function tickInput(overrides: Partial<DeliveryTickInput> = {}): DeliveryTickInput {
    return {
      primed: false,
      rowsReady: true,
      seenIds: new Set<string>(),
      rows: [],
      permission: "granted",
      browserEnabled: true,
      documentHidden: true,
      ...overrides,
    };
  }

  it("a hidden-tab load's first ready snapshot is the MOUNT-SEEN pass: the whole unread backlog fires ZERO", () => {
    const result = deliveryTick(
      tickInput({
        rows: [candidate("note_backlog_1"), candidate("note_backlog_2"), candidate("note_apr_1")],
      }),
    );
    expect(result.fired).toEqual([]);
    expect(result.primed).toBe(true);
    expect([...result.seenIds].sort()).toEqual(["note_apr_1", "note_backlog_1", "note_backlog_2"]);
  });

  it("ticks before the first ready snapshot neither prime nor fire — a late-arriving backlog still cannot burst", () => {
    const result = deliveryTick(
      tickInput({ rowsReady: false, rows: [candidate("note_backlog_1")] }),
    );
    expect(result.fired).toEqual([]);
    expect(result.primed).toBe(false);
  });

  it("after the mount-seen pass a genuinely NEW row fires exactly ONE — and a re-render/re-armed tick never re-fires it", () => {
    // The mount pass consumes the pre-existing row silently.
    const primed = deliveryTick(tickInput({ rows: [candidate("note_backlog_1")] }));
    expect(primed.fired).toEqual([]);

    // A genuine arrival: exactly one notification.
    const arrival = deliveryTick(
      tickInput({
        primed: primed.primed,
        seenIds: primed.seenIds,
        rows: [candidate("note_backlog_1"), candidate("note_new_1")],
      }),
    );
    expect(arrival.fired.map((fired) => fired.notification_id)).toEqual(["note_new_1"]);

    // The same rows again (a re-render re-arms the interval on the rows
    // identity): nothing re-fires.
    const rerender = deliveryTick(
      tickInput({
        primed: arrival.primed,
        seenIds: arrival.seenIds,
        rows: [candidate("note_backlog_1"), candidate("note_new_1")],
      }),
    );
    expect(rerender.fired).toEqual([]);
  });

  it("an arrival while FOCUSED never fires — and is not re-fired when the tab later hides (the record was on screen)", () => {
    const primed = deliveryTick(tickInput({ rows: [] }));
    const focusedArrival = deliveryTick(
      tickInput({
        primed: primed.primed,
        seenIds: primed.seenIds,
        documentHidden: false,
        rows: [candidate("note_seen_focused")],
      }),
    );
    expect(focusedArrival.fired).toEqual([]);
    const laterHidden = deliveryTick(
      tickInput({
        primed: focusedArrival.primed,
        seenIds: focusedArrival.seenIds,
        rows: [candidate("note_seen_focused")],
      }),
    );
    expect(laterHidden.fired).toEqual([]);
  });

  it("muted and already-read arrivals never fire (E3: delivery suppressed, the record still lands)", () => {
    const primed = deliveryTick(tickInput({ rows: [] }));
    const result = deliveryTick(
      tickInput({
        primed: primed.primed,
        seenIds: primed.seenIds,
        rows: [
          candidate("note_muted_1", { muted: true }),
          candidate("note_read_1", { read_at: "2026-11-09T09:00:00.000Z" }),
        ],
      }),
    );
    expect(result.fired).toEqual([]);
  });
});

describe("TabSync events (the hint layer under the server cursor)", () => {
  it("the events are invalidation hints with a closed vocabulary — never record content", () => {
    const event: TabSyncEvent = { kind: "notifications-changed" };
    expect(tabSyncEventBody(event)).toBe(JSON.stringify(event));
    expect(parseTabSyncEvent(tabSyncEventBody(event))).toEqual(event);

    const settings: TabSyncEvent = { kind: "settings-changed", section: "notifications" };
    expect(parseTabSyncEvent(tabSyncEventBody(settings))).toEqual(settings);

    // No conversation history rides this channel: the payload vocabulary has
    // no text/message/event-body field at all.
    const vocabulary = JSON.stringify(
      parseTabSyncEvent(tabSyncEventBody({ kind: "approvals-changed" })),
    );
    expect(vocabulary).not.toMatch(/text|message|body|summary/);
  });

  it("a foreign payload is refused — the channel carries only this slice's hints", () => {
    expect(
      parseTabSyncEvent(JSON.stringify({ kind: "conversation-history", messages: [] })),
    ).toBeNull();
    expect(parseTabSyncEvent("not json")).toBeNull();
    expect(TAB_SYNC_EVENT).toContain("notifications-changed");
    expect(TAB_SYNC_EVENT).toContain("approvals-changed");
    expect(TAB_SYNC_EVENT).toContain("settings-changed");
  });
});
