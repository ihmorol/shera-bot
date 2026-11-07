/**
 * S33 migration-after-restore (issue #34's AC: "migrations are applied
 * correctly after a restore of an older snapshot"; D24).
 *
 * The honest older-snapshot construction: the LIVE database is migrated
 * through the recorded MIGRATIONS prefix (v1..v21 — exactly what a runtime
 * one schema version behind the head ran, same transaction discipline), the
 * snapshot is taken from it, and the restore walk's D24 migration leg lands
 * the restored copy at the CURRENT head (v22 — the backup_snapshots ledger's
 * own version). The result carries the honest before/after applied versions;
 * the restored file verifies and the new-head table exists.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  openDatabase,
  vacuumIntoBackup,
  verifySnapshotIntegrity,
  type SqliteConnection,
} from "../../adapters/sqlite/connection.ts";
import {
  appliedMigrationVersions,
  MIGRATIONS,
  sqliteTableExists,
} from "../../adapters/sqlite/migrations.ts";
import { BackupSnapshotsRepository } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { BackupService } from "./backup-service.ts";
import { RestoreService } from "./restore-service.ts";

const WS = "ws_s33_migrate";
const NOW = "2026-11-08T10:00:00.000Z";

const tempDirs: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(() => {
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

/** The recorded migration run, limited to a prefix of the chain — the exact
 * steps applyMigrations runs (BEGIN IMMEDIATE → sql → recorded version →
 * COMMIT), for a database whose snapshot predates the head. */
function applyMigrationPrefix(db: DatabaseSync, upToVersion: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS) {
    if (migration.version > upToVersion) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        NOW,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

describe("S33 migration after restore (D24)", () => {
  it("restoring an OLDER snapshot runs the missing migrations and lands at the head", async () => {
    const parent = mkdtempSync(join(tmpdir(), "shera-s33-migrate-"));
    tempDirs.push(parent);
    const liveDataDir = join(parent, "live", "data");
    mkdirSync(liveDataDir, { recursive: true });

    // The LIVE database one schema version behind the head (the runtime that
    // took this snapshot had not applied the head version yet).
    const olderConn = openDatabase(join(liveDataDir, "runtime.db"));
    connections.push(olderConn);
    const headVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
    const olderHead = headVersion - 1;
    applyMigrationPrefix(olderConn.db, olderHead);
    const olderVersions = MIGRATIONS.filter((m) => m.version <= olderHead).map((m) => m.version);
    expect(appliedMigrationVersions(olderConn.db)).toEqual(olderVersions);

    // The ledger rides a CURRENT-schema database (the current code backs up
    // the OLDER file it finds — the honest production shape).
    const ledgerConn = openDatabase(join(liveDataDir, "ledger.db"));
    connections.push(ledgerConn);
    applyMigrationPrefix(ledgerConn.db, headVersion);
    const snapshots = new BackupSnapshotsRepository(new SqliteTransactions(ledgerConn.db));

    const service = new BackupService({
      workspaceId: WS,
      dbPath: join(liveDataDir, "runtime.db"),
      snapshotRoot: join(liveDataDir, "..", "data.snapshots"),
      volumeRoots: [liveDataDir],
      exportDatabase: (target) => vacuumIntoBackup(olderConn.db, target),
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots,
      now: () => NOW,
    });
    const taken = await service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;

    // The snapshot's schema is the OLDER head: the head version's table is
    // absent (v22's backup_snapshots is the one the older runtime misses).
    const snapshotDb = openDatabase(join(taken.snapshot_dir, "runtime.db"));
    connections.push(snapshotDb);
    expect(appliedMigrationVersions(snapshotDb.db)).toEqual(olderVersions);
    expect(sqliteTableExists(snapshotDb.db, "backup_snapshots")).toBe(false);
    snapshotDb.close();

    // ── The restore: the walk's D24 migration leg runs the missing v22. ──
    const restoredDataDir = join(parent, "restored", "data");
    mkdirSync(restoredDataDir, { recursive: true });
    const restore = new RestoreService({
      workspaceId: WS,
      dbPath: join(restoredDataDir, "runtime.db"),
      volumeRoots: [restoredDataDir],
      snapshots,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      stopServices: () => {},
      startServices: () => {},
      now: () => NOW,
    });
    const restored = await restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    expect(restored.restored).toBe(true);
    if (!restored.restored) return;

    // The honest before/after: the snapshot's versions IN, the current head
    // OUT — exactly the missing version applied.
    expect(restored.migrated_from).toEqual(olderVersions);
    expect(restored.migrated_to).toEqual(MIGRATIONS.map((m) => m.version));
    expect(restored.migrated_to).toContain(headVersion);

    // The restored database verifies and carries the new head's table.
    const restoredDb = openDatabase(join(restoredDataDir, "runtime.db"));
    connections.push(restoredDb);
    expect(appliedMigrationVersions(restoredDb.db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(sqliteTableExists(restoredDb.db, "backup_snapshots")).toBe(true);
    expect(verifySnapshotIntegrity(join(restoredDataDir, "runtime.db")).ok).toBe(true);
  });
});
