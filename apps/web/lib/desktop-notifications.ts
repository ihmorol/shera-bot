/**
 * S30 — the browser-notification decision (PRD §14; the E15 embed: the Web
 * Notifications API) as PURE logic, so the recorded delivery rules are
 * pinned by tests rather than buried in an effect:
 *
 *   - a notification fires ONLY when the tab is open but UNFOCUSED
 *     (document.hidden), permission is granted, and the workspace toggle is
 *     on — the focused case produces NO notification (the record is already
 *     on screen);
 *   - permission "denied" is an honest state, not an error: the in-app
 *     center keeps working, and the surface explains itself;
 *   - disabling the toggle stops the notifications.
 *
 * G3: the caller passes ONLY the runtime's bounded derived summary as the
 * body — never message content, never secret-shaped material.
 */

export interface BrowserNotificationInput {
  permission: NotificationPermission;
  /** The workspace toggle (PRD §14; default off — an explicit decision). */
  browserEnabled: boolean;
  /** The tab is open but unfocused (document.hidden). */
  documentHidden: boolean;
}

export type BrowserNotificationDecision =
  | { action: "fire" }
  | {
      action: "skip";
      reason: "tab_focused" | "permission_denied" | "permission_default" | "browser_disabled";
    };

export function browserNotificationDecision(
  input: BrowserNotificationInput,
): BrowserNotificationDecision {
  if (!input.documentHidden) {
    return { action: "skip", reason: "tab_focused" };
  }
  if (input.permission === "denied") {
    return { action: "skip", reason: "permission_denied" };
  }
  if (input.permission === "default") {
    return { action: "skip", reason: "permission_default" };
  }
  if (!input.browserEnabled) {
    return { action: "skip", reason: "browser_disabled" };
  }
  return { action: "fire" };
}

export interface BrowserNotificationContent {
  title: string;
  /** The runtime's bounded derived summary — never message content (G3). */
  body: string;
}

/** The one place a browser Notification is constructed. */
export function fireBrowserNotification(content: BrowserNotificationContent): void {
  new Notification(content.title, { body: content.body });
}
