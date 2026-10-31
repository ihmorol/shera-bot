/**
 * Admin routes (S32, issue #33; D47, PRD §15). The authenticated admin
 * surface of the control plane: every route sits behind `requireAdminToken`
 * and every completed action (or failed attempt) is recorded as a security
 * event with actor (the admin token id), action, target, and timestamp (AC6).
 *
 * Scope (D47/E7): API/CLI only — no admin console UI ships in the prototype;
 * administrator status stays a manually managed database flag and NO route
 * here can write `is_admin` (AC7).
 */
import express, { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAccounts } from "../db/schema.ts";
import { adminAccountNotFoundError } from "../errors.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import { requireAdminToken } from "./auth.ts";
import type { AdminTokenService } from "../modules/admin-tokens.ts";
import type { SecurityEventService } from "../modules/security-events.ts";

export interface AdminRouteDependencies {
  db: ControlPlaneDb;
  tokens: AdminTokenService;
  securityEvents: SecurityEventService;
  logger: ControlPlaneLogger;
}

/**
 * The AC6 wrapper: one definition records EVERY admin action (success and
 * failure) with actor, action, target, and timestamp. Routes never hand-roll
 * their audit row — forgetting one is impossible by construction.
 */
export function adminHandler(
  securityEvents: SecurityEventService,
  action: string,
  operation: (args: {
    req: Request;
    res: Response;
    tokenId: string;
    correlationId: string;
  }) => Promise<{ status: number; body: unknown; target: string }>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const tokenId: string | undefined = res.locals.adminToken?.tokenId;
    const correlationId = randomUUID();
    try {
      const outcome = await operation({ req, res, tokenId: tokenId ?? "unknown", correlationId });
      await securityEvents.record({
        eventType: "admin_action",
        accountId: null,
        details: {
          actor: `admin-token:${tokenId ?? "unknown"}`,
          action,
          target: outcome.target,
          status: outcome.status,
        },
        correlationId,
        redactionClass: "restricted",
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      await securityEvents.record({
        eventType: "admin_action_failed",
        accountId: null,
        details: {
          actor: `admin-token:${tokenId ?? "unknown"}`,
          action,
          reason: error instanceof Error ? error.name : "unknown_error",
        },
        correlationId,
        redactionClass: "restricted",
      });
      throw error;
    }
  };
}

export function createAdminRoutes(deps: AdminRouteDependencies): Router {
  const router = Router();
  const requireToken = requireAdminToken({ tokens: deps.tokens });
  router.use(requireToken);

  return router;
}

/** Shared account-existence guard for admin commands (typed 404). */
export async function requireAccountId(db: ControlPlaneDb, accountId: string): Promise<string> {
  const rows = await db
    .select({ id: controlAccounts.id })
    .from(controlAccounts)
    .where(eq(controlAccounts.id, accountId))
    .limit(1);
  if (rows.length === 0) {
    throw adminAccountNotFoundError();
  }
  return accountId;
}
