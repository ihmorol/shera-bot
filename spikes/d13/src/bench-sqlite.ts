/**
 * S03 spike — SQLite driver comparison (issue #4, D10/D24/E11 evidence).
 *
 * Compares node:sqlite (built into Node 24) against better-sqlite3 12.4.1 on
 * the requirements that matter for product state (D10):
 *   1. WAL mode (PRAGMA journal_mode=WAL) — including after reopen.
 *   2. Explicit migrations (versioned schema_migrations runner, idempotent).
 *   3. Foreign keys — DEFAULT state per driver, then explicit PRAGMA.
 *   4. busy_timeout behaviour under contention (second writer in a child
 *      process, because both drivers block the thread while waiting).
 *   5. E11 backup path: VACUUM INTO + PRAGMA integrity_check on the copy,
 *      plus the driver's native online-backup API if one exists.
 *   6. Throughput context: 20k prepared INSERTs in one transaction.
 *
 * Both drivers wrap the same SQLite engine, so differences are driver API and
 * defaults, not engine format. Run: node src/bench-sqlite.ts
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import BetterDatabase from "better-sqlite3";

import { nowMs, round2 } from "./contract.ts";

const SPIKE_DIR = import.meta.dirname;
const RESULTS_DIR = path.join(SPIKE_DIR, "..", "results");

// better-sqlite3 ships no in-package TypeScript types; the spike runs through
// node's type-stripping (no typecheck), so minimal structural types suffice.
type Stmt = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};
type Handle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Stmt;
  close: () => void;
  /** better-sqlite3 only; feature-detected. */
  backup?: (dest: string) => Promise<void>;
};

const MIGRATIONS = [
  {
    version: 1,
    name: "create-operations",
    sql: `CREATE TABLE operations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft'
    );`,
  },
  {
    version: 2,
    name: "create-operation-events",
    sql: `CREATE TABLE operation_events (
      id INTEGER PRIMARY KEY,
      operation_id INTEGER NOT NULL REFERENCES operations(id),
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  },
];

function openNodeSqlite(dbPath: string): Handle {
  return new DatabaseSync(dbPath) as unknown as Handle;
}
function openBetterSqlite(dbPath: string): Handle {
  const Ctor = BetterDatabase as unknown as new (p: string) => Handle;
  return new Ctor(dbPath);
}

type DriverName = "node:sqlite" | "better-sqlite3";

function openDriver(driver: DriverName, dbPath: string): Handle {
  return driver === "node:sqlite" ? openNodeSqlite(dbPath) : openBetterSqlite(dbPath);
}

function migrate(db: Handle): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const appliedNow: number[] = [];
  for (const m of MIGRATIONS) {
    const row = db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(m.version) as { version: number } | undefined;
    if (row) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      appliedNow.push(m.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return appliedNow;
}

function seedOperation(db: Handle): void {
  db.prepare("INSERT INTO operations (id, name, state) VALUES (?, ?, ?)").run(
    1,
    "seed-operation",
    "running",
  );
}

function errFields(err: unknown): { code: string | null; message: string } {
  const e = err as { code?: string; errcode?: string; message?: string };
  return {
    code: e.code ?? e.errcode ?? null,
    message: (e.message ?? String(err)).slice(0, 120),
  };
}

function sqliteVersion(db: Handle): string {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  return row.v;
}

function tryOrphanInsert(db: Handle): { enforced: boolean; code: string | null; message: string } {
  try {
    db.prepare(
      "INSERT INTO operation_events (operation_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
    ).run(9999, 1, "orphan", new Date().toISOString());
    return { enforced: false, code: null, message: "orphan insert ACCEPTED" };
  } catch (err) {
    const f = errFields(err);
    return { enforced: true, code: f.code, message: f.message };
  }
}

function countEvents(db: Handle): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM operation_events").get() as { n: number };
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenarioWal(driver: DriverName, dir: string): Record<string, unknown> {
  const dbPath = path.join(dir, "wal.sqlite");
  const db = openDriver(driver, dbPath);
  const before = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  db.exec("PRAGMA journal_mode = WAL");
  const after = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  migrate(db);
  seedOperation(db);
  db.close();
  // Reopen: WAL must persist (it is a database property, unlike foreign_keys).
  const db2 = openDriver(driver, dbPath);
  const afterReopen = (db2.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
    .journal_mode;
  db2.close();
  return { defaultMode: before, modeAfterSet: after, modeAfterReopen: afterReopen };
}

function scenarioMigrations(driver: DriverName, dir: string): Record<string, unknown> {
  const db = openDriver(driver, path.join(dir, "migrations.sqlite"));
  const firstRun = migrate(db);
  const secondRun = migrate(db);
  const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as {
    version: number;
    name: string;
  }[];
  db.close();
  return { appliedFirstRun: firstRun, appliedSecondRun: secondRun, recorded: rows };
}

function scenarioForeignKeys(driver: DriverName, dir: string): Record<string, unknown> {
  // Default state: no pragmas beyond the driver's own defaults.
  const dbDefault = openDriver(driver, path.join(dir, "fk-default.sqlite"));
  migrate(dbDefault);
  seedOperation(dbDefault);
  const defaultState = tryOrphanInsert(dbDefault);
  dbDefault.close();

  // Explicit state: PRAGMA foreign_keys = ON.
  const dbExplicit = openDriver(driver, path.join(dir, "fk-explicit.sqlite"));
  migrate(dbExplicit);
  seedOperation(dbExplicit);
  dbExplicit.exec("PRAGMA foreign_keys = ON");
  const explicitState = tryOrphanInsert(dbExplicit);
  dbExplicit.close();
  return {
    defaultEnforces: defaultState.enforced,
    defaultDetail: defaultState.message,
    explicitEnforces: explicitState.enforced,
    explicitError: explicitState.message,
  };
}

function scenarioThroughput(driver: DriverName, dir: string): Record<string, number> {
  const db = openDriver(driver, path.join(dir, "perf.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  seedOperation(db);
  db.exec("PRAGMA foreign_keys = ON");
  const stmt = db.prepare(
    "INSERT INTO operation_events (operation_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
  );
  const N = 20000;
  const t0 = nowMs();
  db.exec("BEGIN");
  for (let i = 1; i <= N; i++) {
    stmt.run(1, i, `event-${i}-${"x".repeat(180)}`, new Date().toISOString());
  }
  db.exec("COMMIT");
  const insertMs = nowMs() - t0;
  const n = countEvents(db);
  const t1 = nowMs();
  const rows = db
    .prepare("SELECT seq, payload FROM operation_events ORDER BY seq")
    .all() as unknown[];
  const scanMs = nowMs() - t1;
  db.close();
  return {
    insertedRows: n,
    insertMs: round2(insertMs),
    insertsPerSec: Math.round(N / (insertMs / 1000)),
    scannedRows: rows.length,
    fullScanMs: round2(scanMs),
  };
}

type ContentionResult = { ok: boolean; elapsedMs: number; code: string | null; error: string };

function runContentionChild(
  driver: DriverName,
  dbPath: string,
  busyTimeoutMs: number,
  seq: number,
): Promise<ContentionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(SPIKE_DIR, "bench-sqlite-child.ts"),
        "--driver",
        driver,
        "--db",
        dbPath,
        "--busy-timeout-ms",
        String(busyTimeoutMs),
        "--seq",
        String(seq),
      ],
      { cwd: SPIKE_DIR },
    );
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      out += c;
    });
    child.stderr?.setEncoding("utf8");
    let errText = "";
    child.stderr?.on("data", (c: string) => {
      errText += c;
    });
    child.on("close", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line) as ContentionResult);
      } catch {
        reject(new Error(`contention child failed (exit ${code}): ${errText.slice(0, 300)}`));
      }
    });
  });
}

async function scenarioContention(
  driver: DriverName,
  dir: string,
): Promise<Record<string, unknown>> {
  const cases: { busyTimeoutMs: number; holdMs: number }[] = [
    { busyTimeoutMs: 0, holdMs: 300 },
    { busyTimeoutMs: 100, holdMs: 300 },
    { busyTimeoutMs: 5000, holdMs: 300 },
  ];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c) continue;
    const dbPath = path.join(dir, `contention-${i}.sqlite`);
    const holder = openDriver(driver, dbPath);
    holder.exec("PRAGMA journal_mode = WAL");
    migrate(holder);
    seedOperation(holder);
    // Writer 1 (this process) holds the write lock for holdMs.
    holder.exec("BEGIN IMMEDIATE");
    holder
      .prepare(
        "INSERT INTO operation_events (operation_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(1, 0, "lock-holder", new Date().toISOString());
    const committed = new Promise<void>((resolve) => {
      setTimeout(() => {
        holder.exec("COMMIT");
        resolve();
      }, c.holdMs);
    });
    // Writer 2 (child process) attempts one INSERT with busy_timeout set.
    const childResult = await runContentionChild(driver, dbPath, c.busyTimeoutMs, i + 1);
    await committed;
    holder.close();
    out[`busy_timeout_${c.busyTimeoutMs}ms`] = {
      outcome: childResult.ok ? "blocked-then-succeeded" : "SQLITE_BUSY",
      waitedMs: childResult.elapsedMs,
      error: childResult.ok ? null : childResult.error,
      holdMs: c.holdMs,
    };
  }
  return out;
}

async function scenarioBackup(driver: DriverName, dir: string): Promise<Record<string, unknown>> {
  const dbPath = path.join(dir, "backup-source.sqlite");
  const db = openDriver(driver, dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedOperation(db);
  const stmt = db.prepare(
    "INSERT INTO operation_events (operation_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  for (let i = 1; i <= 20000; i++) {
    stmt.run(1, i, `event-${i}-${"x".repeat(180)}`, new Date().toISOString());
  }
  db.exec("COMMIT");

  // E11 backup path 1: VACUUM INTO (plain SQL; works from any driver).
  const vacuumDest = path.join(dir, "backup-vacuum-into.sqlite");
  const t0 = nowMs();
  db.exec(`VACUUM INTO '${vacuumDest}'`);
  const vacuumIntoMs = round2(nowMs() - t0);

  const bkp = openDriver(driver, vacuumDest);
  const check = bkp.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  const bkpCount = countEvents(bkp);
  const bkpMode = (bkp.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
    .journal_mode;
  bkp.close();

  // E11 backup path 2: driver-native online backup API (feature-detected).
  let nativeBackup: Record<string, unknown> = { available: false };
  if (typeof db.backup === "function") {
    const nativeDest = path.join(dir, "backup-native.sqlite");
    const t2 = nowMs();
    await db.backup(nativeDest);
    const nativeMs = round2(nowMs() - t2);
    const nb = openDriver(driver, nativeDest);
    const nbCheck = nb.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const nbCount = countEvents(nb);
    nb.close();
    nativeBackup = { available: true, elapsedMs: nativeMs, integrity: nbCheck[0], rows: nbCount };
  }

  const sourceCount = countEvents(db);
  const sourceSizeBytes = (
    db
      .prepare(
        "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
      )
      .get() as { bytes: number }
  ).bytes;
  db.close();

  return {
    sourceRows: sourceCount,
    approxSourceBytes: sourceSizeBytes,
    vacuumInto: {
      elapsedMs: vacuumIntoMs,
      integrity: check[0],
      rows: bkpCount,
      journalMode: bkpMode,
    },
    nativeBackupApi: nativeBackup,
    rowCountMatch: bkpCount === sourceCount,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RESULTS_DIR, `sqlite-run-${runStamp}`);
  mkdirSync(runDir, { recursive: true });

  const drivers: DriverName[] = ["node:sqlite", "better-sqlite3"];
  const results: Record<string, Record<string, unknown>> = {};

  for (const driver of drivers) {
    const dir = path.join(runDir, driver.replace(/[^a-z0-9]/gi, "-"));
    mkdirSync(dir, { recursive: true });
    const info: Record<string, unknown> = {};
    const probe = openDriver(driver, ":memory:");
    info.sqliteEngineVersion = sqliteVersion(probe);
    info.nativeBackupApi = typeof probe.backup === "function" ? "present" : "absent";
    probe.close();

    info.wal = scenarioWal(driver, dir);
    info.migrations = scenarioMigrations(driver, dir);
    info.foreignKeys = scenarioForeignKeys(driver, dir);
    info.throughput = scenarioThroughput(driver, dir);
    info.contention = await scenarioContention(driver, dir);
    info.backup = await scenarioBackup(driver, dir);
    results[driver] = info;
  }

  const output = {
    run: runStamp,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    betterSqlite3Package: "12.4.1",
    results,
  };
  const outFile = path.join(RESULTS_DIR, `sqlite-${runStamp}.json`);
  writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);

  for (const [driver, info] of Object.entries(results)) {
    console.log(`\n=== ${driver} ===`);
    console.log(JSON.stringify(info, null, 2));
  }
  console.log(`\nresults written: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
