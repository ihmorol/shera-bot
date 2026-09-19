/**
 * HTTP routes for the identity layer (S05). ExpressAuth owns /api/auth/*
 * (mounted in the factory); this module owns the typed surfaces around it.
 */
import { Router, type Request, type Response } from "express";

import type { ExpressAuthConfig } from "@auth/express";

import type { ControlPlaneDb } from "./db/client.ts";
import { authSignInFailedError, signupCapReachedError } from "./errors.ts";
import type { ControlPlaneLogger } from "./logger.ts";
import type { SecretRegistry } from "./redaction.ts";
import { loadSessionProjection, touchLastActive } from "./modules/session-projection.ts";
import type { SecurityEventService } from "./modules/security-events.ts";
import type { SignupCapService } from "./modules/signup-cap.ts";
import { requireSession } from "./auth/session-middleware.ts";

export interface RouteDependencies {
  db: ControlPlaneDb;
  authConfig: ExpressAuthConfig;
  signupCap: SignupCapService;
  securityEvents: SecurityEventService;
  registry: SecretRegistry;
  authConfigured: boolean;
  logger: ControlPlaneLogger;
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

  return router;
}
