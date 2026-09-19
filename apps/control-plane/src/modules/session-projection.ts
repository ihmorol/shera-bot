/**
 * Session projection (S02 contract): maps the control-plane account record
 * onto the shared `Session` schema — the single source of truth for the
 * session/account shape (D2: the control plane owns account identity).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { Session } from "@shera-bot/contracts";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAccounts, controlOauthAccounts } from "../db/schema.ts";

/** One workspace per user in the prototype; the user container IS the workspace. */
export function workspaceIdFor(accountId: string): string {
  return `ws_${accountId}`;
}

/**
 * Load the S02 Session projection for an account. Google OAuth is the only
 * login method, so the OAuth identity join is by provider "google".
 */
export async function loadSessionProjection(
  db: ControlPlaneDb,
  accountId: string,
): Promise<Session> {
  const rows = await db
    .select({
      id: controlAccounts.id,
      email: controlAccounts.email,
      name: controlAccounts.name,
      image: controlAccounts.image,
      tier: controlAccounts.tier,
      isAdmin: controlAccounts.isAdmin,
      createdAt: controlAccounts.createdAt,
      lastActiveAt: controlAccounts.lastActiveAt,
      googleSub: controlOauthAccounts.providerAccountId,
    })
    .from(controlAccounts)
    .leftJoin(controlOauthAccounts, eq(controlOauthAccounts.userId, controlAccounts.id))
    .where(eq(controlAccounts.id, accountId));

  const row = rows[0];
  if (!row) {
    throw new Error(`session projection: account ${accountId} not found`);
  }

  // The projection is validated against the S02 contract at the boundary —
  // a shape drift fails loudly here instead of leaking a malformed session.
  return Session.parse({
    workspace_id: workspaceIdFor(row.id),
    google_sub: row.googleSub ?? "",
    email: row.email ?? "unknown@example.invalid",
    display_name: row.name ?? "Unnamed",
    ...(row.image ? { avatar_url: row.image } : {}),
    tier: row.tier,
    is_admin: row.isAdmin,
    created_at: row.createdAt.toISOString(),
    last_active_at: row.lastActiveAt.toISOString(),
  } satisfies z.input<typeof Session>);
}

/** Touch last_active_at on a validated session read. */
export async function touchLastActive(db: ControlPlaneDb, accountId: string): Promise<void> {
  await db
    .update(controlAccounts)
    .set({ lastActiveAt: new Date() })
    .where(eq(controlAccounts.id, accountId));
}
