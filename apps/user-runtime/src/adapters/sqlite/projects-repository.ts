/**
 * Projects + credentials + worktrees + merge requests repository (S19 chunk
 * 1; PRD §10, E6, D6, D22, D35, E12) — the only place their SQL lives.
 *
 * The rows are CONTROL RECORDS: the working copies (clone directories, git
 * worktrees, the credential key file) live on the container filesystem and
 * are owned by the git service. This repository enforces the storage-layer
 * invariants the git service composes with:
 *
 *  - Workspace scoping is not optional (E12): every method takes
 *    workspace_id and every statement keys rows by it.
 *  - At most ONE active worktree per project (the v14 partial unique index;
 *    D6: no conflicting simultaneous control). A second insert throws the
 *    typed ProjectWorktreeActiveExistsError — the git service turns that
 *    into a RECORDED queue entry, never a silent grant or a silent refusal.
 *  - At most one ACTIVE credential per (project, kind) (the replace flow
 *    must revoke first); the rows carry ciphertext blobs only (D22/G3).
 *  - Merge requests resolve by their linked approval id — the bridge the
 *    approval machinery uses to find the merge a decision belongs to.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export interface ProjectRow {
  workspace_id: string;
  project_id: string;
  name: string;
  source_kind: "git_url" | "directory" | "archive";
  source_url: string;
  repo_path: string;
  default_branch: string;
  access_mode: "shared" | "restricted";
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectCredentialRow {
  workspace_id: string;
  project_id: string;
  credential_id: string;
  credential_kind: "token" | "password" | "ssh_key";
  username: string | null;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  key_version: number;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  revoked_at: string | null;
}

export type ProjectWorktreeStatus = "active" | "queued" | "admitted" | "released" | "merged";

export interface ProjectWorktreeRow {
  workspace_id: string;
  project_id: string;
  worktree_id: string;
  task_id: string;
  agent_id: string | null;
  branch_name: string;
  worktree_path: string;
  status: ProjectWorktreeStatus;
  queue_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type MergeRequestStatus =
  | "awaiting_approval"
  | "queued"
  | "approved"
  | "merged"
  | "rejected"
  | "changes_requested"
  | "failed";

export interface MergeRequestRow {
  workspace_id: string;
  project_id: string;
  merge_request_id: string;
  task_id: string;
  agent_id: string;
  source_branch: string;
  target_branch: string;
  change_summary: string;
  changed_files_json: string;
  validation_status: "not_run" | "passed" | "failed";
  validation_note: string | null;
  conflict_status: "unknown" | "clean" | "conflict";
  conflict_files_json: string | null;
  approval_id: string | null;
  status: MergeRequestStatus;
  status_reason: string | null;
  merged_commit: string | null;
  created_at: string;
  updated_at: string;
}

/** Typed storage-layer failures (the service maps them onto its taxonomy). */
export class ProjectNotFoundError extends Error {
  constructor(message = "no project with this id exists in the workspace") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectCredentialActiveExistsError extends Error {
  constructor(message = "an active credential of this kind already exists for the project") {
    super(message);
    this.name = "ProjectCredentialActiveExistsError";
  }
}

export class ProjectWorktreeActiveExistsError extends Error {
  constructor(message = "an active worktree already exists for this project") {
    super(message);
    this.name = "ProjectWorktreeActiveExistsError";
  }
}

export class ProjectWorktreeNotFoundError extends Error {
  constructor(message = "no worktree with this id exists for the project") {
    super(message);
    this.name = "ProjectWorktreeNotFoundError";
  }
}

export class MergeRequestNotFoundError extends Error {
  constructor(message = "no merge request with this id exists for the project") {
    super(message);
    this.name = "MergeRequestNotFoundError";
  }
}

/** The subset of columns each row type reads back (STRICT tables, explicit lists). */
const PROJECT_COLUMNS =
  "workspace_id, project_id, name, source_kind, source_url, repo_path, default_branch, access_mode, created_by_type, created_by_id, created_at, updated_at";
const CREDENTIAL_COLUMNS =
  "workspace_id, project_id, credential_id, credential_kind, username, secret_ciphertext, secret_iv, secret_tag, key_version, created_by_type, created_by_id, created_at, revoked_at";
const WORKTREE_COLUMNS =
  "workspace_id, project_id, worktree_id, task_id, agent_id, branch_name, worktree_path, status, queue_reason, created_at, updated_at";
const MERGE_REQUEST_COLUMNS =
  "workspace_id, project_id, merge_request_id, task_id, agent_id, source_branch, target_branch, change_summary, changed_files_json, validation_status, validation_note, conflict_status, conflict_files_json, approval_id, status, status_reason, merged_commit, created_at, updated_at";

export class ProjectsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  // -------------------------------------------------------------------------
  // Projects + the restricted-access allowlist
  // -------------------------------------------------------------------------

  insertProject(row: ProjectRow, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO projects (${PROJECT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.workspace_id,
      row.project_id,
      row.name,
      row.source_kind,
      row.source_url,
      row.repo_path,
      row.default_branch,
      row.access_mode,
      row.created_by_type,
      row.created_by_id,
      row.created_at,
      row.updated_at,
    );
  }

  findProject(workspaceId: string, projectId: string, exec?: DatabaseSync): ProjectRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = ? AND project_id = ?`)
      .get(workspaceId, projectId) as ProjectRow | undefined;
    return row ?? null;
  }

  requireProject(workspaceId: string, projectId: string, exec?: DatabaseSync): ProjectRow {
    const row = this.findProject(workspaceId, projectId, exec);
    if (row === null) {
      throw new ProjectNotFoundError();
    }
    return row;
  }

  listProjects(workspaceId: string, exec?: DatabaseSync): ProjectRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = ? ORDER BY created_at, project_id`,
      )
      .all(workspaceId) as unknown as ProjectRow[];
  }

  updateProject(
    workspaceId: string,
    projectId: string,
    patch: { access_mode?: "shared" | "restricted"; name?: string; updated_at: string },
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const row = this.requireProject(workspaceId, projectId, exec);
    db.prepare(
      `UPDATE projects SET name = ?, access_mode = ?, updated_at = ?
                WHERE workspace_id = ? AND project_id = ?`,
    ).run(
      patch.name ?? row.name,
      patch.access_mode ?? row.access_mode,
      patch.updated_at,
      workspaceId,
      projectId,
    );
  }

  /** Replace the restricted-project allowlist WHOLE (the only mutation). */
  setProjectAgentAccess(
    workspaceId: string,
    projectId: string,
    agentIds: readonly string[],
    at: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    this.requireProject(workspaceId, projectId, exec);
    const apply = (e: DatabaseSync) => {
      e.prepare(`DELETE FROM project_agent_access WHERE workspace_id = ? AND project_id = ?`).run(
        workspaceId,
        projectId,
      );
      for (const agentId of agentIds) {
        e.prepare(
          `INSERT INTO project_agent_access (workspace_id, project_id, agent_id, added_at)
           VALUES (?, ?, ?, ?)`,
        ).run(workspaceId, projectId, agentId, at);
      }
    };
    if (exec) {
      apply(exec);
    } else {
      this.tx.transaction(apply);
    }
  }

  listProjectAgentAccess(workspaceId: string, projectId: string, exec?: DatabaseSync): string[] {
    const db = exec ?? this.tx.connection();
    return (
      db
        .prepare(
          `SELECT agent_id FROM project_agent_access
           WHERE workspace_id = ? AND project_id = ? ORDER BY agent_id`,
        )
        .all(workspaceId, projectId) as Array<{ agent_id: string }>
    ).map((row) => row.agent_id);
  }

  // -------------------------------------------------------------------------
  // Credentials (ciphertext-only rows; D22/G3)
  // -------------------------------------------------------------------------

  insertCredential(row: ProjectCredentialRow, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    // The typed answer in the normal path: one ACTIVE credential per
    // (project, kind) — the replace flow must revoke first.
    if (
      row.revoked_at === null &&
      this.findActiveCredential(row.workspace_id, row.project_id, row.credential_kind, exec) !==
        null
    ) {
      throw new ProjectCredentialActiveExistsError();
    }
    try {
      db.prepare(
        `INSERT INTO project_credentials (${CREDENTIAL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.workspace_id,
        row.project_id,
        row.credential_id,
        row.credential_kind,
        row.username,
        row.secret_ciphertext,
        row.secret_iv,
        row.secret_tag,
        row.key_version,
        row.created_by_type,
        row.created_by_id,
        row.created_at,
        row.revoked_at,
      );
    } catch (error) {
      // The v14 partial unique index backs the pre-check up under races.
      if (isUniqueViolationOf(error, "project_credentials.credential_kind")) {
        throw new ProjectCredentialActiveExistsError();
      }
      throw error;
    }
  }

  findCredential(
    workspaceId: string,
    projectId: string,
    credentialId: string,
    exec?: DatabaseSync,
  ): ProjectCredentialRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM project_credentials
         WHERE workspace_id = ? AND project_id = ? AND credential_id = ?`,
      )
      .get(workspaceId, projectId, credentialId) as ProjectCredentialRow | undefined;
    return row ?? null;
  }

  requireCredential(
    workspaceId: string,
    projectId: string,
    credentialId: string,
    exec?: DatabaseSync,
  ): ProjectCredentialRow {
    const row = this.findCredential(workspaceId, projectId, credentialId, exec);
    if (row === null) {
      throw new ProjectNotFoundError("no credential with this id exists for the project");
    }
    return row;
  }

  /** The one ACTIVE (unrevoked) credential of a kind; null when none stands. */
  findActiveCredential(
    workspaceId: string,
    projectId: string,
    credentialKind: ProjectCredentialRow["credential_kind"],
    exec?: DatabaseSync,
  ): ProjectCredentialRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM project_credentials
         WHERE workspace_id = ? AND project_id = ? AND credential_kind = ? AND revoked_at IS NULL`,
      )
      .get(workspaceId, projectId, credentialKind) as ProjectCredentialRow | undefined;
    return row ?? null;
  }

  listCredentials(
    workspaceId: string,
    projectId: string,
    exec?: DatabaseSync,
  ): ProjectCredentialRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM project_credentials
         WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, credential_id`,
      )
      .all(workspaceId, projectId) as unknown as ProjectCredentialRow[];
  }

  /** Stamp revoked_at (write-once); false when no row matched in the workspace. */
  revokeCredential(
    workspaceId: string,
    projectId: string,
    credentialId: string,
    at: string,
    exec?: DatabaseSync,
  ): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE project_credentials SET revoked_at = ?
         WHERE workspace_id = ? AND project_id = ? AND credential_id = ? AND revoked_at IS NULL`,
      )
      .run(at, workspaceId, projectId, credentialId);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Worktrees (one ACTIVE per project — the storage-level queue invariant)
  // -------------------------------------------------------------------------

  insertWorktree(row: ProjectWorktreeRow, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    // The typed answer in the normal path: at most one ACTIVE worktree per
    // project (D6 — no conflicting simultaneous control).
    if (
      row.status === "active" &&
      this.findActiveWorktree(row.workspace_id, row.project_id, exec) !== null
    ) {
      throw new ProjectWorktreeActiveExistsError();
    }
    try {
      db.prepare(
        `INSERT INTO project_worktrees (${WORKTREE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.workspace_id,
        row.project_id,
        row.worktree_id,
        row.task_id,
        row.agent_id,
        row.branch_name,
        row.worktree_path,
        row.status,
        row.queue_reason,
        row.created_at,
        row.updated_at,
      );
    } catch (error) {
      // The v14 partial unique index backs the pre-check up under races.
      if (
        isUniqueViolationOf(
          error,
          "project_worktrees.workspace_id, project_worktrees.project_id",
        ) &&
        !String(error instanceof Error ? error.message : "").includes("worktree_path")
      ) {
        throw new ProjectWorktreeActiveExistsError();
      }
      throw error;
    }
  }

  findWorktree(
    workspaceId: string,
    projectId: string,
    worktreeId: string,
    exec?: DatabaseSync,
  ): ProjectWorktreeRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM project_worktrees
         WHERE workspace_id = ? AND project_id = ? AND worktree_id = ?`,
      )
      .get(workspaceId, projectId, worktreeId) as ProjectWorktreeRow | undefined;
    return row ?? null;
  }

  findWorktreeByTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
    exec?: DatabaseSync,
  ): ProjectWorktreeRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM project_worktrees
         WHERE workspace_id = ? AND project_id = ? AND task_id = ?
         ORDER BY created_at DESC, worktree_id DESC LIMIT 1`,
      )
      .get(workspaceId, projectId, taskId) as ProjectWorktreeRow | undefined;
    return row ?? null;
  }

  findActiveWorktree(
    workspaceId: string,
    projectId: string,
    exec?: DatabaseSync,
  ): ProjectWorktreeRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM project_worktrees
         WHERE workspace_id = ? AND project_id = ? AND status = 'active'`,
      )
      .get(workspaceId, projectId) as ProjectWorktreeRow | undefined;
    return row ?? null;
  }

  findActiveWorktreeByTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
    exec?: DatabaseSync,
  ): ProjectWorktreeRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM project_worktrees
         WHERE workspace_id = ? AND project_id = ? AND task_id = ? AND status = 'active'`,
      )
      .get(workspaceId, projectId, taskId) as ProjectWorktreeRow | undefined;
    return row ?? null;
  }

  listWorktrees(workspaceId: string, projectId: string, exec?: DatabaseSync): ProjectWorktreeRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM project_worktrees
         WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, worktree_id`,
      )
      .all(workspaceId, projectId) as unknown as ProjectWorktreeRow[];
  }

  /** Queue entries awaiting a free slot, oldest first. */
  listQueuedWorktrees(
    workspaceId: string,
    projectId: string,
    exec?: DatabaseSync,
  ): ProjectWorktreeRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM project_worktrees
         WHERE workspace_id = ? AND project_id = ? AND status = 'queued'
         ORDER BY created_at, worktree_id`,
      )
      .all(workspaceId, projectId) as unknown as ProjectWorktreeRow[];
  }

  markWorktreeStatus(
    workspaceId: string,
    projectId: string,
    worktreeId: string,
    status: ProjectWorktreeStatus,
    at: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE project_worktrees SET status = ?, updated_at = ?
         WHERE workspace_id = ? AND project_id = ? AND worktree_id = ?`,
      )
      .run(status, at, workspaceId, projectId, worktreeId);
    if (Number(result.changes) === 0) {
      throw new ProjectWorktreeNotFoundError();
    }
  }

  /** Transition a task's prior queue entries to 'admitted' (visible lifecycle, G5). */
  admitQueuedWorktreesForTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
    at: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `UPDATE project_worktrees SET status = 'admitted', updated_at = ?
       WHERE workspace_id = ? AND project_id = ? AND task_id = ? AND status = 'queued'`,
    ).run(at, workspaceId, projectId, taskId);
  }

  // -------------------------------------------------------------------------
  // Merge requests
  // -------------------------------------------------------------------------

  insertMergeRequest(row: MergeRequestRow, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO merge_requests (${MERGE_REQUEST_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.workspace_id,
      row.project_id,
      row.merge_request_id,
      row.task_id,
      row.agent_id,
      row.source_branch,
      row.target_branch,
      row.change_summary,
      row.changed_files_json,
      row.validation_status,
      row.validation_note,
      row.conflict_status,
      row.conflict_files_json,
      row.approval_id,
      row.status,
      row.status_reason,
      row.merged_commit,
      row.created_at,
      row.updated_at,
    );
  }

  findMergeRequest(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
    exec?: DatabaseSync,
  ): MergeRequestRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${MERGE_REQUEST_COLUMNS} FROM merge_requests
         WHERE workspace_id = ? AND project_id = ? AND merge_request_id = ?`,
      )
      .get(workspaceId, projectId, mergeRequestId) as MergeRequestRow | undefined;
    return row ?? null;
  }

  requireMergeRequest(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
    exec?: DatabaseSync,
  ): MergeRequestRow {
    const row = this.findMergeRequest(workspaceId, projectId, mergeRequestId, exec);
    if (row === null) {
      throw new MergeRequestNotFoundError();
    }
    return row;
  }

  /** The merge request a D9 approval decision belongs to (the linkage bridge). */
  findMergeRequestByApproval(
    workspaceId: string,
    approvalId: string,
    exec?: DatabaseSync,
  ): MergeRequestRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${MERGE_REQUEST_COLUMNS} FROM merge_requests
         WHERE workspace_id = ? AND approval_id = ?
         ORDER BY created_at DESC, merge_request_id DESC LIMIT 1`,
      )
      .get(workspaceId, approvalId) as MergeRequestRow | undefined;
    return row ?? null;
  }

  listMergeRequests(
    workspaceId: string,
    projectId: string,
    exec?: DatabaseSync,
  ): MergeRequestRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT ${MERGE_REQUEST_COLUMNS} FROM merge_requests
         WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, merge_request_id`,
      )
      .all(workspaceId, projectId) as unknown as MergeRequestRow[];
  }

  updateMergeRequest(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
    patch: Partial<
      Pick<
        MergeRequestRow,
        | "status"
        | "status_reason"
        | "approval_id"
        | "merged_commit"
        | "conflict_status"
        | "conflict_files_json"
        | "validation_status"
        | "validation_note"
      >
    > & { updated_at: string },
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const row = this.requireMergeRequest(workspaceId, projectId, mergeRequestId, exec);
    db.prepare(
      `UPDATE merge_requests SET status = ?, status_reason = ?, approval_id = ?, merged_commit = ?,
         conflict_status = ?, conflict_files_json = ?, validation_status = ?, validation_note = ?, updated_at = ?
       WHERE workspace_id = ? AND project_id = ? AND merge_request_id = ?`,
    ).run(
      patch.status ?? row.status,
      patch.status_reason !== undefined ? patch.status_reason : row.status_reason,
      patch.approval_id !== undefined ? patch.approval_id : row.approval_id,
      patch.merged_commit !== undefined ? patch.merged_commit : row.merged_commit,
      patch.conflict_status ?? row.conflict_status,
      patch.conflict_files_json !== undefined ? patch.conflict_files_json : row.conflict_files_json,
      patch.validation_status ?? row.validation_status,
      patch.validation_note !== undefined ? patch.validation_note : row.validation_note,
      patch.updated_at,
      workspaceId,
      projectId,
      mergeRequestId,
    );
  }
}

/**
 * SQLite's UNIQUE-constraint error signature, narrowed to the named column
 * list. node:sqlite surfaces the extended error code on `errcode` (2067 =
 * SQLITE_CONSTRAINT_UNIQUE) and the violated columns in the message; the
 * driver's `code` is the generic ERR_SQLITE_ERROR. Other unique violations
 * (e.g. the worktree path index) are NOT misclassified.
 */
function isUniqueViolationOf(error: unknown, columnList: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    Number((error as { errcode?: unknown }).errcode) === 2067 &&
    error instanceof Error &&
    error.message.includes(columnList)
  );
}
