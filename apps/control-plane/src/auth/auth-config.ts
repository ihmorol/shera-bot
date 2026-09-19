/**
 * Auth.js v5 configuration (@auth/express + @auth/core, Google provider,
 * database sessions). Auth.js owns the OAuth dance, token lifecycle, and
 * session cookies — nothing here hand-rolls OAuth (E15 S05 embed).
 *
 * Environment references only (G3): GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 * AUTH_SECRET are read from the injected env. The `googleIssuer` override is a
 * documented TEST SEAM: it points the Google provider's OIDC discovery at an
 * in-process mock IdP so the real provider + core machinery is exercised
 * end-to-end without owner credentials. It must never be set in a deployment.
 */
import Google from "@auth/core/providers/google";
import type { Adapter } from "@auth/core/adapters";
import type { ExpressAuthConfig } from "@auth/express";

import {
  AUTH_BASE_PATH,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  type ControlPlaneEnv,
} from "../config.ts";
import { authJsLogger, type ControlPlaneLogger } from "../logger.ts";
import type { SecretRegistry } from "../redaction.ts";
import type { SecurityEventService } from "../modules/security-events.ts";
import type { SignupCapService } from "../modules/signup-cap.ts";

export interface BuildAuthConfigArgs {
  env: ControlPlaneEnv;
  adapter: Adapter;
  signupCap: SignupCapService;
  securityEvents: SecurityEventService;
  logger: ControlPlaneLogger;
  registry: SecretRegistry;
  /** TEST SEAM ONLY (mock IdP); never set in deployments. */
  googleIssuer?: string;
}

export function buildAuthConfig(args: BuildAuthConfigArgs): ExpressAuthConfig {
  const { env, adapter, signupCap, securityEvents, logger, registry } = args;

  // Register the deployment's credential references for value-based redaction.
  registry.register(env.AUTH_SECRET, "auth-secret");
  registry.register(env.GOOGLE_CLIENT_SECRET, "google-client-secret");

  const config: ExpressAuthConfig = {
    ...(env.AUTH_SECRET ? { secret: env.AUTH_SECRET } : {}),
    basePath: AUTH_BASE_PATH,
    adapter,
    providers: [
      Google({
        // Placeholder strings only ever exist in the UNCONFIGURED state, whose
        // mount the factory replaces with a typed configuration error (G4);
        // they are not credentials and never leave the process.
        clientId: env.GOOGLE_CLIENT_ID ?? "unconfigured-client-id",
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? "unconfigured-client-secret",
        ...(args.googleIssuer ? { issuer: args.googleIssuer } : {}),
      }),
    ],
    session: {
      strategy: "database",
      maxAge: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    // The S1 refusal payload is served by GET /auth/error (typed JSON, not a
    // login screen). Other failures land there redacted as well.
    pages: { error: "/auth/error" },
    trustHost: env.AUTH_URL !== undefined || env.AUTH_TRUST_HOST === "true",
    logger: authJsLogger(logger),
    events: {
      async signIn({ user, isNewUser }) {
        await securityEvents.record({
          eventType: "login_succeeded",
          accountId: user.id ?? null,
          details: { provider: "google", is_new_user: isNewUser },
        });
      },
    },
    callbacks: {
      /**
       * Runs BEFORE account creation for OAuth flows (core calls it with the
       * provider profile when no account is linked yet). Returning users pass;
       * a sixth signup is refused here and recorded as a security event.
       */
      async signIn({ account, profile }) {
        if (account?.provider !== "google") {
          // Google OAuth is the only login method (PRD §3.2).
          return false;
        }
        const existing = await adapter.getUserByAccount?.({
          provider: account.provider,
          providerAccountId: account.providerAccountId,
        });
        if (existing) return true;
        if (!(await signupCap.isSignupAllowed())) {
          await signupCap.refuse(account.providerAccountId, profile?.email ?? null);
          return false;
        }
        return true;
      },
      /** Database sessions: expose the account id on the core session. */
      async session({ session, user }) {
        if (user) {
          session.user.id = user.id;
        }
        return session;
      },
    },
  };

  return config;
}
