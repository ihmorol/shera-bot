# @shera-bot/control-plane

The identity layer (S05, GitHub issue #6): Google OAuth as the only login
method, the server-enforced five-account signup cap, database sessions, the
manually managed administrator flag, and security-event recording — on central
PostgreSQL via Drizzle (D2, PRD §§3.2, 12, 15).

## Layout

```
src/
  index.ts          app factory: ExpressAuth mount, logout audit, typed 404/error boundary
  routes.ts         /healthz, /api/session (gated), /auth/error (S1 refusal + redacted failures)
  config.ts         env references (G3: names only, no literals), SIGNUP_CAP = 5
  auth/             Auth.js adapter + config + session middleware
  db/               Drizzle schema (control_* tables), enums, migration runner
  drizzle/          committed, reviewed SQL migrations (D24: never schema-push)
  modules/          signup cap, security events, session projection (S02 contract)
  redaction.ts      SecretRegistry: value- + key-based scrubbing for logs/events
test/
  helpers/          mock Google OIDC IdP, disposable PostgreSQL 16 cluster, HTTPS fixture
  *.test.ts         OAuth flow, signup cap, schema scope, redaction, admin-flag isolation
```

## Local development

```sh
pnpm install --frozen-lockfile
pnpm --filter @shera-bot/control-plane typecheck
pnpm test                # includes the control-plane integration suite
pnpm start               # needs DATABASE_URL + the auth env below
```

Environment references (`.env.example` documents the names; never commit values):

- `DATABASE_URL` — PostgreSQL connection string
- `AUTH_SECRET` — Auth.js session secret (`openssl rand -base64 32`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `AUTH_URL` — the deployment origin (e.g. `https://localhost:3000`)

## Test harness (no Docker required)

Docker is not usable on this machine (socket permissions), so the integration
suite drives the installed **PostgreSQL 16 server binaries** directly:
`initdb` creates a throwaway user-owned cluster under `/tmp`, `pg_ctl` starts
it on a random localhost port with trust auth, and every suite gets its own
cluster (`test/helpers/pg-cluster.ts`). When Compose arrives (S35) this helper
is the swappable seam.

The OAuth flow tests run the **real** Auth.js machinery against an in-process
mock Google OIDC IdP (`test/helpers/mock-google-idp.ts`: discovery, PKCE
authorization-code flow, RS256 id_token verification via JWKS, token exchange)
over a real self-signed HTTPS listener, so cookie flags and prefixes are
asserted against live `Set-Cookie` headers. The mock IdP is wired through the
factory's documented `googleIssuer` test seam — never set in deployments.

## Owner setup for real-Google verification (pending owner item)

1. Google Cloud Console → Credentials → **OAuth client ID** (Web application).
2. Authorized redirect URI: `<origin>/api/auth/callback/google`.
3. Put the client id/secret + `AUTH_SECRET` into the environment (never in the
   repo). Do **not** set `googleIssuer`.
4. `pnpm start`, open `<origin>/api/auth/signin/google`, and complete the flow.

Until then, `G4` holds: an unconfigured environment reports itself on
`/healthz` (`auth.configured: false`) and every sign-in endpoint returns the
typed `AUTH_CONFIGURATION_INVALID` error — no fake login exists.

## Engineering notes (E-note material for the S05 PR)

- **Auth.js v5 adopted** (`@auth/core` 0.41.3, `@auth/express` 0.12.3,
  `@auth/drizzle-adapter` 1.11.3 — ISC): OAuth dance, PKCE, token lifecycle,
  session cookies, and database sessions are framework-owned. Only
  `createUser` (the signup-cap moment, one transaction) and `linkAccount`
  (token registration for redaction) are overridden on the adapter.
- **No-Docker test cluster** (above) — recorded instead of the issue's
  "Compose service or test container" wording; swappable seam documented.
- **Logout security event**: `@auth/core` 0.41.3 does not emit
  `events.signOut` through the Express adapter path (verified by
  instrumentation on 2026-09-19; the session IS deleted, the event is not).
  A pre-handler on `POST /api/auth/signout` records the audit event and
  registers the dying session token for redaction; the framework still owns
  the signout itself.
- **OpenAPI 3.1 note**: the S02 generator cannot render self-referential JSON
  Schemas; the control-plane responses use the S02 contracts and inherit that
  recorded constraint.
