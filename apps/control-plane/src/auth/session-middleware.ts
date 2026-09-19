/**
 * Session middleware (PRD §3.2 login; E8 test posture). Validation goes
 * through @auth/express `getSession` — the Auth.js core validates the cookie
 * against the database session store; nothing hand-rolled here. A protected
 * route without a valid session returns the typed 401 (S02 taxonomy,
 * safe_message only). A request that carries a session cookie which fails
 * validation is recorded as a security event.
 */
import type { NextFunction, Request, Response } from "express";

import { getSession } from "@auth/express";
import type { ExpressAuthConfig } from "@auth/express";

import { unauthenticatedError, statusForError } from "../errors.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import type { SecretRegistry } from "../redaction.ts";
import { SecurityEventService } from "../modules/security-events.ts";

export const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
] as const;

export function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

function sessionCookieValue(req: Request): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookies.get(name);
    if (value) return value;
  }
  return undefined;
}

export function requireSession(args: {
  authConfig: ExpressAuthConfig;
  securityEvents: SecurityEventService;
  registry: SecretRegistry;
  logger: ControlPlaneLogger;
}) {
  return async function requireSession(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let session: Awaited<ReturnType<typeof getSession>> = null;
    try {
      session = await getSession(req, args.authConfig);
    } catch (error) {
      args.logger.error("session_validation_error", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const userId = session?.user?.id;
    if (session && userId) {
      res.locals.session = session;
      next();
      return;
    }

    const presentedToken = sessionCookieValue(req);
    if (presentedToken) {
      // A credential was presented and failed validation (expired or unknown
      // session token) — the auditable failure mode (PRD §22.18).
      args.registry.register(presentedToken, "session-token");
      await args.securityEvents.record({
        eventType: "session_validation_failed",
        accountId: null,
        details: { reason: "expired_or_unknown_session_token" },
      });
    }

    const error = unauthenticatedError();
    args.logger.info("session_gate_rejected", {
      correlation_id: error.correlation_id,
      had_cookie: presentedToken !== undefined,
    });
    res.status(statusForError(error)).json(error);
  };
}
