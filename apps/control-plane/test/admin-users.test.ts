/**
 * S32 admin user-management tests (issue #33; PRD §15, §3.2, AC3, AC6, AC7).
 *
 * - The user list, enable/disable, and tier assignment capabilities are
 *   callable on the authenticated admin API (the CLI drives these same
 *   endpoints; the CLI syntax is documented in E38).
 * - AC3: disabling an account blocks its access IMMEDIATELY — tested against
 *   a LIVE session produced by the real OAuth flow (mock IdP seam).
 * - AC6: every admin action records a security event with actor, action,
 *   target, and timestamp.
 * - AC7: administrator status cannot be granted through the API — no route
 *   accepts an is_admin write, and the request body schema rejects it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { eq } from "drizzle-orm";

import { CookieJar, request, runGoogleSignin } from "./helpers/test-server.ts";
import { controlAccounts, controlSessions } from "../src/db/schema.ts";
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
let adminToken: string;
let adminActorTokenId: string;
let accountA: string;
let accountB: string;

beforeAll(async () => {
  cluster = await startTestCluster("admin-users");
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

  // The owner's admin token (created the way the CLI does it — through the
  // token service, never through HTTP).
  const created = await fixture.controlPlane.adminTokens.create({ createdBy: "cli" });
  adminToken = created.token;
  adminActorTokenId = created.tokenId;

  // Account A: a REAL sign-in (live session for the AC3 leg). The signed-in
  // account is resolved from the session projection's workspace binding.
  const jar = new CookieJar();
  await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
  const sessionResponse = await request(origin, "/api/session", { jar });
  if (sessionResponse.status !== 200) {
    throw new Error(`sign-in fixture failed: ${sessionResponse.status}`);
  }
  const workspaceId = (JSON.parse(sessionResponse.body) as { workspace_id: string }).workspace_id;
  accountA = workspaceId.replace(/^ws_/, "");
  globalThis.__s32JarA = jar;

  // Account B: a seeded account (no session).
  accountB = "b1b2c3d4-0000-4000-8000-000000000002";
  await fixture.controlPlane.db
    .insert(controlAccounts)
    .values({
      id: accountB,
      name: "Seeded B",
      email: "seeded-b@example.com",
      tier: "light",
    })
    .returning();
}, 180_000);

afterAll(async () => {
  await fixture?.stop();
  await idp?.close();
  await cluster?.stop();
}, 180_000);

declare global {
  // eslint-disable-next-line no-var
  var __s32JarA: CookieJar | undefined;
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken}`, ...extra };
}

describe("admin user management (issue #33)", () => {
  it("lists users with account fields and container status — and no credential material", async () => {
    const response = await request(origin, "/api/admin/users", { headers: adminHeaders() });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      users: Array<{
        id: string;
        email: string | null;
        display_name: string | null;
        tier: string;
        signup_state: string;
        is_admin: boolean;
        container_status: string;
      }>;
    };
    expect(body.users).toHaveLength(2);
    const a = body.users.find((user) => user.id === accountA);
    const b = body.users.find((user) => user.id === accountB);
    expect(a?.tier).toBe("balanced");
    expect(a?.signup_state).toBe("active");
    expect(a?.is_admin).toBe(false);
    expect(b?.tier).toBe("light");
    // No credential material anywhere in the list (G3): no session tokens, no
    // OAuth token columns, no digests.
    expect(response.body).not.toContain("session_token");
    expect(response.body).not.toContain("access_token");
    expect(response.body).not.toContain("refresh_token");
    expect(response.body).not.toContain("token_sha256");
  });

  it("disabling an account blocks its LIVE session immediately (AC3)", async () => {
    const jar = globalThis.__s32JarA;
    if (!jar) throw new Error("fixture session missing");
    const before = await request(origin, "/api/session", { jar });
    expect(before.status).toBe(200);

    const disable = await request(origin, `/api/admin/users/${accountA}/disable`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(disable.status).toBe(200);

    // The same live cookie is refused right away (AC3 — not at next login).
    const after = await request(origin, "/api/session", { jar });
    expect(after.status).toBe(401);

    // The session store holds no sessions for the disabled account.
    const rows = await fixture.controlPlane.db
      .select()
      .from(controlSessions)
      .where(eq(controlSessions.userId, accountA));
    expect(rows).toHaveLength(0);
  });

  it("re-enabling restores the account (the user signs in again)", async () => {
    const enable = await request(origin, `/api/admin/users/${accountA}/enable`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(enable.status).toBe(200);
    const rows = await fixture.controlPlane.db
      .select()
      .from(controlAccounts)
      .where(eq(controlAccounts.id, accountA));
    expect(rows[0]?.signupState).toBe("active");
  });

  it("assigns a tier (Light / Balanced / Heavy) and refuses invalid ones", async () => {
    const assign = await request(origin, `/api/admin/users/${accountB}/tier`, {
      method: "PUT",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ tier: "heavy" }),
    });
    expect(assign.status).toBe(200);
    const rows = await fixture.controlPlane.db
      .select()
      .from(controlAccounts)
      .where(eq(controlAccounts.id, accountB));
    expect(rows[0]?.tier).toBe("heavy");

    const invalid = await request(origin, `/api/admin/users/${accountB}/tier`, {
      method: "PUT",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ tier: "galactic" }),
    });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).code).toBe("CONTRACT_VALIDATION_FAILED");
  });

  it("unknown target accounts get the typed 404", async () => {
    const response = await request(
      origin,
      "/api/admin/users/cccccccc-0000-4000-8000-000000000009/disable",
      { method: "POST", headers: adminHeaders() },
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe("ADMIN_ACCOUNT_NOT_FOUND");
  });

  it("administrator status cannot be granted through the API or CLI (AC7)", async () => {
    // No route exists for any is_admin write.
    const patch = await request(origin, `/api/admin/users/${accountB}`, {
      method: "PATCH",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ is_admin: true }),
    });
    expect(patch.status).toBe(404);

    // A body that smuggles is_admin is refused by the strict schema.
    const smuggled = await request(origin, `/api/admin/users/${accountB}/tier`, {
      method: "PUT",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ tier: "light", is_admin: true }),
    });
    expect(smuggled.status).toBe(400);

    const rows = await fixture.controlPlane.db
      .select()
      .from(controlAccounts)
      .where(eq(controlAccounts.id, accountB));
    expect(rows[0]?.isAdmin).toBe(false);
  });

  it("every admin action recorded a security event with actor, action, target, timestamp (AC6)", async () => {
    const events = await fixture.controlPlane.securityEvents.listByType("admin_action");
    const actions = events.map((event) => ({
      action: event.details["action"],
      target: event.details["target"],
      actor: event.details["actor"],
      occurredAt: event.occurredAt,
    }));
    const byAction = (name: string) => actions.filter((row) => row.action === name);
    expect(byAction("users.list").length).toBeGreaterThanOrEqual(1);
    expect(byAction("users.disable").length).toBeGreaterThanOrEqual(1);
    expect(byAction("users.enable").length).toBeGreaterThanOrEqual(1);
    expect(byAction("users.assign_tier").length).toBeGreaterThanOrEqual(1);
    for (const row of actions) {
      expect(row.actor).toBe(`admin-token:${adminActorTokenId}`);
      expect(typeof row.target).toBe("string");
      expect(row.occurredAt.getTime()).not.toBeNaN();
    }
    // The disable event targeted account A.
    expect(byAction("users.disable")[0]?.target).toBe(accountA);
  });
});
