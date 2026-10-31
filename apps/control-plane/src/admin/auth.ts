/**
 * Admin API gate (S32, issue #33, AC2; D47). Every /api/admin route sits
 * behind this middleware: the Bearer token is verified against the hash-only
 * token store; a missing, malformed, or unknown token answers the typed 401
 * (the same safe_message for every failure shape — the response never reveals
 * whether a token exists) and the rejection is recorded as a security event.
 *
 * The presented value is registered with the secret registry BEFORE any other
 * handling (G3: it can then never surface in a log, event, or error).
 */
import type { NextFunction, Request, Response } from "express";

import { adminUnauthenticatedError } from "../errors.ts";
import type { AdminTokenService } from "../modules/admin-tokens.ts";

function bearerOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer (.+)$/s.exec(header);
  return match?.[1] || undefined;
}

export function requireAdminToken(args: { tokens: AdminTokenService }) {
  return async function requireAdminToken(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const presented = bearerOf(req.headers.authorization);
    const verification = await args.tokens.verify(presented);
    if (!verification.ok) {
      const error = adminUnauthenticatedError();
      res.status(401).json(error);
      return;
    }
    res.locals.adminToken = { tokenId: verification.tokenId };
    next();
  };
}
