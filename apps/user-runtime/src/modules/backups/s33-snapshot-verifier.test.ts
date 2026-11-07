/**
 * S33 snapshot verification tests (issue #34; DEV_WORKFLOW Stage 8's
 * "scheduled check that a snapshot actually works — at minimum an integrity
 * check on the live snapshot, with alerting on failure", E11, G4).
 *
 * The verifier re-checks the WHOLE retained window every schedule tick
 * (bounded at seven by the retention rule — the bound makes the check
 * bounded by construction). A snapshot file that fails the recorded
 * integrity statement raises the ALERT (the bounded reason rides the
 * snapshot's ledger row + the redacted fault log), and the restore-candidate
 * policy REFUSES it — a corrupt snapshot can never be restored, and the
 * refusal is demonstrated here with a deliberately corrupted synthetic
 * snapshot. A later HEALTHY verification clears the alert (an environmental
 * failure must not block a restore forever; real corruption keeps failing).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { assertRestorableRow, BackupService, BackupServiceError } from "./backup-service.ts";
import { BackupScheduler } from "./backup-scheduler.ts";
import { SnapshotVerifier } from "./snapshot-verifier.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

afterAll(() => {
  for (const conn of openConnections) {
    try {
      conn.close();
    } catch {
      // already closed (the repair scenario closes its source connection)
    }
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const BASE_MS = Date.parse("2026-11-07T00:00:00.000Z");

interface Fixture {
  service: BackupService;
  verifier: SnapshotVerifier;
  snapshotRoot: string;
  faultLines: string[];
  clock: { tick: number };
}

function makeFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "shera-s33-verify-"));
  tempDirs.push(parent);
  const dataDir = join(parent, "data");
  const snapshotRoot = `${dataDir}.snapshots`;
  mkdirSync(dataDir);
  const conn = openDatabase(join(dataDir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  const faultLines: string[] = [];
  const clock = { tick: 0 };
  const service = new BackupService({
    workspaceId: WS,
    dbPath: join(dataDir, "runtime.db"),
    snapshotRoot,
    exportDatabase: (target) => vacuumIntoBackup(conn.db, target),
    verifyDatabaseCopy: verifySnapshotIntegrity,
    snapshots: new BackupSnapshotsRepository(new SqliteTransactions(conn.db)),
    now: () => new Date(BASE_MS + clock.tick * 3_600_000).toISOString(),
  });
  const verifier = new SnapshotVerifier({
    workspaceId: WS,
    verifyDatabaseCopy: verifySnapshotIntegrity,
    snapshots: service.snapshots,
    logFault: (event, fields) => {
      faultLines.push(JSON.stringify({ event, ...fields }));
    },
  });
  return { service, verifier, snapshotRoot, faultLines, clock };
}

/** Damage a snapshot's database file on disk (the deterministic corruption
 * SQLite always detects — the bit-rot simulation). */
function corruptSnapshotDb(snapshotDir: string): void {
  const dbPath = join(snapshotDir, "runtime.db");
  const damaged = Buffer.from(readFileSync(dbPath));
  damaged.write("DAMAGED-HEADER-PADDING!!", 0, 24, "utf8");
  writeFileSync(dbPath, damaged);
}

describe("the S33 snapshot verifier (the scheduled check + the alert path)", () => {
  it("a healthy retained window verifies clean: no alerts, no fault lines", async () => {
    const fixture = makeFixture();
    fixture.clock.tick = 1;
    const first = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    fixture.clock.tick = 2;
    const second = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(first.taken).toBe(true);
    expect(second.taken).toBe(true);
    const outcomes = await fixture.verifier.verifyRetainedWindow();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.verified)).toBe(true);
    const rows = fixture.service.snapshots.listNewestFirst(WS);
    expect(rows.every((row) => row.alert === null)).toBe(true);
    expect(fixture.faultLines).toHaveLength(0);
  });

  it("a deliberately corrupted snapshot file fails the check, raises the alert, and the restore policy refuses it", async () => {
    const fixture = makeFixture();
    fixture.clock.tick = 1;
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;
    // The deliberate corruption (synthetic bit-rot on the stored file).
    corruptSnapshotDb(taken.snapshot_dir);

    const outcomes = await fixture.verifier.verifyRetainedWindow();
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.verified).toBe(false);
    if (outcome?.verified) return;
    expect(outcome?.detail.length).toBeGreaterThan(0);

    // THE ALERT PATH: the bounded reason rides the snapshot's ledger row
    // and the redacted fault log fired.
    const row = fixture.service.snapshots.require(WS, taken.snapshot_id);
    expect(row.alert).not.toBeNull();
    expect(row.alert?.length).toBeLessThanOrEqual(300);
    expect(fixture.faultLines.some((line) => line.includes("backup_snapshot_corrupt"))).toBe(true);
    expect(fixture.faultLines.some((line) => line.includes(taken.snapshot_id))).toBe(true);

    // The restore-candidate policy REFUSES the alert-marked row — a corrupt
    // snapshot can never be restored (the refusal the restore path runs).
    expect(() => assertRestorableRow(row)).toThrow(BackupServiceError);
    expect(() => assertRestorableRow(row)).toThrow(/RESTORE_SNAPSHOT_CORRUPT/);
  });

  it("a later healthy verification clears the alert (an environmental failure must not block a restore forever)", async () => {
    const fixture = makeFixture();
    fixture.clock.tick = 1;
    const taken = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;
    corruptSnapshotDb(taken.snapshot_dir);
    const failed = await fixture.verifier.verifyRetainedWindow();
    expect(failed[0]?.verified).toBe(false);
    expect(fixture.service.snapshots.require(WS, taken.snapshot_id).alert).not.toBeNull();

    // The file is replaced with a healthy copy (the repair scenario) — the
    // corrupt file is removed first (the recorded export refuses a non-empty
    // target), then the next scheduled verification clears the alert.
    const repairedDbPath = join(taken.snapshot_dir, "runtime.db");
    rmSync(repairedDbPath);
    const healthySource = mkdtempSync(join(tmpdir(), "shera-s33-repair-"));
    tempDirs.push(healthySource);
    const healthyConn = openDatabase(join(healthySource, "repair.db"));
    openConnections.push(healthyConn);
    applyMigrations(healthyConn.db);
    vacuumIntoBackup(healthyConn.db, repairedDbPath);
    healthyConn.close();

    const recovered = await fixture.verifier.verifyRetainedWindow();
    expect(recovered[0]?.verified).toBe(true);
    expect(fixture.service.snapshots.require(WS, taken.snapshot_id).alert).toBeNull();
    // The policy admits the repaired snapshot again.
    expect(() =>
      assertRestorableRow(fixture.service.snapshots.require(WS, taken.snapshot_id)),
    ).not.toThrow();
  });

  it("the schedule tick verifies the retained window BEFORE taking the new snapshot", async () => {
    const fixture = makeFixture();
    fixture.clock.tick = 1;
    const old = await fixture.service.takeSnapshot({ triggeredBy: "schedule" });
    expect(old.taken).toBe(true);
    // The stored snapshot rots between ticks.
    if (!old.taken) return;
    corruptSnapshotDb(old.snapshot_dir);

    const order: string[] = [];
    const verifier = new SnapshotVerifier({
      workspaceId: WS,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots: fixture.service.snapshots,
      logFault: () => {
        order.push("verify");
      },
    });
    const clock = { tick: 2 };
    const scheduler = new BackupScheduler({
      service: {
        takeSnapshot: async (input) => {
          order.push("snapshot");
          return fixture.service.takeSnapshot(input);
        },
      },
      schedule: () => () => {},
      verify: verifier,
      now: () => new Date(BASE_MS + clock.tick * 3_600_000).toISOString(),
    });
    const result = await scheduler.tick();
    expect(result.taken).toBe(true);
    // Verification ran FIRST (the alert was raised before the new snapshot
    // existed), then the snapshot.
    expect(order).toEqual(["verify", "snapshot"]);
    expect(fixture.service.snapshots.require(WS, old.snapshot_id).alert).not.toBeNull();
  });

  it("an integrity-failed ledger row is refused by the policy even without an alert text", () => {
    const row = {
      workspace_id: WS,
      snapshot_id: "snapshot_99999999-9999-4999-8999-999999999999",
      taken_at: "2026-11-07T00:00:00.000Z",
      triggered_by: "schedule" as const,
      db_bytes: 1,
      integrity_status: "failed" as const,
      volume_kind: "copy" as const,
      snapshot_dir: "/unused",
      retained_index: null,
      alert: null,
      restored_at: null,
    };
    expect(() => assertRestorableRow(row)).toThrow(/RESTORE_SNAPSHOT_CORRUPT/);
  });
});
