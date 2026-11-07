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
  adminInvalidBodyError,
  RuntimeOperationError,
  statusForError,
} from "../errors.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import { AdminAccountsService } from "../modules/admin-accounts.ts";
import { AdminBackupsService } from "../modules/admin-backups.ts";
import { AdminCreditsService } from "../modules/admin-credits.ts";
import type { ProvisioningService } from "../modules/runtime-provisioning.ts";
import { requireAdminToken } from "./auth.ts";
import type { AdminTokenService } from "../modules/admin-tokens.ts";
import type { SecurityEventService } from "../modules/security-events.ts";
import type { RuntimeChannelClient } from "../runtime/channel-client.ts";
import type { SecretRegistry } from "../redaction.ts";

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
  /** The secret registry (top-up reasons are free text — scrubbed, G3). */
  registry: SecretRegistry;
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
          // The attempted target is knowable from the route itself, so a
          // parse failure still names what was being targeted (AC6).
          target: typeof req.params["id"] === "string" ? req.params["id"] : "unknown",
          reason: error instanceof Error ? error.name : "unknown_error",
        },
        correlationId,
        redactionClass: "restricted",
      });
      // Typed operation errors (RuntimeOperationError carries the SheraError
      // taxonomy) answer with their mapped status — never a raw 500. The
      // admin body-parse contract answers 400 for CONTRACT_VALIDATION_FAILED
      // (the category map's 404 is the user boundary's route-not-found
      // semantics; review P1 moved parsing inside this handler so the
      // failure is audited AND 400-shaped).
      if (error instanceof RuntimeOperationError) {
        const status =
          error.sheraError.code === "CONTRACT_VALIDATION_FAILED"
            ? 400
            : statusForError(error.sheraError);
        res.status(status).json(error.sheraError);
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

  // Shared JSON body parsing happens INSIDE the audited operation (review
  // P1): a schema-invalid body or malformed JSON is still an admin action
  // attempt, so it must flow through adminHandler's failure recording (the
  // middleware-chain shape skipped the audit entirely and let malformed JSON
  // escape to the app-level handler as an unrecorded 500). Bounded (64kb);
  // every parse failure is the typed CONTRACT_VALIDATION_FAILED error, which
  // adminHandler answers 400.
  const jsonParser = express.json({ limit: "64kb" });

  const parseAdminBody = async <T extends z.ZodType>(
    schema: T,
    args: { req: Request; res: Response; correlationId: string },
  ): Promise<T["_output"]> => {
    await new Promise<void>((resolve, reject) => {
      jsonParser(args.req, args.res as Response, (err?: unknown) => {
        if (err) {
          // Malformed JSON, oversized bodies, bad encodings: ALL parser
          // failures are the typed 400 (audited by adminHandler) — never an
          // escape to the app-level handler (review P1).
          reject(adminInvalidBodyError(args.correlationId));
          return;
        }
        resolve();
      });
    });
    const parsed = schema.safeParse(args.req.body ?? {});
    if (!parsed.success) {
      throw adminInvalidBodyError(args.correlationId);
    }
    return parsed.data;
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
    adminHandler(deps.securityEvents, "users.assign_tier", async (args) => {
      const body = await parseAdminBody(TierBody, args);
      const id = await requireAccountId(deps.db, args.req.params.id);
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
      // S33 (issue #34, D47): the trigger is EXECUTED over the recorded
      // channel — the runtime mechanism's own typed result transitions the
      // row to a truthful status. An unreachable runtime leaves the row at
      // `requested` (the honest non-terminal record, G4 — the snapshot was
      // never taken).
      let dispatched: string = "runtime_unavailable";
      try {
        const target = await deps.runtimeTargetForAccount(id);
        const take = await deps.channel.takeBackup(target.endpoint, target.bearer, {
          workspace_id: `ws_${id}`,
          snapshot_ref: result.snapshot_ref,
          actor: { type: "admin", id: `admin-token:${args.tokenId}` },
        });
        if (take.taken) {
          await backups.markTaken(id, result.backup_id, new Date(take.taken_at));
          dispatched = "taken";
        } else {
          await backups.markTakeRefused(id, result.backup_id, take.reason);
          dispatched = `refused:${take.reason}`;
        }
      } catch {
        // Unreachable/ChannelRejected: the row stays `requested`.
      }
      return {
        status: 200,
        body: { ...result, dispatched },
        target: id,
        details: {
          backup_id: result.backup_id,
          snapshot_ref: result.snapshot_ref,
          dispatched,
        },
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
      // S33 (issue #34, D47): the restore EXECUTES over the recorded channel
      // through the runtime's recorded walk. The row transitions to the
      // truthful outcome; an unreachable runtime leaves the request recorded
      // (restore_requested) — the runbook's operator procedure is the
      // handoff, never a claimed restore (G4).
      const backupId = await backups.requireIdBySnapshotRef(id, result.snapshot_ref);
      let dispatched: string = "runtime_unavailable";
      try {
        const target = await deps.runtimeTargetForAccount(id);
        const restore = await deps.channel.restoreBackup(target.endpoint, target.bearer, {
          workspace_id: `ws_${id}`,
          snapshot_id: result.snapshot_ref,
          actor: { type: "admin", id: `admin-token:${args.tokenId}` },
        });
        if (restore.restored) {
          if (backupId) {
            await backups.markRestoreOutcome(id, backupId, "restored", "");
          }
          dispatched = "restored";
        } else {
          if (backupId) {
            await backups.markRestoreOutcome(id, backupId, "restore_refused", restore.code);
          }
          dispatched = `refused:${restore.code}`;
        }
      } catch {
        // Unreachable/ChannelRejected: the row stays `restore_requested`.
      }
      return {
        status: 200,
        body: { ...result, dispatched },
        target: `${id}/${result.snapshot_ref}`,
        details: { account_id: id, snapshot_ref: result.snapshot_ref, dispatched },
      };
    }),
  );

  // --- Credit top-up (D48, AC9): the durable grant record + the runtime's
  // recorded resume path. The strict body schema refuses zero/negative
  // amounts and any smuggled key (the database CHECK re-guards positivity).

  const TopUpBody = z.strictObject({
    amount: z.number().int().positive(),
    reason: z.string().min(1).max(500).optional(),
  });

  const credits = new AdminCreditsService({
    db: deps.db,
    channel: deps.channel,
    registry: deps.registry,
    runtimeTargetForAccount: deps.runtimeTargetForAccount,
  });

  router.post(
    "/users/:id/credits/top-up",
    adminHandler(deps.securityEvents, "credits.topup", async (args) => {
      const body = await parseAdminBody(TopUpBody, args);
      const id = await requireAccountId(deps.db, args.req.params.id);
      const result = await credits.topUp({
        accountId: id,
        amount: body.amount,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        tokenId: args.tokenId,
      });
      return {
        status: 200,
        body: result,
        target: id,
        details: { account_id: id, amount: result.amount, topup_id: result.topup_id },
      };
    }),
  );

  // --- Failures view (PRD §15): container failures from the control plane's
  // own security events; task failures from the runtime journal over the
  // recorded channel. A read degrades truthfully when the runtime is
  // unreachable (task_failures_status), never inventing records (G4).

  const CONTAINER_FAILURE_EVENT_TYPES = [
    "runtime_provision_failed",
    "runtime_operation_failed",
    "runtime_channel_auth_failed",
  ] as const;

  router.get(
    "/users/:id/failures",
    adminHandler(deps.securityEvents, "failures.view", async (args) => {
      const id = await requireAccountId(deps.db, args.req.params.id);
      const containerRows = await deps.securityEvents.listForAccount(
        id,
        CONTAINER_FAILURE_EVENT_TYPES,
        50,
      );
      const container_failures = containerRows.map((row) => ({
        event_type: row.eventType,
        occurred_at: row.occurredAt.toISOString(),
        details: row.details,
      }));

      let task_failures: Array<{
        run_id: string;
        state: string;
        occurred_at: string;
        events: Array<{ type: string; occurred_at: string; reason: string | null }>;
      }> = [];
      let task_failures_status = "ok";
      try {
        const target = await deps.runtimeTargetForAccount(id);
        const read = await deps.channel.listTaskFailures(target.endpoint, target.bearer, {
          workspace_id: `ws_${id}`,
          limit: 50,
        });
        task_failures = read.failures;
      } catch {
        // The read degrades: the task journal lives in the (unreachable)
        // container's SQLite. The status says so — no fabricated records.
        task_failures_status = "runtime_unavailable";
      }
      return {
        status: 200,
        body: { container_failures, task_failures, task_failures_status },
        target: id,
        details: {
          account_id: id,
          container_failure_count: container_failures.length,
          task_failure_count: task_failures.length,
        },
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
