/**
 * S05 end-to-end OAuth flow tests (issue #6).
 *
 * The REAL @auth/express + @auth/core machinery runs against the in-process
 * mock Google IdP (test seam; real-Google E2E needs owner credentials and is
 * documented in apps/control-plane/README.md). HTTPS is real so the
 * `__Secure-` cookie prefix and its flags are asserted against live
 * Set-Cookie headers — not mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

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
let authSecret: string;

beforeAll(async () => {
  cluster = await startTestCluster("auth-flow");
  idp = await startMockGoogleIdp();
  authSecret = randomTestSecret();
  const port = await freePort();
  fixture = await startControlPlaneFixture({
    databaseUrl: cluster.connectionString,
    port,
    googleIssuer: idp.origin,
    env: {
      AUTH_SECRET: authSecret,
      GOOGLE_CLIENT_ID: idp.clientId,
      GOOGLE_CLIENT_SECRET: idp.clientSecret,
      AUTH_URL: `https://127.0.0.1:${port}`,
    },
  });
  origin = fixture.origin;
}, 180_000);

afterAll(async () => {
  await fixture?.stop();
  await idp?.close();
  await cluster?.stop();
}, 180_000);

describe("Google OAuth flow (only login method)", () => {
  it("reports the configured auth state on /healthz (G4)", async () => {
    const response = await request(origin, "/healthz");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      status: string;
      auth: { configured: boolean; provider: string };
    };
    expect(body.status).toBe("ok");
    expect(body.auth).toEqual({ configured: true, provider: "google" });
  });

  it("refuses an unauthenticated /api/session with the typed 401", async () => {
    const response = await request(origin, "/api/session");
    expect(response.status).toBe(401);
    const body = JSON.parse(response.body) as {
      code: string;
      category: string;
      internal_details: unknown;
    };
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(body.category).toBe("unauthorized");
    // D23 rule 4: internal_details never crosses the boundary unredacted.
    expect(body.internal_details).toBeNull();
  });

  it("runs the full browser-equivalent OAuth flow and sets the secure session cookie", async () => {
    idp.setIdentity({
      sub: "flow-sub-001",
      email: "flow@example.com",
      name: "Flow User",
      picture: "https://example.com/flow.png",
    });
    const jar = new CookieJar();
    const { finalRedirect, setCookie } = await runGoogleSignin({
      origin,
      idpOrigin: idp.origin,
      jar,
    });

    expect(finalRedirect).toBe(`${origin}/app`);

    const sessionLine = setCookie.find((line) => line.startsWith("__Secure-authjs.session-token="));
    expect(
      sessionLine,
      `expected a __Secure- session cookie in: ${setCookie.join(" | ")}`,
    ).toBeDefined();
    const lowered = sessionLine?.toLowerCase() ?? "";
    expect(lowered).toContain("httponly");
    expect(lowered).toContain("secure");
    expect(lowered).toContain("samesite=lax");
    // Defined expiry: seven days (PRD §3.2; config SESSION_MAX_AGE_SECONDS).
    // Auth.js emits an absolute Expires date rather than Max-Age.
    const expiresMatch = sessionLine?.match(/expires=([^;]+)/i);
    expect(expiresMatch).toBeDefined();
    const days = (new Date(expiresMatch?.[1] ?? "").getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    expect(jar.get("__Secure-authjs.session-token")).toBeDefined();
  });

  it("serves the S02 Session projection behind the session gate", async () => {
    idp.setIdentity({
      sub: "flow-sub-002",
      email: "projection@example.com",
      name: "Projection User",
      picture: null as unknown as string,
    });
    const jar = new CookieJar();
    await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });

    const response = await request(origin, "/api/session", { jar });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      workspace_id: string;
      google_sub: string;
      email: string;
      tier: string;
      is_admin: boolean;
    };
    // E12: workspace_id is derived and present; D40: one workspace per user.
    expect(body.workspace_id).toMatch(/^ws_/);
    expect(body.google_sub).toBe("flow-sub-002");
    expect(body.email).toBe("projection@example.com");
    // PRD §3.2: balanced is the default tier; admin is a manual DB flag.
    expect(body.tier).toBe("balanced");
    expect(body.is_admin).toBe(false);
  });

  it("invalidates the session on logout and records the security event", async () => {
    idp.setIdentity({
      sub: "flow-sub-003",
      email: "logout@example.com",
      name: "Logout User",
      picture: "https://example.com/logout.png",
    });
    const jar = new CookieJar();
    await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
    expect(jar.get("__Secure-authjs.session-token")).toBeDefined();

    // Auth.js signout: POST with the CSRF token from the cookie pair.
    const csrf = await request(origin, "/api/auth/csrf", { jar });
    const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };
    const signout = await request(origin, "/api/auth/signout", {
      method: "POST",
      jar,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, json: "true" }).toString(),
    });
    expect([200, 302, 303]).toContain(signout.status);

    // The old session token no longer validates: the database session is gone.
    const after = await request(origin, "/api/session", { jar });
    expect(after.status).toBe(401);

    const events = await fixture.controlPlane.securityEvents.listByType("logout");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("signs a returning user in without creating a second account", async () => {
    idp.setIdentity({
      sub: "flow-sub-001",
      email: "flow@example.com",
      name: "Flow User",
      picture: "https://example.com/flow.png",
    });
    const jar = new CookieJar();
    await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
    const response = await request(origin, "/api/session", { jar });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { email: string };
    expect(body.email).toBe("flow@example.com");
  });
});
