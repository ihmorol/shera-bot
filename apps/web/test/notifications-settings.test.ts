/**
 * S30 chunk 4 — the Notifications settings surface (UI_DESIGN §S9
 * "Notifications"; PRD §14, D16, G4/G6) and the S30 settings-overview index.
 *
 * The surface renders the runtime's own settings view: the in-app and
 * browser toggles with their recommended defaults (in-app on, browser off —
 * browser notifications ride an explicit permission), why-it-matters copy,
 * risk notes, reset-to-default (D16's settings contract), and the HONEST
 * permission states: denied never blocks the in-app center, and the browser
 * toggle explains itself.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  currentPermissionState,
  NotificationsSettingsView,
  notifyPermissionChanged,
  subscribePermissionState,
} from "../components/settings/notifications-settings";

const SETTINGS = {
  in_app_enabled: true,
  browser_enabled: false,
  recommended_default: { in_app_enabled: true, browser_enabled: false },
} as const;

function renderView(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(NotificationsSettingsView, {
      settings: SETTINGS,
      surfaceState: "ready",
      safeErrorMessage: undefined,
      permissionState: "granted",
      commandPending: false,
      commandSafeError: undefined,
      savedKey: null,
      pendingReset: false,
      onToggleInApp: () => undefined,
      onToggleBrowser: () => undefined,
      onResetClick: () => undefined,
      onResetConfirm: () => undefined,
      onResetCancel: () => undefined,
      ...props,
    }),
  );
}

describe("Notifications settings view (S9 Notifications, D16)", () => {
  it("renders both toggles with the recommended defaults, why-it-matters, and risk notes", () => {
    const html = renderView();
    expect(html).toContain('data-testid="notifications-in-app-toggle"');
    expect(html).toContain('data-testid="notifications-browser-toggle"');
    expect(html).toContain("In-app notifications");
    expect(html).toContain("Browser notifications");
    expect(html).toContain("Recommended default:");
    // The in-app toggle's default is ON (the browser one OFF — explicit permission).
    expect(html).toContain('aria-pressed="true"');
    // D16: every setting shows why it matters and the risk/cost impact.
    expect(html).toContain("Why this matters");
    expect(html).toContain("unfocused tab only");
  });

  it("the toggles carry the persisted values from the runtime's own settings view", () => {
    const html = renderView({
      settings: { ...SETTINGS, browser_enabled: true },
    });
    expect(html).toContain('data-testid="notifications-browser-toggle"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("a denied permission is an honest state — the in-app center keeps working (PRD §14)", () => {
    const html = renderView({ permissionState: "denied" });
    expect(html).toContain("denied");
    expect(html).toContain("in-app notifications still work");
  });

  it("reset-to-default is armed and confirmed — no destructive command from one click (D16)", () => {
    const html = renderView();
    expect(html).toContain('data-testid="notifications-reset"');
    const armed = renderView({ pendingReset: true });
    expect(armed).toContain("Confirm reset");
    expect(armed).toContain("Cancel");
  });

  it("loading and error render honest states", () => {
    expect(renderView({ surfaceState: "loading" })).toContain("aria-busy");
    const failed = renderView({
      surfaceState: "error",
      safeErrorMessage: "The notification settings could not be loaded.",
    });
    expect(failed).toContain("The notification settings could not be loaded.");
  });

  it("an unsupported browser renders its honest state", () => {
    const html = renderView({ permissionState: "unsupported" });
    expect(html).toContain("does not expose the Notifications API");
    expect(html).toContain("in-app notifications still work");
  });
});

describe("The browser permission store (the mount-time honest read)", () => {
  const globalWithNotification = globalThis as { Notification?: unknown; window?: unknown };

  it("reads the browser's own permission — the truth before any toggle (G4)", () => {
    // The node test env has no window/Notification — stub the browser's own
    // globals the same way the decision-matrix tests stub the API.
    globalWithNotification.window = globalWithNotification;
    globalWithNotification.Notification = { permission: "denied" };
    expect(currentPermissionState()).toBe("denied");
    globalWithNotification.Notification = { permission: "granted" };
    expect(currentPermissionState()).toBe("granted");
    globalWithNotification.Notification = { permission: "default" };
    expect(currentPermissionState()).toBe("default");
    delete globalWithNotification.Notification;
    delete globalWithNotification.window;
  });

  it("a browser without the Notifications API is honestly unsupported", () => {
    delete globalWithNotification.Notification;
    expect(currentPermissionState()).toBe("unsupported");
  });

  it("subscribe notifies subscribers when a decision lands; unsubscribe stops it", () => {
    let calls = 0;
    const unsubscribe = subscribePermissionState(() => {
      calls += 1;
    });
    notifyPermissionChanged();
    expect(calls).toBe(1);
    unsubscribe();
    notifyPermissionChanged();
    expect(calls).toBe(1);
  });
});
