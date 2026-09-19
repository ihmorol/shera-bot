/**
 * Environment references (G3): the control plane reads configuration from the
 * environment and never embeds literals for secrets, client credentials, or
 * deployment endpoints. `.env.example` documents the names only.
 *
 * G4: an unconfigured deployment is a first-class state — the factory reports
 * it (`authConfigured`) and sign-in surfaces a typed configuration error
 * instead of a fake login.
 */
export const SIGNUP_CAP = 5;

/** Session lifetime (seconds). Defined expiry: seven days, refreshed daily. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export interface ControlPlaneEnv {
  AUTH_SECRET: string | undefined;
  AUTH_URL: string | undefined;
  AUTH_TRUST_HOST: string | undefined;
  GOOGLE_CLIENT_ID: string | undefined;
  GOOGLE_CLIENT_SECRET: string | undefined;
  DATABASE_URL: string | undefined;
  PORT: string | undefined;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): ControlPlaneEnv {
  return {
    AUTH_SECRET: env.AUTH_SECRET,
    AUTH_URL: env.AUTH_URL,
    AUTH_TRUST_HOST: env.AUTH_TRUST_HOST,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    DATABASE_URL: env.DATABASE_URL,
    PORT: env.PORT,
  };
}

/**
 * Google OAuth is the only login method (PRD §3.2): the deployment is
 * configured for sign-in when all three credential references are present.
 */
export function isAuthConfigured(env: ControlPlaneEnv): boolean {
  return Boolean(env.AUTH_SECRET && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export const AUTH_BASE_PATH = "/api/auth";
