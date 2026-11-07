/**
 * S30 — the notification center HTTP surface (issue #31; PRD §14, D16, E3,
 * G2/G3/G6).
 *
 * Three routes, all workspace-scoped (E12):
 *
 *   GET  /v1/notifications            — the derived center rows (the RUNTIME's
 *                                       own records; never a parallel store).
 *   POST /v1/notifications/commands   — the ONE typed commands envelope
 *                                       (mark_read / mute / settings); the
 *                                       acting actor is bound SERVER-SIDE by
 *                                       the proxy's session binding.
 *   GET/POST /v1/notifications/settings(/commands)
 *                                   — the delivery toggles with reset-to-default.
 */
import type { Express } from "express";
import { z } from "zod";

import { WorkspaceId } from "@shera-bot/contracts";

import { contractValidationResponse } from "../http/typed-errors.ts";
import type {
  NotificationsService,
  NotificationsServiceError,
} from "../../modules/notifications/notifications.service.ts";

export const LIST_NOTIFICATIONS_PATH = "/v1/notifications" as const;
export const NOTIFICATION_COMMANDS_PATH = "/v1/notifications/commands" as const;
export const NOTIFICATION_SETTINGS_PATH = "/v1/notifications/settings" as const;
export const NOTIFICATION_SETTINGS_COMMANDS_PATH = "/v1/notifications/settings/commands" as const;

export interface NotificationsApiHandle {
  notifications: NotificationsService;
  /** E12: the container's workspace. */
  workspaceId: string;
}

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

function workspaceMatches(handle: NotificationsApiHandle, workspaceId: string): boolean {
  return workspaceId === handle.workspaceId;
}

export function registerNotificationsRoutes(app: Express, deps: NotificationsApiHandle): void {
  // The derived center rows (newest first, bounded).
  app.get(LIST_NOTIFICATIONS_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The notifications request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, query.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res.status(200).json({ notifications: deps.notifications.list(query.data.workspace_id) });
  });

  app.get(NOTIFICATION_SETTINGS_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The notification settings request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, query.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res.status(200).json({ settings: deps.notifications.settings(query.data.workspace_id) });
  });

  // The ONE typed commands envelope (G2). The proxy binds the actor from the
  // authenticated session (G6) — the browser never asserts an identity. The
  // service validates the body's workspace_id against THIS runtime's.
  const submit = (req: { body: unknown }, res: { status(code: number): { json(body: unknown): void } }): void => {
    try {
      deps.notifications.submitCommand(deps.workspaceId, req.body);
      res.status(200).json({ accepted: true });
    } catch (error) {
      const typed = error as NotificationsServiceError;
      if (typed instanceof Error && typed.name === "NotificationsServiceError") {
        res.status(typed.status).json({
          code: typed.code,
          category: typed.category,
          safe_message: typed.message,
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: null,
        });
        return;
      }
      throw error;
    }
  };

  app.post(NOTIFICATION_COMMANDS_PATH, (req, res) => {
    submit(req, res);
  });

  app.post(NOTIFICATION_SETTINGS_COMMANDS_PATH, (req, res) => {
    submit(req, res);
  });
}
