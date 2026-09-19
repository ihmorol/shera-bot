/**
 * Auth.js adapter wiring (D24: repository interfaces above Drizzle; D23 rule
 * 2: SQL lives in the adapter layer). The base is the official
 * @auth/drizzle-adapter mapped onto the control_* tables; only createUser and
 * linkAccount are overridden: createUser is the signup moment (the five-account
 * cap check and the insert run in one transaction, PRD §3.2), and linkAccount
 * is where Google-issued tokens enter the system (registered for redaction, G3).
 */
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter, AdapterUser } from "@auth/core/adapters";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { controlAccounts, controlOauthAccounts, controlSessions } from "../db/schema.ts";
import type { SecretRegistry } from "../redaction.ts";
import { SignupCapRefusedError, type SignupCapService } from "../modules/signup-cap.ts";

export function createSheraAuthAdapter(args: {
  db: NodePgDatabase;
  signupCap: SignupCapService;
  registry: SecretRegistry;
}): Adapter {
  const base = DrizzleAdapter(args.db, {
    usersTable: controlAccounts,
    accountsTable: controlOauthAccounts,
    sessionsTable: controlSessions,
  });
  const baseLinkAccount = base.linkAccount;
  if (!baseLinkAccount) {
    throw new Error("drizzle adapter did not provide linkAccount");
  }

  return {
    ...base,
    async linkAccount(data): Promise<void> {
      // Register issued OAuth token values so value-based redaction can scrub
      // them from every log line and security event (G3).
      args.registry.register(data.access_token, "access-token");
      args.registry.register(data.refresh_token, "refresh-token");
      args.registry.register(data.id_token, "id-token");
      await baseLinkAccount(data);
    },
    async createUser(data): Promise<AdapterUser> {
      try {
        return await args.db.transaction(async (tx) => {
          await args.signupCap.assertCapOpen(tx);
          const [row] = await tx
            .insert(controlAccounts)
            .values({
              name: data.name ?? null,
              email: data.email ?? null,
              emailVerified: data.emailVerified ?? null,
              image: data.image ?? null,
            })
            .returning();
          if (!row || row.email === null) {
            throw new Error("createUser produced an account without an email");
          }
          return {
            id: row.id,
            name: row.name,
            email: row.email,
            emailVerified: row.emailVerified,
            image: row.image,
          };
        });
      } catch (error) {
        if (error instanceof SignupCapRefusedError) {
          // The pre-check in the signIn callback normally refuses first; this
          // is the concurrent-race backstop. The refusal event is recorded on
          // the pool (outside the aborted transaction).
          await args.signupCap.refuse(data.id ?? "unknown", data.email ?? null);
        }
        throw error;
      }
    },
  };
}
