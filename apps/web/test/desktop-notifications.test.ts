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
  fireBrowserNotification,
  type BrowserNotificationInput,
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
