"use client";

import {
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ExternalLink,
  LifeBuoy,
  Settings2,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  useNotificationCommands,
  useNotifications,
  useNotificationSettings,
  useTabSyncNotifications,
} from "@/lib/notifications-data";
import { useSessionIdentity } from "@/lib/container-connection";
import { routes } from "@/lib/routes";
import { useRouter } from "next/navigation";
import { deliveryTick, fireBrowserNotification } from "@/lib/desktop-notifications";
import type { NotificationView } from "@shera-bot/contracts";
import { cn } from "@/lib/utils";

/**
 * The notification center (S30; UI_DESIGN §S10, PRD §14, D16, E3, E43).
 *
 * The bell lives in the global chrome row (§3.2: bell | gear) and opens the
 * center as a slide-over panel that overlays any route. Everything rendered
 * here is the RUNTIME's own derived record (GET /v1/notifications — the AC9
 * posture): the four kinds with their bounded summaries, deep links to the
 * conversation/run, mark-read, and the per-item mute. A muted row STAYS
 * LISTED (E3: muting affects delivery only — it never hides or resolves
 * anything; an approval item's mute creates the S20 approval-scope mute).
 *
 * The badge mirrors the unread rows (§3.2: badge counts mirror the sidebar
 * states). The empty state carries the E43 pattern: a one-line value promise
 * naming what will appear, from the runtime's own records, plus a single
 * primary CTA. Every state is real: loading skeleton, typed error with
 * retry, empty — no fabricated rows, ever (G4).
 */

export type NotificationRow = NotificationView;

/** The bell badge: the unread rows' count (mirrors the sidebar states). */
export function notificationBadgeCount(rows: readonly NotificationRow[]): number {
  return rows.filter((row) => row.read_at === null).length;
}

/**
 * The bell's ATTENTION signal (§3.2), gated by the in-app delivery toggle
 * (D16; the review round's F4): with in-app notifications explicitly off the
 * badge and the unread label stay silent — the center itself keeps every
 * record listed (E3: a pending approval is never hidden, only its attention
 * signal is). Before the settings read lands the recommended default (on)
 * stands, so the badge does not blink off during load.
 */
export function bellBadgeCount(rows: readonly NotificationRow[], inAppEnabled: boolean): number {
  return inAppEnabled ? notificationBadgeCount(rows) : 0;
}

/** One kind's glyph + accessible label (color is never the only signal). */
function KindGlyph({ kind }: { kind: NotificationRow["kind"] }) {
  switch (kind) {
    case "completion":
      return (
        <>
          <CheckCircle2 className="size-4 shrink-0 text-live" aria-hidden="true" />
          <span className="sr-only">completed</span>
        </>
      );
    case "failure":
      return (
        <>
          <XCircle className="size-4 shrink-0 text-failed" aria-hidden="true" />
          <span className="sr-only">failed</span>
        </>
      );
    case "approval_required":
      return (
        <>
          <AlertTriangle className="size-4 shrink-0 text-approval" aria-hidden="true" />
          <span className="sr-only">needs your approval</span>
        </>
      );
    case "recovery":
      return (
        <>
          <LifeBuoy className="size-4 shrink-0 text-sky" aria-hidden="true" />
          <span className="sr-only">needs recovery review</span>
        </>
      );
  }
}

/**
 * The record's own UTC timestamp, formatted for display — the schedules
 * surface's precedent: the truthful value from the runtime's record, no
 * local math, no render-time impure call.
 */
function utcStamp(occurredAt: string): string {
  const occurred = new Date(occurredAt);
  if (Number.isNaN(occurred.getTime())) return occurredAt;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${occurred.getUTCDate()} ${
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      occurred.getUTCMonth()
    ]
  } ${occurred.getUTCFullYear()}, ${pad(occurred.getUTCHours())}:${pad(occurred.getUTCMinutes())} UTC`;
}

function RowSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3 p-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="rounded-xl border border-line bg-surface p-3">
          <div className="h-3 w-40 animate-pulse rounded bg-surface-elevated" />
          <div className="mt-2 h-2.5 w-full animate-pulse rounded bg-surface-elevated" />
        </div>
      ))}
    </div>
  );
}

export interface NotificationCenterViewProps {
  rows: readonly NotificationRow[];
  settings: { in_app_enabled: boolean; browser_enabled: boolean } | undefined;
  surfaceState: "loading" | "ready" | "error";
  safeErrorMessage?: string | undefined;
  onMarkRead: (notificationId: string) => void;
  onMute: (notificationId: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}

/**
 * The center panel (presentational). The row's primary affordance is the
 * deep link (mark-read rides the navigation); the mute button is a separate,
 * explicit control. An already-muted row shows its Muted marker and no mute
 * button (E3: write-once, no un-mute — the S20 posture).
 */
export function NotificationCenterView(props: NotificationCenterViewProps) {
  const { rows, settings, surfaceState, safeErrorMessage } = props;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="notification-center">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-display font-semibold tracking-tight text-text">
            Notifications
          </h2>
          <p className="text-xs text-muted">
            Task results, approvals, and recovery — from your workspace&apos;s own records.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={props.onOpenSettings} className="shrink-0">
          <Settings2 className="size-4" aria-hidden="true" />
          Settings
        </Button>
      </div>

      {settings ? (
        <p
          className="border-b border-line px-4 py-2 text-xs text-muted"
          data-testid="notification-delivery-line"
        >
          In-app delivery {settings.in_app_enabled ? "on" : "off"} · browser notifications{" "}
          {settings.browser_enabled ? "on" : "off"} (unfocused tab only)
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {surfaceState === "loading" ? (
          <div aria-busy="true">
            <RowSkeleton />
          </div>
        ) : surfaceState === "error" ? (
          <div role="alert" className="p-4">
            <p className="flex items-start gap-2 text-sm text-failed">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {safeErrorMessage ?? "The notifications could not be loaded."}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <Bell className="size-8 text-muted" aria-hidden="true" />
            <p className="max-w-xs text-sm text-text">
              Notifications will appear here when a task finishes, fails, needs your approval, or
              hits a snag — each with a direct link to the conversation.
            </p>
            <Button asChild data-testid="notification-empty-cta">
              <Link href={routes.app()} onClick={props.onClose}>
                Pick an Agent to start
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li
                key={row.notification_id}
                data-testid="notification-row"
                className={cn(
                  "group relative px-4 py-3 transition-colors hover:bg-surface-elevated",
                  row.read_at === null ? "bg-surface" : "bg-canvas",
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5">
                    <KindGlyph kind={row.kind} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p
                        className={cn(
                          "truncate text-sm",
                          row.read_at === null ? "font-medium text-text" : "text-muted",
                        )}
                      >
                        {row.title}
                      </p>
                      {row.read_at === null ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-sky"
                          aria-hidden="true"
                          title="Unread"
                        />
                      ) : null}
                      {row.muted ? (
                        <span
                          data-testid="notification-muted"
                          className="flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted"
                        >
                          <BellOff className="size-3" aria-hidden="true" />
                          Muted
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted">{row.summary}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <Link
                        href={row.deep_link}
                        onClick={() => props.onMarkRead(row.notification_id)}
                        className="inline-flex items-center gap-1 text-xs text-sky underline-offset-4 hover:underline"
                      >
                        <ExternalLink className="size-3" aria-hidden="true" />
                        Open conversation
                      </Link>
                      <time dateTime={row.occurred_at} className="font-mono text-[11px] text-muted">
                        {utcStamp(row.occurred_at)}
                      </time>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {row.read_at === null ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid="notification-mark-read"
                        aria-label="Mark read"
                        onClick={() => props.onMarkRead(row.notification_id)}
                      >
                        <Check className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                    {!row.muted ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid="notification-mute"
                        aria-label="Mute this notification"
                        onClick={() => props.onMute(row.notification_id)}
                      >
                        <BellOff className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live wiring: the bell, the sheet host, the queries and the mutations
// ---------------------------------------------------------------------------

function BellBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="notification-badge"
      className="absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-approval px-1 font-mono text-[10px] leading-4 text-canvas"
      aria-hidden="true"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/** The chrome-row bell (desktop sidebar + mobile header): badge + the panel host. */
export function NotificationBell({
  workspaceId,
  onNavigate,
  className,
}: {
  workspaceId: string | null;
  onNavigate: (() => void) | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <BellButton workspaceId={workspaceId} className={className} onOpen={() => setOpen(true)} />
      <NotificationCenterHost
        workspaceId={workspaceId}
        open={open}
        onOpenChange={setOpen}
        onNavigate={onNavigate}
      />
    </>
  );
}

/** The live badge: the gated attention signal of the runtime's derived rows. */
function NotificationBadge({
  workspaceId,
  inAppEnabled,
}: {
  workspaceId: string | null;
  inAppEnabled: boolean;
}) {
  const query = useNotifications(workspaceId);
  const count = bellBadgeCount(query.rows, inAppEnabled);
  if (!workspaceId || count === 0) return null;
  return <BellBadge count={count} />;
}

/**
 * The bell with its §2.3 honest label: the visual badge is decorative, so
 * the accessible name carries the unread count (color/position is never the
 * only signal) — gated by the in-app toggle like the badge itself.
 */
function BellButton({
  workspaceId,
  className,
  onOpen,
}: {
  workspaceId: string | null;
  className?: string | undefined;
  onOpen: () => void;
}) {
  const query = useNotifications(workspaceId);
  const settings = useNotificationSettings(workspaceId);
  const inAppEnabled = settings.settings?.in_app_enabled ?? true;
  const unread = workspaceId ? bellBadgeCount(query.rows, inAppEnabled) : 0;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("relative", className)}
      aria-label={unread > 0 ? `Open notifications, ${unread} unread` : "Open notifications"}
      onClick={onOpen}
    >
      <Bell className="size-4" aria-hidden="true" />
      <NotificationBadge workspaceId={workspaceId} inAppEnabled={inAppEnabled} />
    </Button>
  );
}

function NotificationCenterHost({
  workspaceId,
  open,
  onOpenChange,
  onNavigate,
}: {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (() => void) | undefined;
}) {
  const query = useNotifications(workspaceId);
  const settings = useNotificationSettings(workspaceId);
  const commands = useNotificationCommands(workspaceId);
  const session = useSessionIdentity();
  const router = useRouter();
  useTabSyncNotifications(workspaceId);

  const actorId = session.data?.google_sub ?? "";

  // The browser-notification delivery (PRD §14; E15 embed). The 5s poll is
  // the arrival mechanism; the decision logic (desktop-notifications) fires
  // ONLY when the tab is open but unfocused, permission granted, and the
  // toggle on — the focused case produces NO notification. The schedule is
  // the PURE deliveryTick: the first ready rows snapshot is the MOUNT-SEEN
  // pass (seeded without deciding — a fresh page load, even a background tab
  // holding the whole unread history, never fires the backlog), and only
  // ARRIVALS after it are decided, each exactly once (a re-render never
  // re-fires). The body is the runtime's bounded summary only (G3).
  const deliveredIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  // ONE delivery interval, re-armed when the committed rows/settings identity
  // changes (the 5s poll cadence) — no refs written outside the interval
  // callback, no render-time impurity: the closure reads the committed values.
  useEffect(() => {
    if (!workspaceId) return;
    const id = window.setInterval(() => {
      const browserEnabled = settings.settings?.browser_enabled ?? false;
      const permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
      const tick = deliveryTick({
        primed: primedRef.current,
        rowsReady: !query.loading,
        seenIds: deliveredIdsRef.current,
        rows: query.rows,
        permission: permission as NotificationPermission,
        browserEnabled,
        documentHidden: document.hidden,
      });
      primedRef.current = tick.primed;
      deliveredIdsRef.current = tick.seenIds;
      for (const row of tick.fired) {
        fireBrowserNotification({ title: row.title, body: row.summary });
      }
    }, 5_000);
    return () => window.clearInterval(id);
    // The interval re-arms on the committed rows/settings identity — the
    // closure reads exactly what this render committed.
  }, [workspaceId, query.rows, query.loading, settings.settings]);

  const markRead = (notificationId: string) => {
    if (!workspaceId) return;
    commands.submit({
      command_id: `cmd_${crypto.randomUUID()}`,
      idempotency_key: `idem_${crypto.randomUUID()}`,
      workspace_id: workspaceId,
      actor: { type: "user", id: actorId },
      issued_at: new Date().toISOString(),
      type: "notifications.mark_read",
      notification_id: notificationId,
    });
  };

  const mute = (notificationId: string) => {
    if (!workspaceId) return;
    commands.submit({
      command_id: `cmd_${crypto.randomUUID()}`,
      idempotency_key: `idem_${crypto.randomUUID()}`,
      workspace_id: workspaceId,
      actor: { type: "user", id: actorId },
      issued_at: new Date().toISOString(),
      type: "notifications.mute",
      notification_id: notificationId,
    });
  };

  const surfaceState: "loading" | "ready" | "error" = query.loading
    ? "loading"
    : query.failed
      ? "error"
      : "ready";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="left-auto w-96 max-w-[92vw]">
        {commands.safeError ? (
          <p role="alert" className="border-b border-line px-4 py-2 text-xs text-failed">
            {commands.safeError}
          </p>
        ) : null}
        <NotificationCenterView
          rows={query.rows}
          settings={settings.state === "ready" ? settings.settings : undefined}
          surfaceState={surfaceState}
          safeErrorMessage={query.safeErrorMessage}
          onMarkRead={markRead}
          onMute={mute}
          onClose={() => onOpenChange(false)}
          onOpenSettings={() => {
            onOpenChange(false);
            onNavigate?.();
            router.push(routes.settings("notifications"));
          }}
        />
        <SheetTitle className="sr-only">Notifications</SheetTitle>
        <SheetDescription className="sr-only">
          Your workspace's task results, approvals, and recovery notices.
        </SheetDescription>
      </SheetContent>
    </Sheet>
  );
}
