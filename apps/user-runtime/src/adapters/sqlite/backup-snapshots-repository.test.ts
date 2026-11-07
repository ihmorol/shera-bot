/**
 * S33 backup-snapshot storage contract tests (issue #34, PRD §12, E11, E12,
 * D23 rule 2): the v22 migration creates the STRICT backup_snapshots ledger —
 * the runtime's durable record of every snapshot it took — and the repository
 * enforces the writer-side rules: workspace scoping as the primary-key prefix
 * (E12), the checked vocabularies (triggered_by / integrity_status /
 * volume_kind) that make a misrecorded row unrepresentable at the storage
 * layer, and typed refusals for a duplicate snapshot id and an unknown
 * snapshot.
 *
 * Real SQLite, real migrations — the same discipline as the S28/S23
 * repository tests. Vocabulary: Pack → Operations → Agents (G1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import {
  appliedMigrationVersions,
  applyMigrations,
  MIGRATIONS,
  sqliteTableColumns,
  sqliteTableExists,
} from "./migrations.ts";
import {
  BackupSnapshotsRepository,
  BackupSnapshotError,
  type BackupSnapshotInsert,
} from "./backup-snapshots-repository.ts";
import { SqliteTransactions } from "./transactions.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

function newDb(): { conn: SqliteConnection; tx: SqliteTransactions } {
  const dir = mkdtempSync(join(tmpdir(), "shera-s33-snapshots-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  return { conn, tx: new SqliteTransactions(conn.db) };
}

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const OTHER_WS = "ws-other-0000";
const CLOCK = "2026-11-07T12:00:00.000Z";

function snapshotInput(overrides: Partial<BackupSnapshotInsert> = {}): BackupSnapshotInsert {
  return {
    workspace_id: WS,
    snapshot_id: "snapshot_11111111-1111-4111-8111-111111111111",
    taken_at: CLOCK,
    triggered_by: "schedule",
    db_bytes: 4096,
    integrity_status: "ok",
    volume_kind: "copy",
    snapshot_dir: join(tmpdir(), "shera-s33-snapshots-dir-1"),
    ...overrides,
  };
}

describe("the v22 backup_snapshots migration (chain head)", () => {
  it("is the migration-chain head and creates the STRICT ledger table", () => {
    const { conn } = newDb();
    const versions = appliedMigrationVersions(conn.db);
    expect(versions).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(versions.at(-1)).toBe(23);
    expect(MIGRATIONS.at(-1)?.name).toBe("backup-snapshots");
    expect(sqliteTableExists(conn.db, "backup_snapshots")).toBe(true);
  });

  it("declares exactly the recorded columns in order", () => {
    const { conn } = newDb();
    expect(sqliteTableColumns(conn.db, "backup_snapshots")).toEqual([
      "workspace_id",
      "snapshot_id",
      "taken_at",
      "triggered_by",
      "db_bytes",
      "integrity_status",
      "volume_kind",
      "snapshot_dir",
      "retained_index",
      "alert",
      "restored_at",
    ]);
  });
});

describe("the backup snapshot ledger repository", () => {
  it("records a snapshot and reads it back (round-trip)", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    const input = snapshotInput();
    repo.record(input);
    const row = repo.require(WS, input.snapshot_id);
    expect(row.workspace_id).toBe(WS);
    expect(row.snapshot_id).toBe(input.snapshot_id);
    expect(row.taken_at).toBe(CLOCK);
    expect(row.triggered_by).toBe("schedule");
    expect(row.db_bytes).toBe(4096);
    expect(row.integrity_status).toBe("ok");
    expect(row.volume_kind).toBe("copy");
    expect(row.snapshot_dir).toBe(input.snapshot_dir);
    expect(row.retained_index).toBeNull();
    expect(row.alert).toBeNull();
    expect(row.restored_at).toBeNull();
  });

  it("refuses a duplicate snapshot id in the SAME workspace (typed, no second row)", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    repo.record(snapshotInput());
    expect(() => repo.record(snapshotInput({ taken_at: "2026-11-07T18:00:00.000Z" }))).toThrow(
      BackupSnapshotError,
    );
    expect(repo.listNewestFirst(WS)).toHaveLength(1);
  });

  it("scopes the ledger by workspace (E12): the same snapshot id may exist in another workspace", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    const id = "snapshot_22222222-2222-4222-8222-222222222222";
    repo.record(snapshotInput({ snapshot_id: id }));
    // Same id, different workspace: an independent row (E12 workspace
    // independence — one container's ledger never collides with another's).
    repo.record(snapshotInput({ workspace_id: OTHER_WS, snapshot_id: id }));
    expect(repo.require(WS, id).workspace_id).toBe(WS);
    expect(repo.require(OTHER_WS, id).workspace_id).toBe(OTHER_WS);
    // Lists never leak across workspaces.
    expect(repo.listNewestFirst(WS)).toHaveLength(1);
    expect(repo.listNewestFirst(OTHER_WS)).toHaveLength(1);
  });

  it("lists newest-taken first and oldest first (the retention scan's two orders)", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    for (let index = 0; index < 5; index += 1) {
      repo.record(
        snapshotInput({
          snapshot_id: `snapshot_33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
          taken_at: new Date(Date.parse(CLOCK) + index * 3_600_000).toISOString(),
        }),
      );
    }
    const newestFirst = repo.listNewestFirst(WS);
    expect(newestFirst[0]?.taken_at).toBe("2026-11-07T16:00:00.000Z");
    expect(newestFirst.at(-1)?.taken_at).toBe(CLOCK);
    const oldestFirst = repo.listOldestFirst(WS);
    expect(oldestFirst[0]?.taken_at).toBe(CLOCK);
    expect(oldestFirst.at(-1)?.taken_at).toBe("2026-11-07T16:00:00.000Z");
  });

  it("marks an alert on a snapshot (the failure vocabulary rides the row, bounded)", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    const id = "snapshot_44444444-4444-4444-8444-444444444444";
    repo.record(snapshotInput({ snapshot_id: id }));
    repo.markAlert(WS, id, "integrity check failed: page 3: never used");
    expect(repo.require(WS, id).alert).toBe("integrity check failed: page 3: never used");
  });

  it("marks the restore time and the retention index on a snapshot", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    const id = "snapshot_55555555-5555-4555-8555-555555555555";
    repo.record(snapshotInput({ snapshot_id: id }));
    repo.setRetainedIndex(WS, id, 3);
    repo.markRestored(WS, id, "2026-11-07T19:00:00.000Z");
    const row = repo.require(WS, id);
    expect(row.retained_index).toBe(3);
    expect(row.restored_at).toBe("2026-11-07T19:00:00.000Z");
  });

  it("deletes a snapshot row (the retention prune's ledger leg) and reports absence", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    const id = "snapshot_66666666-6666-4666-8666-666666666666";
    repo.record(snapshotInput({ snapshot_id: id }));
    expect(repo.delete(WS, id)).toBe(true);
    expect(repo.delete(WS, id)).toBe(false);
    expect(repo.get(WS, id)).toBeNull();
    expect(() => repo.require(WS, id)).toThrow(BackupSnapshotError);
  });

  it("refuses vocabulary violations at the storage layer (unrepresentable rows)", () => {
    const { tx } = newDb();
    const repo = new BackupSnapshotsRepository(tx);
    // The STRICT schema's CHECKs reject a bad triggered_by — surfaced as the
    // typed repository error, never a raw driver message (D23 rule 4).
    expect(() => repo.record(snapshotInput({ triggered_by: "cron" as "schedule" }))).toThrow(
      BackupSnapshotError,
    );
    expect(() => repo.record(snapshotInput({ integrity_status: "probably fine" as "ok" }))).toThrow(
      BackupSnapshotError,
    );
    expect(() => repo.record(snapshotInput({ volume_kind: "tar" as "copy" }))).toThrow(
      BackupSnapshotError,
    );
  });
});
