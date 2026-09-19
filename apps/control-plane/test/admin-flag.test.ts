/**
 * S05 administrator-flag isolation test (issue #6, PRD §3.2/§15).
 *
 * The administrator status is a manually managed database flag: NO
 * user-facing endpoint can set it, and an unauthenticated probe of the admin
 * surface cannot exist. The audit trail lives in the database trigger
 * (schema-and-migrations.test.ts covers the trigger); this file proves the
 * HTTP surface cannot flip the flag.
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
