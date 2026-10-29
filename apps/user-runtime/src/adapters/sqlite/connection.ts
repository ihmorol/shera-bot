/**
 * Container-local SQLite connection (S07; E17).
 *
 * node:sqlite (E17) is the chosen driver — no additional sqlite dependency is
 * introduced. The adapter owns every connection concern: opening the database
 * file, WAL mode, foreign keys, a bounded busy timeout, and short
 * transactions. The required pragmas are ASSERTED after opening (AC1), never
 * assumed: a database that silently runs without foreign keys or WAL fails
 * fast at startup and in tests.
 *
 * All SQL in the user-runtime lives under adapters/sqlite (AC7); the boundary
 * contract test enforces this.
 */
import { DatabaseSync } from "node:sqlite";

/** Bounded wait (ms) a writer holds before surfacing SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5_000;

/** Upper bound on lock retries for BEGIN IMMEDIATE under contention. */
export const MAX_LOCK_RETRIES = 5;

export interface SqliteConnection {
  readonly db: DatabaseSync;
  close(): void;
}

/**
 * Open (or create) the container-local database with the required pragmas
 * applied and asserted. Every caller — production startup and tests — goes
 * through this function.
 */
export function openDatabase(path: string): SqliteConnection {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  assertRequiredPragmas(db);
  return { db, close: () => db.close() };
}

/**
 * AC1: fail fast if the connection is not in the required configuration.
 * Throws with a boundary-redaction-safe message (G3 — no file content, no
 * secrets; the path is the caller's own input).
 */
export function assertRequiredPragmas(db: DatabaseSync): void {
  const journalMode = readPragma(db, "journal_mode");
  if (journalMode !== "wal") {
    throw new Error(`sqlite pragma assertion failed: journal_mode must be wal, got ${journalMode}`);
  }
  const foreignKeys = readPragma(db, "foreign_keys");
  if (foreignKeys !== 1) {
    throw new Error(
      `sqlite pragma assertion failed: foreign_keys must be 1, got ${String(foreignKeys)}`,
    );
  }
  const busyTimeout = readPragma(db, "busy_timeout");
  if (busyTimeout !== BUSY_TIMEOUT_MS) {
    throw new Error(
      `sqlite pragma assertion failed: busy_timeout must be ${BUSY_TIMEOUT_MS}, got ${String(busyTimeout)}`,
    );
  }
}

/**
 * Read a pragma's value. PRAGMA result column names are not stable across
 * pragmas (e.g. busy_timeout reports its column as `timeout`), so the FIRST
 * column value is returned regardless of its name.
 */
function readPragma(db: DatabaseSync, name: string): string | number | null {
  const row = db.prepare(`PRAGMA ${name}`).get() as
    Record<string, string | number | bigint | null> | undefined;
  if (!row) {
    return null;
  }
  const value = Object.values(row)[0];
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value ?? null;
}

/**
 * S23 custody-scan support (and the E11 backup shape): force a WAL
 * checkpoint so the main database file carries every committed page. The
 * at-rest scan reads the FILE bytes; without the checkpoint the newest pages
 * may live only in the WAL sidecar.
 */
export function walCheckpointTruncate(db: DatabaseSync): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/**
 * The E11 backup mechanism (recorded at the D13 spike): a consistent
 * `VACUUM INTO` copy of the whole database. The custody scan produces one to
 * prove a DEFAULT backup carries the sealed credential payloads and never
 * the plaintext (D22's backup exclusion, in its at-rest form).
 */
export function vacuumIntoBackup(db: DatabaseSync, targetPath: string): void {
  db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
}
