/**
 * S33 backup scheduler tests (issue #34; PRD §12 AC18, E11, E37's
 * injected-clock discipline): the six-hour schedule is an injected clock
 * seam — the tests drive the ticks, never wall-clock sleeps — and every tick
 * walks the same takeSnapshot path (schedule + retention + the honest
 * failure posture).
 *
 * Retention under the schedule is the AC18 integration: exactly seven
 * snapshots survive, the eighth tick removes the OLDEST, and the newest is
 * never removed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  openDatabase,
  verifySnapshotIntegrity,
  vacuumIntoBackup,
  type SqliteConnection,
} from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { BackupSnapshotsRepository } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { BackupService, SIX_HOURS_MS } from "./backup-service.ts";
import { BackupScheduler } from "./backup-scheduler.ts";

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
const BASE_MS = Date.parse("2026-11-07T00:00:00.000Z");

interface Fixture {
  scheduler: BackupScheduler;
  service: BackupService;
  snapshotRoot: string;
  faultLines: string[];
  /** What the fake clock seam received: the delay and its cancel handle. */
  scheduled: Array<{ delayMs: number }>;
  cancels: number;
  /** The mutable clock the service reads (one tick per six-hour step). */
  clock: { tick: number };
}

function makeFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "shera-s33-sched-"));
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
    now: () => new Date(BASE_MS + clock.tick * SIX_HOURS_MS).toISOString(),
  });
  const fixture: Fixture = {
    scheduler: null as never,
    service,
    snapshotRoot,
    faultLines,
    scheduled: [],
    cancels: 0,
    clock,
  };
  const scheduler = new BackupScheduler({
    service,
    // The FAKE CLOCK: the seam records the delay and hands back a cancel
    // spy; the TEST drives the tick callback directly — never a sleep.
    schedule: (delayMs) => {
      fixture.scheduled.push({ delayMs });
      return () => {
        fixture.cancels += 1;
      };
    },
    logFault: (event, fields) => {
      faultLines.push(JSON.stringify({ event, ...fields }));
    },
  });
  fixture.scheduler = scheduler;
  return fixture;
}

describe("the S33 backup scheduler (the six-hour schedule, fake clock)", () => {
  it("schedules its tick at exactly the six-hour interval and takes one scheduled snapshot per tick", async () => {
    const fixture = makeFixture();
    fixture.scheduler.start();
    expect(fixture.scheduled).toHaveLength(1);
    expect(fixture.scheduled[0]?.delayMs).toBe(SIX_HOURS_MS);
    expect(SIX_HOURS_MS).toBe(6 * 60 * 60 * 1000);
    // Two ticks, two scheduled snapshots, distinct taken_at instants — the
    // fake clock advanced one six-hour step per tick, never a sleep.
    fixture.clock.tick = 1;
    const first = await fixture.scheduler.tick();
    expect(first.taken).toBe(true);
    fixture.clock.tick = 2;
    const second = await fixture.scheduler.tick();
    expect(second.taken).toBe(true);
    const rows = fixture.service.snapshots.listNewestFirst(WS);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.triggered_by === "schedule")).toBe(true);
    expect(rows[0]?.taken_at).not.toBe(rows[1]?.taken_at);
  });

  it("eight ticks keep exactly seven snapshots: the OLDEST is removed and the newest never (AC18 retention)", async () => {
    const fixture = makeFixture();
    fixture.scheduler.start();
    const ids: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      fixture.clock.tick = index;
      const result = await fixture.scheduler.tick();
      expect(result.taken).toBe(true);
      if (result.taken) ids.push(result.snapshot_id);
    }
    const rows = fixture.service.snapshots.listNewestFirst(WS);
    expect(rows).toHaveLength(7);
    expect(rows[0]?.retained_index).toBe(1);
    expect(rows[6]?.retained_index).toBe(7);
    // The OLDEST (tick 1) is gone from disk and ledger; the NEWEST (tick 8)
    // survives with index 1.
    expect(rows.map((row) => row.snapshot_id)).toEqual([...ids.slice(1)].reverse());
    expect(existsSync(join(fixture.snapshotRoot, ids[0] ?? "missing"))).toBe(false);
    expect(rows[0]?.snapshot_id).toBe(ids[7]);
    // Exactly seven snapshot directories remain on disk.
    expect(readdirSync(fixture.snapshotRoot).sort()).toHaveLength(7);
  });

  it("stop() cancels the scheduled tick through the seam's cancel handle (idempotently)", () => {
    const fixture = makeFixture();
    fixture.scheduler.start();
    fixture.scheduler.stop();
    expect(fixture.cancels).toBe(1);
    fixture.scheduler.stop();
    expect(fixture.cancels).toBe(1);
  });

  it("a failed tick is fault-logged, keeps the ledger honest, and the next tick still snapshots", async () => {
    const fixture = makeFixture();
    fixture.scheduler.start();
    // One good tick, then a bad-disk window: every export fails.
    fixture.clock.tick = 1;
    const good = await fixture.scheduler.tick();
    expect(good.taken).toBe(true);
    const brokenService = new BackupService({
      workspaceId: WS,
      dbPath: join(fixture.snapshotRoot, "..", "data", "runtime.db"),
      snapshotRoot: fixture.snapshotRoot,
      exportDatabase: () => {
        throw new Error("disk gone");
      },
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots: fixture.service.snapshots,
      now: () => new Date(BASE_MS + 99 * SIX_HOURS_MS).toISOString(),
    });
    const failingScheduler = new BackupScheduler({
      service: brokenService,
      schedule: () => () => {},
      logFault: (event, fields) => {
        fixture.faultLines.push(JSON.stringify({ event, ...fields }));
      },
    });
    const failed = await failingScheduler.tick();
    expect(failed.taken).toBe(false);
    expect(fixture.faultLines.some((line) => line.includes("backup_snapshot_failed"))).toBe(true);
    // The ledger still holds exactly the one good snapshot (the failure
    // invented nothing) and the schedule machinery is intact.
    expect(fixture.service.snapshots.listNewestFirst(WS)).toHaveLength(1);
    // A healthy tick afterwards still snapshots (the cadence never stalls).
    fixture.clock.tick = 2;
    const recovered = await fixture.scheduler.tick();
    expect(recovered.taken).toBe(true);
    expect(fixture.service.snapshots.listNewestFirst(WS)).toHaveLength(2);
  });

  it("refuses a second start while running (typed, never a double schedule)", () => {
    const fixture = makeFixture();
    fixture.scheduler.start();
    expect(() => fixture.scheduler.start()).toThrow(/BACKUP_SCHEDULER_ALREADY_RUNNING/);
    fixture.scheduler.stop();
  });
});
