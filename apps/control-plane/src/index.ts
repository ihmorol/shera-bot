/**
 * @shera-bot/control-plane — the identity layer (S05, GitHub issue #6).
 *
 * Google OAuth as the only login method (Auth.js v5, database sessions), the
 * server-enforced five-account signup cap, httpOnly/Secure/SameSite session
 * cookies with defined expiry, logout invalidation, the manually managed
 * administrator flag, and security-event recording — on central PostgreSQL
 * via Drizzle (D2, PRD §3.2, §12, §15; PRD §17: Express API).
 *
 * The factory is the S01 seam, kept: it takes injected dependencies so tests
 * run the real app in-process against a disposable PostgreSQL cluster.
 *
 * G4: an unconfigured OAuth environment is a first-class state — sign-in
 * surfaces a typed configuration error, never a fake login.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { ExpressAuth, getSession } from "@auth/express";

import { AUTH_BASE_PATH, isAuthConfigured, readEnv } from "./config.ts";
import { parseCookieHeader, SESSION_COOKIE_NAMES } from "./auth/session-middleware.ts";
import { createDb, type ControlPlaneDb } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import {
  authConfigurationError,
  internalErrorPayload,
  routeNotFoundError,
  statusForError,
} from "./errors.ts";
import { createControlPlaneLogger, type ControlPlaneLogger } from "./logger.ts";
import { SecretRegistry } from "./redaction.ts";
import { AdminTokenService } from "./modules/admin-tokens.ts";
import { ProvisioningService } from "./modules/runtime-provisioning.ts";
import { RuntimeChannelClient } from "./runtime/channel-client.ts";
import { LocalContainerBackend } from "./runtime/local-container-backend.ts";
import { createLiveRuntimeTransport, type LiveRuntimeTransport } from "./runtime/live-transport.ts";
import { SecurityEventService } from "./modules/security-events.ts";
import { SignupCapService } from "./modules/signup-cap.ts";
import { createSheraAuthAdapter } from "./auth/adapter.ts";
import { buildAuthConfig } from "./auth/auth-config.ts";
import { createRoutes } from "./routes.ts";
import { createAdminRoutes } from "./admin/routes.ts";
import type { RuntimeBackend } from "@shera-bot/contracts";

export interface ControlPlaneOptions {
  /**
   * PostgreSQL connection string. Defaults to DATABASE_URL; tests inject the
   * disposable cluster's URL.
   */
  databaseUrl?: string;
  /** Environment reference map; defaults to process.env (G3: no literals). */
  env?: NodeJS.ProcessEnv;
  /** Run committed migrations at creation (default true, D24). */
  runMigrations?: boolean;
  /**
   * TEST SEAM ONLY: point the Google provider's OIDC discovery at a local
   * mock IdP (E15 S05: the real provider + core machinery is exercised
   * end-to-end without owner credentials). Never set in a deployment.
   */
  googleIssuer?: string;
  /** Log sink injection for the redaction test. */
  logSink?: (line: string) => void;
  /**
   * Runtime backend override (TEST SEAM and future remote/cloud backends,
   * D12). Defaults to the LocalContainerBackend for the local single-host
   * deployment (S35); the engine client connects lazily, so an engine-less
   * environment constructs fine and provisioning fails truthfully (G4).
   */
  runtimeBackend?: RuntimeBackend;
  /** TEST SEAM: bypass container lifecycle while exercising runtime HTTP and live proxies. */
  runtimeTargetForAccount?: (accountId: string) => Promise<{ endpoint: string; bearer: string }>;
  /** TEST SEAM: shorten direct session-revocation checks. */
  liveSessionValidationIntervalMs?: number;
}

export interface ControlPlaneApp {
  app: Express;
  db: ControlPlaneDb;
  logger: ControlPlaneLogger;
  registry: SecretRegistry;
  securityEvents: SecurityEventService;
  signupCap: SignupCapService;
  adminTokens: AdminTokenService;
  provisioning: ProvisioningService;
  liveTransport: LiveRuntimeTransport;
  authConfigured: boolean;
  env: ReturnType<typeof readEnv>;
  close(): Promise<void>;
}

export async function createControlPlaneApp(
  options: ControlPlaneOptions = {},
): Promise<ControlPlaneApp> {
  const env = readEnv(options.env);
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or options.databaseUrl) is required");
  }

  const registry = new SecretRegistry();
  const logger = createControlPlaneLogger({ registry });
  if (options.logSink) logger.sink = options.logSink;

  const { db, pool } = createDb(databaseUrl);
  if (options.runMigrations !== false) {
    await runMigrations(db);
  }

  const securityEvents = new SecurityEventService(db, registry, logger);
  const signupCap = new SignupCapService(db, securityEvents, logger);

  // S32 (D47, issue #33): the owner-held admin API token (hash-only storage,
  // AC5) and the authenticated admin surface. Token lifecycle (create/rotate)
  // is a LOCAL CLI operation; the HTTP surface only ever verifies digests.
  const adminTokens = new AdminTokenService({ db, registry, securityEvents });

  // S06 runtime provisioning (D12): the typed backend seam. Tests and future
  // remote/cloud backends inject their implementation; the default speaks to
  // the local engine for the local single-host deployment (S35).
  const runtimeBackend =
    options.runtimeBackend ?? new LocalContainerBackend({ env: options.env ?? process.env });
  const provisioning = new ProvisioningService({
    db,
    backend: runtimeBackend,
    channel: new RuntimeChannelClient(),
    securityEvents,
    registry,
    logger,
  });

  const liveTransportRef: { current?: LiveRuntimeTransport } = {};
  const adapter = createSheraAuthAdapter({
    db,
    signupCap,
    registry,
    onSessionDeleted: (token) => liveTransportRef.current?.revokeSession(token),
  });
  const authConfigured = isAuthConfigured(env);

  const app = express();
  // @auth/express setup: honor proxy headers so protocol/host detection and
  // secure-cookie derivation follow the TLS-terminating edge.
  app.set("trust proxy", true);

  const authConfig = buildAuthConfig({
    env,
    adapter,
    signupCap,
    securityEvents,
    logger,
    registry,
    ...(options.googleIssuer ? { googleIssuer: options.googleIssuer } : {}),
  });
  const runtimeTargetForAccount =
    options.runtimeTargetForAccount ??
    ((accountId: string) => provisioning.getChannelTarget(accountId));
  const liveTransport = createLiveRuntimeTransport({
    db,
    authConfig,
    registry,
    trustedWebOrigin: env.SHERA_WEB_ORIGIN,
    targetForAccount: runtimeTargetForAccount,
    logger,
    ...(options.liveSessionValidationIntervalMs === undefined
      ? {}
      : { sessionValidationIntervalMs: options.liveSessionValidationIntervalMs }),
  });
  liveTransportRef.current = liveTransport;

  if (authConfigured) {
    // Logout audit (issue #6 security events; E-note): @auth/core 0.41.3 does
    // not emit `events.signOut` through the Express adapter path (verified by
    // instrumentation on 2026-09-19 — the session IS deleted, the event is
    // not). The framework still owns signout, cookies, and session deletion;
    // this pre-handler only records the audit trail and registers the dying
    // session token for value-based redaction (G3).
    app.post(
      `${AUTH_BASE_PATH}/signout`,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const session = await getSession(req, authConfig);
          const accountId = session?.user?.id;
          if (accountId) {
            const cookies = parseCookieHeader(req.headers.cookie ?? "");
            for (const cookieName of SESSION_COOKIE_NAMES) {
              registry.register(cookies.get(cookieName), "session-token");
            }
            await securityEvents.record({
              eventType: "logout",
              accountId,
              details: { provider: "google" },
            });
          }
        } catch (error) {
          // Audit must never break the signout itself (surfaced in the log).
          logger.error("logout_audit_failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        next();
      },
    );
    app.use(AUTH_BASE_PATH, ExpressAuth(authConfig));
  } else {
    // G4: unconfigured deployments refuse sign-in with a typed configuration
    // error on every auth endpoint — there is no fake login path.
    app.use(AUTH_BASE_PATH, (_req: Request, res: Response) => {
      const error = authConfigurationError();
      res.status(statusForError(error)).json(error);
    });
  }

  app.use(
    createRoutes({
      db,
      authConfig,
      signupCap,
      securityEvents,
      registry,
      authConfigured,
      logger,
      provisioning,
      runtimeTargetForAccount,
    }),
  );

  // S32: the authenticated admin surface (every route behind the token gate;
  // every action recorded — AC2/AC6). Mounted before the typed 404 so the
  // gate answers first on any /api/admin path.
  app.use("/api/admin", createAdminRoutes({ db, tokens: adminTokens, securityEvents, logger, provisioning }));

  // Typed 404 (S02 taxonomy).
  app.use((_req: Request, res: Response) => {
    const error = routeNotFoundError();
    res.status(404).json(error);
  });

  // Typed error boundary: full details go to the redacted log only; the
  // response body carries safe_message + correlation_id (never internals).
  app.use(createErrorHandler(logger));

  return {
    app,
    db,
    logger,
    registry,
    securityEvents,
    signupCap,
    adminTokens,
    provisioning,
    liveTransport,
    authConfigured,
    env,
    async close() {
      liveTransport.close();
      await pool.end();
    },
  };
}

export function createErrorHandler(logger: Pick<ControlPlaneLogger, "error">) {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    const correlationId = crypto.randomUUID();
    logger.error("request_failed", {
      correlation_id: correlationId,
      method: req.method,
      path: req.path,
      reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? (err.stack ?? null) : null,
    });
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json(internalErrorPayload(correlationId));
  };
}
