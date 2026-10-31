/**
 * S32 admin credit top-up tests (issue #33, AC9; D48, D47). The top-up is
 * the recorded unblocking path for a run paused with `insufficient_credits`:
 *
 * - the grant is a durable control-plane record (control_credit_topups) plus
 *   the AC6 audit event;
 * - the runtime applies the top-up over the recorded internal channel by
 *   resuming the workspace's insufficient-credit-paused runs through the
 *   recorded D8 `resume_task` transition (PAUSED → QUEUED, admin actor) —
 *   the S24 credit ledger is NOT built yet, so this is the honest seam
 *   shape: a real grant record + the real recorded resume path, never a
 *   fake balance (G4; pinned in E38).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts, controlCreditTopups } from "../src/db/schema.ts";
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
import { taskStreamId } from "../../../apps/user-runtime/src/modules/tasks/task-events.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";
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

/** Create a run row and drive it into the recorded insufficient-credit pause
 * through the REAL transition machinery (journal task.paused + row write). */
function createInsufficientCreditPausedRun(name: string): string {
  const operationId = runtime.operations.createOperation(WS, {
    definition_ref: null,
    name: `Op ${name}`,
    roster_agent_ids: [AGENT_ID],
    coordinator_agent_id: AGENT_ID,
  }).operation_id;
  const runId = `run_s32_${name}`;
  runtime.operations.createRun(WS, operationId, { run_id: runId });
  runtime.operations.applyRunState(WS, operationId, runId, "QUEUED");
  const applied = applyRowLifecycleTransition(
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
      command: "pause_insufficient_credits",
      actor: { type: "runtime", id: "runtime-gateway" },
    },
  );
  if (!applied.ok) throw new Error(`pause fixture failed: ${applied.reason}`);
  return runId;
}

function runState(runId: string): string | null {
  const operationId = runtime.operations.findRunOperation(WS, runId);
  if (operationId === null) return null;
  return runtime.operations.getRun(WS, operationId, runId).state;
}

beforeAll(async () => {
  cluster = await startTestCluster("admin-credits");
  dbDir = mkdtempSync(join(tmpdir(), "s32-credits-"));
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
  await controlPlane.db
    .insert(controlAccounts)
    .values({ id: A, name: "Credit User", email: "credits@example.com" })
    .returning();
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

describe("admin credit top-up (AC9, D48)", () => {
  it("resumes a run paused with insufficient_credits through the recorded resume path", async () => {
    const pausedRun = createInsufficientCreditPausedRun("paused1");
    expect(runState(pausedRun)).toBe("PAUSED");

    const response = await request(server.origin, `/api/admin/users/${A}/credits/top-up`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ amount: 500, reason: "monthly grant" }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      topup_id: string;
      amount: number;
      resumed_run_ids: string[];
    };
    expect(body.amount).toBe(500);
    expect(body.resumed_run_ids).toContain(pausedRun);

    // The recorded D8 resume: PAUSED → QUEUED through the transition table.
    expect(runState(pausedRun)).toBe("QUEUED");
    const journalTypes = runtime.journal
      .readFrom(WS, taskStreamId(pausedRun), 0, 1_000)
      .map((row) => row.event_type);
    expect(journalTypes).toContain("task.paused");
    expect(journalTypes).toContain("task.resumed");

    // The durable grant record (the credit record the seam consults).
    const grants = await controlPlane.db
      .select()
      .from(controlCreditTopups)
      .where(eq(controlCreditTopups.accountId, A));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.amount).toBe(500);
    expect(grants[0]?.correlationId).toMatch(/[0-9a-f-]{36}/);
  });

  it("does not resume runs paused for other reasons (retry_exhausted is not a credit pause)", async () => {
    const operationId = runtime.operations.createOperation(WS, {
      definition_ref: null,
      name: "Op retryex",
      roster_agent_ids: [AGENT_ID],
      coordinator_agent_id: AGENT_ID,
    }).operation_id;
    const runId = "run_s32_retryex";
    runtime.operations.createRun(WS, operationId, { run_id: runId });
    // Retry exhaustion is a mid-run condition: RUNNING is where the D8 row
    // allows the retry-exhausted pause (QUEUED only pauses on credits).
    runtime.operations.applyRunState(WS, operationId, runId, "RUNNING");
    const paused = applyRowLifecycleTransition(
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
        command: "pause_retry_exhausted",
        actor: { type: "runtime", id: "runtime-gateway" },
      },
    );
    if (!paused.ok) throw new Error(`pause fixture failed: ${paused.reason}`);

    const response = await request(server.origin, `/api/admin/users/${A}/credits/top-up`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ amount: 250 }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      resumed_run_ids: string[];
      skipped: Array<{ run_id: string; reason: string }>;
    };
    expect(body.resumed_run_ids).not.toContain(runId);
    expect(body.skipped).toContainEqual({
      run_id: runId,
      reason: "pause_reason_not_insufficient_credits",
    });
    expect(runState(runId)).toBe("PAUSED");
  });

  it("rejects invalid amounts and unknown accounts with typed errors", async () => {
    const zero = await request(server.origin, `/api/admin/users/${A}/credits/top-up`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ amount: 0 }),
    });
    expect(zero.status).toBe(400);

    const negative = await request(server.origin, `/api/admin/users/${A}/credits/top-up`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ amount: -5 }),
    });
    expect(negative.status).toBe(400);

    const unknown = await request(
      server.origin,
      "/api/admin/users/cccccccc-0000-4000-8000-000000000009/credits/top-up",
      {
        method: "POST",
        headers: adminHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ amount: 5 }),
      },
    );
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).code).toBe("ADMIN_ACCOUNT_NOT_FOUND");
  });

  it("every top-up recorded a security event with actor, action, target, amount (AC6)", async () => {
    const events = await controlPlane.securityEvents.listByType("admin_action");
    const topups = events.filter((event) => event.details["action"] === "credits.topup");
    expect(topups.length).toBeGreaterThanOrEqual(2);
    for (const event of topups) {
      expect(event.details["target"]).toBe(A);
      expect(event.details["actor"]).toMatch(/^admin-token:/);
      expect(typeof event.details["amount"]).toBe("number");
    }
  });
});
