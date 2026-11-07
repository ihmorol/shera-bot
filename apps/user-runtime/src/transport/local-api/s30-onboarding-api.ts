/**
 * S30 — the onboarding HTTP surface (issue #31; D16, E43, G2/G6).
 *
 * Two routes, both workspace-scoped (E12):
 *
 *   GET  /v1/onboarding          — the resumable snapshot (status, steps,
 *                                  answers, the deployment default read).
 *   POST /v1/onboarding/commands — the ONE typed commands envelope (answer /
 *                                  dismiss / reopen); the acting actor is
 *                                  bound SERVER-SIDE by the proxy's session
 *                                  binding. The memory step's effect rides
 *                                  the memory commands surface (D16).
 */
import type { Express } from "express";
import { z } from "zod";

import { WorkspaceId } from "@shera-bot/contracts";

import { contractValidationResponse } from "../http/typed-errors.ts";
import type {
  OnboardingService,
  OnboardingServiceError,
} from "../../modules/onboarding/onboarding.service.ts";

export const ONBOARDING_SNAPSHOT_PATH = "/v1/onboarding" as const;
export const ONBOARDING_COMMANDS_PATH = "/v1/onboarding/commands" as const;

export interface OnboardingApiHandle {
  onboarding: OnboardingService;
  /** E12: the container's workspace. */
  workspaceId: string;
}

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

function workspaceMatches(handle: OnboardingApiHandle, workspaceId: string): boolean {
  return workspaceId === handle.workspaceId;
}

export function registerOnboardingRoutes(app: Express, deps: OnboardingApiHandle): void {
  app.get(ONBOARDING_SNAPSHOT_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The onboarding request is not valid: a workspace_id is required.",
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
    res.status(200).json({ onboarding: deps.onboarding.snapshot(query.data.workspace_id) });
  });

  // The ONE typed commands envelope (G2); the proxy binds the actor (G6).
  app.post(ONBOARDING_COMMANDS_PATH, (req, res) => {
    try {
      deps.onboarding.submitCommand(deps.workspaceId, req.body);
      res.status(200).json({ accepted: true });
    } catch (error) {
      const typed = error as OnboardingServiceError;
      if (typed instanceof Error && typed.name === "OnboardingServiceError") {
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
  });
}
