/**
 * S33 restore-service tests (issue #34: "stop container services → verify
 * the snapshot's integrity → replace the local database and workspace mounts
 * → restart"; DEV_WORKFLOW Stage 8's restore drill; E11, D24, G3/G4).
 *
 * The restore walk is TYPED at every stage: the restore-candidate policy
 * (a corrupt snapshot can never be restored — the alert-marked or
 * integrity-failed row is refused BEFORE services are even stopped), the
 * stop posture runs FIRST among mutating stages, the snapshot FILE is
 * re-verified after the stop (it can rot between the ledger and the disk —
 * a refusal here raises the alert), the database and workspace volume are
 * REPLACED (stale -wal/-shm removed, stale volume entries cleared — the
 * excluded names are never deleted), migrations run over the restored file
 * (D24 — applyMigrations is idempotent, so "if required" is "always attempt"
 * with the honest before/after versions), restart runs LAST, and the ledger
 * row is stamped restored_at.
 *
 * NOTHING is touched on a refusal: the target database and volume keep
 * their pre-restore bytes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  openDatabase,
  vacuumIntoBackup,
  verifySnapshotIntegrity,
  type SqliteConnection,
} from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { BackupSnapshotsRepository } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { BackupService } from "./backup-service.ts";
import { SnapshotVerifier } from "./snapshot-verifier.ts";
import { RestoreService } from "./restore-service.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

afterAll(() => {
  for (const conn of openConnections.splice(0)) {
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

const WS = "ws-local-default";
const BASE_MS = Date.parse("2026-11-07T00:00:00.000Z");

interface Fixture {
  service: BackupService;
  verifier: SnapshotVerifier;
  /** The "live" data dir (the snapshot's source). */
  liveDataDir: string;
  /** The "live" workspace volume dir. */
  liveWorkspaceDir: string;
  snapshotRoot: string;
  clock: { tick: number };
}

/** A snapshot source: a migrated database, a workspace volume with one
 * seeded file, one snapshot taken. */
function makeFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "shera-s33-restore-"));
  tempDirs.push(parent);
  const liveDataDir = join(parent, "live", "data");
  const liveWorkspaceDir = join(parent, "live", "workspace");
  const snapshotRoot = `${liveDataDir}.snapshots`;
  mkdirSync(liveDataDir, { recursive: true });
  mkdirSync(liveWorkspaceDir, { recursive: true });
  const conn = openDatabase(join(liveDataDir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  writeFileSync(join(liveWorkspaceDir, "seeded.txt"), "seeded-content\n", "utf8");

  const clock = { tick: 1 };
  const service = new BackupService({
    workspaceId: WS,
    dbPath: join(liveDataDir, "runtime.db"),
    snapshotRoot,
    volumeRoots: [liveWorkspaceDir],
    exportDatabase: (target) => vacuumIntoBackup(conn.db, target),
    verifyDatabaseCopy: verifySnapshotIntegrity,
    snapshots: new BackupSnapshotsRepository(new SqliteTransactions(conn.db)),
    now: () => new Date(BASE_MS + clock.tick * 3_600_000).toISOString(),
  });
  const verifier = new SnapshotVerifier({
    workspaceId: WS,
    verifyDatabaseCopy: verifySnapshotIntegrity,
    snapshots: service.snapshots,
  });
  return { service, verifier, liveDataDir, liveWorkspaceDir, snapshotRoot, clock };
}

/** A scratch restore target: a STALE database (garbage bytes plus stale
 * -wal/-shm siblings) and a STALE workspace file — everything the restore
 * must replace or remove. */
function makeScratchTarget(parent: string): { dataDir: string; workspaceDir: string } {
  const dataDir = join(parent, "scratch", "data");
  const workspaceDir = join(parent, "scratch", "workspace");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const dbPath = join(dataDir, "runtime.db");
  writeFileSync(dbPath, "this is not a database file", "utf8");
  writeFileSync(`${dbPath}-wal`, "stale wal", "utf8");
  writeFileSync(`${dbPath}-shm`, "stale shm", "utf8");
  writeFileSync(join(workspaceDir, "stale-after-snapshot.txt"), "stale\n", "utf8");
  return { dataDir, workspaceDir };
}

interface Harness {
  restore: RestoreService;
  order: string[];
  faults: string[];
  target: { dataDir: string; workspaceDir: string };
}

function makeRestoreHarness(fixture: Fixture, snapshotId: string, targetParent: string): Harness {
  const order: string[] = [];
  const faults: string[] = [];
  const target = makeScratchTarget(targetParent);
  const restore = new RestoreService({
    workspaceId: WS,
    dbPath: join(target.dataDir, "runtime.db"),
    volumeRoots: [target.workspaceDir],
    snapshots: fixture.service.snapshots,
    verifyDatabaseCopy: verifySnapshotIntegrity,
    stopServices: () => {
      order.push("stopped");
    },
    startServices: () => {
      order.push("started");
    },
    now: () => new Date(BASE_MS + 12 * 3_600_000).toISOString(),
    logFault: (event, fields) => {
      faults.push(JSON.stringify({ event, ...fields }));
    },
    onStage: (stage) => {
      order.push(stage);
    },
  });
  return { restore, order, faults, target };
}

describe("the S33 restore walk (stop → verify → replace → restart, typed)", () => {
  it("restores a healthy snapshot into a scratch copy: stop first, start last, the stale state replaced, the ledger stamped", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;
    const snapshotId = taken.snapshot_id;

    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const harness = makeRestoreHarness(fixture, snapshotId, targetParent);

    const result = await harness.restore.restoreSnapshot({ snapshotId });
    expect(result.restored).toBe(true);
    if (!result.restored) return;

    // The stage order: policy → stop → verify → database → volume →
    // migrations → restart (the issue's posture; the policy gates BEFORE the
    // stop — services are never taken down for a snapshot that can never
    // restore). The "stopped"/"started" markers are the stop/start CALLBACKS
    // themselves, pinned between their stages.
    expect(harness.order).toEqual([
      "policy",
      "stop",
      "stopped",
      "verify",
      "database",
      "volume",
      "migrations",
      "restart",
      "started",
    ]);
    expect(result.snapshot_id).toBe(snapshotId);
    expect(result.restored_at).toBe(new Date(BASE_MS + 12 * 3_600_000).toISOString());

    // The scratch database is the SNAPSHOT's database: it opens, migrates,
    // verifies, and carries the schema (not the stale garbage bytes).
    const dbPath = join(harness.target.dataDir, "runtime.db");
    expect(readFileSync(dbPath, "utf8").startsWith("this is not a database")).toBe(false);
    // The walk left NO stale WAL siblings — asserted BEFORE the verification
    // read below: the readonly verification open creates its own (empty)
    // WAL read-view pair, a read artifact, never stale state.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(verifySnapshotIntegrity(dbPath).ok).toBe(true);

    // The scratch workspace is the SNAPSHOT's volume: the seeded file is
    // back, the post-snapshot stale file is GONE (the replace semantics).
    expect(readFileSync(join(harness.target.workspaceDir, "seeded.txt"), "utf8")).toBe(
      "seeded-content\n",
    );
    expect(existsSync(join(harness.target.workspaceDir, "stale-after-snapshot.txt"))).toBe(false);

    // The honest migration record (the head at snapshot time, the head after).
    expect(result.migrated_from).toEqual(expect.arrayContaining([23]));
    expect(result.migrated_to).toEqual(result.migrated_from);

    // The ledger stamps the restore.
    const row = fixture.service.snapshots.require(WS, snapshotId);
    expect(row.restored_at).toBe(result.restored_at);
  });

  it("an alert-marked snapshot is refused at the policy gate: typed, nothing touched, services never stopped", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;
    // The deliberate corruption + the verifier's alert (the same refusal the
    // scheduled check demonstrates).
    const dbPath = join(taken.snapshot_dir, "runtime.db");
    const damaged = Buffer.from(readFileSync(dbPath));
    damaged.write("DAMAGED-HEADER-PADDING!!", 0, 24, "utf8");
    writeFileSync(dbPath, damaged);
    const outcomes = fixture.verifier.verifyRetainedWindow();
    expect(outcomes[0]?.verified).toBe(false);

    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const harness = makeRestoreHarness(fixture, taken.snapshot_id, targetParent);
    const staleBytes = readFileSync(join(harness.target.dataDir, "runtime.db"));

    const result = await harness.restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(result.restored).toBe(false);
    if (result.restored) return;
    expect(result.failed_stage).toBe("policy");
    expect(result.code).toBe("RESTORE_SNAPSHOT_CORRUPT");
    // Services were NEVER stopped (the policy gates before the posture) and
    // the target keeps its pre-restore bytes.
    expect(harness.order).toEqual(["policy"]);
    expect(readFileSync(join(harness.target.dataDir, "runtime.db"))).toEqual(staleBytes);
    expect(existsSync(join(harness.target.workspaceDir, "stale-after-snapshot.txt"))).toBe(true);
  });

  it("a snapshot whose FILE fails verification at restore time is refused after the stop: alert raised, nothing replaced", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;
    // The file rots AFTER the ledger row was written clean (no alert yet —
    // the scheduled check has not run).
    const dbPath = join(taken.snapshot_dir, "runtime.db");
    const damaged = Buffer.from(readFileSync(dbPath));
    damaged.write("DAMAGED-HEADER-PADDING!!", 0, 24, "utf8");
    writeFileSync(dbPath, damaged);

    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const harness = makeRestoreHarness(fixture, taken.snapshot_id, targetParent);
    const staleBytes = readFileSync(join(harness.target.dataDir, "runtime.db"));

    const result = await harness.restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(result.restored).toBe(false);
    if (result.restored) return;
    // The stop posture ran (the file is only checked when services are
    // down), the verify stage refused, the alert was raised on the row.
    expect(harness.order).toEqual(["policy", "stop", "stopped", "verify"]);
    expect(result.failed_stage).toBe("verify");
    expect(result.code).toBe("RESTORE_SNAPSHOT_CORRUPT");
    expect(harness.faults.some((line) => line.includes("backup_restore_refused"))).toBe(true);
    const row = fixture.service.snapshots.require(WS, taken.snapshot_id);
    expect(row.alert).not.toBeNull();
    expect(readFileSync(join(harness.target.dataDir, "runtime.db"))).toEqual(staleBytes);
  });

  it("an unknown snapshot id is a typed policy refusal", async () => {
    const fixture = makeFixture();
    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const harness = makeRestoreHarness(
      fixture,
      "snapshot_00000000-0000-4000-8000-000000000000",
      targetParent,
    );
    const result = await harness.restore.restoreSnapshot({
      snapshotId: "snapshot_00000000-0000-4000-8000-000000000000",
    });
    expect(result.restored).toBe(false);
    if (result.restored) return;
    expect(result.failed_stage).toBe("policy");
    expect(result.code).toBe("RESTORE_SNAPSHOT_NOT_FOUND");
    expect(harness.order).toEqual(["policy"]);
  });

  it("never deletes a custody key from the restore target (the delete leg's D22/E9)", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;

    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const harness = makeRestoreHarness(fixture, taken.snapshot_id, targetParent);
    // The live custody keys are NEVER in a snapshot (D22/E9) — the restore's
    // replace must leave them standing (the runbook copies them back from the
    // pre-restore archive; the walk must not be what removes them).
    writeFileSync(join(harness.target.workspaceDir, "provider-credentials.key"), "live-custody");
    writeFileSync(join(harness.target.dataDir, "project-credentials.key"), "live-custody");

    const result = await harness.restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(result.restored).toBe(true);
    if (!result.restored) return;
    expect(
      readFileSync(join(harness.target.workspaceDir, "provider-credentials.key"), "utf8"),
    ).toBe("live-custody");
    expect(readFileSync(join(harness.target.dataDir, "project-credentials.key"), "utf8")).toBe(
      "live-custody",
    );
  });

  it("a tampered sidecar manifest entry is refused typed (never writes outside the restore root)", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;
    // The tamper (the review P3c): an attacker-controlled snapshot directory
    // — a manifest row naming a path OUTSIDE the captured roots, with the
    // payload staged where the reverse mapping would read it.
    const sidecarPath = join(taken.snapshot_dir, "snapshot.json");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      volume_entries: string[];
    };
    sidecar.volume_entries = ["0:../../exfil"];
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    writeFileSync(join(taken.snapshot_dir, "volume", "exfil"), "exfiltrated-bytes", "utf8");

    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const harness = makeRestoreHarness(fixture, taken.snapshot_id, targetParent);

    const result = await harness.restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(result.restored).toBe(false);
    if (result.restored) return;
    expect(result.failed_stage).toBe("volume");
    expect(result.code).toBe("RESTORE_VOLUME_FAILED");
    // Nothing landed outside the restore root (the workspace's grandparent
    // is where the tampered row pointed).
    expect(existsSync(join(targetParent, "exfil"))).toBe(false);
  });

  it("a stop failure refuses typed before anything is touched", async () => {
    const fixture = makeFixture();
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;

    const targetParent = mkdtempSync(join(tmpdir(), "shera-s33-restore-target-"));
    tempDirs.push(targetParent);
    const target = makeScratchTarget(targetParent);
    const staleBytes = readFileSync(join(target.dataDir, "runtime.db"));
    const faults: string[] = [];
    const restore = new RestoreService({
      workspaceId: WS,
      dbPath: join(target.dataDir, "runtime.db"),
      volumeRoots: [target.workspaceDir],
      snapshots: fixture.service.snapshots,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      stopServices: () => {
        throw new Error("the container supervisor refused the stop");
      },
      startServices: () => {},
      logFault: (event, fields) => {
        faults.push(JSON.stringify({ event, ...fields }));
      },
    });
    const result = await restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(result.restored).toBe(false);
    if (result.restored) return;
    expect(result.failed_stage).toBe("stop");
    expect(result.code).toBe("RESTORE_STOP_FAILED");
    expect(faults.some((line) => line.includes("backup_restore_refused"))).toBe(true);
    expect(readFileSync(join(target.dataDir, "runtime.db"))).toEqual(staleBytes);
  });
});
