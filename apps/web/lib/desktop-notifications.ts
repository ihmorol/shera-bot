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

// ---------------------------------------------------------------------------
// The delivery HOST's schedule (the review round's F1): the pure tick the
// host's delivery effect runs once per poll cadence, so the sequence
// invariant — "a fresh page load never spams the history" — is pinned by
// tests rather than buried in the effect.
// ---------------------------------------------------------------------------

/** The row fields the delivery schedule reads (the NotificationView subset). */
export interface DeliveryCandidate {
  notification_id: string;
  read_at: string | null;
  muted: boolean;
  title: string;
  summary: string;
}

export interface DeliveryTickInput {
  /**
   * The mount-seen pass state: false until the first READY rows snapshot has
   * been seeded. The host holds this across ticks (a ref written only inside
   * the interval callback — never during render).
   */
  primed: boolean;
  /** The rows read has completed at least once (the poll is not pending). */
  rowsReady: boolean;
  /** The ids already seen — the seen set the host carries across ticks. */
  seenIds: ReadonlySet<string>;
  rows: readonly DeliveryCandidate[];
  permission: NotificationPermission;
  browserEnabled: boolean;
  documentHidden: boolean;
}

export interface DeliveryTickOutput {
  primed: boolean;
  seenIds: Set<string>;
  /** The rows whose browser notification should fire THIS tick. */
  fired: DeliveryCandidate[];
}

/**
 * One delivery tick, PURE:
 *
 *   - MOUNT-SEEN PASS: until the first ready snapshot, nothing fires; the
 *     first ready snapshot seeds EVERY id it carries without deciding — a
 *     background-tab load with the entire unread backlog fires ZERO
 *     notifications (the invariant the code previously claimed but did not
 *     implement);
 *   - ticks while the first snapshot is still loading neither prime nor fire
 *     (a backlog arriving later is still seeded, never burst);
 *   - after the pass, only ARRIVALS (ids not in the seen set) are decided,
 *     each exactly once — a re-render or a re-armed interval never re-fires;
 *   - the per-row decision is browserNotificationDecision: fire only
 *     unfocused + granted + toggle on. A row skipped as focused is seen (the
 *     record was on screen) and never re-fired later.
 */
export function deliveryTick(input: DeliveryTickInput): DeliveryTickOutput {
  const seenIds = new Set(input.seenIds);
  if (!input.primed) {
    if (!input.rowsReady) {
      // The poll has not delivered its first read yet: nothing is seeded and
      // nothing fires — the mount-seen pass has not run.
      return { primed: false, seenIds, fired: [] };
    }
    for (const row of input.rows) {
      seenIds.add(row.notification_id);
    }
    return { primed: true, seenIds, fired: [] };
  }
  const fired: DeliveryCandidate[] = [];
  for (const row of input.rows) {
    if (seenIds.has(row.notification_id)) continue;
    // Arrivals mark themselves seen exactly once: only rows arriving AFTER
    // the mount-seen pass can fire (a fresh page load never spams the
    // history).
    seenIds.add(row.notification_id);
    if (row.read_at !== null || row.muted) continue;
    const decision = browserNotificationDecision({
      permission: input.permission,
      browserEnabled: input.browserEnabled,
      documentHidden: input.documentHidden,
    });
    if (decision.action === "fire") {
      fired.push(row);
    }
  }
  return { primed: true, seenIds, fired };
}
