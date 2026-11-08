/**
 * S33 admin backup chain (issue #34, D47; the S32 machinery, E38): the admin
 * route → the RuntimeChannelClient → the runtime internal API (channel
 * credential, tenant check) → the runtime's OWN backup mechanism.
 *
 * The take executes the recorded snapshot walk with the control plane's 1:1
 * ref; the restore executes the recorded walk through the composition's
 * stop/start ports (wired here with a SCRATCH target — the drill posture; the
 * prototype production composition wires no ports and answers the honest
 * RESTORE_PORTS_NOT_WIRED refusal). Every control_backups row transitions to
 * a TRUTHFUL status — a refusal is never recorded as a success (G4).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts, controlBackups } from "../src/db/schema.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";
import { FakeContainerBackend } from "@shera-bot/test-kit";
import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
} from "../../user-runtime/src/index.ts";
import {
  composeRuntime,
  type RuntimeHandle,
} from "../../user-runtime/src/transport/local-api/compose.ts";
import { BackupSnapshotsRepository } from "../../user-runtime/src/adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../user-runtime/src/adapters/sqlite/transactions.ts";
import {
  openDatabase,
  verifySnapshotIntegrity,
  type SqliteConnection,
} from "../../user-runtime/src/adapters/sqlite/connection.ts";
import { RestoreService } from "../../user-runtime/src/modules/backups/restore-service.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let adminToken: string;
let runtime: RuntimeHandle;
let runtimeDbDir: string;
const fakeServers: Server[] = [];
const connections: SqliteConnection[] = [];
const scratchDirs: string[] = [];
let runtimeOrigin = "";
let runtimeCredentials: ChannelCredentialStore | undefined;

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken}`, ...extra };
}

beforeAll(async () => {
  // The REAL composed runtime (its admin handle now carries the S33 backup
  // take; the restore ports are wired with a SCRATCH target — the drill
  // posture — so the executed-restore leg is provable end to end).
  runtimeDbDir = mkdtempSync(join(tmpdir(), "s33-runtime-a-"));
  const scratchDataDir = join(runtimeDbDir, "scratch-restored", "data");
  const scratchWorkspaceDir = join(runtimeDbDir, "scratch-restored", "workspace");
  mkdirSync(scratchDataDir, { recursive: true });
  mkdirSync(scratchWorkspaceDir, { recursive: true });
  scratchDirs.push(join(runtimeDbDir, "scratch-restored"));
  // The restore reads the RUNTIME'S OWN ledger (the rows the take wrote) and
  // replaces the SCRATCH target — the drill posture.
  const restoreService: { current?: RestoreService } = { current: undefined };
  runtime = composeRuntime({
    dbPath: join(runtimeDbDir, "runtime.db"),
    workspaceId: `ws_${A}`,
    restorePorts: {
      restoreSnapshot: (input) => {
        const service = restoreService.current;
        if (!service) throw new Error("the restore ports were never wired");
        return service.restoreSnapshot(input);
      },
    },
  });
  const runtimeLedgerConn = openDatabase(join(runtimeDbDir, "runtime.db"));
  connections.push(runtimeLedgerConn);
  restoreService.current = new RestoreService({
    workspaceId: `ws_${A}`,
    dbPath: join(scratchDataDir, "runtime.db"),
    volumeRoots: [scratchWorkspaceDir],
    snapshots: new BackupSnapshotsRepository(new SqliteTransactions(runtimeLedgerConn.db)),
    verifyDatabaseCopy: verifySnapshotIntegrity,
    stopServices: () => {},
    startServices: () => {},
  });

  runtimeCredentials = new ChannelCredentialStore();
  const api = createInternalApi({
    credentials: runtimeCredentials,
    accountId: A,
    localApi: runtime.app,
    adminCommands: runtime.adminCommands,
    securityEvents: new InMemorySecurityEventRecorder(),
  });
  const httpServer = createServer(api.app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  runtimeOrigin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  fakeServers.push(httpServer);

  const backend = new FakeContainerBackend({
    endpointFor: (accountId) => (accountId === A ? runtimeOrigin : null),
    deliverCredential: (accountId, digest) => {
      if (accountId === A) runtimeCredentials?.admitDigest(digest);
    },
  });
  cluster = await startTestCluster("s33-admin-backups");
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
    runtimeBackend: backend,
  });
  await controlPlane.db
    .insert(controlAccounts)
    .values({ id: A, name: "User A33", email: "a33@example.com" })
    .returning();
  await controlPlane.provisioning.ensureProvisioned(A);
  server = await startHttpsApp(controlPlane.app);
  const created = await controlPlane.adminTokens.create({ createdBy: "cli" });
  adminToken = created.token;
}, 240_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  await runtime?.close();
  for (const conn of connections.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  for (const container of fakeServers) {
    await new Promise<void>((resolve) => container.close(() => resolve()));
  }
  for (const dir of [...scratchDirs, runtimeDbDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  await cluster?.stop();
}, 240_000);

interface BackupBody {
  backup_id: string;
  snapshot_ref: string;
  status: string;
  dispatched: string;
}

describe("S33 admin backup chain (take + restore over the recorded channel)", () => {
  it("the trigger EXECUTES: the runtime takes the snapshot under the 1:1 ref and the row reads taken", async () => {
    const response = await request(server.origin, `/api/admin/users/${A}/backups`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as BackupBody;
    expect(body.dispatched).toBe("taken");

    // The control-plane row is TRUTHFUL: taken, with the runtime's stamp.
    const rows = await controlPlane.db
      .select()
      .from(controlBackups)
      .where(eq(controlBackups.id, body.backup_id));
    expect(rows[0]?.status).toBe("taken");
    expect(rows[0]?.snapshotRef).toBe(body.snapshot_ref);

    // The runtime's OWN ledger holds the snapshot under the SAME id,
    // recorded as the ADMIN trigger.
    const ledgerConn = openDatabase(join(runtimeDbDir, "runtime.db"));
    connections.push(ledgerConn);
    const ledger = new BackupSnapshotsRepository(new SqliteTransactions(ledgerConn.db));
    const row = ledger.require(`ws_${A}`, body.snapshot_ref);
    expect(row.triggered_by).toBe("admin");
    expect(row.integrity_status).toBe("ok");
  });

  it("the restore EXECUTES through the wired ports and the row reads restored", async () => {
    const list = await request(server.origin, `/api/admin/users/${A}/backups`, {
      headers: adminHeaders(),
    });
    const backups = (JSON.parse(list.body) as { backups: Array<{ snapshot_ref: string }> }).backups;
    const ref = backups[0]?.snapshot_ref;
    expect(ref).toMatch(/^snapshot_/);

    const response = await request(server.origin, `/api/admin/users/${A}/backups/${ref}/restore`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as BackupBody;
    expect(body.dispatched).toBe("restored");

    const rows = await controlPlane.db
      .select()
      .from(controlBackups)
      .where(eq(controlBackups.snapshotRef, ref));
    expect(rows[0]?.status).toBe("restored");

    // The scratch target (the ports' posture) received the restore: the
    // restored database verifies and the ledger row in it is the snapshot's.
    const scratchDb = join(runtimeDbDir, "scratch-restored", "data", "runtime.db");
    expect(existsSync(scratchDb)).toBe(true);
    expect(verifySnapshotIntegrity(scratchDb).ok).toBe(true);
    expect(readFileSync(scratchDb, "utf8").startsWith("SQLite format 3")).toBe(true);
  });

  it("a restore request for an unknown ref stays the typed 404", async () => {
    const response = await request(
      server.origin,
      `/api/admin/users/${A}/backups/snapshot_00000000-0000-4000-8000-00000000dead/restore`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(response.status).toBe(404);
  });
});
