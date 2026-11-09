/**
 * Notification center contracts (S30, issue #31; PRD §14, D16, E3).
 *
 * The center renders the RUNTIME's own records (the AC9 truth posture): the
 * four kinds derive from durable runtime state — completion/failure/recovery
 * from the journal's task-lifecycle events, approval_required from the
 * approvals module's PENDING rows. Read/mute state is workspace-scoped
 * durable state. Every summary is a bounded derived line, never message
 * content or secret material (G3).
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, WorkspaceId } from "./primitives.ts";

/** PRD §14's recorded notification kinds. */
export const NOTIFICATION_KINDS = [
  "completion",
  "failure",
  "approval_required",
  "recovery",
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * One center row. `deep_link` is the in-app route the row opens (the
 * conversation/task the record names); `read_at`/`muted` carry the durable
 * read and delivery-suppression state. A muted row stays LISTED (E3:
 * muting affects delivery only — it never hides or resolves anything).
 */
export const NotificationView = z.strictObject({
  notification_id: Id,
  workspace_id: WorkspaceId,
  kind: NotificationKind,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(200),
  conversation_id: Id.nullable(),
  task_id: Id.nullable(),
  approval_id: Id.nullable(),
  occurred_at: IsoDateTime,
  read_at: IsoDateTime.nullable(),
  muted: z.boolean(),
  deep_link: z.string().min(1).max(256),
});
export type NotificationView = z.infer<typeof NotificationView>;

/**
 * The per-workspace notification settings (PRD §14: users can enable/disable
 * browser and in-app notifications). In-app delivery is always on by
 * default; browser notifications ride an explicit permission decision, so
 * the recommended default is OFF.
 */
export const NotificationSettingsView = z.strictObject({
  in_app_enabled: z.boolean(),
  browser_enabled: z.boolean(),
  recommended_default: z.strictObject({
    in_app_enabled: z.literal(true),
    browser_enabled: z.literal(false),
  }),
});
export type NotificationSettingsView = z.infer<typeof NotificationSettingsView>;

/**
 * The typed user commands the center accepts (G2/G6: every acting actor is
 * bound SERVER-SIDE by the proxy's session binding — the browser client
 * sends no actor of its own choosing; the S20/S23/S28/S29 convention).
 *
 * `notifications.mute` on an approval item creates the S20 approval-scope
 * mute through the approvals service — ONE mute record family (E3); on a
 * journal-derived item it writes the notification's own durable mute state.
 * There is deliberately no un-mute (the S20 write-once posture).
 */
export const NotificationCommand = z.discriminatedUnion("type", [
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("notifications.mark_read"),
    notification_id: Id,
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("notifications.mute"),
    notification_id: Id,
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("notifications.set_settings"),
    in_app_enabled: z.boolean(),
    browser_enabled: z.boolean(),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("notifications.reset_settings"),
  }),
]);
export type NotificationCommand = z.infer<typeof NotificationCommand>;
export type NotificationMarkReadCommand = Extract<
  NotificationCommand,
  { type: "notifications.mark_read" }
>;
export type NotificationMuteCommand = Extract<NotificationCommand, { type: "notifications.mute" }>;
export type NotificationSetSettingsCommand = Extract<
  NotificationCommand,
  { type: "notifications.set_settings" }
>;
export type NotificationResetSettingsCommand = Extract<
  NotificationCommand,
  { type: "notifications.reset_settings" }
>;
