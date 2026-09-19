/**
 * Five-account signup cap (PRD §3.2): "Open signup is allowed until five
 * accounts are registered. Signup is refused after the five-account cap."
 *
 * Enforcement is layered so the cap is not bypassable:
 * 1. `isSignupAllowed` — the fast pre-check used by the Auth.js signIn
 *    callback, which runs BEFORE account creation; a refusal records the
 *    security event and produces the exact S1 refusal payload.
 * 2. `assertCapOpen` — the transactional backstop wrapped around the
 *    adapter's createUser: the advisory lock, the count check, and the insert
 *    happen in one transaction, so two concurrent flows cannot both squeeze
 *    past the pre-check.
 */
import { sql, type SQL } from "drizzle-orm";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { SIGNUP_CAP } from "../config.ts";
import { SIGNUP_CAP_REFUSAL_MESSAGE } from "../errors.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import { SecurityEventService } from "./security-events.ts";

/** Typed marker error for the transactional cap backstop. */
export class SignupCapRefusedError extends Error {
  constructor() {
    super("signup cap reached");
    this.name = "SignupCapRefusedError";
  }
}

/**
 * The execute seam shared by a pool database and a transaction; the concrete
 * drizzle types are structurally compatible at this boundary.
 */
export interface QueryExecutorLike {
  execute(query: SQL): Promise<unknown>;
}

/** The exact S1 refusal payload (docs/UI_DESIGN.md S1; no retry affordance). */
export interface SignupCapRefusal {
  code: "SIGNUP_CAP_REACHED";
  category: "policy";
  safe_message: string;
  retryable: false;
  user_action: null;
}

export class SignupCapService {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly securityEvents: SecurityEventService,
    private readonly logger: ControlPlaneLogger,
  ) {}

  /** Current registered-account count (every account consumes a slot). */
  async countAccounts(): Promise<number> {
    return this.countRows(this.db);
  }

  async isSignupAllowed(): Promise<boolean> {
    return (await this.countAccounts()) < SIGNUP_CAP;
  }

  /**
   * Pre-check refusal path: records the security event and returns the exact
   * refusal payload for the S1 state. Never throws.
   */
  async refuse(providerAccountId: string, email: string | null): Promise<SignupCapRefusal> {
    await this.securityEvents.record({
      eventType: "signup_cap_refused",
      accountId: null,
      details: {
        provider: "google",
        provider_account_id: providerAccountId,
        attempted_email: email,
      },
    });
    this.logger.info("signup_cap_refused", { provider_account_id: providerAccountId });
    return {
      code: "SIGNUP_CAP_REACHED",
      category: "policy",
      safe_message: SIGNUP_CAP_REFUSAL_MESSAGE,
      retryable: false,
      user_action: null,
    };
  }

  /**
   * Transactional backstop for the race between the pre-check and the insert.
   * Throws SignupCapRefusedError when the cap filled concurrently; the caller
   * records the refusal event outside the aborted transaction.
   */
  async assertCapOpen(tx: QueryExecutorLike): Promise<void> {
    // Transaction-scoped advisory lock serializes concurrent signups so the
    // count-check and the insert cannot interleave across transactions.
    // D23 rule 2 judgment (recorded on standards review 2026-09-19): this is
    // the one deliberately reviewed raw-SQL site in this module — the
    // advisory lock has no Drizzle-native equivalent, and the count stays
    // raw SQL beside it so both race-control statements are visible in one
    // reviewed place. Repository extraction happens if the module grows.
    await tx.execute(sql`select pg_advisory_xact_lock(918273645)`);
    const count = await this.countRows(tx);
    if (count >= SIGNUP_CAP) {
      throw new SignupCapRefusedError();
    }
  }

  private async countRows(executor: QueryExecutorLike): Promise<number> {
    const result = (await executor.execute(
      sql`select count(*)::text as count from control_accounts`,
    )) as { rows: Array<{ count: string }> };
    return Number(result.rows[0]?.count ?? "0");
  }
}
