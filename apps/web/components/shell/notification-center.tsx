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
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  safeNotificationsMessage,
  useNotificationCommands,
  useNotifications,
  useNotificationSettings,
} from "@/lib/notifications-data";
import { useSessionIdentity } from "@/lib/container-connection";
import { routes } from "@/lib/routes";
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

/** Relative time in whole minutes/hours from the record's own timestamp. */
function relativeTime(occurredAt: string, nowMs: number): string {
  const occurred = Date.parse(occurredAt);
  const deltaMs = Math.max(0, nowMs - occurred);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
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
  const nowMs = Date.now();

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
        <p className="border-b border-line px-4 py-2 text-xs text-muted" data-testid="notification-delivery-line">
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
                      <span className="font-mono text-[11px] text-muted">
                        {relativeTime(row.occurred_at, nowMs)}
                      </span>
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
  onNavigate?: () => void;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn("relative", className)}
        aria-label="Open notifications"
        onClick={() => setOpen(true)}
      >
        <Bell className="size-4" aria-hidden="true" />
        <NotificationBadge workspaceId={workspaceId} />
      </Button>
      <NotificationCenterHost
        workspaceId={workspaceId}
        open={open}
        onOpenChange={setOpen}
        onNavigate={onNavigate}
      />
    </>
  );
}

/** The live badge: the unread count of the runtime's derived rows. */
function NotificationBadge({ workspaceId }: { workspaceId: string | null }) {
  const query = useNotifications(workspaceId);
  if (!workspaceId || query.rows.length === 0) return null;
  return <BellBadge count={notificationBadgeCount(query.rows)} />;
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
  onNavigate?: () => void;
}) {
  const query = useNotifications(workspaceId);
  const settings = useNotificationSettings(workspaceId);
  const commands = useNotificationCommands(workspaceId);
  const session = useSessionIdentity();

  const actorId = session.data?.google_sub ?? "";

  const markRead = (notificationId: string) => {
    if (!workspaceId) return;
    commands.submit(
      {
        command_id: `cmd_${crypto.randomUUID()}`,
        idempotency_key: `idem_${crypto.randomUUID()}`,
        workspace_id: workspaceId,
        actor: { type: "user", id: actorId },
        issued_at: new Date().toISOString(),
        type: "notifications.mark_read",
        notification_id: notificationId,
      },
    );
  };

  const mute = (notificationId: string) => {
    if (!workspaceId) return;
    commands.submit(
      {
        command_id: `cmd_${crypto.randomUUID()}`,
        idempotency_key: `idem_${crypto.randomUUID()}`,
        workspace_id: workspaceId,
        actor: { type: "user", id: actorId },
        issued_at: new Date().toISOString(),
        type: "notifications.mute",
        notification_id: notificationId,
      },
    );
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
            window.location.assign(routes.settings("notifications"));
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
