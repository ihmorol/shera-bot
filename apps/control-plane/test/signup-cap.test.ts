/**
 * S05 five-account signup-cap tests (issue #6, PRD §3.2).
 *
 * The cap is server-enforced: the signIn callback refuses a NEW identity when
 * five accounts exist, records the refusal as a security event, and Auth.js
 * lands on /auth/error?error=AccessDenied, which serves the exact S1 refusal
 * payload with no retry affordance. Returning users are never refused — the
 * cap limits signups, not sign-ins. The concurrent-race backstop lives in the
 * adapter's createUser override.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

import { controlAccounts, controlOauthAccounts } from "../src/db/schema.ts";
import { CookieJar, request, runGoogleSignin } from "./helpers/test-server.ts";
import { startMockGoogleIdp, type MockIdp } from "./helpers/mock-google-idp.ts";
import {
  randomTestSecret,
  startControlPlaneFixture,
  type ControlPlaneFixture,
} from "./helpers/test-app.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => (address.port > 0 ? resolve(address.port) : reject(new Error("no port"))));
    });
    probe.on("error", reject);
  });
}

let cluster: TestCluster;
let idp: MockIdp;
let fixture: ControlPlaneFixture;
let origin: string;

beforeAll(async () => {
  cluster = await startTestCluster("signup-cap");
  idp = await startMockGoogleIdp();
  const port = await freePort();
  fixture = await startControlPlaneFixture({
    databaseUrl: cluster.connectionString,
    port,
    googleIssuer: idp.origin,
    env: {
      AUTH_SECRET: randomTestSecret(),
      GOOGLE_CLIENT_ID: idp.clientId,
      GOOGLE_CLIENT_SECRET: idp.clientSecret,
      AUTH_URL: `https://127.0.0.1:${port}`,
    },
  });
  origin = fixture.origin;

  // Seed five accounts — the cap is FULL (PRD §3.2: open signup until five).
  await fixture.controlPlane.db.insert(controlAccounts).values(
    Array.from({ length: 5 }, (_, index) => ({
      name: `Seeded User ${index + 1}`,
      email: `seeded-${index + 1}@example.com`,
    })),
  );

  // A returning user among the five, with a linked Google identity.
  const [returning] = await fixture.controlPlane.db
    .insert(controlAccounts)
    .values({ name: "Returning User", email: "returning@example.com" })
    .returning();
  if (!returning) throw new Error("seed failed");
  await fixture.controlPlane.db.insert(controlOauthAccounts).values({
    userId: returning.id,
    type: "oidc",
    provider: "google",
    providerAccountId: "returning-sub-001",
  });
}, 180_000);

afterAll(async () => {
  await fixture?.stop();
  await idp?.close();
  await cluster?.stop();
}, 180_000);

describe("five-account signup cap (server-enforced)", () => {
  it("refuses the sixth signup at the server and serves the exact S1 refusal payload", async () => {
    idp.setIdentity({
      sub: "sixth-sub-001",
      email: "sixth@example.com",
      name: "Sixth User",
      picture: "https://example.com/sixth.png",
    });
    const jar = new CookieJar();
    const { finalRedirect } = await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });

    // Auth.js sends the refused sign-in to the configured error page with
    // AccessDenied; the control plane serves the typed refusal there.
    expect(finalRedirect).toContain("/auth/error?error=AccessDenied");
    const refusal = await request(origin, "/auth/error?error=AccessDenied");
    expect(refusal.status).toBe(403);
    const body = JSON.parse(refusal.body) as {
      code: string;
      category: string;
      safe_message: string;
      retryable: boolean;
      user_action: string | null;
      internal_details: unknown;
    };
    // docs/UI_DESIGN.md S1: exact refusal copy, no retry affordance.
    expect(body.code).toBe("SIGNUP_CAP_REACHED");
    expect(body.category).toBe("policy");
    expect(body.safe_message).toBe("Shera is in private testing and is at its five-account limit.");
    expect(body.retryable).toBe(false);
    expect(body.user_action).toBeNull();
    expect(body.internal_details).toBeNull();

    // No session was established: the refusal is not bypassable by retry.
    expect(jar.get("__Secure-authjs.session-token")).toBeUndefined();
  });

  it("records the refusal as a security event and is not bypassable by a second flow", async () => {
    const before = (await fixture.controlPlane.securityEvents.listByType("signup_cap_refused"))
      .length;

    idp.setIdentity({
      sub: "sixth-sub-002",
      email: "sixth-again@example.com",
      name: "Sixth User Again",
      picture: "https://example.com/sixth2.png",
    });
    const jar = new CookieJar();
    const { finalRedirect } = await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
    expect(finalRedirect).toContain("/auth/error?error=AccessDenied");

    const after = await fixture.controlPlane.securityEvents.listByType("signup_cap_refused");
    expect(after.length).toBeGreaterThan(before);

    const accounts = await fixture.controlPlane.db.select().from(controlAccounts);
    expect(accounts.length).toBe(6); // five seeded + the returning user; no sixth signup
  });

  it("never refuses a returning user (the cap limits signups, not sign-ins)", async () => {
    idp.setIdentity({
      sub: "returning-sub-001",
      email: "returning@example.com",
      name: "Returning User",
      picture: "https://example.com/returning.png",
    });
    const jar = new CookieJar();
    const { finalRedirect } = await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
    expect(finalRedirect).toBe(`${origin}/app`);

    const response = await request(origin, "/api/session", { jar });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { email: string };
    expect(body.email).toBe("returning@example.com");
  });
});
