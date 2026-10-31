/**
 * Admin token service (S32, issue #33, AC5; D47) — the owner-held operator
 * credential for the admin API/CLI.
 *
 * Rules this module exists to enforce:
 * - The raw token is generated once, DISPLAYED ONCE (the create/rotate
 *   return), and never stored: the table carries only the SHA-256 digest
 *   (hash-only storage, G3).
 * - The digest hint (first 12 hex chars of the digest) identifies a token in
 *   events and CLI output without being token material.
 * - Verification is a constant-time digest comparison; a missing or unknown
 *   token is refused with a reason and recorded as an `admin_auth_rejected`
 *   security event — the presented value is NEVER recorded (G3).
 * - Rotation revokes the previous token immediately (AC5); at most one token
 *   is active at a time, so a lost token is recovered by creating a new one
 *   (a rotation by effect — the old digest stops verifying).
 * - Every raw value the process handles is registered with the secret
 *   registry for value-based redaction (G3: never rendered, never logged).
 *
 * Token creation/rotation are LOCAL operator operations (the CLI on the
 * control-plane host, with database authority). The token never crosses HTTP
 * except as the Bearer credential of the requests it authorizes.
 */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";

import { desc, eq, isNull } from "drizzle-orm";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAdminTokens } from "../db/schema.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import type { SecretRegistry } from "../redaction.ts";
import type { SecurityEventService } from "./security-events.ts";

/** The token prefix makes the credential recognizable in the owner's records
 * without ever carrying meaning about its validity. */
const TOKEN_PREFIX = "shera_admin_";
const TOKEN_BYTES = 32;
const DIGEST_HINT_LENGTH = 12;

export interface AdminTokenCreated {
  /** The raw token — displayed exactly once, never persisted (G3). */
  token: string;
  tokenId: string;
  tokenDigestHint: string;
  createdAt: string;
}

export type AdminTokenVerification =
  { ok: true; tokenId: string } | { ok: false; reason: "missing_token" | "unknown_token" };

export interface AdminTokenServiceDeps {
  db: ControlPlaneDb;
  registry: SecretRegistry;
  securityEvents: SecurityEventService;
}

export class AdminTokenService {
  private readonly deps: AdminTokenServiceDeps;

  constructor(deps: AdminTokenServiceDeps) {
    this.deps = deps;
  }

  /**
   * Create the active token, revoking any previous one (the lost-token
   * recovery is a rotation by effect). Returns the raw token exactly once.
   */
  async create(args: { createdBy: string; correlationId?: string }): Promise<AdminTokenCreated> {
    const raw = this.generateToken();
    const digest = sha256Hex(raw);
    // G3: the raw value is scrubbed from every log and event if it ever
    // reaches one.
    this.deps.registry.register(raw, "admin-api-token");

    const previous = await this.activeToken();
    const inserted = await this.deps.db
      .insert(controlAdminTokens)
      .values({
        tokenSha256: digest,
        tokenDigestHint: digest.slice(0, DIGEST_HINT_LENGTH),
        createdBy: args.createdBy,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("admin token insert returned no row");
    if (previous) {
      await this.deps.db
        .update(controlAdminTokens)
        .set({ revokedAt: new Date() })
        .where(eq(controlAdminTokens.id, previous.id));
    }

    await this.deps.securityEvents.record({
      eventType: "admin_token_created",
      accountId: null,
      details: {
        token_id: row.id,
        token_digest_hint: row.tokenDigestHint,
        created_by: args.createdBy,
        replaced_token_id: previous?.id ?? null,
      },
      correlationId: args.correlationId,
      redactionClass: "restricted",
    });
    return {
      token: raw,
      tokenId: row.id,
      tokenDigestHint: row.tokenDigestHint,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Rotate on demand (AC5): a new active token, the previous one revoked.
   * The previous token stops verifying the moment the new one commits.
   */
  async rotate(args: {
    rotatedBy: string;
    previousTokenId?: string | undefined;
    correlationId?: string;
  }): Promise<AdminTokenCreated> {
    const previous = await this.activeToken();
    if (previous && args.previousTokenId && previous.id !== args.previousTokenId) {
      // The caller presented a stale view of which token is active; refuse
      // rather than silently rotating a token the caller did not verify.
      throw new Error("rotation refused: the presented token is no longer the active one");
    }
    const created = await this.create({ createdBy: args.rotatedBy, ...args });
    await this.deps.securityEvents.record({
      eventType: "admin_token_rotated",
      accountId: null,
      details: {
        token_id: created.tokenId,
        token_digest_hint: created.tokenDigestHint,
        previous_token_id: previous?.id ?? null,
        rotated_by: args.rotatedBy,
      },
      correlationId: args.correlationId,
      redactionClass: "restricted",
    });
    return created;
  }

  /**
   * Verify a presented bearer value. Failures are recorded (reason only —
   * never the presented value) and answered with a typed reason so the HTTP
   * gate can answer the typed 401.
   */
  async verify(presented: string | undefined): Promise<AdminTokenVerification> {
    if (!presented) {
      await this.recordRejection("missing_token");
      return { ok: false, reason: "missing_token" };
    }
    // G3: even a failed attempt's presented value is registered so it can
    // never surface in a later log or event.
    this.deps.registry.register(presented, "admin-api-token");
    const presentedDigest = sha256Hex(presented);
    const expected = await this.activeTokenDigest();
    if (!expected || !digestsEqual(presentedDigest, expected.tokenSha256)) {
      await this.recordRejection("unknown_token");
      return { ok: false, reason: "unknown_token" };
    }
    // Best-effort usage stamp (an audit nicety; failure is contained).
    try {
      await this.deps.db
        .update(controlAdminTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(controlAdminTokens.id, expected.id));
    } catch {
      // The verification answer never depends on the stamp.
    }
    return { ok: true, tokenId: expected.id };
  }

  /** The active token's non-secret identity, or null when none exists. */
  async activeToken(): Promise<{
    id: string;
    tokenDigestHint: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  } | null> {
    const rows = await this.deps.db
      .select({
        id: controlAdminTokens.id,
        tokenDigestHint: controlAdminTokens.tokenDigestHint,
        createdAt: controlAdminTokens.createdAt,
        lastUsedAt: controlAdminTokens.lastUsedAt,
        revokedAt: controlAdminTokens.revokedAt,
      })
      .from(controlAdminTokens)
      .where(isNull(controlAdminTokens.revokedAt))
      .orderBy(desc(controlAdminTokens.createdAt))
      .limit(2);
    // The invariant is "at most one active"; if data ever says otherwise the
    // caller must not quietly pick one — surface the state (G5).
    if (rows.length > 1) {
      throw new Error("multiple active admin tokens exist; resolve the token table before use");
    }
    return rows[0] ?? null;
  }

  private async activeTokenDigest(): Promise<{ id: string; tokenSha256: string } | null> {
    const rows = await this.deps.db
      .select({
        id: controlAdminTokens.id,
        tokenSha256: controlAdminTokens.tokenSha256,
      })
      .from(controlAdminTokens)
      .where(isNull(controlAdminTokens.revokedAt))
      .orderBy(desc(controlAdminTokens.createdAt))
      .limit(2);
    if (rows.length > 1) {
      throw new Error("multiple active admin tokens exist; resolve the token table before use");
    }
    return rows[0] ?? null;
  }

  private async recordRejection(reason: "missing_token" | "unknown_token"): Promise<void> {
    await this.deps.securityEvents.record({
      eventType: "admin_auth_rejected",
      accountId: null,
      details: { reason },
      redactionClass: "restricted",
    });
  }

  private generateToken(): string {
    return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two equal-length hex digests. */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Correlation id helper shared by the admin routes (one definition). */
export function newAdminCorrelationId(): string {
  return randomUUID();
}
