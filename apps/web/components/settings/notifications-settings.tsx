"use client";

import { AlertTriangle, Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { useNotificationCommands, useNotificationSettings } from "@/lib/notifications-data";
import { useContainerResolution } from "@/lib/container-connection";
import type { NotificationSettings } from "@/lib/notifications-api";

/**
 * The S9 "Notifications" settings surface (S30; PRD §14, D16, G4/G6): the
 * in-app and browser delivery toggles as REAL command targets — every change
 * goes through the notifications settings commands envelope (the same typed
 * surface onboarding never bypasses), the read-after-write snapshot is the
 * truth, and reset-to-default restores the recommended defaults (in-app on,
 * browser off) armed-and-confirmed like every D16 reset.
 *
 * The permission posture is honest (PRD §14): a denied browser permission
 * never blocks the in-app center — the surface says exactly that; the
 * browser toggle requests the permission only when the user turns it ON.
 */

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

/** The current permission, honestly typed (SSR/unknown → "unsupported"). */
export function currentPermissionState(): NotificationPermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission as NotificationPermissionState;
}

/**
 * The permission as a React external store (the workspace-routes idiom): no
 * effect-driven setState on mount, no render-time impurity. The surface
 * reads the browser's own decision through useSyncExternalStore, so the
 * denied banner is true from the FIRST client paint (G4), and the toggle's
 * requestPermission resolution notifies the subscribers — the store, not a
 * stale state copy, is the truth.
 */
const permissionListeners = new Set<() => void>();

export function subscribePermissionState(listener: () => void): () => void {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

export function notifyPermissionChanged(): void {
  for (const listener of permissionListeners) {
    listener();
  }
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-hidden="true" className="space-y-4">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="rounded-xl border border-line bg-surface p-4">
          <div className="h-3 w-40 animate-pulse rounded bg-surface-elevated" />
          <div className="mt-3 h-2.5 w-full animate-pulse rounded bg-surface-elevated" />
        </div>
      ))}
    </div>
  );
}

function ToggleRow({
  testId,
  title,
  enabled,
  onToggle,
  children,
}: {
  testId: string;
  title: string;
  enabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      data-setting-key={testId}
      aria-label={title}
      className="rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">{title}</h3>
        <Button
          variant="outline"
          size="sm"
          data-testid={testId}
          aria-pressed={enabled}
          onClick={onToggle}
        >
          {enabled ? "On" : "Off"}
        </Button>
      </div>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function WhyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-muted">
      <span className="font-medium text-text">Why this matters:</span> {children}
    </p>
  );
}

export interface NotificationsSettingsViewProps {
  settings: NotificationSettings | undefined;
  surfaceState: "loading" | "ready" | "error";
  safeErrorMessage?: string | undefined;
  permissionState: NotificationPermissionState;
  commandPending: boolean;
  commandSafeError?: string | undefined;
  /** The toggle/reset the last settled command affected (the inline "Saved"). */
  savedKey: "in_app" | "browser" | "reset" | null;
  pendingReset: boolean;
  onToggleInApp: () => void;
  onToggleBrowser: () => void;
  onResetClick: () => void;
  onResetConfirm: () => void;
  onResetCancel: () => void;
}

export function NotificationsSettingsView(props: NotificationsSettingsViewProps) {
  const { settings, surfaceState, safeErrorMessage, permissionState } = props;

  if (surfaceState === "loading") {
    return <Skeleton />;
  }
  if (surfaceState === "error" || !settings) {
    return (
      <div role="alert" className="rounded-xl border border-line bg-surface p-6">
        <p className="flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {safeErrorMessage ?? "The notification settings could not be loaded."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {props.commandPending ? (
        <p role="status" className="text-sm text-sky">
          Saving…
        </p>
      ) : null}
      {props.commandSafeError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {props.commandSafeError}
        </p>
      ) : null}

      <ToggleRow
        testId="notifications-in-app-toggle"
        title="In-app notifications"
        enabled={settings.in_app_enabled}
        onToggle={props.onToggleInApp}
      >
        <p className="text-sm text-text">
          Completion, failure, approval-required, and recovery notices, always in the bell panel.
        </p>
        <WhyLine>
          the bell badge and the notification center are built on these records — turning them off
          silences delivery, it never hides a pending approval.
        </WhyLine>
        <p className="text-xs text-muted">
          Recommended default: <span className="font-mono text-sky">on</span>
        </p>
        <SavedBadge visible={props.savedKey === "in_app"} />
      </ToggleRow>

      <ToggleRow
        testId="notifications-browser-toggle"
        title="Browser notifications"
        enabled={settings.browser_enabled}
        onToggle={props.onToggleBrowser}
      >
        <p className="text-sm text-text">
          A desktop notification when the tab is open but unfocused — unfocused tab only, never over
          the tab you are looking at.
        </p>
        {permissionState === "denied" ? (
          <p
            data-testid="notifications-permission-denied"
            className="flex items-start gap-2 text-xs text-approval"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Your browser has denied notification permission for this site — in-app notifications
            still work. Re-allow notifications in the browser&apos;s site settings to use this.
          </p>
        ) : permissionState === "unsupported" ? (
          <p className="text-xs text-muted">
            This browser does not expose the Notifications API — in-app notifications still work.
          </p>
        ) : null}
        <WhyLine>
          long-running tasks finish while you work elsewhere; the notification carries the
          task&apos;s summary line, never message content.
        </WhyLine>
        <p className="text-xs text-muted">
          Recommended default: <span className="font-mono text-sky">off</span> (an explicit
          permission decision)
        </p>
        <SavedBadge visible={props.savedKey === "browser"} />
      </ToggleRow>

      <section
        aria-label="Reset notification settings"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
              Reset to defaults
            </h3>
            <p className="mt-1 text-xs text-muted">
              Restores the recommended defaults: in-app on, browser off.
            </p>
          </div>
          {props.pendingReset ? (
            <span className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={props.onResetConfirm}>
                Confirm reset
              </Button>
              <Button variant="ghost" size="sm" onClick={props.onResetCancel}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              data-testid="notifications-reset"
              onClick={props.onResetClick}
            >
              <RotateCcw aria-hidden="true" />
              Reset to default
            </Button>
          )}
        </div>
        <SavedBadge visible={props.savedKey === "reset"} />
      </section>
    </div>
  );
}

function SavedBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span role="status" className="mt-2 flex items-center gap-1 text-xs text-live">
      <Check className="size-3.5" aria-hidden="true" />
      Saved
    </span>
  );
}

// ---------------------------------------------------------------------------
// Live wiring
// ---------------------------------------------------------------------------

/** The honest configuration state: the settings read needs the container. */
function ContainerUnavailableState() {
  return (
    <div
      role="status"
      className="mx-auto my-8 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center"
    >
      <p className="text-sm text-text">
        Notification settings live in your workspace&apos;s runtime. Start your workspace and come
        back.
      </p>
    </div>
  );
}

type SavedKey = "in_app" | "browser" | "reset" | null;

export function NotificationsSettingsSurface() {
  const resolution = useContainerResolution();
  const workspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;
  const settings = useNotificationSettings(workspaceId);
  const commands = useNotificationCommands(workspaceId);
  // The browser's own permission, read through the external store — the
  // denied banner is true before any toggle, never a stale state copy. The
  // server snapshot is the honest not-known-yet state; hydration corrects it
  // in the same commit (no mismatch, no effect cascade).
  const permissionState = useSyncExternalStore(
    subscribePermissionState,
    currentPermissionState,
    () => "unsupported" as NotificationPermissionState,
  );
  const [savedKey, setSavedKey] = useState<SavedKey>(null);
  const [pendingReset, setPendingReset] = useState(false);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const confirmSaved = (key: SavedKey) => {
    setSavedKey(key);
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      setSavedKey(null);
    }, 2500);
  };

  if (!workspaceId) {
    return <ContainerUnavailableState />;
  }

  const command = (body: Record<string, unknown>, key: SavedKey) => {
    commands.submit({
      command_id: `cmd_${crypto.randomUUID()}`,
      idempotency_key: `idem_${crypto.randomUUID()}`,
      workspace_id: workspaceId,
      actor: { type: "user", id: "" },
      issued_at: new Date().toISOString(),
      ...body,
    } as Parameters<typeof commands.submit>[0]);
    confirmSaved(key);
  };

  const toggleBrowser = () => {
    const nextEnabled = !(settings.settings?.browser_enabled ?? false);
    if (nextEnabled && currentPermissionState() === "default") {
      // The explicit permission decision rides the toggle (PRD §14); the
      // typed command records the workspace choice either way. The decision
      // notifies the permission store — the banner follows the truth.
      void Notification.requestPermission().then(() => notifyPermissionChanged());
    }
    command(
      {
        type: "notifications.set_settings",
        in_app_enabled: settings.settings?.in_app_enabled ?? true,
        browser_enabled: nextEnabled,
      },
      "browser",
    );
  };

  return (
    <div className="mx-auto max-w-xl">
      <NotificationsSettingsView
        settings={settings.settings}
        surfaceState={settings.state}
        safeErrorMessage={settings.safeErrorMessage}
        permissionState={permissionState}
        commandPending={commands.pending}
        commandSafeError={commands.safeError}
        savedKey={savedKey}
        pendingReset={pendingReset}
        onToggleInApp={() =>
          command(
            {
              type: "notifications.set_settings",
              in_app_enabled: !(settings.settings?.in_app_enabled ?? true),
              browser_enabled: settings.settings?.browser_enabled ?? false,
            },
            "in_app",
          )
        }
        onToggleBrowser={toggleBrowser}
        onResetClick={() => setPendingReset(true)}
        onResetConfirm={() => {
          setPendingReset(false);
          command({ type: "notifications.reset_settings" }, "reset");
        }}
        onResetCancel={() => setPendingReset(false)}
      />
    </div>
  );
}
