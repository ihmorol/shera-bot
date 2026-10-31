/**
 * S32 admin backup-trigger tests (issue #33; PRD §12, §15; E11). This slice
 * wires the trigger and the command surface; the snapshot/restore MECHANISM
 * arrives with S33 (E17's `VACUUM INTO` + integrity check). The trigger is
 * honest by construction (G4): it records the request durably (control_backups
 * + security event) and its response never claims a snapshot completed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts, controlBackups } from "../src/db/schema.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let adminToken: string;

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
  cluster = await startTestCluster("admin-backups");
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
  });
  await createAccount(A);
  server = await startHttpsApp(controlPlane.app);
  const created = await controlPlane.adminTokens.create({ createdBy: "cli" });
  adminToken = created.token;
}, 180_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  await cluster?.stop();
}, 180_000);

describe("admin backup trigger and restore request (issue #33)", () => {
  it("triggers a backup: durable control_backups record + event, honest status", async () => {
    const response = await request(server.origin, `/api/admin/users/${A}/backups`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      backup_id: string;
      snapshot_ref: string;
      status: string;
    };
    expect(body.status).toBe("requested");
    expect(body.snapshot_ref).toMatch(/^snapshot_/);
    expect(body.backup_id).toMatch(/[0-9a-f-]{36}/);

    const rows = await controlPlane.db
      .select()
      .from(controlBackups)
      .where(eq(controlBackups.id, body.backup_id));
    expect(rows[0]?.accountId).toBe(A);
    expect(rows[0]?.status).toBe("requested");
    expect(rows[0]?.snapshotRef).toBe(body.snapshot_ref);

    // The response never claims the snapshot completed (G4 — the mechanism is
    // S33's; the row says requested, and no "completed" language appears).
    expect(response.body).not.toContain("completed");
  });

  it("lists the recorded backups for the account", async () => {
    const response = await request(server.origin, `/api/admin/users/${A}/backups`, {
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      backups: Array<{ snapshot_ref: string; status: string }>;
    };
    expect(body.backups.length).toBeGreaterThanOrEqual(1);
    expect(body.backups[0]?.snapshot_ref).toMatch(/^snapshot_/);
  });

  it("requests a restore of one recorded snapshot — refused honestly for an unknown ref", async () => {
    // Unknown snapshot ref: typed 404, nothing recorded as restored.
    const unknown = await request(
      server.origin,
      `/api/admin/users/${A}/backups/snapshot_does-not-exist/restore`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).code).toBe("ADMIN_SNAPSHOT_NOT_FOUND");

    // A recorded snapshot: the restore REQUEST is recorded (S33 performs it).
    const list = await request(server.origin, `/api/admin/users/${A}/backups`, {
      headers: adminHeaders(),
    });
    const snapshotRef = (JSON.parse(list.body) as { backups: Array<{ snapshot_ref: string }> })
      .backups[0].snapshot_ref;
    const restore = await request(
      server.origin,
      `/api/admin/users/${A}/backups/${snapshotRef}/restore`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(restore.status).toBe(200);
    const body = JSON.parse(restore.body) as { snapshot_ref: string; status: string };
    expect(body.snapshot_ref).toBe(snapshotRef);
    expect(body.status).toBe("restore_requested");
    expect(restore.body).not.toContain("restored successfully");

    const rows = await controlPlane.db
      .select()
      .from(controlBackups)
      .where(eq(controlBackups.snapshotRef, snapshotRef));
    expect(rows[0]?.status).toBe("restore_requested");
  });

  it("unknown accounts get the typed 404", async () => {
    const response = await request(
      server.origin,
      "/api/admin/users/cccccccc-0000-4000-8000-000000000009/backups",
      { headers: adminHeaders() },
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe("ADMIN_ACCOUNT_NOT_FOUND");
  });

  it("every backup action recorded a security event (AC6)", async () => {
    const events = await controlPlane.securityEvents.listByType("admin_action");
    const actions = events.map((event) => event.details["action"]);
    expect(actions).toContain("backups.trigger");
    expect(actions).toContain("backups.restore_requested");
    const restore = events.find((event) => event.details["action"] === "backups.restore_requested");
    expect(restore?.details["snapshot_ref"]).toMatch(/^snapshot_/);
  });
});
