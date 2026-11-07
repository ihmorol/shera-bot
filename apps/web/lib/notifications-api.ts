import { z } from "zod";

import {
  NotificationCommand,
  NotificationSettingsView,
  NotificationView,
} from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * S30 — the typed browser client for the notification center (UI_DESIGN
 * §S10; PRD §14, D16, E3), reached through the same-origin runtime proxy
 * (/api/runtime/* → the container's local API). Every failure arrives as the
 * S02 taxonomy through the shared typed-error parser, so surfaces show
 * safe_message only (G3); a 2xx body that breaks its contract is a server
 * drift, never a fabricated success. The rows are the RUNTIME's derived
 * records — the client never computes a row of its own (the AC9 posture).
 */

const NotificationsPayload = z.strictObject({ notifications: z.array(NotificationView) });
const SettingsPayload = z.strictObject({ settings: NotificationSettingsView });

/** The derived center rows, newest first (the runtime's own records). */
export function fetchNotifications(workspaceId: string): Promise<NotificationView[]> {
  return requestRuntime(
    `/api/runtime/v1/notifications?workspace_id=${encodeURIComponent(workspaceId)}`,
    (payload) => NotificationsPayload.parse(payload).notifications,
  );
}

export type NotificationSettings = z.infer<typeof NotificationSettingsView>;

/** The delivery toggles (PRD §14) with the recommended defaults (D16). */
export function fetchNotificationSettings(workspaceId: string): Promise<NotificationSettings> {
  return requestRuntime(
    `/api/runtime/v1/notifications/settings?workspace_id=${encodeURIComponent(workspaceId)}`,
    (payload) => SettingsPayload.parse(payload).settings,
  );
}

/**
 * One typed center command (mark_read / mute / set_settings / reset_settings).
 * The actor is the SESSION identity (the proxy binds it server-side — G6);
 * the caller passes the session's shape, and a client-asserted identity
 * never reaches the runtime. The workspace_id travels in the command BODY
 * (the proxy's tenant check reads it there).
 */
export function submitNotificationCommand(
  workspaceId: string,
  command: z.infer<typeof NotificationCommand>,
): Promise<unknown> {
  return requestRuntime("/api/runtime/v1/notifications/commands", (payload) => payload, {
    method: "POST",
    body: JSON.stringify(command),
  });
}

/** The settings toggles' typed commands envelope. */
export function submitNotificationSettingsCommand(
  workspaceId: string,
  command: z.infer<typeof NotificationCommand>,
): Promise<unknown> {
  return requestRuntime(
    "/api/runtime/v1/notifications/settings/commands",
    (payload) => payload,
    { method: "POST", body: JSON.stringify(command) },
  );
}
