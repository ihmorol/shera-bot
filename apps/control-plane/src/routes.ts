/**
 * HTTP routes for the identity layer (S05). ExpressAuth owns /api/auth/*
 * (mounted in the factory); this module owns the typed surfaces around it.
 */
import { Router, type Request, type Response } from "express";

import type { ExpressAuthConfig } from "@auth/express";

import type { ControlPlaneDb } from "./db/client.ts";
import {
  authSignInFailedError,
  statusForError,
  signupCapReachedError,
  RuntimeOperationError,
} from "./errors.ts";
import type { ControlPlaneLogger } from "./logger.ts";
import type { ProvisioningService } from "./modules/runtime-provisioning.ts";
import type { SecretRegistry } from "./redaction.ts";
import { loadSessionProjection, touchLastActive } from "./modules/session-projection.ts";
import type { SecurityEventService } from "./modules/security-events.ts";
import type { SignupCapService } from "./modules/signup-cap.ts";
import { createRuntimeApiProxy } from "./runtime/api-proxy.ts";
import { requireSession } from "./auth/session-middleware.ts";

export interface RouteDependencies {
  db: ControlPlaneDb;
  authConfig: ExpressAuthConfig;
  signupCap: SignupCapService;
  securityEvents: SecurityEventService;
  registry: SecretRegistry;
  authConfigured: boolean;
  logger: ControlPlaneLogger;
  provisioning: ProvisioningService;
}

export function createRoutes(deps: RouteDependencies): Router {
  const router = Router();
  const requireSessionMiddleware = requireSession({
    authConfig: deps.authConfig,
    securityEvents: deps.securityEvents,
    registry: deps.registry,
    logger: deps.logger,
  });

  /**
   * S1 signup-cap refusal / redacted error state (docs/UI_DESIGN.md S1).
   * Auth.js redirects here with ?error=<type>; the payload is typed JSON:
   * - AccessDenied while the cap is full → the exact refusal payload, with
   *   no retry affordance (the cap is server-enforced).
   * - anything else → a redacted, retry-allowed sign-in failure.
   * The UI decides which S1 screen to render from code + retryable.
   */
  router.get("/auth/error", async (req: Request, res: Response) => {
    const errorType = typeof req.query.error === "string" ? req.query.error : "Configuration";
    if (errorType === "AccessDenied" && !(await deps.signupCap.isSignupAllowed())) {
      res.status(403).json(signupCapReachedError());
      return;
    }
    const failure = authSignInFailedError();
    res.status(502).json(failure);
  });

  /**
   * The authenticated session projection (S02 Session contract). The
   * requireSession middleware gates the route; unauthenticated access gets
   * the typed 401.
   */
  router.get("/api/session", requireSessionMiddleware, async (req, res) => {
    const accountId: string | undefined = res.locals.session?.user?.id;
    if (!accountId) {
      // Unreachable while requireSession runs before this handler; the
      // invariant is checked rather than assumed (D23 rule 5 posture).
      throw new Error("session gate passed without an account id");
    }
    const projection = await loadSessionProjection(deps.db, accountId);
    await touchLastActive(deps.db, accountId);
    res.status(200).json(projection);
  });

  /**
   * Liveness + configuration state (G4): an unconfigured deployment reports
   * itself here and refuses sign-in with a typed configuration error — it
   * never fakes a login.
   */
  router.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      auth: { configured: deps.authConfigured, provider: "google" },
    });
  });

  /**
   * S06 runtime lifecycle routes (issue #7; D12, PRD §6). Every route derives
   * the target runtime from the SESSION account — there is no route parameter
   * that could address another user's runtime, which is the local-setup
   * cross-tenant guarantee (AC6; the attempt record for S27 lives in the
   * integration suite). Responses carry only the contract's web-facing shape:
   * opaque runtime handle + resource summary, never a container ID, host
   * path, internal port, or credential (D12; asserted by the
   * response-scanning suite).
   */
  const runtimeHandler =
    (operation: (accountId: string, correlationId?: string) => Promise<unknown>) =>
    async (req: Request, res: Response): Promise<void> => {
      const accountId: string | undefined = res.locals.session?.user?.id;
      if (!accountId) {
        throw new Error("session gate passed without an account id");
      }
      try {
        const result = await operation(accountId);
        res.status(200).json(result);
      } catch (error) {
        if (error instanceof RuntimeOperationError) {
          res.status(statusForError(error.sheraError)).json(error.sheraError);
          return;
        }
        throw error;
      }
    };

  router.post(
    "/api/runtime/provision",
    requireSessionMiddleware,
    runtimeHandler((accountId, correlationId) =>
      deps.provisioning.ensureProvisioned(accountId, correlationId),
    ),
  );
  router.get(
    "/api/runtime/status",
    requireSessionMiddleware,
    runtimeHandler((accountId, correlationId) =>
      deps.provisioning.getStatus(accountId, correlationId),
    ),
  );
  router.post(
    "/api/runtime/restart",
    requireSessionMiddleware,
    runtimeHandler((accountId, correlationId) =>
      deps.provisioning.restart(accountId, correlationId),
    ),
  );
  router.post(
    "/api/runtime/stop",
    requireSessionMiddleware,
    runtimeHandler((accountId, correlationId) => deps.provisioning.stop(accountId, correlationId)),
  );

  router.use(
    "/api/runtime/local",
    requireSessionMiddleware,
    createRuntimeApiProxy({
      targetForAccount: (accountId) => deps.provisioning.getChannelTarget(accountId),
    }),
  );

  return router;
}
