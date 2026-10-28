/**
 * S19 chunk 1 — projects + credentials + worktrees + merge requests storage
 * contract tests (issue #20; PRD §10, E6, D6, D22, D35, E12). Red-first: these
 * tests pin the v14 migration and the repository behaviors before they exist.
 *
 *   1. The migration chain appends v14 (projects-and-git) with the four
 *      product tables plus the restricted-access allowlist table.
 *   2. STRICT table discipline: invalid enum values are unrepresentable.
 *   3. Workspace scoping is not optional (E12): every read and mutation keys
 *      rows by workspace_id — another workspace's rows are invisible.
 *   4. Projects are shared by default with an optional Agent allowlist
 *      (PRD §10); the allowlist is replaceable as a whole.
 *   5. Credentials are per-repository rows carrying ONLY ciphertext (D22/G3):
 *      the secret material lives in the three BLOB columns, and one ACTIVE
 *      credential per kind per repository is unrepresentable (the replace
 *      flow revokes the old row first).
 *   6. Worktrees: at most ONE active worktree per project (partial unique
 *      index — two concurrent coding worktrees on one project cannot exist at
 *      the storage layer, D6/E6); queued rows carry their visible reason.
 *   7. Merge requests record exactly the PRD §10 minimal fields (change
 *      summary, changed files, validation status, conflict status, target
 *      branch) plus the approval linkage and lifecycle state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import {
  appliedMigrationVersions,
  applyMigrations,
  MIGRATIONS,
  sqliteTableExists,
} from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import {
  ProjectsRepository,
  ProjectCredentialActiveExistsError,
  ProjectNotFoundError,
  ProjectWorktreeActiveExistsError,
  type MergeRequestRow,
  type ProjectCredentialRow,
  type ProjectRow,
  type ProjectWorktreeRow,
} from "./projects-repository.ts";

const WS = "ws_primary";
const OTHER_WS = "ws_other_0001";
const USER = { type: "user", id: "user_001" } as const;
const NOW = "2026-10-29T10:00:00.000Z";

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s19-projects-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("S19 v14 migration (projects-and-git)", () => {
  let conn: SqliteConnection;

  beforeEach(() => {
    conn = openDatabase(newTempDbPath());
    applyMigrations(conn.db);
  });

  afterEach(() => {
    conn.close();
  });

  it("appends v15 to the committed migration chain", () => {
    const v14 = MIGRATIONS.find((migration) => migration.version === 14);
    expect(v14?.name).toBe("projects-and-git");
    const v15 = MIGRATIONS.find((migration) => migration.version === 15);
    expect(v15?.name).toBe("projects-archive-source");
    expect(MIGRATIONS.at(-1)?.version).toBe(15);
    const applied = appliedMigrationVersions(conn.db);
    expect(applied.at(-1)).toBe(15);
  });

  it("v15 widens projects.source_kind to admit archives while keeping the strict enum", () => {
    const v15 = MIGRATIONS.find((migration) => migration.version === 15);
    expect(v15?.up).toContain("'archive'");
    expect(v15?.up).toContain("'git_url'");
    expect(v15?.up).toContain("'directory'");
    // The rebuilt table still refuses an unknown kind (STRICT discipline).
    expect(() =>
      conn.db
        .prepare(
          `INSERT INTO projects (workspace_id, project_id, name, source_kind, source_url, repo_path,
             default_branch, access_mode, created_by_type, created_by_id, created_at, updated_at)
           VALUES (?, 'prj_x', 'demo', 'not_a_kind', 'https://example.invalid/repo', '/tmp/r',
             'main', 'shared', 'user', 'user_001', '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z')`,
        )
        .run(WS),
    ).toThrow();
  });

  it("creates the four product tables plus the access allowlist table", () => {
    for (const table of [
      "projects",
      "project_credentials",
      "project_worktrees",
      "merge_requests",
      "project_agent_access",
    ]) {
      expect(sqliteTableExists(conn.db, table)).toBe(true);
    }
  });

  it("refuses invalid enum values (STRICT tables)", () => {
    expect(() =>
      conn.db
        .prepare(
          `INSERT INTO projects (workspace_id, project_id, name, source_kind, source_url, repo_path,
             default_branch, access_mode, created_by_type, created_by_id, created_at, updated_at)
           VALUES (?, 'prj_x', 'demo', 'not_a_kind', 'https://example.invalid/repo', '/tmp/r',
             'main', 'shared', 'user', 'user_001', '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z')`,
        )
        .run(WS),
    ).toThrow();

    expect(() =>
      conn.db
        .prepare(
          `INSERT INTO merge_requests (workspace_id, project_id, merge_request_id, task_id, agent_id,
             source_branch, target_branch, change_summary, changed_files_json, validation_status,
             conflict_status, status, created_at, updated_at)
           VALUES (?, 'prj_x', 'mr_x', 'task_x', 'agent_x', 'shera/task/x', 'main', 'summary',
             '[]', 'not_run', 'unknown', 'not_a_status', '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z')`,
        )
        .run(WS),
    ).toThrow();
  });
});

describe("S19 projects repository", () => {
  let conn: SqliteConnection;
  let tx: SqliteTransactions;
  let repo: ProjectsRepository;

  beforeEach(() => {
    conn = openDatabase(newTempDbPath());
    applyMigrations(conn.db);
    tx = new SqliteTransactions(conn.db);
    repo = new ProjectsRepository(tx);
  });

  afterEach(() => {
    conn.close();
  });

  function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
    return {
      workspace_id: WS,
      project_id: "prj_001",
      name: "demo-repo",
      source_kind: "git_url",
      source_url: "https://example.invalid/demo-repo",
      repo_path: join(tempDirs[0] ?? ".", "projects", "prj_001", "repo"),
      default_branch: "main",
      access_mode: "shared",
      created_by_type: USER.type,
      created_by_id: USER.id,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    };
  }

  it("inserts and reads a project; another workspace's project is invisible (E12)", () => {
    repo.insertProject(projectRow());
    const found = repo.findProject(WS, "prj_001");
    expect(found?.name).toBe("demo-repo");
    expect(found?.access_mode).toBe("shared");
    expect(repo.findProject(OTHER_WS, "prj_001")).toBeNull();
    expect(repo.listProjects(OTHER_WS)).toEqual([]);
    expect(repo.listProjects(WS)).toHaveLength(1);
    expect(() => repo.requireProject(OTHER_WS, "prj_001")).toThrow(ProjectNotFoundError);
  });

  it("replaces the restricted-access Agent allowlist as a whole", () => {
    repo.insertProject(projectRow({ access_mode: "restricted" }));
    repo.setProjectAgentAccess(WS, "prj_001", ["agent_dev_1", "agent_dev_2"], NOW);
    expect(repo.listProjectAgentAccess(WS, "prj_001").sort()).toEqual([
      "agent_dev_1",
      "agent_dev_2",
    ]);
    // A shared project admits every Agent: the allowlist stays empty.
    repo.insertProject(projectRow({ project_id: "prj_002", access_mode: "shared" }));
    expect(repo.listProjectAgentAccess(WS, "prj_002")).toEqual([]);
  });

  it("stores credential rows as ciphertext blobs only and enforces one ACTIVE credential per kind", () => {
    const cred = (overrides: Partial<ProjectCredentialRow> = {}): ProjectCredentialRow => ({
      workspace_id: WS,
      project_id: "prj_001",
      credential_id: "cred_001",
      credential_kind: "token",
      username: "x-access-token",
      secret_ciphertext: Buffer.from([1, 2, 3]),
      secret_iv: Buffer.from([4]),
      secret_tag: Buffer.from([5]),
      key_version: 1,
      created_by_type: USER.type,
      created_by_id: USER.id,
      created_at: NOW,
      revoked_at: null,
      ...overrides,
    });

    repo.insertProject(projectRow());
    repo.insertCredential(cred());
    expect(repo.findCredential(WS, "prj_001", "cred_001")?.username).toBe("x-access-token");
    expect(repo.findActiveCredential(WS, "prj_001", "token")?.credential_id).toBe("cred_001");

    // One ACTIVE credential per (project, kind): the replace flow must revoke
    // the old row before a new one lands.
    expect(() => repo.insertCredential(cred({ credential_id: "cred_002" }))).toThrow(
      ProjectCredentialActiveExistsError,
    );
    repo.revokeCredential(WS, "prj_001", "cred_001", NOW);
    expect(repo.findActiveCredential(WS, "prj_001", "token")).toBeNull();
    repo.insertCredential(cred({ credential_id: "cred_002", created_at: NOW }));
    expect(repo.findActiveCredential(WS, "prj_001", "token")?.credential_id).toBe("cred_002");
    expect(repo.listCredentials(WS, "prj_001")).toHaveLength(2);

    // E12: the credential is scoped to one repository.
    expect(repo.findCredential(WS, "prj_other", "cred_001")).toBeNull();
  });

  it("enforces at most one ACTIVE worktree per project and records queue rows with reasons", () => {
    const wt = (overrides: Partial<ProjectWorktreeRow> = {}): ProjectWorktreeRow => {
      const worktreeId = overrides.worktree_id ?? "wt_001";
      return {
        workspace_id: WS,
        project_id: "prj_001",
        worktree_id: worktreeId,
        task_id: "task_A",
        agent_id: "agent_dev_1",
        branch_name: "shera/task/task_A",
        worktree_path: join(tempDirs[0] ?? ".", "projects", "prj_001", "worktrees", worktreeId),
        status: "active",
        queue_reason: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
      };
    };

    repo.insertProject(projectRow());
    repo.insertWorktree(wt());
    expect(repo.findActiveWorktree(WS, "prj_001")?.task_id).toBe("task_A");

    // The storage layer makes two concurrent active worktrees on one project
    // unrepresentable (D6: no conflicting simultaneous control).
    expect(() => repo.insertWorktree(wt({ worktree_id: "wt_002", task_id: "task_B" }))).toThrow(
      ProjectWorktreeActiveExistsError,
    );

    // The queue entry is a recorded row with its visible reason (G5).
    repo.insertWorktree(
      wt({
        worktree_id: "wt_003",
        task_id: "task_B",
        status: "queued",
        queue_reason: "active worktree wt_001 held by task task_A",
      }),
    );
    expect(repo.listQueuedWorktrees(WS, "prj_001").map((row) => row.task_id)).toEqual(["task_B"]);
    expect(repo.listQueuedWorktrees(WS, "prj_001")[0]?.queue_reason).toContain("task_A");

    // Release frees the slot: the active partial index no longer binds.
    repo.markWorktreeStatus(WS, "prj_001", "wt_001", "merged", NOW);
    repo.insertWorktree(wt({ worktree_id: "wt_004", task_id: "task_B" }));
    expect(repo.findActiveWorktree(WS, "prj_001")?.task_id).toBe("task_B");
    expect(repo.listWorktrees(WS, "prj_001")).toHaveLength(3);
  });

  it("stores merge requests with the minimal PRD fields and resolves them by approval id", () => {
    const mr = (overrides: Partial<MergeRequestRow> = {}): MergeRequestRow => ({
      workspace_id: WS,
      project_id: "prj_001",
      merge_request_id: "mr_001",
      task_id: "task_A",
      agent_id: "agent_dev_1",
      source_branch: "shera/task/task_A",
      target_branch: "main",
      change_summary: "Add the greeting module.",
      changed_files_json: JSON.stringify(["src/greet.ts"]),
      validation_status: "not_run",
      validation_note: null,
      conflict_status: "clean",
      conflict_files_json: null,
      approval_id: "apr_001",
      status: "awaiting_approval",
      status_reason: null,
      merged_commit: null,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    });

    repo.insertProject(projectRow());
    repo.insertMergeRequest(mr());
    const found = repo.findMergeRequest(WS, "prj_001", "mr_001");
    expect(found?.target_branch).toBe("main");
    expect(found?.conflict_status).toBe("clean");
    expect(JSON.parse(found?.changed_files_json ?? "[]")).toEqual(["src/greet.ts"]);
    expect(repo.findMergeRequestByApproval(WS, "apr_001")?.merge_request_id).toBe("mr_001");
    expect(repo.findMergeRequestByApproval(WS, "apr_missing")).toBeNull();
    expect(repo.listMergeRequests(WS, "prj_001")).toHaveLength(1);
    // E12: another workspace cannot resolve the merge request by approval id.
    expect(repo.findMergeRequestByApproval(OTHER_WS, "apr_001")).toBeNull();

    repo.updateMergeRequest(WS, "prj_001", "mr_001", {
      status: "merged",
      merged_commit: "abc123",
      updated_at: NOW,
    });
    expect(repo.findMergeRequest(WS, "prj_001", "mr_001")?.status).toBe("merged");
    expect(repo.findMergeRequest(WS, "prj_001", "mr_001")?.merged_commit).toBe("abc123");
  });
});
