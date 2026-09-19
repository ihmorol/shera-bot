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
import { SESSION_COOKIE_NAMES } from "./auth/session-middleware.ts";
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
import { SecurityEventService } from "./modules/security-events.ts";
import { SignupCapService } from "./modules/signup-cap.ts";
import { createSheraAuthAdapter } from "./auth/adapter.ts";
import { buildAuthConfig } from "./auth/auth-config.ts";
import { createRoutes } from "./routes.ts";

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
}

export interface ControlPlaneApp {
  app: Express;
  db: ControlPlaneDb;
  logger: ControlPlaneLogger;
  registry: SecretRegistry;
  securityEvents: SecurityEventService;
  signupCap: SignupCapService;
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
  const adapter = createSheraAuthAdapter({ db, signupCap, registry });
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
            for (const cookieName of SESSION_COOKIE_NAMES) {
              const raw = req.headers.cookie
                ?.split(";")
                .map((part) => part.trim())
                .find((part) => part.startsWith(`${cookieName}=`))
                ?.slice(cookieName.length + 1);
              registry.register(raw, "session-token");
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
    }),
  );

  // Typed 404 (S02 taxonomy).
  app.use((_req: Request, res: Response) => {
    const error = routeNotFoundError();
    res.status(404).json(error);
  });

  // Typed error boundary: full details go to the redacted log only; the
  // response body carries safe_message + correlation_id (never internals).
  app.use((err: unknown, req: Request, res: Response) => {
    const correlationId = crypto.randomUUID();
    logger.error("request_failed", {
      correlation_id: correlationId,
      method: req.method,
      path: req.path,
      reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? (err.stack ?? null) : null,
    });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json(internalErrorPayload(correlationId));
  });

  return {
    app,
    db,
    logger,
    registry,
    securityEvents,
    signupCap,
    authConfigured,
    env,
    async close() {
      await pool.end();
    },
  };
}
