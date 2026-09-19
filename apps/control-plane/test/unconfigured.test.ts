/**
 * S05 unconfigured-state tests (issue #6 via G4): a deployment without OAuth
 * credential references reports itself and refuses sign-in with the typed
 * AUTH_CONFIGURATION_INVALID error — there is no fake login path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { statusForError, authConfigurationError } from "../src/errors.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let origin: string;
let httpServer: import("node:http").Server;

beforeAll(async () => {
  cluster = await startTestCluster("unconfigured");
  // Deliberately NO GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / AUTH_SECRET.
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
  });
  const server = controlPlane.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  httpServer = server;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await controlPlane?.close();
  await cluster?.stop();
}, 180_000);

describe("unconfigured OAuth environment (G4)", () => {
  it("reports auth.configured: false on /healthz", async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { auth: { configured: boolean; provider: string } };
    expect(body.auth.configured).toBe(false);
    expect(body.auth.provider).toBe("google");
  });

  it("refuses sign-in endpoints with the typed configuration error", async () => {
    const expectedStatus = statusForError(authConfigurationError());
    for (const path of ["/api/auth/signin/google", "/api/auth/callback/google"]) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(response.status).toBe(expectedStatus);
      const body = (await response.json()) as {
        code: string;
        category: string;
        internal_details: unknown;
      };
      expect(body.code).toBe("AUTH_CONFIGURATION_INVALID");
      expect(body.internal_details).toBeNull();
    }
  });
});
