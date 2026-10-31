/**
 * Admin account service (S32, issue #33; PRD §15, §3.2). The account-level
 * admin capabilities as service rules, not route logic:
 *
 * - listUsers: the bounded account directory (the five-account cap bounds it
 *   by design) with the account fields and the container provisioning status
 *   summary. Never a credential column (G3).
 * - disable: sets signup_state = disabled AND deletes every session of the
 *   account — that is what makes the block IMMEDIATE (AC3): the Auth.js
 *   database session store no longer validates the live cookie, the next
 *   request is the typed 401, and the live-transport validation sweep (which
 *   already requires signup_state = active) drops any WebSocket peer.
 * - enable: restores signup_state = active. Sessions stay deleted (the user
 *   signs in again) — a re-enabled account never resurrects a dead cookie.
 * - assignTier: the simulated tier (PRD §3.2; Light/Balanced/Heavy). A tier
 *   change governs NEW provisioning; a running container keeps its recorded
 *   tier until reprovisioned (the response says so — G4, no claimed live
 *   resize the prototype does not perform).
 *
 * Administrator status is NEVER written here (AC7, PRD §3.2): the flag is
 * manually managed SQL, and the 0001 audit trigger records flag changes.
 */
import { desc, eq } from "drizzle-orm";

import { ResourceTier } from "@shera-bot/contracts";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAccounts, controlContainerMappings, controlSessions } from "../db/schema.ts";

export interface AdminUserView {
  id: string;
  email: string | null;
  display_name: string | null;
  tier: ResourceTier;
  signup_state: string;
  is_admin: boolean;
  created_at: string;
  last_active_at: string;
  container_status: string;
}

export class AdminAccountsService {
  constructor(private readonly db: ControlPlaneDb) {}

  /** The account directory. Bounded by the five-account cap; a hard limit
   * keeps the honest bound even if the cap is ever widened. */
  async listUsers(): Promise<{ users: AdminUserView[] }> {
    const rows = await this.db
      .select({
        id: controlAccounts.id,
        email: controlAccounts.email,
        name: controlAccounts.name,
        tier: controlAccounts.tier,
        signupState: controlAccounts.signupState,
        isAdmin: controlAccounts.isAdmin,
        createdAt: controlAccounts.createdAt,
        lastActiveAt: controlAccounts.lastActiveAt,
        provisioningStatus: controlContainerMappings.provisioningStatus,
      })
      .from(controlAccounts)
      .leftJoin(
        controlContainerMappings,
        eq(controlContainerMappings.accountId, controlAccounts.id),
      )
      .orderBy(desc(controlAccounts.createdAt))
      .limit(100);
    return {
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        display_name: row.name,
        tier: row.tier,
        signup_state: row.signupState,
        is_admin: row.isAdmin,
        created_at: row.createdAt.toISOString(),
        last_active_at: row.lastActiveAt.toISOString(),
        container_status: row.provisioningStatus ?? "not_provisioned",
      })),
    };
  }

  /** Disable an account and kill its sessions (AC3: immediate block). */
  async disableAccount(accountId: string): Promise<{ id: string; signup_state: string }> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(controlAccounts)
        .set({ signupState: "disabled" })
        .where(eq(controlAccounts.id, accountId))
        .returning({ id: controlAccounts.id, signupState: controlAccounts.signupState });
      const row = updated[0];
      if (!row) {
        throw new Error(`account ${accountId} vanished during disable`);
      }
      await tx.delete(controlSessions).where(eq(controlSessions.userId, accountId));
      return { id: row.id, signup_state: row.signupState };
    });
  }

  /** Re-enable an account (sessions stay deleted; the user signs in again). */
  async enableAccount(accountId: string): Promise<{ id: string; signup_state: string }> {
    const updated = await this.db
      .update(controlAccounts)
      .set({ signupState: "active" })
      .where(eq(controlAccounts.id, accountId))
      .returning({ id: controlAccounts.id, signupState: controlAccounts.signupState });
    const row = updated[0];
    if (!row) {
      throw new Error(`account ${accountId} vanished during enable`);
    }
    return { id: row.id, signup_state: row.signupState };
  }

  /** Assign the simulated tier (PRD §3.2). Applies to new provisioning. */
  async assignTier(
    accountId: string,
    tier: ResourceTier,
  ): Promise<{ id: string; tier: ResourceTier; applies_at: string }> {
    const updated = await this.db
      .update(controlAccounts)
      .set({ tier })
      .where(eq(controlAccounts.id, accountId))
      .returning({ id: controlAccounts.id, tier: controlAccounts.tier });
    const row = updated[0];
    if (!row) {
      throw new Error(`account ${accountId} vanished during tier assignment`);
    }
    return {
      id: row.id,
      tier: row.tier,
      applies_at: "next_provisioning",
    };
  }
}
