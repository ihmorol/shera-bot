/**
 * S32 admin container-lifecycle tests (issue #33; PRD §15). The admin
 * provision/restart/stop/status/usage endpoints drive the SAME recorded
 * provisioning path the user-facing S06 routes use (the ProvisioningService
 * keyed by the targeted account) — the admin authority comes from the token
 * gate, and every action is recorded (AC6).
 *
 * Real channel: each fake container runs the REAL user-runtime internal API
 * with its own credential store, so registration/rotation semantics hold.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts } from "../src/db/schema.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";
import { FakeContainerBackend } from "@shera-bot/test-kit";
import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
} from "../../../apps/user-runtime/src/index.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let backend: FakeContainerBackend;
let adminToken: string;
const fakeServers: Server[] = [];

async function createAccount(id: string) {
  await controlPlane.db
    .insert(controlAccounts)
    .values({ id, name: `User ${id.slice(0, 6)}`, email: `${id.slice(0, 6)}@example.com` })
    .returning();
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken}`, ...extra };
}

beforeAll(async () => {
  cluster = await startTestCluster("admin-containers");
  const credentials = new ChannelCredentialStore();
  const api = createInternalApi({
    credentials,
    securityEvents: new InMemorySecurityEventRecorder(),
  });
  const containerServer = createServer(api.app);
  await new Promise<void>((resolve) => containerServer.listen(0, "127.0.0.1", resolve));
  fakeServers.push(containerServer);
  const containerOrigin = `http://127.0.0.1:${(containerServer.address() as AddressInfo).port}`;

  backend = new FakeContainerBackend({
    endpointFor: (accountId) => (accountId === A ? containerOrigin : null),
    deliverCredential: (accountId, digest) => {
      if (accountId !== A) throw new Error(`no fake container for ${accountId}`);
      credentials.admitDigest(digest);
    },
  });
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
    runtimeBackend: backend,
  });
  await createAccount(A);
  server = await startHttpsApp(controlPlane.app);
  const created = await controlPlane.adminTokens.create({ createdBy: "cli" });
  adminToken = created.token;
}, 180_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  for (const container of fakeServers) {
    await new Promise<void>((resolve) => container.close(() => resolve()));
  }
  await cluster?.stop();
}, 180_000);

describe("admin container lifecycle (issue #33)", () => {
  it("provisions through the recorded path and reports status", async () => {
    const provision = await request(server.origin, `/api/admin/users/${A}/container/provision`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(provision.status).toBe(200);
    const provisioned = JSON.parse(provision.body) as {
      runtime_handle: string;
      provisioning_status: string;
      tier: string;
    };
    expect(provisioned.provisioning_status).toBe("running");
    expect(provisioned.tier).toBe("balanced");
    // The web-facing boundary holds for admin responses too: no container
    // refs, endpoints, or credentials (D12, G3).
    expect(provision.body).not.toContain("container_ref");
    expect(provision.body).not.toContain("internal_endpoint");
    expect(provision.body).not.toContain("internal_channel");

    const status = await request(server.origin, `/api/admin/users/${A}/container/status`, {
      headers: adminHeaders(),
    });
    expect(status.status).toBe(200);
    const statusBody = JSON.parse(status.body) as { provisioning_status: string; health: string };
    expect(statusBody.provisioning_status).toBe("running");
    expect(statusBody.health).toBe("healthy");
  });

  it("restarts and stops through the same recorded path (idempotent, truthful)", async () => {
    const restart = await request(server.origin, `/api/admin/users/${A}/container/restart`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(restart.status).toBe(200);
    expect(JSON.parse(restart.body).provisioning_status).toBe("running");

    const stop = await request(server.origin, `/api/admin/users/${A}/container/stop`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(stop.status).toBe(200);
    expect(JSON.parse(stop.body).provisioning_status).toBe("stopped");

    // Idempotent stop: already-stopped is a truthful success, not an error.
    const stopAgain = await request(server.origin, `/api/admin/users/${A}/container/stop`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(stopAgain.status).toBe(200);
    expect(JSON.parse(stopAgain.body).provisioning_status).toBe("stopped");
  });

  it("reports resource usage as the recorded health/tier view — never invented live metrics", async () => {
    const usage = await request(server.origin, `/api/admin/users/${A}/container/usage`, {
      headers: adminHeaders(),
    });
    expect(usage.status).toBe(200);
    const body = JSON.parse(usage.body) as {
      tier: string;
      provisioning_status: string;
      health: string;
      resource_summary: Record<string, unknown>;
      last_health_check_at: string | null;
    };
    expect(body.tier).toBe("balanced");
    expect(body.resource_summary).toMatchObject({ tier: "balanced" });
    expect(typeof body.last_health_check_at).toBe("string");
  });

  it("an unprovisioned account's status is the typed state error, not a 500", async () => {
    const B = "b1b2c3d4-0000-4000-8000-000000000002";
    await createAccount(B);
    const status = await request(server.origin, `/api/admin/users/${B}/container/status`, {
      headers: adminHeaders(),
    });
    expect(status.status).toBe(409);
    expect(JSON.parse(status.body).code).toBe("RUNTIME_NOT_PROVISIONED");
  });

  it("unknown accounts get the typed 404", async () => {
    const response = await request(
      server.origin,
      "/api/admin/users/cccccccc-0000-4000-8000-000000000009/container/status",
      { headers: adminHeaders() },
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe("ADMIN_ACCOUNT_NOT_FOUND");
  });

  it("every container action recorded a security event with actor, action, target (AC6)", async () => {
    const events = await controlPlane.securityEvents.listByType("admin_action");
    const actions = events.map((event) => event.details["action"]);
    expect(actions).toContain("container.provision");
    expect(actions).toContain("container.restart");
    expect(actions).toContain("container.stop");
    expect(actions).toContain("container.status");
    expect(actions).toContain("container.usage");
    const provisionEvent = events.find(
      (event) => event.details["action"] === "container.provision",
    );
    expect(provisionEvent?.details["target"]).toBe(A);
    expect(provisionEvent?.details["actor"]).toMatch(/^admin-token:/);
  });
});
