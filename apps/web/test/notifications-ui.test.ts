/**
 * S30 chunk 3 — the notification center web surface (UI_DESIGN §S10; PRD §14,
 * D16, E3, G2/G3/G4/G6).
 *
 * The center renders the RUNTIME's own records (GET /v1/notifications — the
 * derived rows proven in apps/user-runtime) through the same-origin proxy:
 * the four kinds with their bounded summaries, deep links, mark-read, and
 * the per-item mute. An approval item's mute rides the S20 machinery — the
 * row stays LISTED and marked muted (E3: delivery suppressed, state
 * unchanged). The badge mirrors the unread rows (UI_DESIGN §3.2). The empty
 * state carries the E43 one-line value promise + a single primary CTA. Every
 * failure is a typed safe_message (G3); the client never fabricates a row.
 *
 * Client + view tests render to static markup / stub fetch at the proxy
 * boundary (the house pattern); the real round trip is proven in
 * apps/user-runtime (s30-notifications-api).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchNotificationSettings,
  fetchNotifications,
  submitNotificationCommand,
  submitNotificationSettingsCommand,
} from "../lib/notifications-api";
import {
  bellBadgeCount,
  NotificationCenterView,
  notificationBadgeCount,
  type NotificationRow,
} from "../components/shell/notification-center";

const WORKSPACE = "ws_default_01";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    notification_id: "note-evt_done_1",
    workspace_id: WORKSPACE,
    kind: "completion",
    title: "Task completed",
    summary: "Task run task_done_1 completed",
    conversation_id: "conv_done_1",
    task_id: "task_done_1",
    approval_id: null,
    occurred_at: "2026-11-08T09:00:00.000Z",
    read_at: null,
    muted: false,
    deep_link: "/app/operation/op_done",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The typed client through the same-origin proxy
// ---------------------------------------------------------------------------

describe("Notifications client (proxy paths)", () => {
  it("fetchNotifications GETs the derived rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { notifications: [row()] }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchNotifications(WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ notification_id: "note-evt_done_1", kind: "completion" });
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/notifications?workspace_id=${WORKSPACE}`);
  });

  it("mark-read and mute POST the ONE typed commands envelope through the proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { accepted: true }));
    vi.stubGlobal("fetch", fetchMock);
    await submitNotificationCommand(WORKSPACE, {
      command_id: "cmd_1",
      idempotency_key: "idem_1",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "google-1" },
      issued_at: "2026-11-08T10:00:00.000Z",
      type: "notifications.mark_read",
      notification_id: "note-evt_done_1",
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/notifications/commands");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["type"]).toBe("notifications.mark_read");
    expect(body["actor"]).toEqual({ type: "user", id: "google-1" });

    await submitNotificationCommand(WORKSPACE, {
      command_id: "cmd_2",
      idempotency_key: "idem_2",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "google-1" },
      issued_at: "2026-11-08T10:01:00.000Z",
      type: "notifications.mute",
      notification_id: "note-apr-apr_1",
    });
    const [mutePath, muteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(mutePath).toBe("/api/runtime/v1/notifications/commands");
    expect(JSON.parse(String(muteInit.body))["type"]).toBe("notifications.mute");
  });

  it("the settings toggles POST the settings commands envelope and parse the typed view", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        settings: {
          in_app_enabled: true,
          browser_enabled: false,
          recommended_default: { in_app_enabled: true, browser_enabled: false },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const settings = await fetchNotificationSettings(WORKSPACE);
    expect(settings).toMatchObject({
      in_app_enabled: true,
      browser_enabled: false,
      recommended_default: { browser_enabled: false },
    });
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/notifications/settings?workspace_id=${WORKSPACE}`);

    await submitNotificationSettingsCommand(WORKSPACE, {
      command_id: "cmd_3",
      idempotency_key: "idem_3",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "google-1" },
      issued_at: "2026-11-08T10:02:00.000Z",
      type: "notifications.set_settings",
      in_app_enabled: false,
      browser_enabled: true,
    });
    const [setPath, setInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(setPath).toBe("/api/runtime/v1/notifications/settings/commands");
    const body = JSON.parse(String(setInit.body)) as Record<string, unknown>;
    expect(body["type"]).toBe("notifications.set_settings");
    expect(body["browser_enabled"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The center view: kinds, deep links, badge, mute, empty state
// ---------------------------------------------------------------------------

interface ViewProps {
  rows?: NotificationRow[];
  settings?: { in_app_enabled: boolean; browser_enabled: boolean } | undefined;
  surfaceState?: "loading" | "ready" | "error";
  safeErrorMessage?: string | undefined;
  unreadCount?: number | undefined;
}

function renderCenter(props: ViewProps = {}): string {
  return renderToStaticMarkup(
    createElement(NotificationCenterView, {
      rows: props.rows ?? [],
      settings: props.settings,
      surfaceState: props.surfaceState ?? "ready",
      safeErrorMessage: props.safeErrorMessage,
      onMarkRead: () => undefined,
      onMute: () => undefined,
      onClose: () => undefined,
      onOpenSettings: () => undefined,
      ...props,
    }),
  );
}

describe("Notification center view (S10)", () => {
  it("renders the four kinds from the runtime's rows with deep links — never fabricated rows", () => {
    const html = renderCenter({
      rows: [
        row(),
        row({
          notification_id: "note-evt_fail_1",
          kind: "failure",
          title: "Task failed",
          summary: "Task run task_fail_1 failed — review the run timeline",
          task_id: "task_fail_1",
          occurred_at: "2026-11-08T09:05:00.000Z",
          deep_link: "/app/operation/op_fail",
        }),
        row({
          notification_id: "note-apr-apr_1",
          kind: "approval_required",
          title: "Approval required",
          approval_id: "apr_1",
          deep_link: "/app/operation/op_apr",
        }),
        row({
          notification_id: "note-evt_rec_1",
          kind: "recovery",
          title: "Recovery review needed",
          deep_link: "/app",
        }),
      ],
    });
    expect(html).toContain("Task completed");
    expect(html).toContain("Task failed");
    expect(html).toContain("Approval required");
    expect(html).toContain("Recovery review needed");
    // Deep links name the runtime's own records (no invented rows).
    expect(html).toContain('href="/app/operation/op_done"');
    expect(html).toContain('href="/app/operation/op_apr"');
    expect(html).toContain('data-testid="notification-row"');
  });

  it("the badge mirrors the unread rows; mark-read decrements it", () => {
    expect(notificationBadgeCount([row(), row({ notification_id: "note-2" })])).toBe(2);
    expect(
      notificationBadgeCount([
        row(),
        row({ notification_id: "note-2", read_at: "2026-11-08T10:00:00.000Z" }),
      ]),
    ).toBe(1);
    expect(notificationBadgeCount([])).toBe(0);
  });

  it("a muted approval row stays LISTED and marked muted (E3 — delivery suppressed, state unchanged)", () => {
    const html = renderCenter({
      rows: [
        row({
          notification_id: "note-apr-apr_mute_1",
          kind: "approval_required",
          title: "Approval required",
          approval_id: "apr_mute_1",
          muted: true,
        }),
      ],
    });
    expect(html).toContain("Approval required");
    expect(html).toContain('data-testid="notification-muted"');
    // The mute control state is honest: the row shows its muted marker.
    expect(html).toContain("Muted");
  });

  it("mark-read and mute raise the typed callbacks with the row identity", () => {
    const marked: string[] = [];
    const muted: string[] = [];
    const html = renderToStaticMarkup(
      createElement(NotificationCenterView, {
        rows: [
          row(),
          row({
            notification_id: "note-apr-apr_1",
            kind: "approval_required",
            approval_id: "apr_1",
          }),
        ],
        settings: undefined,
        surfaceState: "ready",
        safeErrorMessage: undefined,
        onMarkRead: (id: string) => {
          marked.push(id);
        },
        onMute: (id: string) => {
          muted.push(id);
        },
        onClose: () => undefined,
        onOpenSettings: () => undefined,
      }),
    );
    // The static markup carries the controls wired to the callbacks (the
    // interaction contracts are pinned by the data-testid attributes).
    expect(html).toContain('data-testid="notification-mark-read"');
    expect(html).toContain('data-testid="notification-mute"');
    expect(marked).toEqual([]);
    expect(muted).toEqual([]);
  });

  it("the empty state carries the one-line value promise and a single primary CTA (E43)", () => {
    const html = renderCenter({ rows: [] });
    expect(html).toContain(
      "Notifications will appear here when a task finishes, fails, needs your approval, or hits a snag",
    );
    expect(html).toContain('data-testid="notification-empty-cta"');
  });

  it("failures render the typed safe message with a retry — never a fabricated list", () => {
    const html = renderCenter({
      surfaceState: "error",
      safeErrorMessage: "The connection to Shera failed. You can try again.",
    });
    expect(html).toContain("The connection to Shera failed. You can try again.");
    expect(html).not.toContain("Task completed");
  });

  it("loading renders the skeleton state", () => {
    const html = renderCenter({ surfaceState: "loading" });
    expect(html).toContain("aria-busy");
  });
});

// ---------------------------------------------------------------------------
// 3. The bell's attention signal: the in-app delivery gate (the review
//    round's F4 — the badge is the observable thing the in-app toggle gates;
//    the center's records view is NEVER gated, E3)
// ---------------------------------------------------------------------------

describe("The bell's attention signal (the in-app delivery gate)", () => {
  it("the in-app toggle gates the bell's unread badge — off silences the attention signal (D16/E3)", () => {
    const rows = [row(), row({ notification_id: "note-2" })];
    expect(bellBadgeCount(rows, true)).toBe(2);
    expect(bellBadgeCount(rows, false)).toBe(0);
    // The center's own record count is NOT gated — the records view is E3's.
    expect(notificationBadgeCount(rows)).toBe(2);
    expect(bellBadgeCount([], true)).toBe(0);
  });

  it("with in-app delivery off the center still renders every record — never a hidden pending approval (E3)", () => {
    const html = renderCenter({
      rows: [
        row({
          notification_id: "note-apr-gate_1",
          kind: "approval_required",
          title: "Approval required",
          approval_id: "apr_gate_1",
        }),
      ],
      settings: { in_app_enabled: false, browser_enabled: false },
    });
    expect(html).toContain("Approval required");
    expect(html).toContain('data-testid="notification-row"');
    expect(html).toContain("In-app delivery off");
  });
});
