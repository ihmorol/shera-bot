/**
 * S32 emergency cancel-all tests (issue #33, AC4). The admin command reaches
 * the runtime's OWN cancellation machinery (S22 RunCancellationService) over
 * the RECORDED internal channel (the S06 authenticated per-container bearer
 * channel — no second channel invented):
 *
 *   control plane admin route → RuntimeChannelClient → runtime internal API
 *   (/internal/v1/admin/cancel-all, channel credential) → the composed
 *   RunCancellationService per non-terminal run (admin actor).
 *
 * The isolation leg (AC4): cancel-all for account A stops A's RUNNING and
 * QUEUED work (parent and queued; children are S22's recursive teardown) and
 * leaves account B's work untouched. Two REAL composed runtimes run behind
 * the fake containers — real SQLite, real journals, real transitions.
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

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "b1b2c3d4-0000-4000-8000-000000000002";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let adminToken: string;
const runtimes = new Map<string, { runtime: RuntimeHandle; dbDir: string; server: Server }>();

const AGENT_ID = "agent_researcher";
const PACKS_ROOT = resolve(import.meta.dirname, "../../../agent-packs");

/**
 * Create a REAL operation run row (the S13 durable record the admin commands
 * and the S22 cancellation walk) in the requested non-terminal state. QUEUED
 * exercises the queued-work leg of AC4; RUNNING the live-work leg.
 */
function createOpRun(
  runtime: RuntimeHandle,
  accountId: string,
  name: string,
  state: "QUEUED" | "RUNNING",
): string {
  const ws = `ws_${accountId}`;
  const operationId = runtime.operations.createOperation(ws, {
    definition_ref: null,
    name: `Op ${name}`,
    roster_agent_ids: [AGENT_ID],
    coordinator_agent_id: AGENT_ID,
  }).operation_id;
  const runId = `run_s32_${name}`;
  runtime.operations.createRun(ws, operationId, { run_id: runId });
  if (state !== "CREATED") {
    runtime.operations.applyRunState(ws, operationId, runId, state);
  }
  return runId;
}

async function startFakeRuntime(accountId: string): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), `s32-runtime-${accountId.slice(0, 4)}-`));
  const runtime = composeRuntime({
    dbPath: join(dbDir, "runtime.db"),
    workspaceId: `ws_${accountId}`,
    packsRoot: PACKS_ROOT,
  });
  const credentials = new ChannelCredentialStore();
  const api = createInternalApi({
    credentials,
    accountId,
    localApi: runtime.app,
    adminCommands: runtime.adminCommands,
    securityEvents: new InMemorySecurityEventRecorder(),
  });
  const httpServer = createServer(api.app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  fakeOrigins.set(accountId, origin);
  fakeCredentials.set(accountId, credentials);
  fakeServers.push(httpServer);
  runtimes.set(accountId, { runtime, dbDir, server: httpServer });
}

const fakeOrigins = new Map<string, string>();
const fakeCredentials = new Map<string, ChannelCredentialStore>();
const fakeServers: Server[] = [];

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken}`, ...extra };
}

beforeAll(async () => {
  cluster = await startTestCluster("admin-cancel-all");
  await startFakeRuntime(A);
  await startFakeRuntime(B);
  const backend = new FakeContainerBackend({
    endpointFor: (accountId) => fakeOrigins.get(accountId) ?? null,
    deliverCredential: (accountId, digest) => {
      fakeCredentials.get(accountId)?.admitDigest(digest);
    },
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
    await controlPlane.provisioning.ensureProvisioned(accountId);
  }
  server = await startHttpsApp(controlPlane.app);
  const created = await controlPlane.adminTokens.create({ createdBy: "cli" });
  adminToken = created.token;
}, 240_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  for (const entry of runtimes.values()) {
    await entry.runtime.close();
    rmSync(entry.dbDir, { recursive: true, force: true });
  }
  for (const container of fakeServers) {
    await new Promise<void>((resolve) => container.close(() => resolve()));
  }
  await cluster?.stop();
}, 240_000);

function runState(accountId: string, runId: string): string | null {
  const runtime = runtimes.get(accountId)?.runtime;
  if (!runtime) throw new Error(`no runtime for ${accountId}`);
  const operationId = runtime.operations.findRunOperation(`ws_${accountId}`, runId);
  if (operationId === null) return null;
  return runtime.operations.getRun(`ws_${accountId}`, operationId, runId).state;
}

describe("emergency cancel-all for one user (AC4)", () => {
  it("stops the targeted user's RUNNING and QUEUED work and leaves other users untouched", async () => {
    // Account A: one RUNNING run, one QUEUED run.
    const runningA = createOpRun(runtimes.get(A)!.runtime, A, "a1", "RUNNING");
    const queuedA = createOpRun(runtimes.get(A)!.runtime, A, "a2", "QUEUED");
    // Account B: work that must survive (isolation).
    const runningB = createOpRun(runtimes.get(B)!.runtime, B, "b1", "RUNNING");
    const queuedB = createOpRun(runtimes.get(B)!.runtime, B, "b2", "QUEUED");

    // Sanity: the scripted work is where the test needs it.
    expect(runState(A, runningA)).toBe("RUNNING");
    expect(runState(A, queuedA)).toBe("QUEUED");
    expect(runState(B, runningB)).toBe("RUNNING");

    const response = await request(server.origin, `/api/admin/users/${A}/emergency-cancel`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      workspace_id: string;
      results: Array<{ run_id: string; outcome: string }>;
    };
    expect(body.workspace_id).toBe(`ws_${A}`);
    const outcomes = new Map(body.results.map((row) => [row.run_id, row.outcome]));
    expect(outcomes.get(runningA)).toBe("cancelled");
    expect(outcomes.get(queuedA)).toBe("cancelled");

    // A's work stopped through the real cancellation machinery.
    expect(runState(A, runningA)).toBe("CANCELLED");
    expect(runState(A, queuedA)).toBe("CANCELLED");

    // B's work is untouched (AC4 isolation).
    expect(runState(B, runningB)).toBe("RUNNING");
    expect(runState(B, queuedB)).toBe("QUEUED");

    // The cancel walked the recorded D8 two-step on the parent.
    const events = runtimes
      .get(A)!
      .runtime.runControl.listRunEvents({ workspaceId: `ws_${A}`, runId: runningA });
    const types = events.map((event) => event.type);
    expect(types).toContain("task.cancelling");
    expect(types).toContain("task.cancelled");
  });

  it("is idempotent: a second cancel-all answers the typed already-terminal outcomes", async () => {
    const response = await request(server.origin, `/api/admin/users/${A}/emergency-cancel`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      results: Array<{ run_id: string; outcome: string }>;
    };
    for (const row of body.results) {
      expect(["already_cancelled", "already_settled"]).toContain(row.outcome);
    }
  });

  it("records the emergency action with actor, action, target (AC6)", async () => {
    const events = await controlPlane.securityEvents.listByType("admin_action");
    const cancel = events.find((event) => event.details["action"] === "emergency.cancel_all");
    expect(cancel?.details["target"]).toBe(A);
    expect(cancel?.details["actor"]).toMatch(/^admin-token:/);
    expect(cancel?.details["cancelled_count"]).toBe(2);
  });

  it("unknown accounts get the typed 404", async () => {
    const response = await request(
      server.origin,
      "/api/admin/users/cccccccc-0000-4000-8000-000000000009/emergency-cancel",
      { method: "POST", headers: adminHeaders() },
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe("ADMIN_ACCOUNT_NOT_FOUND");
  });
});
