/**
 * S05 administrator-flag isolation test (issue #6, PRD §3.2/§15); the admin
 * surface probes updated by S32 (issue #33, E38).
 *
 * The administrator status is a manually managed database flag: NO endpoint
 * can set it, and the HTTP surface cannot flip the flag. The audit trail
 * lives in the database trigger (schema-and-migrations.test.ts covers the
 * trigger).
 *
 * S32 evolution (recorded in E38): `/api/admin` is now the REAL gated admin
 * surface — unauthenticated probes answer the gate's typed 401
 * (ADMIN_UNAUTHENTICATED, auth before routing so the route inventory is
 * never revealed; the rejection is recorded as a security event). That is a
 * STRONGER refusal than the previously pinned 404, and the flag remains
 * unsettable through it (AC7: no write route exists anywhere). Non-admin
 * paths that were never admin surface stay typed 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let origin: string;

beforeAll(async () => {
  cluster = await startTestCluster("admin-flag");
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
  });
  // Plain HTTP listener is enough: these probes never carry a session.
  const server = await new Promise<{ close(): Promise<void> }>((resolve) => {
    const listener = controlPlane.app.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      resolve({
        close: () =>
          new Promise((closeResolve) => {
            listener.close(() => closeResolve());
          }),
      });
    });
  });
  httpServer = server;
}, 180_000);

let httpServer: { close(): Promise<void> };

afterAll(async () => {
  await httpServer?.close();
  await controlPlane?.close();
  await cluster?.stop();
}, 180_000);

describe("no endpoint can set the administrator flag", () => {
  it.each([
    ["POST", "/api/admin"],
    ["PATCH", "/api/admin"],
  ])("%s %s answers the admin gate's typed 401 — the flag is still unsettable (S32)", async (method, path) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_admin: true, isAdmin: true }),
    });
    // The gate refuses before any routing happens (typed 401, AC2's posture:
    // unauthenticated requests get the typed 401 and are recorded) — and
    // there is still no endpoint that sets the flag behind it.
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string; internal_details: unknown };
    expect(body.code).toBe("ADMIN_UNAUTHENTICATED");
    expect(body.internal_details).toBeNull();
  });

  it.each([
    ["POST", "/api/accounts/promote"],
    ["PATCH", "/api/session"],
    ["POST", "/api/session/admin"],
  ])("%s %s does not exist as an admin path", async (method, path) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_admin: true, isAdmin: true }),
    });
    // The route is absent (typed 404) — there is nothing to exploit.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; internal_details: unknown };
    expect(body.code).toBe("ROUTE_NOT_FOUND");
    expect(body.internal_details).toBeNull();
  });
});
