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
import { z } from "zod";

import { Id, ResourceTier } from "@shera-bot/contracts";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAccounts } from "../db/schema.ts";
import {
  adminAccountNotFoundError,
  contractValidationError,
  RuntimeOperationError,
  statusForError,
} from "../errors.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import { AdminAccountsService } from "../modules/admin-accounts.ts";
import { AdminBackupsService } from "../modules/admin-backups.ts";
import type { ProvisioningService } from "../modules/runtime-provisioning.ts";
import { requireAdminToken } from "./auth.ts";
import type { AdminTokenService } from "../modules/admin-tokens.ts";
import type { SecurityEventService } from "../modules/security-events.ts";
import type { RuntimeChannelClient } from "../runtime/channel-client.ts";

export interface AdminRouteDependencies {
  db: ControlPlaneDb;
  tokens: AdminTokenService;
  securityEvents: SecurityEventService;
  logger: ControlPlaneLogger;
  provisioning: ProvisioningService;
  /** The server-internal channel target resolver (endpoint + bearer). */
  runtimeTargetForAccount: (accountId: string) => Promise<{ endpoint: string; bearer: string }>;
  /** The typed internal-channel client (registration/rotation + S32 commands). */
  channel: RuntimeChannelClient;
}

/**
 * The AC6 wrapper: one definition records EVERY admin action (success and
 * failure) with actor, action, target, and timestamp. Routes never hand-roll
 * their audit row — forgetting one is impossible by construction.
 */
export interface AdminActionOutcome {
  status: number;
  body: unknown;
  target: string;
  /** Extra redacted audit fields for the admin_action event (AC6). */
  details?: Record<string, unknown>;
}

export function adminHandler(
  securityEvents: SecurityEventService,
  action: string,
  operation: (args: {
    req: Request;
    res: Response;
    tokenId: string;
    correlationId: string;
  }) => Promise<AdminActionOutcome>,
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
          ...(outcome.details ?? {}),
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
      // Typed operation errors (RuntimeOperationError carries the SheraError
      // taxonomy) answer with their mapped status — never a raw 500.
      if (error instanceof RuntimeOperationError) {
        res.status(statusForError(error.sheraError)).json(error.sheraError);
        return;
      }
      throw error;
    }
  };
}

export function createAdminRoutes(deps: AdminRouteDependencies): Router {
  const router = Router();
  const requireToken = requireAdminToken({ tokens: deps.tokens });
  router.use(requireToken);

  // Shared JSON body parser for admin command bodies (bounded, typed 400).
  const jsonParser = express.json({ limit: "64kb" });
  const parseBody =
    <T extends z.ZodType>(schema: T) =>
    (req: Request, res: Response, next: express.NextFunction): void => {
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(contractValidationError("The request body is not valid."));
        return;
      }
      res.locals.body = parsed.data;
      next();
    };

  const accounts = new AdminAccountsService(deps.db);

  // --- Users (list, enable/disable, tier) -----------------------------------

  router.get(
    "/users",
    adminHandler(deps.securityEvents, "users.list", async () => {
      const result = await accounts.listUsers();
      return { status: 200, body: result, target: "all" };
    }),
  );

  router.post(
    "/users/:id/disable",
    adminHandler(deps.securityEvents, "users.disable", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const result = await accounts.disableAccount(id);
      return { status: 200, body: result, target: id };
    }),
  );

  router.post(
    "/users/:id/enable",
    adminHandler(deps.securityEvents, "users.enable", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const result = await accounts.enableAccount(id);
      return { status: 200, body: result, target: id };
    }),
  );

  const TierBody = z.strictObject({ tier: ResourceTier });

  router.put(
    "/users/:id/tier",
    jsonParser,
    parseBody(TierBody),
    adminHandler(deps.securityEvents, "users.assign_tier", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const body = args.res.locals.body as { tier: ResourceTier };
      const result = await accounts.assignTier(id, body.tier);
      return { status: 200, body: result, target: id };
    }),
  );

  // --- Container lifecycle (the recorded S06 provisioning path, keyed by the
  // admin-targeted account; D12/PRD §15). The provisioning service's typed
  // errors (RuntimeOperationError) answer through adminHandler — a 404
  // unknown account, a 409 unprovisioned runtime, never a raw 500.

  const containerOperation =
    (operation: (accountId: string) => Promise<unknown>) =>
    async (args: { req: Request; res: Response; tokenId: string; correlationId: string }) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const result = await operation(id);
      return { status: 200, body: result, target: id };
    };

  router.post(
    "/users/:id/container/provision",
    adminHandler(
      deps.securityEvents,
      "container.provision",
      containerOperation((id) => deps.provisioning.ensureProvisioned(id)),
    ),
  );
  router.post(
    "/users/:id/container/restart",
    adminHandler(
      deps.securityEvents,
      "container.restart",
      containerOperation((id) => deps.provisioning.restart(id)),
    ),
  );
  router.post(
    "/users/:id/container/stop",
    adminHandler(
      deps.securityEvents,
      "container.stop",
      containerOperation((id) => deps.provisioning.stop(id)),
    ),
  );
  router.get(
    "/users/:id/container/status",
    adminHandler(
      deps.securityEvents,
      "container.status",
      containerOperation((id) => deps.provisioning.getStatus(id)),
    ),
  );
  router.get(
    "/users/:id/container/usage",
    adminHandler(
      deps.securityEvents,
      "container.usage",
      containerOperation((id) => deps.provisioning.getUsageSummary(id)),
    ),
  );

  // --- Backup trigger + restore request (E11; the mechanism is S33's, this
  // slice wires the trigger and the command surface — every response is
  // honest about the requested-not-completed status, G4).

  const backups = new AdminBackupsService(deps.db);

  router.post(
    "/users/:id/backups",
    adminHandler(deps.securityEvents, "backups.trigger", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const result = await backups.triggerBackup(id);
      return {
        status: 200,
        body: result,
        target: id,
        details: { backup_id: result.backup_id, snapshot_ref: result.snapshot_ref },
      };
    }),
  );

  router.get(
    "/users/:id/backups",
    adminHandler(deps.securityEvents, "backups.list", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const result = await backups.listBackups(id);
      return { status: 200, body: result, target: id };
    }),
  );

  router.post(
    "/users/:id/backups/:snapshotRef/restore",
    adminHandler(deps.securityEvents, "backups.restore_requested", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const snapshotRef = Id.parse(args.req.params.snapshotRef);
      const result = await backups.requestRestore(id, snapshotRef);
      return {
        status: 200,
        body: result,
        target: `${id}/${result.snapshot_ref}`,
        details: { account_id: id, snapshot_ref: result.snapshot_ref },
      };
    }),
  );

  // --- Emergency cancel-all (AC4): reach the runtime's S22 cancellation
  // machinery over the recorded internal channel, scoped to THIS user. The
  // runtime target resolves through the provisioning service's channel
  // binding (a stopped/unreachable runtime is the typed unavailable error —
  // there is no "pretend it cancelled" answer, G4).

  router.post(
    "/users/:id/emergency-cancel",
    adminHandler(deps.securityEvents, "emergency.cancel_all", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const target = await deps.runtimeTargetForAccount(id);
      const result = await deps.channel.cancelAll(target.endpoint, target.bearer, {
        workspace_id: `ws_${id}`,
        actor: { type: "admin", id: `admin-token:${args.tokenId}` },
      });
      const cancelledCount = result.results.filter((row) => row.outcome === "cancelled").length;
      return {
        status: 200,
        body: result,
        target: id,
        details: { account_id: id, cancelled_count: cancelledCount },
      };
    }),
  );

  return router;
}

/** Shared account-target guard for admin commands: a malformed id and an
 * unknown id are the same typed 404 (no account enumeration). */
export async function requireAccountId(db: ControlPlaneDb, rawId: unknown): Promise<string> {
  const parsed = Id.safeParse(rawId);
  if (!parsed.success) {
    throw adminAccountNotFoundError();
  }
  const rows = await db
    .select({ id: controlAccounts.id })
    .from(controlAccounts)
    .where(eq(controlAccounts.id, parsed.data))
    .limit(1);
  if (rows.length === 0) {
    throw adminAccountNotFoundError();
  }
  return parsed.data;
}
