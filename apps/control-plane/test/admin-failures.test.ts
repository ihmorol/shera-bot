/**
 * S32 admin failures-view tests (issue #33; PRD §15 "view recent container
 * and task failures"). The view merges BOTH truth sources honestly:
 *
 * - container failures: the control plane's own security events
 *   (runtime_provision_failed / runtime_operation_failed /
 *   runtime_channel_auth_failed) for the targeted account;
 * - task failures: the runtime's journal over the recorded internal channel —
 *   FAILED and RECOVERY_REQUIRED runs with their failure events. When the
 *   runtime is not reachable the read degrades truthfully (the task-failure
 *   leg says so); it never invents records (G4).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts } from "../src/db/schema.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";
import { FakeContainerBackend } from "@shera-bot/test-kit";
import {
  ChannelCredentialStore,
  createInternalApi,
  InMemorySecurityEventRecorder,
} from "../../../apps/user-runtime/src/index.ts";
import {
  composeRuntime,
  type RuntimeHandle,
} from "../../../apps/user-runtime/src/transport/local-api/compose.ts";
import { OperationsRunSeam } from "../../../apps/user-runtime/src/modules/workers/operations-run-seam.ts";
import { applyRowLifecycleTransition } from "../../../apps/user-runtime/src/modules/tasks/run-lifecycle.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "b1b2c3d4-0000-4000-8000-000000000002";
const WS = `ws_${A}`;
const AGENT_ID = "agent_researcher";
const PACKS_ROOT = resolve(import.meta.dirname, "../../../agent-packs");

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let adminToken: string;
let runtime: RuntimeHandle;
let dbDir = "";
const fakeServers: Server[] = [];

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken}`, ...extra };
}

function createFailedRun(name: string): string {
  const operationId = runtime.operations.createOperation(WS, {
    definition_ref: null,
    name: `Op ${name}`,
    roster_agent_ids: [AGENT_ID],
    coordinator_agent_id: AGENT_ID,
  }).operation_id;
  const runId = `run_s32_${name}`;
  runtime.operations.createRun(WS, operationId, { run_id: runId });
  runtime.operations.applyRunState(WS, operationId, runId, "RUNNING");
  const failed = applyRowLifecycleTransition(
    {
      tx: runtime.tx,
      journal: runtime.journal,
      events: runtime.events,
      operations: runtime.operations,
      runControl: new OperationsRunSeam(runtime.operations),
    },
    {
      workspaceId: WS,
      runId,
      command: "fail_task",
      actor: { type: "runtime", id: "runtime-gateway" },
    },
  );
  if (!failed.ok) throw new Error(`fail fixture failed: ${failed.reason}`);
  return runId;
}

beforeAll(async () => {
  cluster = await startTestCluster("admin-failures");
  dbDir = mkdtempSync(join(tmpdir(), "s32-failures-"));
  runtime = composeRuntime({
    dbPath: join(dbDir, "runtime.db"),
    workspaceId: WS,
    packsRoot: PACKS_ROOT,
  });
  const credentials = new ChannelCredentialStore();
  const api = createInternalApi({
    credentials,
    accountId: A,
    localApi: runtime.app,
    adminCommands: runtime.adminCommands,
    securityEvents: new InMemorySecurityEventRecorder(),
  });
  const containerServer = createServer(api.app);
  await new Promise<void>((resolveListen) => containerServer.listen(0, "127.0.0.1", resolveListen));
  fakeServers.push(containerServer);
  const origin = `http://127.0.0.1:${(containerServer.address() as AddressInfo).port}`;

  const backend = new FakeContainerBackend({
    endpointFor: (accountId) => (accountId === A ? origin : null),
    deliverCredential: (_accountId, digest) => credentials.admitDigest(digest),
  });
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
    runtimeBackend: backend,
  });
  for (const accountId of [A, B]) {
    await controlPlane.db
      .insert(controlAccounts)
      .values({
        id: accountId,
        name: `User ${accountId.slice(0, 4)}`,
        email: `${accountId.slice(0, 6)}@example.com`,
      })
      .returning();
  }
  await controlPlane.provisioning.ensureProvisioned(A);
  server = await startHttpsApp(controlPlane.app);
  const created = await controlPlane.adminTokens.create({ createdBy: "cli" });
  adminToken = created.token;
}, 240_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  runtime?.close();
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  for (const container of fakeServers) {
    await new Promise<void>((resolveClose) => container.close(() => resolveClose()));
  }
  await cluster?.stop();
}, 240_000);

describe("admin failures view (issue #33)", () => {
  it("lists recent container failures from the control plane's own security events", async () => {
    // Produce a REAL provisioning failure for B (no fake container for B).
    const provision = await request(server.origin, `/api/admin/users/${B}/container/provision`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(provision.status).toBe(503);

    const response = await request(server.origin, `/api/admin/users/${B}/failures`, {
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      container_failures: Array<{ event_type: string; occurred_at: string }>;
      task_failures: Array<{ run_id: string; state: string }>;
      task_failures_status: string;
    };
    expect(body.container_failures.length).toBeGreaterThanOrEqual(1);
    expect(body.container_failures[0]?.event_type).toBe("runtime_provision_failed");
    // B has no runtime: the task-failure leg degrades truthfully.
    expect(body.task_failures).toEqual([]);
    expect(body.task_failures_status).toBe("runtime_unavailable");
  });

  it("lists task failures from the runtime journal with their failure events", async () => {
    const failedRun = createFailedRun("failed1");

    const response = await request(server.origin, `/api/admin/users/${A}/failures`, {
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      container_failures: Array<{ event_type: string }>;
      task_failures: Array<{
        run_id: string;
        state: string;
        events: Array<{ type: string; occurred_at: string }>;
      }>;
      task_failures_status: string;
    };
    expect(body.task_failures_status).toBe("ok");
    const record = body.task_failures.find((row) => row.run_id === failedRun);
    expect(record?.state).toBe("FAILED");
    const types = (record?.events ?? []).map((event) => event.type);
    expect(types).toContain("task.failed");

    // Only the targeted user's failures appear (the view is per-account).
    for (const row of body.task_failures) {
      expect(row.run_id).not.toContain("other");
    }
  });

  it("unknown accounts get the typed 404", async () => {
    const response = await request(
      server.origin,
      "/api/admin/users/cccccccc-0000-4000-8000-000000000009/failures",
      { headers: adminHeaders() },
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe("ADMIN_ACCOUNT_NOT_FOUND");
  });

  it("the view itself is audited (AC6)", async () => {
    const events = await controlPlane.securityEvents.listByType("admin_action");
    const views = events.filter((event) => event.details["action"] === "failures.view");
    // Two successful views; the unknown-account attempt is recorded as
    // admin_action_failed (the failure leg of the AC6 wrapper).
    expect(views.length).toBe(2);
    expect(views[0]?.details["actor"]).toMatch(/^admin-token:/);
    const failedAttempts = await controlPlane.securityEvents.listByType("admin_action_failed");
    expect(
      failedAttempts.some(
        (event) =>
          event.details["action"] === "failures.view" &&
          event.details["reason"] === "RuntimeOperationError",
      ),
    ).toBe(true);
  });
});
