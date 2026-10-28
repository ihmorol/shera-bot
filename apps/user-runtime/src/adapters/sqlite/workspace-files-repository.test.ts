/**
 * S17 chunk 1: workspace files storage contract (PRD §4.3, D6, D23 rule 8,
 * D39, AC16 partial).
 *
 * RED-FIRST: this suite was committed failing, then implemented against.
 *
 * What is pinned here:
 * - v9 migration: workspace_nodes (the real file tree behind the Files tab),
 *   write_leases + artifact_refs (created here; semantics land in chunk 2).
 * - Scoped URI resolution: `workspace://<relative-path>` and
 *   `agent://<agent_id>/<relative-path>` — traversal, encoded traversal,
 *   backslash tricks, null bytes and absolute paths are typed rejections.
 *   Storage is row-based (no filesystem behind the nodes), so symlink escapes
 *   cannot occur at this layer; the path-resolution rejections ARE the safety
 *   surface and are tested directly.
 * - Private-folder rules (D39): an Agent actor is denied other Agents'
 *   private folders at runtime level (PRIVATE_SCOPE_DENIED); the user actor —
 *   the panel viewer — may read both scopes.
 * - Delete rules (G6, D6): agent-driven delete is a typed refusal
 *   (AGENT_DELETE_REQUIRES_APPROVAL) in every scope — only the user path
 *   deletes. User deletes work; non-empty directories refuse non-recursive
 *   deletion.
 * - Persistence (AC16 partial): files written before a close are readable
 *   after reopening the same database file.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.ts";
import { applyMigrations, MIGRATIONS, sqliteTableExists } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import {
  AgentDeleteRefusedError,
  PrivateScopeDeniedError,
  WorkspaceDirectoryNotEmptyError,
  WorkspaceFilesRepository,
  WorkspaceNodeNotFoundError,
  WorkspacePathError,
  WorkspaceNodeTypeError,
  type WorkspaceStorageActor,
} from "./workspace-files-repository.ts";

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s17-workspace-files-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function openMigratedDb(path: string) {
  const conn = openDatabase(path);
  applyMigrations(conn.db);
  return conn;
}

function makeRepo() {
  const conn = openMigratedDb(newTempDbPath());
  return {
    conn,
    repo: new WorkspaceFilesRepository(new SqliteTransactions(conn.db)),
  };
}

const USER: WorkspaceStorageActor = { type: "user", id: "user-1" };
const ALICE: WorkspaceStorageActor = { type: "agent", id: "alice" };
const BOB: WorkspaceStorageActor = { type: "agent", id: "bob" };

function tableColumns(db: ReturnType<typeof openDatabase>["db"], table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

describe("S17 v9 migration: workspace storage tables", () => {
  it("adds v9 'workspace-storage' to the committed migration chain", () => {
    const v9 = MIGRATIONS.find((migration) => migration.version === 9);
    expect(v9?.name).toBe("workspace-storage");
  });

  it("creates all three S17 tables", () => {
    const conn = openMigratedDb(newTempDbPath());
    try {
      expect(sqliteTableExists(conn.db, "workspace_nodes")).toBe(true);
      expect(sqliteTableExists(conn.db, "write_leases")).toBe(true);
      expect(sqliteTableExists(conn.db, "artifact_refs")).toBe(true);
    } finally {
      conn.close();
    }
  });

  it("pins the workspace_nodes columns chunk 2 and the UI build against", () => {
    const conn = openMigratedDb(newTempDbPath());
    try {
      expect(tableColumns(conn.db, "workspace_nodes")).toEqual([
        "id",
        "workspace_id",
        "scope",
        "agent_id",
        "parent_id",
        "name",
        "is_directory",
        "size",
        "mime_type",
        "content",
        "created_by_type",
        "created_by_id",
        "created_at",
        "updated_at",
      ]);
    } finally {
      conn.close();
    }
  });

  it("pins the write_leases and artifact_refs columns (chunk 2 fills semantics)", () => {
    const conn = openMigratedDb(newTempDbPath());
    try {
      expect(tableColumns(conn.db, "write_leases")).toEqual([
        "lease_id",
        "workspace_id",
        "scope",
        "agent_id",
        "task_id",
        "path",
        "holder_type",
        "holder_id",
        "acquired_at",
        "expires_at",
        "renewed_at",
        "released_at",
      ]);
      expect(tableColumns(conn.db, "artifact_refs")).toEqual([
        "artifact_id",
        "workspace_id",
        "name",
        "artifact_type",
        "size",
        "mime_type",
        "content",
        "producer_agent_id",
        "producer_task_id",
        "created_at",
      ]);
    } finally {
      conn.close();
    }
  });

  it("enforces scope/agent coherence, directory content coherence, and name sanity at the schema level", () => {
    const conn = openMigratedDb(newTempDbPath());
    try {
      interface InsertRow {
        id: string;
        workspace_id: string;
        scope: string;
        agent_id: string | null;
        parent_id: string | null;
        name: string;
        is_directory: number;
        size: number;
        mime_type: string | null;
        content: Uint8Array | null;
        created_by_type: string;
        created_by_id: string;
        created_at: string;
        updated_at: string;
      }
      const base: InsertRow = {
        id: "n1",
        workspace_id: "ws_default",
        scope: "workspace",
        agent_id: null,
        parent_id: null,
        name: "f.txt",
        is_directory: 0,
        size: 1,
        mime_type: "text/plain",
        content: null,
        created_by_type: "user",
        created_by_id: "user-1",
        created_at: "2026-10-28T00:00:00.000Z",
        updated_at: "2026-10-28T00:00:00.000Z",
      };
      const insert = (over: Partial<InsertRow>) => {
        const row = { ...base, ...over };
        return conn.db
          .prepare(
            `INSERT INTO workspace_nodes (
               id, workspace_id, scope, agent_id, parent_id, name,
               is_directory, size, mime_type, content,
               created_by_type, created_by_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.workspace_id,
            row.scope,
            row.agent_id,
            row.parent_id,
            row.name,
            row.is_directory,
            row.size,
            row.mime_type,
            row.content,
            row.created_by_type,
            row.created_by_id,
            row.created_at,
            row.updated_at,
          );
      };

      // scope='agent' requires agent_id; scope='workspace' forbids it.
      expect(() => insert({ scope: "agent", agent_id: null, name: "f.txt", content: new Uint8Array(1) })).toThrow();
      expect(() => insert({ scope: "workspace", agent_id: "alice", name: "f.txt", content: new Uint8Array(1) })).toThrow();

      // Directories carry no content; files always carry content.
      expect(() => insert({ scope: "workspace", agent_id: null, name: "d", is_directory: 1, size: 0, mime_type: null, content: new Uint8Array(1) })).toThrow();
      expect(() => insert({ scope: "workspace", agent_id: null, name: "f.txt", content: null })).toThrow();

      // Name sanity: traversal segments and separators are unrepresentable.
      expect(() => insert({ scope: "workspace", agent_id: null, name: "..", content: new Uint8Array(1) })).toThrow();
      expect(() => insert({ scope: "workspace", agent_id: null, name: ".", content: new Uint8Array(1) })).toThrow();
      expect(() => insert({ scope: "workspace", agent_id: null, name: "a/b", content: new Uint8Array(1) })).toThrow();
      expect(() => insert({ scope: "workspace", agent_id: null, name: "a\\b", content: new Uint8Array(1) })).toThrow();

      // One happy row: a plain workspace-scope file inserts cleanly.
      expect(() =>
        insert({ scope: "workspace", agent_id: null, name: "ok.txt", content: new Uint8Array(1) }),
      ).not.toThrow();
    } finally {
      conn.close();
    }
  });
});

describe("scoped URI resolution and path safety", () => {
  it("rejects traversal, encoded traversal, backslash tricks, null bytes, and absolute paths with a typed error", () => {
    const { conn, repo } = makeRepo();
    try {
      const hostile = [
        "workspace://../secret",
        "workspace://a/../b",
        "workspace://a/../../etc/passwd",
        "workspace://%2e%2e/secret",
        "workspace://a/%2e%2e/b",
        "workspace://a/%2E%2E/secret",
        "workspace://a%2fb",
        "workspace://a/b%2F..%2Fc",
        "workspace://a\\b.txt",
        "workspace://a/%5Cb",
        "workspace://bad%00name",
        "workspace://a//b",
        "workspace:///etc/passwd",
        "workspace://./x",
        "workspace://a/./b",
        "team://notes",
        "agent://ALICE/notes.txt",
        "agent://al ice/notes.txt",
        "agent://alice/../bob/notes.txt",
        "agent://alice/%2e%2e/bob/notes.txt",
        "agent://alice/notes%00.txt",
      ];
      for (const uri of hostile) {
        expect(() => repo.write("ws_default", uri, USER, new Uint8Array([1]), null), uri).toThrow(
          WorkspacePathError,
        );
      }
      // Invalid percent-encoding is a path rejection, not a crash.
      expect(() => repo.write("ws_default", "workspace://a%ZZb", USER, new Uint8Array([1]), null)).toThrow(
        WorkspacePathError,
      );
      // Nothing was written by any rejected attempt.
      expect(repo.list("ws_default", "workspace://", USER)).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it("resolves workspace:// and agent://<id>/ URIs to rows without content for the tree view", () => {
    const { conn, repo } = makeRepo();
    try {
      const dir = repo.mkdir("ws_default", "workspace://reports", USER);
      const file = repo.write(
        "ws_default",
        "workspace://reports/q4.md",
        USER,
        new Uint8Array([1, 2, 3]),
        "text/markdown",
      );

      expect(repo.resolve("ws_default", "workspace://reports", USER)?.id).toBe(dir.id);
      expect(repo.resolve("ws_default", "workspace://reports/q4.md", USER)?.id).toBe(file.id);
      expect(repo.resolve("ws_default", "workspace://reports/missing.md", USER)).toBeNull();
      // The resolved tree rows carry metadata; content travels only via read().
      expect(repo.resolve("ws_default", "workspace://reports/q4.md", USER)).not.toHaveProperty("content");
      // The scope roots themselves resolve once something exists under them.
      expect(repo.resolve("ws_default", "workspace://", USER)?.is_directory).toBe(1);
    } finally {
      conn.close();
    }
  });
});

describe("read/write/list/mkdir over workspace_nodes (user actor)", () => {
  it("writes a file and reads back byte-exact content with size and mime type", () => {
    const { conn, repo } = makeRepo();
    try {
      const bytes = new Uint8Array(Buffer.from("hello workspace", "utf8"));
      const written = repo.write("ws_default", "workspace://hello.txt", USER, bytes, "text/plain");

      expect(written.scope).toBe("workspace");
      expect(written.agent_id).toBeNull();
      expect(written.name).toBe("hello.txt");
      expect(written.is_directory).toBe(0);
      expect(written.size).toBe(bytes.byteLength);
      expect(written.mime_type).toBe("text/plain");
      expect(written.created_by_type).toBe("user");
      expect(written.created_by_id).toBe("user-1");

      const read = repo.read("ws_default", "workspace://hello.txt", USER);
      expect(Buffer.compare(Buffer.from(read.content), Buffer.from(bytes))).toBe(0);
    } finally {
      conn.close();
    }
  });

  it("auto-creates missing parent directories on write and lists children", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "workspace://reports/2026/q4.md", USER, new Uint8Array([9]), "text/markdown");

      const rootChildren = repo.list("ws_default", "workspace://", USER);
      expect(rootChildren.map((node) => node.name)).toEqual(["reports"]);
      expect(rootChildren[0]?.is_directory).toBe(1);

      const nested = repo.list("ws_default", "workspace://reports/2026", USER);
      expect(nested.map((node) => node.name)).toEqual(["q4.md"]);
      expect(nested[0]?.mime_type).toBe("text/markdown");
    } finally {
      conn.close();
    }
  });

  it("lists directories-first by name, and mkdir is idempotent", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "workspace://zebra.txt", USER, new Uint8Array([1]), "text/plain");
      repo.mkdir("ws_default", "workspace://archive", USER);
      repo.write("ws_default", "workspace://apple.txt", USER, new Uint8Array([2]), "text/plain");

      const names = repo.list("ws_default", "workspace://", USER).map((node) => node.name);
      expect(names).toEqual(["archive", "apple.txt", "zebra.txt"]);

      const first = repo.mkdir("ws_default", "workspace://archive", USER);
      const again = repo.mkdir("ws_default", "workspace://archive", USER);
      expect(again.id).toBe(first.id);
    } finally {
      conn.close();
    }
  });

  it("types missing nodes, wrong node kinds, and write-over-directory as distinct rejections", () => {
    const { conn, repo } = makeRepo();
    try {
      expect(() => repo.read("ws_default", "workspace://missing.txt", USER)).toThrow(
        WorkspaceNodeNotFoundError,
      );
      expect(() => repo.list("ws_default", "workspace://missing-dir", USER)).toThrow(
        WorkspaceNodeNotFoundError,
      );
      expect(() => repo.delete("ws_default", "workspace://missing.txt", USER)).toThrow(
        WorkspaceNodeNotFoundError,
      );

      repo.mkdir("ws_default", "workspace://docs", USER);
      expect(() => repo.read("ws_default", "workspace://docs", USER)).toThrow(WorkspaceNodeTypeError);
      repo.write("ws_default", "workspace://file.txt", USER, new Uint8Array([1]), "text/plain");
      expect(() => repo.list("ws_default", "workspace://file.txt", USER)).toThrow(
        WorkspaceNodeTypeError,
      );
      expect(() =>
        repo.write("ws_default", "workspace://docs", USER, new Uint8Array([1]), "text/plain"),
      ).toThrow(WorkspaceNodeTypeError);
      expect(() => repo.mkdir("ws_default", "workspace://file.txt", USER)).toThrow(
        WorkspaceNodeTypeError,
      );
      expect(() => repo.mkdir("ws_default", "workspace://file.txt/inside", USER)).toThrow(
        WorkspaceNodeTypeError,
      );
    } finally {
      conn.close();
    }
  });

  it("overwrites file content on rewrite without deleting the node (D6 lease gating arrives in chunk 2)", () => {
    const { conn, repo } = makeRepo();
    try {
      const first = repo.write("ws_default", "workspace://log.txt", USER, new Uint8Array([1, 2]), "text/plain");
      const second = repo.write("ws_default", "workspace://log.txt", USER, new Uint8Array([1, 2, 3, 4]), "text/plain");

      expect(second.id).toBe(first.id);
      expect(second.size).toBe(4);
      expect(Buffer.from(second.content)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(second.created_by_id).toBe(first.created_by_id);
      expect(second.updated_at >= first.updated_at).toBe(true);
    } finally {
      conn.close();
    }
  });

  it("keeps the same URI in two workspaces independent (E12)", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_a", "workspace://notes.txt", USER, new Uint8Array([1]), "text/plain");
      repo.write("ws_b", "workspace://notes.txt", USER, new Uint8Array([2, 2]), "text/plain");

      expect(Buffer.from(repo.read("ws_a", "workspace://notes.txt", USER).content)).toEqual(
        Buffer.from([1]),
      );
      expect(Buffer.from(repo.read("ws_b", "workspace://notes.txt", USER).content)).toEqual(
        Buffer.from([2, 2]),
      );
    } finally {
      conn.close();
    }
  });
});

describe("private folder rules (D39)", () => {
  it("lets an Agent read, write, and list its OWN private folder", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "agent://alice/notes.txt", ALICE, new Uint8Array([7]), "text/plain");

      const read = repo.read("ws_default", "agent://alice/notes.txt", ALICE);
      expect(read.scope).toBe("agent");
      expect(read.agent_id).toBe("alice");
      expect(Buffer.from(read.content)).toEqual(Buffer.from([7]));
      expect(repo.list("ws_default", "agent://alice", ALICE).map((node) => node.name)).toEqual([
        "notes.txt",
      ]);
      // The agent's own root also lists via the trailing-slash form.
      expect(repo.list("ws_default", "agent://alice/", ALICE)).toHaveLength(1);
    } finally {
      conn.close();
    }
  });

  it("denies an Agent another Agent's private folder in every operation (runtime-level)", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "agent://alice/notes.txt", ALICE, new Uint8Array([7]), "text/plain");

      expect(() => repo.read("ws_default", "agent://alice/notes.txt", BOB)).toThrow(
        PrivateScopeDeniedError,
      );
      expect(() => repo.list("ws_default", "agent://alice", BOB)).toThrow(PrivateScopeDeniedError);
      expect(() =>
        repo.write("ws_default", "agent://alice/notes.txt", BOB, new Uint8Array([8]), "text/plain"),
      ).toThrow(PrivateScopeDeniedError);
      expect(() => repo.mkdir("ws_default", "agent://alice/scratch", BOB)).toThrow(
        PrivateScopeDeniedError,
      );
      expect(() => repo.resolve("ws_default", "agent://alice/notes.txt", BOB)).toThrow(
        PrivateScopeDeniedError,
      );
      // The denial left the file untouched.
      expect(repo.read("ws_default", "agent://alice/notes.txt", ALICE).size).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("lets the user actor read both scopes (the panel viewer is user-facing)", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "agent://alice/notes.txt", ALICE, new Uint8Array([7]), "text/plain");
      expect(repo.read("ws_default", "agent://alice/notes.txt", USER).size).toBe(1);
      expect(repo.list("ws_default", "agent://alice", USER)).toHaveLength(1);
    } finally {
      conn.close();
    }
  });

  it("keeps private folders workspace-scoped (E12): same agent, two workspaces", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_a", "agent://alice/notes.txt", ALICE, new Uint8Array([1]), "text/plain");
      repo.write("ws_b", "agent://alice/notes.txt", ALICE, new Uint8Array([2]), "text/plain");

      expect(Buffer.from(repo.read("ws_a", "agent://alice/notes.txt", ALICE).content)).toEqual(
        Buffer.from([1]),
      );
      expect(Buffer.from(repo.read("ws_b", "agent://alice/notes.txt", ALICE).content)).toEqual(
        Buffer.from([2]),
      );
    } finally {
      conn.close();
    }
  });
});

describe("delete rules (G6, D6)", () => {
  it("refuses agent-driven delete with a typed approval-path refusal in every scope", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "workspace://shared.txt", USER, new Uint8Array([1]), "text/plain");
      repo.write("ws_default", "agent://alice/own.txt", ALICE, new Uint8Array([2]), "text/plain");

      // Shared workspace file: agents never delete; the approval path does.
      expect(() => repo.delete("ws_default", "workspace://shared.txt", ALICE)).toThrow(
        AgentDeleteRefusedError,
      );
      // Even the Agent's own private file: delete is never agent-triggered
      // without the approval path, so the refusal is scope-uniform.
      expect(() => repo.delete("ws_default", "agent://alice/own.txt", ALICE)).toThrow(
        AgentDeleteRefusedError,
      );
      // The refusals left both files in place.
      expect(repo.read("ws_default", "workspace://shared.txt", USER).size).toBe(1);
      expect(repo.read("ws_default", "agent://alice/own.txt", ALICE).size).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("denies an agent cross-private delete before the delete rule (scope first)", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "agent://alice/own.txt", ALICE, new Uint8Array([2]), "text/plain");
      expect(() => repo.delete("ws_default", "agent://alice/own.txt", BOB)).toThrow(
        PrivateScopeDeniedError,
      );
    } finally {
      conn.close();
    }
  });

  it("deletes files and directories on the user path, refusing non-empty non-recursive directory deletes", () => {
    const { conn, repo } = makeRepo();
    try {
      repo.write("ws_default", "workspace://tmp/a.txt", USER, new Uint8Array([1]), "text/plain");
      repo.write("ws_default", "workspace://tmp/b.txt", USER, new Uint8Array([2]), "text/plain");

      expect(() => repo.delete("ws_default", "workspace://tmp", USER)).toThrow(
        WorkspaceDirectoryNotEmptyError,
      );
      // The refused delete left the subtree intact.
      expect(repo.list("ws_default", "workspace://tmp", USER)).toHaveLength(2);

      repo.delete("ws_default", "workspace://tmp", USER, { recursive: true });
      expect(repo.resolve("ws_default", "workspace://tmp", USER)).toBeNull();
      expect(() => repo.read("ws_default", "workspace://tmp/a.txt", USER)).toThrow(
        WorkspaceNodeNotFoundError,
      );

      repo.write("ws_default", "workspace://gone.txt", USER, new Uint8Array([3]), "text/plain");
      repo.delete("ws_default", "workspace://gone.txt", USER);
      expect(repo.resolve("ws_default", "workspace://gone.txt", USER)).toBeNull();

      // The scope root itself is structural and cannot be deleted.
      expect(() => repo.delete("ws_default", "workspace://", USER)).toThrow(WorkspaceNodeTypeError);
    } finally {
      conn.close();
    }
  });
});

describe("persistence across restart (AC16 partial)", () => {
  it("reads back files written before the database was closed, after reopening the same file", () => {
    const path = newTempDbPath();
    const sharedBytes = new Uint8Array(Buffer.from("persist me", "utf8"));
    const privateBytes = new Uint8Array([0, 1, 2, 0, 255]);

    const first = openMigratedDb(path);
    let writtenIds: { shared: string; private: string };
    try {
      const repo = new WorkspaceFilesRepository(new SqliteTransactions(first.db));
      const shared = repo.write("ws_default", "workspace://docs/report.bin", USER, sharedBytes, "application/octet-stream");
      const priv = repo.write("ws_default", "agent://alice/scratch.bin", ALICE, privateBytes, "application/octet-stream");
      writtenIds = { shared: shared.id, private: priv.id };
    } finally {
      first.close();
    }

    // Reopen the SAME database file; the committed chain is idempotent.
    const second = openMigratedDb(path);
    try {
      const repo = new WorkspaceFilesRepository(new SqliteTransactions(second.db));

      const shared = repo.read("ws_default", "workspace://docs/report.bin", USER);
      expect(shared.id).toBe(writtenIds.shared);
      expect(Buffer.compare(Buffer.from(shared.content), Buffer.from(sharedBytes))).toBe(0);

      const priv = repo.read("ws_default", "agent://alice/scratch.bin", ALICE);
      expect(priv.id).toBe(writtenIds.private);
      expect(Buffer.compare(Buffer.from(priv.content), Buffer.from(privateBytes))).toBe(0);

      // The tree and the private-folder rules survived the restart too.
      expect(repo.list("ws_default", "workspace://docs", USER).map((node) => node.name)).toEqual([
        "report.bin",
      ]);
      expect(() => repo.read("ws_default", "agent://alice/scratch.bin", BOB)).toThrow(
        PrivateScopeDeniedError,
      );
    } finally {
      second.close();
    }
  });
});
