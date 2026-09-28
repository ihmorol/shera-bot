/**
 * AC1 (S07): the container-local SQLite database starts from empty, applies the
 * committed migration chain, and the required connection pragmas (WAL journal,
 * foreign keys ON, bounded busy timeout) are asserted — never assumed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertRequiredPragmas,
  BUSY_TIMEOUT_MS,
  openDatabase,
  type SqliteConnection,
} from "./connection.ts";
import { applyMigrations } from "./migrations.ts";

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-sqlite-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sqlite connection", () => {
  it("opens a WAL database with foreign keys and a bounded busy timeout", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      // Journal mode is durable state on a file DB; it must read back as WAL.
      expect(conn.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
      expect(conn.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({
        foreign_keys: 1,
      });
      // node:sqlite reports the busy_timeout pragma under the column name
      // `timeout`; read the value positionally instead of by name.
      const busyRow = conn.db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
      expect(Object.values(busyRow)[0]).toBe(BUSY_TIMEOUT_MS);
    } finally {
      conn.close();
    }
  });

  it("assertRequiredPragmas accepts a correctly configured connection", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      expect(() => assertRequiredPragmas(conn.db)).not.toThrow();
    } finally {
      conn.close();
    }
  });

  it("assertRequiredPragmas rejects a connection that silently lost foreign keys", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      conn.db.exec("PRAGMA foreign_keys = OFF;");
      expect(() => assertRequiredPragmas(conn.db)).toThrow(/foreign_keys/i);
    } finally {
      conn.close();
    }
  });
});

describe("committed migrations", () => {
  it("apply from an empty database and create the event journal, conversations, and command receipt tables (AC1, E12)", () => {
    const conn: SqliteConnection = openDatabase(newTempDbPath());
    try {
      applyMigrations(conn.db);

      const tables = (
        conn.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);

      expect(tables).toContain("event_journal");
      expect(tables).toContain("conversations");
      expect(tables).toContain("command_receipts");
      expect(tables).toContain("schema_migrations");

      // Every product table carries workspace_id (E12) from the very first
      // migration — command receipts included, since receipts are keyed by
      // (workspace_id, idempotency_key).
      for (const table of ["event_journal", "conversations", "command_receipts"]) {
        const columns = (
          conn.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).map((row) => row.name);
        expect(columns, `${table} must carry workspace_id (E12)`).toContain("workspace_id");
      }
    } finally {
      conn.close();
    }
  });

  it("are idempotent: re-applying the chain on a migrated database changes nothing", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      applyMigrations(conn.db);
      const before = conn.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
      expect(() => applyMigrations(conn.db)).not.toThrow();
      const after = conn.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
      expect(after).toEqual(before);
    } finally {
      conn.close();
    }
  });
});
