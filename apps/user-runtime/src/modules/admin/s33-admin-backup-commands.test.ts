/**
 * S33 admin backup commands (issue #34, D47; the S32 machinery, E38): the
 * admin-triggered snapshot and restore through the recorded internal channel.
 *
 * The take's snapshot_ref is the CONTROL PLANE's 1:1 handle — the runtime
 * mints no id of its own for a triggered snapshot (a replayed trigger is the
 * typed `conflict` refusal, never a second snapshot). The restore executes
 * the recorded walk through the composition's stop/start ports; a
 * composition without ports answers the honest RESTORE_PORTS_NOT_WIRED
 * refusal — the operator runbook is the handoff, never a fake restore (G4).
 *
 * The route-level pins run the REAL internal API over real HTTP (the same
 * surface the channel client calls): channel credential, tenant check,
 * contract validation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import {
  RUNTIME_ADMIN_BACKUP_TAKE_PATH,
  RuntimeAdminBackupTakeResponse,
} from "@shera-bot/contracts";

import {
  openDatabase,
  vacuumIntoBackup,
  verifySnapshotIntegrity,
  type SqliteConnection,
} from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { BackupSnapshotsRepository } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { BackupService } from "../backups/backup-service.ts";
import { RestoreService } from "../backups/restore-service.ts";
import { buildRuntimeAdminCommandsHandle } from "./runtime-admin-commands.ts";
import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
} from "../runtime/internal-api.ts";

const WS = "ws_account-1";
const ACTOR = { type: "admin" as const, id: "admin-token:test" };
const REF = "snapshot_a1b2c3d4-0000-4000-8000-00000000000f";

const tempDirs: string[] = [];
const connections: SqliteConnection[] = [];
const servers: Server[] = [];

afterAll(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const conn of connections.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeThrowawayTx(): SqliteTransactions {
  const dir = mkdtempSync(join(tmpdir(), "shera-s33-admin-tx-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "tx.db"));
  connections.push(conn);
  return new SqliteTransactions(conn.db);
}

/** The admin handle's stub deps: the backup legs are the ones under test;
 * the S22/S24/S32 legs are typed no-op stubs (never exercised here). */
function stubHandleDeps(
  extra: Partial<Parameters<typeof buildRuntimeAdminCommandsHandle>[0]> = {},
): Parameters<typeof buildRuntimeAdminCommandsHandle>[0] {
  return {
    listWorkspaceRuns: () => [],
    runCancellation: {
      cancelRun: async () =>
        ({ outcome: "cancelled" }) as unknown as Awaited<
          ReturnType<
            import("../tasks/run-cancellation.service.ts").RunCancellationService["cancelRun"]
          >
        >,
    },
    tx: makeThrowawayTx(),
    journal: { findById: () => null, nextSequence: () => 1, readFrom: () => [] },
    events: {
      appendEvent: <T extends import("../events/events.types.ts").EventType>(
        input: import("../events/events.types.ts").AppendEventInput<T>,
      ) =>
        ({
          event_id: "evt_stub",
          workspace_id: input.workspace_id,
          stream_id: input.stream_id,
          sequence: 1,
          type: input.type,
          occurred_at: new Date().toISOString(),
          correlation_id: null,
          payload: "{}",
        }) as unknown as import("../events/events.types.ts").EventEnvelope<T>,
    },
    runControl: {
      runState: () => null,
      applyRunState: () => {},
    },
    findRunOperation: () => null,
    findChat: () => null,
    ...extra,
  };
}

interface Fixture {
  service: BackupService;
  snapshots: BackupSnapshotsRepository;
  liveDataDir: string;
  workspaceDir: string;
}

function makeFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "shera-s33-admin-"));
  tempDirs.push(parent);
  const liveDataDir = join(parent, "live", "data");
  const workspaceDir = join(parent, "live", "workspace");
  mkdirSync(liveDataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const conn = openDatabase(join(liveDataDir, "runtime.db"));
  connections.push(conn);
  applyMigrations(conn.db);
  const snapshots = new BackupSnapshotsRepository(new SqliteTransactions(conn.db));
  const service = new BackupService({
    workspaceId: WS,
    dbPath: join(liveDataDir, "runtime.db"),
    snapshotRoot: join(parent, "live", "data.snapshots"),
    volumeRoots: [workspaceDir],
    exportDatabase: (target) => vacuumIntoBackup(conn.db, target),
    verifyDatabaseCopy: verifySnapshotIntegrity,
    snapshots,
    now: () => new Date(Date.parse("2026-11-08T00:00:00.000Z")).toISOString(),
  });
  return { service, snapshots, liveDataDir, workspaceDir };
}

describe("S33 admin backup commands (the S32 machinery, D47)", () => {
  it("takeBackup executes the recorded walk with the control-plane ref as the 1:1 snapshot id", async () => {
    const fixture = makeFixture();
    const handle = buildRuntimeAdminCommandsHandle(
      stubHandleDeps({ backupTake: (input) => fixture.service.takeSnapshot(input) }),
    );

    const result = await handle.takeBackup({
      workspaceId: WS,
      snapshotRef: REF,
      actor: ACTOR,
    });
    const parsed = RuntimeAdminBackupTakeResponse.parse(result);
    expect(parsed.taken).toBe(true);
    if (!parsed.taken) return;
    // The 1:1 ref identity: the snapshot IS the control plane's handle.
    expect(parsed.snapshot_id).toBe(REF);
    expect(parsed.taken_at).toBe(new Date(Date.parse("2026-11-08T00:00:00.000Z")).toISOString());

    // The ledger row records the ADMIN trigger.
    const row = fixture.snapshots.require(WS, REF);
    expect(row.triggered_by).toBe("admin");

    // The replayed trigger is the typed conflict — never a second snapshot.
    const replay = await handle.takeBackup({
      workspaceId: WS,
      snapshotRef: REF,
      actor: ACTOR,
    });
    expect(replay.taken).toBe(false);
    if (replay.taken) return;
    expect(replay.reason).toBe("conflict");
    expect(fixture.snapshots.get(WS, REF) !== null).toBe(true);
  });

  it("restoreBackup executes the walk through the wired ports (the drill posture)", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "admin", snapshotRef: REF });
    expect(taken.taken).toBe(true);

    const parent = mkdtempSync(join(tmpdir(), "shera-s33-admin-restore-"));
    tempDirs.push(parent);
    const restoredDataDir = join(parent, "restored", "data");
    const restoredWorkspaceDir = join(parent, "restored", "workspace");
    mkdirSync(restoredDataDir, { recursive: true });
    mkdirSync(restoredWorkspaceDir, { recursive: true });
    // Stale target state the restore must replace.
    writeFileSync(join(restoredDataDir, "runtime.db"), "stale bytes", "utf8");
    writeFileSync(join(restoredWorkspaceDir, "stale.txt"), "stale\n", "utf8");

    const restoreService = new RestoreService({
      workspaceId: WS,
      dbPath: join(restoredDataDir, "runtime.db"),
      volumeRoots: [restoredWorkspaceDir],
      snapshots: fixture.service.snapshots,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      stopServices: () => {},
      startServices: () => {},
    });
    const handle = buildRuntimeAdminCommandsHandle(
      stubHandleDeps({
        restorePorts: {
          restoreSnapshot: (input) => restoreService.restoreSnapshot(input),
          workspaceId: WS,
        },
      }),
    );

    const result = await handle.restoreBackup({
      workspaceId: WS,
      snapshotId: REF,
      actor: ACTOR,
    });
    expect(result.restored).toBe(true);
    if (!result.restored) return;
    expect(result.snapshot_id).toBe(REF);
    // The stale target state was replaced.
    expect(readFileSync(join(restoredDataDir, "runtime.db"), "utf8")).not.toBe("stale bytes");
    expect(existsSync(join(restoredWorkspaceDir, "stale.txt"))).toBe(false);
    // The ledger stamps the restore.
    expect(fixture.snapshots.require(WS, REF).restored_at).toBe(result.restored_at);
  });

  it("restoreBackup without ports is the honest typed refusal (the runbook handoff)", async () => {
    const handle = buildRuntimeAdminCommandsHandle(stubHandleDeps());
    const result = await handle.restoreBackup({
      workspaceId: WS,
      snapshotId: REF,
      actor: ACTOR,
    });
    expect(result.restored).toBe(false);
    if (result.restored) return;
    expect(result.code).toBe("RESTORE_PORTS_NOT_WIRED");
    expect(result.failed_stage).toBe("policy");
    expect(result.replaced_before_failure).toBe(false);
    expect(result.detail).toContain("runbook");
  });
});

describe("S33 admin backup routes (the internal channel surface)", () => {
  async function startApi(
    handle: ReturnType<typeof buildRuntimeAdminCommandsHandle> | undefined,
    accountId?: string,
  ): Promise<{ origin: string; credential: string }> {
    const credentials = new ChannelCredentialStore();
    credentials.admit("channel-token-1");
    const api = createInternalApi({
      credentials,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(handle !== undefined ? { adminCommands: handle } : {}),
      securityEvents: new InMemorySecurityEventRecorder(),
    });
    const server = createServer(api.app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${address.port}`, credential: "channel-token-1" };
  }

  it("serves the admin take over the channel: contract 400, tenant 403, the happy 200", async () => {
    const fixture = makeFixture();
    const handle = buildRuntimeAdminCommandsHandle(
      stubHandleDeps({ backupTake: (input) => fixture.service.takeSnapshot(input) }),
    );
    const { origin, credential } = await startApi(handle, "account-1");
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    };

    // The contract 400 (no actor).
    const bad = await fetch(`${origin}${RUNTIME_ADMIN_BACKUP_TAKE_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace_id: WS, snapshot_ref: REF }),
    });
    expect(bad.status).toBe(400);

    // The tenant 403 (another workspace).
    const foreign = await fetch(`${origin}${RUNTIME_ADMIN_BACKUP_TAKE_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: "ws_account-2",
        snapshot_ref: REF,
        actor: ACTOR,
      }),
    });
    expect(foreign.status).toBe(403);

    // The happy 200: the mechanism's own typed result.
    const ok = await fetch(`${origin}${RUNTIME_ADMIN_BACKUP_TAKE_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace_id: WS, snapshot_ref: REF, actor: ACTOR }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { taken: boolean; snapshot_id?: string };
    expect(body.taken).toBe(true);
    expect(body.snapshot_id).toBe(REF);
  });

  it("an unbound composition fails CLOSED (the typed 503, no skipped tenant check)", async () => {
    const handle = buildRuntimeAdminCommandsHandle(stubHandleDeps());
    const { origin, credential } = await startApi(handle);
    const response = await fetch(`${origin}${RUNTIME_ADMIN_BACKUP_TAKE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ workspace_id: WS, snapshot_ref: REF, actor: ACTOR }),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("INTERNAL_CHANNEL_NOT_BOUND");
  });
});
