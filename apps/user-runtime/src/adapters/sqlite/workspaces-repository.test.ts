/**
 * S10 workspace pack pinning (D19/D28): the migration chain creates the
 * workspace record with the pin columns, the pin is all-or-nothing, and every
 * repository operation is workspace-scoped (E12). Real SQLite, real
 * migrations — the same discipline as the connection test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.ts";
import { applyMigrations, MIGRATIONS } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import { WorkspacesRepository } from "./workspaces-repository.ts";

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s10-workspaces-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PIN = {
  agent_pack_id: "student",
  agent_pack_version: "1.0.0",
  manifest_hash: "a".repeat(64),
  installed_at: "2026-10-01T00:00:00.000Z",
};

describe("workspace pack pinning (S10 migration v3)", () => {
  it("appends v3 to the committed migration chain", () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(3);
    expect(MIGRATIONS.at(-1)?.name).toBe("workspace-pack-pinning");
  });

  it("creates an unpinned workspace row and reads it back workspace-scoped", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      applyMigrations(conn.db);
      const workspaces = new WorkspacesRepository(new SqliteTransactions(conn.db));

      workspaces.ensureWorkspace("ws_default");
      workspaces.ensureWorkspace("ws_default"); // idempotent
      workspaces.ensureWorkspace("ws_other");

      const row = workspaces.findById("ws_default");
      expect(row).toEqual({
        workspace_id: "ws_default",
        agent_pack_id: null,
        agent_pack_version: null,
        manifest_hash: null,
        installed_at: null,
      });
      expect(workspaces.findPinnedPack("ws_default")).toBeNull();

      // E12: a foreign workspace's row is never touched by another's reads.
      expect(workspaces.findById("ws_other")?.workspace_id).toBe("ws_other");
      expect(workspaces.findById("ws_missing")).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("pins, re-pins on upgrade, and keeps workspaces isolated (D19)", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      applyMigrations(conn.db);
      const workspaces = new WorkspacesRepository(new SqliteTransactions(conn.db));

      workspaces.ensureWorkspace("ws_default");
      workspaces.pinPack("ws_default", PIN);
      expect(workspaces.findPinnedPack("ws_default")).toEqual(PIN);

      // An explicit upgrade re-pins to the new version; the row is replaced,
      // not duplicated (one pinned pack per workspace — D19).
      const upgraded = {
        ...PIN,
        agent_pack_version: "2.0.0",
        installed_at: "2026-10-02T00:00:00.000Z",
      };
      workspaces.pinPack("ws_default", upgraded);
      expect(workspaces.findPinnedPack("ws_default")).toEqual(upgraded);

      // Another workspace stays unpinned — pins never leak across tenants.
      workspaces.ensureWorkspace("ws_other");
      expect(workspaces.findPinnedPack("ws_other")).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("rejects a half-pinned row at the schema level", () => {
    const conn = openDatabase(newTempDbPath());
    try {
      applyMigrations(conn.db);
      expect(() =>
        conn.db
          .prepare(
            `INSERT INTO workspaces (workspace_id, agent_pack_id, agent_pack_version, manifest_hash, installed_at)
             VALUES ('ws_half', 'student', NULL, NULL, NULL)`,
          )
          .run(),
      ).toThrow();
    } finally {
      conn.close();
    }
  });
});
