/**
 * S33 backup mechanism tests (issue #34; PRD §12, E11, E17, D22, D24, G3/G4).
 *
 * The recorded mechanism (E17's final call on E11): a consistent database
 * copy produced with the recorded export helper (taken on the live WAL
 * connection — the copy is self-contained and carries WAL-resident writes),
 * verified at snapshot time with the recorded integrity statement, and the
 * workspace volume (private folders, projects, browser profile) captured
 * beside it. The credential KEY FILES are excluded from the volume snapshot
 * (D22/E9: keys are excluded from backups unless explicitly encrypted and
 * authorized — the sealed ciphertext rows ride the database copy, the usable
 * key material does not ride the volume), and the exclusion is asserted here
 * by inspection, never assumed.
 *
 * Real SQLite, real filesystem, fixed clock. Vocabulary: Pack → Operations →
 * Agents (G1).
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  openDatabase,
  verifySnapshotIntegrity,
  vacuumIntoBackup,
  type SqliteConnection,
} from "../../adapters/sqlite/connection.ts";
import { applyMigrations, appliedMigrationVersions } from "../../adapters/sqlite/migrations.ts";
import { BackupSnapshotsRepository } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";
import { BackupService, BackupServiceError } from "./backup-service.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const CLOCK = "2026-11-07T12:00:00.000Z";

/**
 * A secret-shaped fixture (the S23 custody-scan shape): if the volume
 * snapshot ever leaks usable credential material, the byte scan finds THIS.
 */
const SECRET_FIXTURE = `sk-prod-${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0"}u1V2`;
const SECRET_FRAGMENT = "a1B2c3D4e5F6g7H8";

interface Fixture {
  service: BackupService;
  conn: SqliteConnection;
  dbPath: string;
  dataDir: string;
  snapshotRoot: string;
  faultLines: string[];
}

function makeFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "shera-s33-backup-"));
  tempDirs.push(parent);
  const dataDir = join(parent, "data");
  const snapshotRoot = `${dataDir}.snapshots`;
  mkdirSync(dataDir);
  // The on-disk volume state (S11 private folders, S19 projects) and the two
  // credential key files (S23 provider custody, S19 project custody) — the
  // EXACT layout the composition produces under dirname(dbPath).
  mkdirSync(join(dataDir, "agent-files"));
  writeFileSync(join(dataDir, "agent-files", "profile.md"), "# Agent profile\n");
  mkdirSync(join(dataDir, "projects"));
  writeFileSync(join(dataDir, "projects", "repo.txt"), "worktree state\n");
  writeFileSync(join(dataDir, "provider-credentials.key"), SECRET_FIXTURE);
  writeFileSync(join(dataDir, "project-credentials.key"), SECRET_FIXTURE);
  // The recorded EXACT name at DEPTH: the exclusion must hold at every
  // directory level of the walk (the inspection caught the wholesale-cpSync
  // hole — a nested key file rode the projects/ copy).
  writeFileSync(join(dataDir, "projects", "provider-credentials.key"), SECRET_FIXTURE);
  const dbPath = join(dataDir, "runtime.db");
  const conn = openDatabase(dbPath);
  openConnections.push(conn);
  applyMigrations(conn.db);
  const faultLines: string[] = [];
  const tx = new SqliteTransactions(conn.db);
  const service = new BackupService({
    workspaceId: WS,
    dbPath,
    snapshotRoot,
    exportDatabase: (target) => vacuumIntoBackup(conn.db, target),
    verifyDatabaseCopy: verifySnapshotIntegrity,
    snapshots: new BackupSnapshotsRepository(tx),
    now: () => CLOCK,
    logFault: (event, fields) => {
      faultLines.push(JSON.stringify({ event, ...fields }));
    },
  });
  return { service, conn, dbPath, dataDir, snapshotRoot, faultLines };
}

/** Every file under the snapshot root must be free of the raw fixture. */
function assertSecretAbsentFromTree(root: string, where: string): void {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(root)) {
    const bytes = readFileSync(file);
    expect(bytes.includes(Buffer.from(SECRET_FIXTURE, "utf8")), `${where}: ${file}`).toBe(false);
    expect(bytes.includes(Buffer.from(SECRET_FRAGMENT, "utf8")), `${where}: ${file}`).toBe(false);
  }
}

/** The taken-snapshot id at `index`, or a loud failure (no silent undefined
 * path in an existence assertion). */
function mustSnapshotId(ids: string[], index: number): string {
  const value = ids[index];
  if (value === undefined) {
    throw new Error(`no snapshot was recorded at index ${index}`);
  }
  return value;
}

describe("the S33 backup mechanism (takeSnapshot)", () => {
  it("produces a working database copy that carries WAL-resident writes, plus the workspace volume, and records the ledger row", async () => {
    const fixture = makeFixture();
    // Real product state, written into the live database and NEVER
    // checkpointed: the row lives in the WAL sidecar — the copy must still
    // carry it (a consistent copy, not a stale file copy).
    const triggers = new TriggersRepository(new SqliteTransactions(fixture.conn.db));
    triggers.createTrigger({
      workspace_id: WS,
      trigger_id: "trg_backup_probe",
      name: "weekly literature sweep",
      kind: "schedule",
      target_operation_id: "op_research",
      config_json: JSON.stringify({ cron: "0 9 * * 1", plan: { prompt: "Sweep." } }),
      catch_up_policy: "skip",
      state: "active",
      pause_reason: null,
      created_by_type: "user",
      created_by_id: "emon",
      created_at: CLOCK,
      updated_at: CLOCK,
    });

    const result = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(result.taken).toBe(true);
    if (!result.taken) return;
    expect(result.integrity).toBe("ok");
    expect(result.db_bytes).toBeGreaterThan(0);
    expect(result.retained_index).toBe(1);

    // The snapshot root is a SIBLING of the data dir — never inside the
    // volume it snapshots.
    expect(fixture.snapshotRoot).toBe(`${fixture.dataDir}.snapshots`);
    expect(existsSync(fixture.snapshotRoot)).toBe(true);

    // The database copy opens, carries the whole applied migration chain,
    // and holds the WAL-resident row — read back through the REAL reader
    // (row-count match, E17's measured shape).
    const copyPath = join(result.snapshot_dir, "runtime.db");
    expect(existsSync(copyPath)).toBe(true);
    const copy = openDatabase(copyPath);
    try {
      expect(appliedMigrationVersions(copy.db)).toContain(22);
      const copyTriggers = new TriggersRepository(new SqliteTransactions(copy.db));
      const rows = copyTriggers.listTriggers(WS);
      expect(rows.map((row) => row.trigger_id)).toEqual(["trg_backup_probe"]);
    } finally {
      copy.close();
    }

    // The volume copy: the private folders and projects ride along; the live
    // database files and the credential key files do NOT.
    const volumeDir = join(result.snapshot_dir, "volume", "roots", "0");
    expect(existsSync(join(volumeDir, "agent-files", "profile.md"))).toBe(true);
    expect(existsSync(join(volumeDir, "projects", "repo.txt"))).toBe(true);
    expect(existsSync(join(volumeDir, "runtime.db"))).toBe(false);
    expect(existsSync(join(volumeDir, "provider-credentials.key"))).toBe(false);
    expect(existsSync(join(volumeDir, "project-credentials.key"))).toBe(false);

    // The ledger row: restorable, newest, alert-free.
    const row = fixture.service.snapshots.require(WS, result.snapshot_id);
    expect(row.integrity_status).toBe("ok");
    expect(row.triggered_by).toBe("schedule");
    expect(row.taken_at).toBe(CLOCK);
    expect(row.alert).toBeNull();

    // The sidecar makes the snapshot directory self-describing (the drill
    // reads it without the runtime's database).
    const sidecar = JSON.parse(
      readFileSync(join(result.snapshot_dir, "snapshot.json"), "utf8"),
    ) as {
      snapshot_id: string;
      workspace_id: string;
      taken_at: string;
      integrity_status: string;
      volume_roots: string[];
    };
    expect(sidecar.snapshot_id).toBe(result.snapshot_id);
    expect(sidecar.workspace_id).toBe(WS);
    expect(sidecar.taken_at).toBe(CLOCK);
    expect(sidecar.integrity_status).toBe("ok");
    expect(sidecar.volume_roots).toEqual([fixture.dataDir]);
  });

  it("excludes usable credential material from the snapshot (D22/E9 asserted by inspection)", async () => {
    const fixture = makeFixture();
    const result = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(result.taken).toBe(true);
    // Byte-level inspection of EVERY file the snapshot produced: the
    // secret-shaped value never appears (the sealed rows ride the database
    // copy encrypted; the key files that could open them ride nothing).
    assertSecretAbsentFromTree(fixture.snapshotRoot, "snapshot tree");
  });

  it("refuses a second snapshot under the same explicit id (typed, nothing overwritten)", async () => {
    const fixture = makeFixture();
    const ref = "snapshot_77777777-7777-4777-8777-777777777777";
    const first = await fixture.service.takeSnapshot({ triggeredBy: "admin", snapshotRef: ref });
    expect(first.taken).toBe(true);
    await expect(
      fixture.service.takeSnapshot({ triggeredBy: "admin", snapshotRef: ref }),
    ).rejects.toThrow(BackupServiceError);
    // The first snapshot's directory is intact (a replay never clobbers).
    expect(readdirSync(fixture.snapshotRoot)).toHaveLength(1);
  });

  it("refuses a snapshot whose copy fails the snapshot-time integrity check: alert + fault log, nothing retained", async () => {
    const parent = mkdtempSync(join(tmpdir(), "shera-s33-backup-"));
    tempDirs.push(parent);
    const dataDir = join(parent, "data");
    const snapshotRoot = `${dataDir}.snapshots`;
    mkdirSync(dataDir);
    const conn = openDatabase(join(dataDir, "runtime.db"));
    openConnections.push(conn);
    applyMigrations(conn.db);
    const faultLines: string[] = [];
    const service = new BackupService({
      workspaceId: WS,
      dbPath: join(dataDir, "runtime.db"),
      snapshotRoot,
      exportDatabase: (target) => vacuumIntoBackup(conn.db, target),
      // The simulated bad-disk copy: the verification reports failure.
      verifyDatabaseCopy: () => ({ ok: false, message: "page 3: never used" }),
      snapshots: new BackupSnapshotsRepository(new SqliteTransactions(conn.db)),
      now: () => CLOCK,
      logFault: (event, fields) => {
        faultLines.push(JSON.stringify({ event, ...fields }));
      },
    });

    const result = await service.takeSnapshot({ triggeredBy: "schedule" });
    expect(result.taken).toBe(false);
    if (result.taken) return;
    expect(result.reason).toBe("integrity_failed");
    expect(result.detail).toContain("page 3");
    // The bad copy's directory is removed (a corrupted file never sits in
    // the snapshot root as a restore candidate); the failure is recorded in
    // the redacted fault log.
    expect(result.snapshot_dir).not.toBeNull();
    expect(existsSync(result.snapshot_dir as string)).toBe(false);
    expect(faultLines.length).toBeGreaterThanOrEqual(1);
    expect(faultLines[0]).toContain("backup_snapshot_failed");
    // The ledger holds only restorable snapshots (the failed row's evidence
    // lives in the fault log and the typed result, not as a phantom row).
    expect(service.snapshots.listNewestFirst(WS)).toHaveLength(0);
  });

  it("prunes to exactly the newest seven: the eighth removes the OLDEST and never the newest", async () => {
    const fixture = makeFixture();
    let clockTick = 0;
    const clocked = new BackupService({
      workspaceId: WS,
      dbPath: join(fixture.dataDir, "runtime.db"),
      snapshotRoot: fixture.snapshotRoot,
      exportDatabase: (target) => vacuumIntoBackup(fixture.conn.db, target),
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots: fixture.service.snapshots,
      now: () => new Date(Date.parse(CLOCK) + clockTick * 3_600_000).toISOString(),
    });
    const ids: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      clockTick = index;
      const result = await clocked.takeSnapshot({ triggeredBy: "schedule" });
      expect(result.taken).toBe(true);
      if (result.taken) ids.push(result.snapshot_id);
    }
    const rows = clocked.snapshots.listNewestFirst(WS);
    expect(rows).toHaveLength(7);
    // The two OLDEST are gone; the NEWEST survives with index 1 (the list
    // is newest-first).
    expect(rows.map((row) => row.snapshot_id)).toEqual([...ids.slice(2)].reverse());
    expect(rows[0]?.retained_index).toBe(1);
    expect(rows[0]?.snapshot_id).toBe(mustSnapshotId(ids, 8));
    expect(rows[6]?.snapshot_id).toBe(mustSnapshotId(ids, 2));
    expect(rows[6]?.retained_index).toBe(7);
    expect(existsSync(join(fixture.snapshotRoot, mustSnapshotId(ids, 0)))).toBe(false);
    expect(existsSync(join(fixture.snapshotRoot, mustSnapshotId(ids, 1)))).toBe(false);
    for (const id of ids.slice(2)) {
      expect(existsSync(join(fixture.snapshotRoot, id))).toBe(true);
    }
  });

  it("verifies snapshots with the recorded integrity statement: a valid copy passes, a deliberately corrupted file fails", () => {
    const fixture = makeFixture();
    // A valid database file passes with the recorded "ok".
    const good = verifySnapshotIntegrity(fixture.dbPath);
    expect(good.ok).toBe(true);
    expect(good.message).toBe("ok");
    // A deliberately corrupted synthetic file fails (bit-rot simulation —
    // the restore-path refusal and the alert are pinned on this helper).
    // Damaging the file header is the deterministic corruption SQLite
    // always detects.
    const corruptDir = mkdtempSync(join(tmpdir(), "shera-s33-corrupt-"));
    tempDirs.push(corruptDir);
    const corruptPath = join(corruptDir, "corrupt.db");
    const damaged = Buffer.from(readFileSync(fixture.dbPath));
    damaged.write("DAMAGED-HEADER-PADDING!!", 0, 24, "utf8");
    writeFileSync(corruptPath, damaged);
    const bad = verifySnapshotIntegrity(corruptPath);
    expect(bad.ok).toBe(false);
    expect(bad.message.length).toBeGreaterThan(0);
    // Absolute garbage: the helper fails closed without throwing.
    const garbagePath = join(corruptDir, "garbage.db");
    writeFileSync(garbagePath, Buffer.from("this is not a database at all"));
    expect(verifySnapshotIntegrity(garbagePath).ok).toBe(false);
  });
});
