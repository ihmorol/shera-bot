/**
 * Git service (S19 chunk 1; PRD §10, E6, D6, D22, D35, G2/G3/G5/G6) — the
 * container's git coordination seam: project import/clone, task-scoped
 * branches + worktrees, the conflict queue, and the approval-gated merge.
 *
 * ---------------------------------------------------------------------------
 * The rules this module exists to enforce
 *
 * G2 — Agents propose; the runtime executes. Every mutation here is a runtime
 * operation on typed input; nothing parses prose. The coordinating Agent
 * PREPARES a merge request (the D35 preview: diff, branch, worktree) and the
 * RUNTIME executes the merge only after a valid D9 approval — `performMerge`
 * refuses unless the linked approval request is resolved `approved`. There is
 * no push code path at all in this chunk: the only repository mutation is the
 * local merge, and no dashed force form appears anywhere in this source (the
 * static scan in git.service.test.ts pins that; E6: the runtime never
 * force-pushes, and the merge never rebases — plain `git merge --no-ff`
 * only).
 *
 * G3 — credentials never leak. Secrets live in project_credentials rows as
 * AES-256-GCM ciphertext (the vault); they are decrypted ONLY at the moment a
 * clone needs one, injected into an https URL in-process, and the remote is
 * immediately re-pointed at the sanitized URL so no credential lands in
 * .git/config. URLs with embedded userinfo are refused outright. Fault logs
 * and typed failures carry the sanitized URL only — never a git error string
 * (which can quote the authenticated URL).
 *
 * G5 — conflicts queue, nothing is silently resolved. ONE active worktree per
 * project (the v15 partial unique index): a second task's request is a
 * RECORDED queue entry with a visible reason naming the holder, never a
 * concurrent grant. An execution-time merge conflict aborts the merge (target
 * branch untouched) and records the failure on the merge request.
 *
 * E6 — each admitted coding task gets an isolated branch and worktree; the
 * project's default branch is untouched until the approved merge lands.
 *
 * ATOMICITY — a failed import/clone leaves NO project row registered (the
 * staging directory is built first, the row is inserted last, and any failure
 * removes the staging tree). Worktree allocation joins one SQL transaction
 * for its row writes; the git filesystem operations happen before them.
 */
import { randomUUID, createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { simpleGit, type SimpleGit } from "simple-git";

import type { TaskRun } from "@shera-bot/contracts";

import {
  MergeRequestNotFoundError,
  ProjectCredentialActiveExistsError,
  ProjectNotFoundError,
  type MergeRequestRow,
  type ProjectCredentialRow,
  type ProjectRow,
  type ProjectsRepository,
  type ProjectWorktreeRow,
} from "../../adapters/sqlite/projects-repository.ts";
import type { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ApprovalsService, type TypedToolProposal } from "../approvals/approvals.service.ts";
import {
  CredentialVault,
  CredentialVaultError,
  buildAuthenticatedUrl,
  maskSecret,
  sanitizeGitUrl,
  urlHasEmbeddedCredentials,
} from "../projects/credential-vault.ts";
import { ArchiveImportError, extractArchiveInto } from "../projects/archive-import.ts";

/** Stable failure codes for the git boundary (SCREAMING_SNAKE). */
export type GitServiceFailureCode =
  | "GIT_PROJECT_IMPORT_FAILED"
  | "GIT_PROJECT_NOT_FOUND"
  | "GIT_AGENT_NOT_AUTHORIZED"
  | "GIT_WORKTREE_ALLOCATION_FAILED"
  | "GIT_WORKTREE_NOT_FOUND"
  | "GIT_WORKTREE_RELEASE_FAILED"
  | "GIT_CREDENTIAL_NOT_FOUND"
  | "GIT_CREDENTIAL_REVOKED"
  | "GIT_CREDENTIAL_ACTIVE_EXISTS"
  | "GIT_CREDENTIAL_INVALID"
  | "GIT_URL_INVALID"
  | "GIT_ARCHIVE_INVALID"
  | "GIT_FETCH_FAILED"
  | "GIT_VALIDATION_TARGET_INVALID"
  | "GIT_MERGE_REQUEST_NOT_FOUND"
  | "GIT_MERGE_REQUEST_INVALID"
  | "GIT_MERGE_NOT_APPROVED"
  | "GIT_MERGE_CONFLICT"
  | "GIT_REPO_DIRTY";

export class GitServiceError extends Error {
  readonly code: GitServiceFailureCode;
  readonly category: "validation" | "state" | "forbidden";

  constructor(
    code: GitServiceFailureCode,
    category: "validation" | "state" | "forbidden",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GitServiceError";
    this.code = code;
    this.category = category;
  }
}

/** The redacted fault sink (the composition's redacted logger). */
export type GitFaultLogger = (event: string, fields: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Read models (the API answers these; storage rows never cross raw)
// ---------------------------------------------------------------------------

export interface ProjectView {
  workspace_id: string;
  project_id: string;
  name: string;
  source_kind: "git_url" | "directory" | "archive";
  /** The sanitized origin label — never credential-bearing (G3). */
  source_url: string;
  /** The container-local clone directory (the UI never needs it; tests and ops do). */
  repo_path: string;
  default_branch: string;
  access_mode: "shared" | "restricted";
  created_by: { type: string; id: string };
  created_at: string;
  updated_at: string;
}

export interface WorktreeView {
  workspace_id: string;
  project_id: string;
  worktree_id: string;
  task_id: string;
  agent_id: string | null;
  branch_name: string;
  worktree_path: string;
  status: ProjectWorktreeRow["status"];
  queue_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CredentialView {
  workspace_id: string;
  project_id: string;
  credential_id: string;
  credential_kind: ProjectCredentialRow["credential_kind"];
  username: string | null;
  /** Masked display value — the secret itself has no read-back surface (D22). */
  masked_hint: string;
  created_at: string;
  revoked_at: string | null;
}

/** The minimal PRD §10 merge-approval view plus approval state. */
export interface MergeRequestView {
  workspace_id: string;
  project_id: string;
  merge_request_id: string;
  task_id: string;
  agent_id: string;
  source_branch: string;
  target_branch: string;
  change_summary: string;
  changed_files: string[];
  validation_status: MergeRequestRow["validation_status"];
  validation_note: string | null;
  conflict_status: MergeRequestRow["conflict_status"];
  conflict_files: string[];
  approval_id: string | null;
  status: MergeRequestRow["status"];
  status_reason: string | null;
  merged_commit: string | null;
  created_at: string;
  updated_at: string;
}

export type WorktreeAllocation =
  | { outcome: "allocated"; worktree: WorktreeView }
  | { outcome: "reacquired"; worktree: WorktreeView }
  | { outcome: "queued"; worktree: WorktreeView; reason: string };

export interface ImportProjectInput {
  workspace_id: string;
  name: string;
  actor: { type: string; id: string };
  source:
    | {
        kind: "git_url";
        url: string;
        /**
         * The D22 call-time credential: provided ONCE in the request, used for
         * THIS clone through buildAuthenticatedUrl (https only), and sealed
         * into the project's credential rows on success. It is never
         * persisted raw, echoed, or logged (G3) — a failed import leaves no
         * row and no secret.
         */
        credential?: { username: string | null; secret: string };
      }
    | { kind: "directory"; path: string }
    | { kind: "archive"; path: string };
}

export interface PrepareMergeRequestInput {
  workspace_id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  conversation_id: string;
  change_summary: string;
  /** The task run's current projection (the caller rebuilds it from the journal). */
  run: TaskRun;
}

export interface GitServiceDeps {
  projects: ProjectsRepository;
  vault: CredentialVault;
  /** The D9 approval boundary — merge approvals ride the SAME machinery. */
  approvals: ApprovalsService;
  approvalsRepository: ApprovalsRepository;
  tx: SqliteTransactions;
  /** The container-local root every project clone + worktree lives under. */
  projectsRoot: string;
  /**
   * Optional git environment for EVERY git call this service makes, passed
   * through simple-git's allowEnvironment seam (ambient GIT_* variables are
   * guarded otherwise). The deployment seam for TLS posture: a corporate CA
   * bundle (GIT_SSL_CAINFO) or a loopback test certificate
   * (GIT_SSL_NO_VERIFY) is wired HERE, by the composition — never set as an
   * ambient process variable, never persisted into any repository's config.
   */
  gitEnvironment?: Record<string, string>;
  /** Injected clock (ISO strings); defaults to the system clock. */
  clock?: () => string;
  /** The redacted fault sink; default: no-op (the composition injects one). */
  logFault?: GitFaultLogger;
}

const MAX_CHANGE_SUMMARY = 2000;
/** The merge tool identity the D9 approval records (runtime-owned, D38). */
export const MERGE_TOOL = {
  tool_id: "git.merge",
  tool_version: "1.0.0",
  capability: "repository.merge",
  risk_class: "LOCAL_MUTATION",
} as const;

function sanitizeBranchSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
}

function taskBranchName(taskId: string): string {
  return `shera/task/${sanitizeBranchSegment(taskId)}`;
}

/** Pull the stdout out of a simple-git failure without trusting its message. */
function rawStdout(error: unknown): string {
  if (typeof error === "object" && error !== null && "git" in error) {
    const git = (error as { git?: { stdout?: unknown } }).git;
    if (git && typeof git.stdout === "string") {
      return git.stdout;
    }
  }
  return "";
}

/** The storage row's read model — the exact PRD §10 minimal fields plus approval state. */
export function toMergeRequestView(row: MergeRequestRow): MergeRequestView {
  return {
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    merge_request_id: row.merge_request_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    source_branch: row.source_branch,
    target_branch: row.target_branch,
    change_summary: row.change_summary,
    changed_files: parseJsonList(row.changed_files_json),
    validation_status: row.validation_status,
    validation_note: row.validation_note,
    conflict_status: row.conflict_status,
    conflict_files: parseJsonList(row.conflict_files_json),
    approval_id: row.approval_id,
    status: row.status,
    status_reason: row.status_reason,
    merged_commit: row.merged_commit,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseJsonList(text: string | null): string[] {
  if (text === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export class GitService {
  /** In-flight merge executions keyed by merge request id (the decide seam). */
  private readonly mergeOutcomes = new Map<string, Promise<MergeRequestView>>();

  constructor(private readonly deps: GitServiceDeps) {}

  /**
   * The git client for one working directory, carrying the composition's git
   * environment (see gitEnvironment). Every git invocation in this service
   * goes through here. The runtime is headless and its credential custody is
   * the vault (D22): terminal prompts are disabled and credential helpers are
   * cleared per-invocation (`-c credential.helper=`, never persisted), so a
   * missing credential fails typed instead of blocking on an interactive
   * helper that sits OUTSIDE the vault.
   */
  private git(cwd?: string): SimpleGit {
    const gitEnvironment = this.deps.gitEnvironment ?? {};
    const env = { GIT_TERMINAL_PROMPT: "0", ...gitEnvironment };
    const client = simpleGit({
      ...(cwd !== undefined ? { baseDir: cwd } : {}),
      // The helper CLEAR is the safe direction of this guarded option (an
      // empty credential.helper removes every ambient helper): the runtime's
      // only credential custody is the vault (D22), and a helper outside the
      // container would be an invisible, unauditable credential path.
      unsafe: { allowUnsafeCredentialHelper: true },
      config: ["credential.helper="],
      allowEnvironment: Object.keys(env),
    });
    return client.env(env);
  }

  private now(): string {
    return (this.deps.clock ?? (() => new Date().toISOString()))();
  }

  private fault(event: string, fields: Record<string, unknown>): void {
    this.deps.logFault?.(event, fields);
  }

  /** The repository's typed misses become this boundary's typed 404s. */
  private requireProject(workspaceId: string, projectId: string): ProjectRow {
    try {
      return this.deps.projects.requireProject(workspaceId, projectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        throw new GitServiceError(
          "GIT_PROJECT_NOT_FOUND",
          "state",
          "no project with this id exists in the workspace",
        );
      }
      throw error;
    }
  }

  private requireMergeRequest(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
  ): MergeRequestRow {
    try {
      return this.deps.projects.requireMergeRequest(workspaceId, projectId, mergeRequestId);
    } catch (error) {
      if (error instanceof MergeRequestNotFoundError) {
        throw new GitServiceError(
          "GIT_MERGE_REQUEST_NOT_FOUND",
          "state",
          "no merge request with this id exists for the project",
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Import / clone (atomicity: no row on failure)
  // -------------------------------------------------------------------------

  async importProject(input: ImportProjectInput): Promise<ProjectView> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 255) {
      throw new GitServiceError(
        "GIT_PROJECT_IMPORT_FAILED",
        "validation",
        "the project name must be 1-255 characters",
      );
    }
    const projectId = `prj_${randomUUID()}`;
    const staging = join(this.deps.projectsRoot, projectId);
    const repoPath = join(staging, "repo");

    // D22: the provided credential is encrypted BEFORE anything else runs, so
    // a vault failure registers nothing and leaves no plaintext path behind.
    const providedCredential =
      input.source.kind === "git_url" ? input.source.credential : undefined;
    const sealedCredential =
      providedCredential !== undefined && providedCredential.secret.length > 0
        ? this.deps.vault.encrypt(providedCredential.secret)
        : null;

    try {
      let sourceUrl: string;
      if (input.source.kind === "git_url") {
        const url = input.source.url.trim();
        // D22: credentials ride credential rows, never the URL. An embedded
        // userinfo component is refused outright (its secret would land in
        // .git/config in plaintext).
        if (urlHasEmbeddedCredentials(url)) {
          throw new GitServiceError(
            "GIT_URL_INVALID",
            "validation",
            "the git URL must not embed credentials; store a project credential instead",
          );
        }
        sourceUrl = sanitizeGitUrl(url);
        mkdirSync(staging, { recursive: true });
        const cloneUrl =
          providedCredential !== undefined && sealedCredential !== null
            ? // The call-time injection (D22): https only — the vault seam
              // refuses any other scheme, so a file:// path never takes a
              // secret. The authenticated URL exists in this frame only.
              buildAuthenticatedUrl(url, {
                username: providedCredential.username,
                secret: providedCredential.secret,
              })
            : url;
        await this.git().clone(cloneUrl, repoPath);
        // The remote is stored credential-free (G3): a later fetch re-injects
        // the project's stored credential at call time.
        await this.git(repoPath)
          .remote(["set-url", "origin", sourceUrl])
          .catch(() => {});
      } else if (input.source.kind === "archive") {
        sourceUrl = input.source.path;
        mkdirSync(staging, { recursive: true });
        // The bounded-format extraction: every entry passes the traversal and
        // size guards; a refusal throws ArchiveImportError and leaves the
        // staging tree gone (mapped to the typed GIT_ARCHIVE_INVALID below).
        await extractArchiveInto(input.source.path, repoPath);
        const git = this.git(repoPath);
        await git.init(["-b", "main"]);
        await git.addConfig("user.email", "runtime@shera.local");
        await git.addConfig("user.name", "Shera Runtime");
        await git.add(["-A"]);
        await git.commit(`Import ${name}`);
      } else {
        const sourcePath = input.source.path;
        if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
          throw new GitServiceError(
            "GIT_PROJECT_IMPORT_FAILED",
            "validation",
            "the source directory does not exist",
          );
        }
        sourceUrl = sourcePath;
        mkdirSync(staging, { recursive: true });
        cpSync(sourcePath, repoPath, { recursive: true });
        const git = this.git(repoPath);
        if (existsSync(join(repoPath, ".git"))) {
          // An already-versioned tree: keep its history as-is.
          await git.addConfig("user.email", "runtime@shera.local");
          await git.addConfig("user.name", "Shera Runtime");
        } else {
          await git.init(["-b", "main"]);
          await git.addConfig("user.email", "runtime@shera.local");
          await git.addConfig("user.name", "Shera Runtime");
          await git.add(["-A"]);
          await git.commit(`Import ${name}`);
        }
      }

      const repo = this.git(repoPath);
      const defaultBranch = String(await repo.revparse(["--abbrev-ref", "HEAD"])).trim();

      // The row is inserted LAST: a failure anywhere above leaves no project
      // registered (the atomicity AC).
      const at = this.now();
      const row = {
        workspace_id: input.workspace_id,
        project_id: projectId,
        name,
        source_kind: input.source.kind,
        source_url: sourceUrl,
        repo_path: repoPath,
        default_branch: defaultBranch.length > 0 ? defaultBranch : "main",
        access_mode: "shared" as const,
        created_by_type: input.actor.type,
        created_by_id: input.actor.id,
        created_at: at,
        updated_at: at,
      };
      this.deps.projects.insertProject(row);
      if (providedCredential !== undefined && sealedCredential !== null) {
        // The secret is sealed into the project's credential custody only
        // after the project row exists: future clones/fetches resolve it at
        // call time (D22). The plaintext never touches any other surface.
        this.deps.projects.insertCredential({
          workspace_id: input.workspace_id,
          project_id: projectId,
          credential_id: `cred_${randomUUID()}`,
          credential_kind: "token",
          username: providedCredential.username,
          secret_ciphertext: sealedCredential.ciphertext,
          secret_iv: sealedCredential.iv,
          secret_tag: sealedCredential.tag,
          key_version: sealedCredential.key_version,
          created_by_type: input.actor.type,
          created_by_id: input.actor.id,
          created_at: at,
          revoked_at: null,
        });
      }
      return this.toProjectView(row);
    } catch (error) {
      // Nothing registered, nothing left behind (G4: honest, bounded failure).
      rmSync(staging, { recursive: true, force: true });
      if (error instanceof ArchiveImportError) {
        // The extraction's typed refusals are the import's typed refusals:
        // their messages are authored guard copy (never a raw entry name or
        // a filesystem path), so they cross the boundary safely.
        this.fault("s19_project_import_failed", {
          workspace_id: input.workspace_id,
          project_id: projectId,
          name,
          kind: input.source.kind,
        });
        throw new GitServiceError("GIT_ARCHIVE_INVALID", "validation", error.message);
      }
      if (error instanceof CredentialVaultError) {
        this.fault("s19_project_import_failed", {
          workspace_id: input.workspace_id,
          project_id: projectId,
          name,
          kind: input.source.kind,
        });
        throw new GitServiceError("GIT_URL_INVALID", "validation", error.message);
      }
      if (error instanceof GitServiceError) {
        this.fault("s19_project_import_failed", {
          workspace_id: input.workspace_id,
          project_id: projectId,
          name,
          kind: input.source.kind,
        });
        throw error;
      }
      // The git error text can quote an authenticated URL — never surface it.
      this.fault("s19_project_import_failed", {
        workspace_id: input.workspace_id,
        project_id: projectId,
        name,
        kind: input.source.kind,
      });
      throw new GitServiceError(
        "GIT_PROJECT_IMPORT_FAILED",
        "state",
        `the project import failed; nothing was registered`,
      );
    }
  }

  listProjects(workspaceId: string): ProjectView[] {
    return this.deps.projects.listProjects(workspaceId).map((row) => this.toProjectView(row));
  }

  getProject(workspaceId: string, projectId: string): ProjectView {
    return this.toProjectView(this.requireProject(workspaceId, projectId));
  }

  private toProjectView(row: ProjectRow): ProjectView {
    return {
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      name: row.name,
      source_kind: row.source_kind,
      source_url: row.source_url,
      repo_path: row.repo_path,
      default_branch: row.default_branch,
      access_mode: row.access_mode,
      created_by: { type: row.created_by_type, id: row.created_by_id },
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Fetch the project's origin into the local clone (the D22 call-time
   * consumer on the fetch side). When the project holds an ACTIVE token
   * credential it is decrypted HERE and injected into the fetched URL through
   * buildAuthenticatedUrl — the authenticated URL exists only inside this
   * frame and is never stored, logged, or echoed (G3). Without a credential
   * the fetch runs anonymously (public remotes). A REVOKED credential fails
   * safely: the typed refusal fires from the resolve BEFORE any git call.
   * A git-level failure is typed GIT_FETCH_FAILED with no git error text.
   */
  async refreshProject(workspaceId: string, projectId: string): Promise<{ fetched: boolean }> {
    const project = this.requireProject(workspaceId, projectId);
    const repo = this.git(project.repo_path);

    // D22: revocation is revocation, never a fall-back. When the project has
    // a token credential at all, the fetch MUST go through it: an active one
    // is decrypted HERE and injected into the fetched URL through
    // buildAuthenticatedUrl (the authenticated URL exists only inside this
    // frame — never stored, logged, or echoed, G3); a revoked one refuses
    // typed BEFORE any git call.
    const tokenRows = this.deps.projects
      .listCredentials(workspaceId, projectId)
      .filter((row) => row.credential_kind === "token");

    if (tokenRows.length > 0) {
      const activeToken = tokenRows.find((row) => row.revoked_at === null);
      if (activeToken === undefined) {
        this.fault("s19_project_fetch_failed", {
          workspace_id: workspaceId,
          project_id: projectId,
          reason: "credential_revoked",
        });
        throw new GitServiceError(
          "GIT_CREDENTIAL_REVOKED",
          "state",
          "the credential has been revoked and can no longer be used",
        );
      }
      // The revoked case also throws here — belt and braces (D22).
      const credential = await this.resolveCredential(
        workspaceId,
        projectId,
        activeToken.credential_id,
      );
      const authenticatedUrl = buildAuthenticatedUrl(project.source_url, credential);
      try {
        await repo.raw(["fetch", authenticatedUrl, "+refs/heads/*:refs/remotes/origin/*"]);
      } catch {
        this.fault("s19_project_fetch_failed", {
          workspace_id: workspaceId,
          project_id: projectId,
        });
        throw new GitServiceError(
          "GIT_FETCH_FAILED",
          "state",
          "the origin fetch failed; the local clone is unchanged",
        );
      }
      return { fetched: true };
    }

    try {
      await repo.fetch(["origin"]);
    } catch {
      this.fault("s19_project_fetch_failed", {
        workspace_id: workspaceId,
        project_id: projectId,
      });
      throw new GitServiceError(
        "GIT_FETCH_FAILED",
        "state",
        "the origin fetch failed; the local clone is unchanged",
      );
    }
    return { fetched: true };
  }

  // -------------------------------------------------------------------------
  // Task-scoped branches + worktrees; the conflict queue
  // -------------------------------------------------------------------------

  async allocateWorktree(input: {
    workspace_id: string;
    project_id: string;
    task_id: string;
    agent_id: string;
  }): Promise<WorktreeAllocation> {
    const project = this.requireProject(input.workspace_id, input.project_id);

    // PRD §10: shared by default; restricted projects admit only the
    // allowlisted Agents.
    if (project.access_mode === "restricted") {
      const allowed = this.deps.projects.listProjectAgentAccess(
        input.workspace_id,
        input.project_id,
      );
      if (!allowed.includes(input.agent_id)) {
        throw new GitServiceError(
          "GIT_AGENT_NOT_AUTHORIZED",
          "forbidden",
          "the project is restricted and this Agent is not on its access list",
        );
      }
    }

    const repo = this.git(project.repo_path);
    const at = this.now();
    const branchName = taskBranchName(input.task_id);

    // Idempotent re-request: the task already holds the project's slot.
    const own = this.deps.projects.findActiveWorktreeByTask(
      input.workspace_id,
      input.project_id,
      input.task_id,
    );
    if (own !== null) {
      return { outcome: "reacquired", worktree: this.toWorktreeView(own) };
    }

    // The conflict queue (D6/E6, G5): the slot is held by an earlier task
    // whose work is not merged yet — the request is RECORDED with its reason,
    // never granted concurrently.
    const active = this.deps.projects.findActiveWorktree(input.workspace_id, input.project_id);
    if (active !== null) {
      const existingQueue = this.deps.projects
        .listQueuedWorktrees(input.workspace_id, input.project_id)
        .find((row) => row.task_id === input.task_id);
      if (existingQueue) {
        return {
          outcome: "queued",
          worktree: this.toWorktreeView(existingQueue),
          reason: existingQueue.queue_reason ?? "",
        };
      }
      const reason = `active worktree ${active.worktree_id} held by task ${active.task_id}; related conflicting work queues until the earlier change finishes (D6/E6)`;
      const worktreeId = `wt_${randomUUID()}`;
      const row: ProjectWorktreeRow = {
        workspace_id: input.workspace_id,
        project_id: input.project_id,
        worktree_id: worktreeId,
        task_id: input.task_id,
        agent_id: input.agent_id,
        branch_name: branchName,
        worktree_path: join(this.deps.projectsRoot, input.project_id, "worktrees", worktreeId),
        status: "queued",
        queue_reason: reason,
        created_at: at,
        updated_at: at,
      };
      this.deps.projects.insertWorktree(row);
      return { outcome: "queued", worktree: this.toWorktreeView(row), reason };
    }

    // Admit: the task's own isolated branch + worktree (E6). The branch is
    // created at the default branch's current commit; the worktree checks it
    // out at the task's own path. The queue entries of this task are marked
    // admitted (visible lifecycle — G5) in the same transaction.
    const worktreeId = `wt_${randomUUID()}`;
    const worktreePath = join(this.deps.projectsRoot, input.project_id, "worktrees", worktreeId);
    try {
      const branches = await repo.branch(["--list", branchName]);
      if (!branches.all.includes(branchName)) {
        await repo.branch([branchName]);
      }
      await repo.raw(["worktree", "add", worktreePath, branchName]);
    } catch {
      rmSync(join(this.deps.projectsRoot, input.project_id, "worktrees", worktreeId), {
        recursive: true,
        force: true,
      });
      this.fault("s19_worktree_allocation_failed", {
        workspace_id: input.workspace_id,
        project_id: input.project_id,
        task_id: input.task_id,
      });
      throw new GitServiceError(
        "GIT_WORKTREE_ALLOCATION_FAILED",
        "state",
        "the worktree allocation failed; the repository state was left unchanged",
      );
    }

    const row: ProjectWorktreeRow = {
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      worktree_id: worktreeId,
      task_id: input.task_id,
      agent_id: input.agent_id,
      branch_name: branchName,
      worktree_path: worktreePath,
      status: "active",
      queue_reason: null,
      created_at: at,
      updated_at: at,
    };
    this.deps.tx.transaction((exec) => {
      this.deps.projects.admitQueuedWorktreesForTask(
        input.workspace_id,
        input.project_id,
        input.task_id,
        at,
        exec,
      );
      this.deps.projects.insertWorktree(row, exec);
    });
    return { outcome: "allocated", worktree: this.toWorktreeView(row) };
  }

  listWorktrees(workspaceId: string, projectId: string): WorktreeView[] {
    this.requireProject(workspaceId, projectId);
    return this.deps.projects
      .listWorktrees(workspaceId, projectId)
      .map((row) => this.toWorktreeView(row));
  }

  /**
   * Release one worktree (freeing the project's slot). `merged` also deletes
   * the task branch with the SAFE delete (`-d` refuses unmerged branches —
   * no history is destroyed). `released` keeps the branch: a rejected or
   * revised task's commits stay inspectable.
   */
  async releaseWorktree(input: {
    workspace_id: string;
    project_id: string;
    worktree_id: string;
    outcome: "released" | "merged";
  }): Promise<WorktreeView> {
    const row = this.deps.projects.findWorktree(
      input.workspace_id,
      input.project_id,
      input.worktree_id,
    );
    if (row === null) {
      throw new GitServiceError(
        "GIT_WORKTREE_NOT_FOUND",
        "state",
        "no worktree with this id exists for the project",
      );
    }
    const project = this.requireProject(input.workspace_id, input.project_id);
    const repo = this.git(project.repo_path);
    if (row.status === "active") {
      try {
        await repo.raw(["worktree", "remove", row.worktree_path]);
        if (input.outcome === "merged") {
          // The SAFE delete: refuses to drop an unmerged branch.
          await repo.raw(["branch", "-d", row.branch_name]);
        }
      } catch {
        this.fault("s19_worktree_release_failed", {
          workspace_id: input.workspace_id,
          project_id: input.project_id,
          worktree_id: row.worktree_id,
        });
        throw new GitServiceError(
          "GIT_WORKTREE_RELEASE_FAILED",
          "state",
          "the worktree release failed; the slot is unchanged",
        );
      }
    }
    const at = this.now();
    this.deps.projects.markWorktreeStatus(
      input.workspace_id,
      input.project_id,
      input.worktree_id,
      input.outcome,
      at,
    );
    return this.toWorktreeView({
      ...row,
      status: input.outcome,
      updated_at: at,
    });
  }

  private toWorktreeView(row: ProjectWorktreeRow): WorktreeView {
    return {
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      worktree_id: row.worktree_id,
      task_id: row.task_id,
      agent_id: row.agent_id,
      branch_name: row.branch_name,
      worktree_path: row.worktree_path,
      status: row.status,
      queue_reason: row.queue_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // Merge requests (E6/D35) — prepared through the S20 approval machinery
  // -------------------------------------------------------------------------

  /**
   * Prepare one merge request: compute the PRD §10 fields from the REAL
   * repository (changed files via the merge-base diff, conflict status via
   * `git merge-tree` — no working-tree mutation), then file the D9 approval
   * through ApprovalsService — the SAME boundary every gated action uses (no
   * parallel approval path). Row + approval commit as ONE transaction.
   */
  async prepareMergeRequest(
    input: PrepareMergeRequestInput,
  ): Promise<{ merge_request: MergeRequestView; approval_id: string; run: TaskRun }> {
    const project = this.requireProject(input.workspace_id, input.project_id);
    const worktree = this.deps.projects.findActiveWorktreeByTask(
      input.workspace_id,
      input.project_id,
      input.task_id,
    );
    if (worktree === null) {
      throw new GitServiceError(
        "GIT_MERGE_REQUEST_INVALID",
        "state",
        "the task holds no active worktree on this project; there is nothing to merge",
      );
    }
    const summary = input.change_summary.trim();
    if (summary.length < 1 || summary.length > MAX_CHANGE_SUMMARY) {
      throw new GitServiceError(
        "GIT_MERGE_REQUEST_INVALID",
        "validation",
        `the change summary must be 1-${MAX_CHANGE_SUMMARY} characters`,
      );
    }

    const sourceBranch = worktree.branch_name;
    const targetBranch = project.default_branch;
    const repo = this.git(project.repo_path);

    // The change set: commits + files on the task branch that the target
    // branch does not have (merge-base diff — the D35 preview's diff).
    let changedFiles: string[] = [];
    let commitCount: number;
    try {
      changedFiles = splitLines(
        await repo.raw(["diff", "--name-only", `${targetBranch}...${sourceBranch}`]),
      );
      commitCount = Number(
        (await repo.raw(["rev-list", "--count", `${targetBranch}..${sourceBranch}`])).trim() || "0",
      );
    } catch {
      throw new GitServiceError(
        "GIT_MERGE_REQUEST_INVALID",
        "state",
        "the task branch could not be compared against the target branch",
      );
    }

    // The conflict status (E6's recorded conflict field): `git merge-tree`
    // decides on the object database alone — the working tree is untouched.
    let conflictStatus: MergeRequestRow["conflict_status"] = "clean";
    let conflictFiles: string[] = [];
    try {
      await repo.raw(["merge-tree", "--write-tree", "--name-only", targetBranch, sourceBranch]);
    } catch (error) {
      conflictStatus = "conflict";
      // merge-tree --name-only prints the tree oid first, then the
      // conflicted paths; the first line is never a file. A parse miss does
      // not hide the conflict — the status stands regardless (G5).
      conflictFiles = splitLines(rawStdout(error)).slice(1);
    }
    const headCommit = String(await repo.revparse([sourceBranch])).trim();

    // G3: the digest is the only argument-derived surface. It pins the exact
    // change set the user is shown approving.
    const argsDigest = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          project_id: input.project_id,
          source_branch: sourceBranch,
          target_branch: targetBranch,
          head_commit: headCommit,
          changed_files: [...changedFiles].sort(),
        }),
      )
      .digest("hex")}`;

    const proposal: TypedToolProposal = {
      workspace_id: input.workspace_id,
      task_id: input.task_id,
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      tool_id: MERGE_TOOL.tool_id,
      tool_version: MERGE_TOOL.tool_version,
      capability: MERGE_TOOL.capability,
      risk_class: MERGE_TOOL.risk_class,
      // The explicit resource identity (D9/D35 — "for this repository/path"):
      // the project's NAME is the human-readable repository identity the
      // approval card and any reusable grant pin. Deliberately NOT the raw
      // project id: the approval boundary's conservative redaction pass
      // scrubs high-entropy runs (a UUID is one) from free-text surfaces, so
      // a UUID-bearing scope would render as unusable [REDACTED] text. The
      // durable project linkage lives on the merge request row; the scope is
      // the matching key.
      resource_scope: `git://${sanitizeBranchSegment(project.name).toLowerCase()}/branches/${targetBranch}`,
      args_digest: argsDigest,
      side_effect_summary: `Merge ${sourceBranch} into ${targetBranch} (${changedFiles.length} file(s), ${commitCount} commit(s)) in project ${project.name}.`,
    };

    const mergeRequestId = `mr_${randomUUID()}`;
    const at = this.now();

    // One atomic unit: the row and its approval. A transition rejection
    // (the run cannot pause) rolls the row back — nothing half-prepared.
    const result = this.deps.tx.transaction((exec) => {
      const row: MergeRequestRow = {
        workspace_id: input.workspace_id,
        project_id: input.project_id,
        merge_request_id: mergeRequestId,
        task_id: input.task_id,
        agent_id: input.agent_id,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        change_summary: summary,
        changed_files_json: JSON.stringify(changedFiles),
        validation_status: "not_run",
        validation_note: null,
        conflict_status: conflictStatus,
        conflict_files_json: conflictStatus === "conflict" ? JSON.stringify(conflictFiles) : null,
        approval_id: null,
        status: "awaiting_approval",
        status_reason: null,
        merged_commit: null,
        created_at: at,
        updated_at: at,
      };
      this.deps.projects.insertMergeRequest(row, exec);

      // The D9 pause. The merge itself is the withheld action — executed
      // only by the composition's approval executor after the user approves.
      const pause = this.deps.approvals.createRequestFromTypedProposal({
        proposal,
        run: input.run,
        execute: () => {},
      });
      if (pause.outcome !== "paused_for_approval") {
        throw new GitServiceError(
          "GIT_MERGE_REQUEST_INVALID",
          "state",
          "the merge request could not be filed: the task run could not pause for approval",
        );
      }
      this.deps.projects.updateMergeRequest(
        input.workspace_id,
        input.project_id,
        mergeRequestId,
        { approval_id: pause.approval_id, updated_at: at },
        exec,
      );
      return { row, approval_id: pause.approval_id, run: pause.run };
    });

    return {
      merge_request: this.toMergeRequestView(
        this.requireMergeRequest(input.workspace_id, input.project_id, mergeRequestId),
      ),
      approval_id: result.approval_id,
      run: result.run,
    };
  }

  listMergeRequests(workspaceId: string, projectId: string): MergeRequestView[] {
    this.requireProject(workspaceId, projectId);
    return this.deps.projects
      .listMergeRequests(workspaceId, projectId)
      .map((row) => this.toMergeRequestView(row));
  }

  getMergeRequest(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
  ): MergeRequestView {
    return this.toMergeRequestView(
      this.requireMergeRequest(workspaceId, projectId, mergeRequestId),
    );
  }

  /**
   * Record the PRD §10 reject / request-changes outcome on the row. The
   * TARGET BRANCH is untouched by construction: this only moves the merge
   * request's own lifecycle state (the D9 denial happened in the approval
   * machinery; the merge never executes).
   */
  recordMergeDecision(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
    outcome: "rejected" | "changes_requested",
  ): MergeRequestView {
    const at = this.now();
    this.deps.projects.updateMergeRequest(workspaceId, projectId, mergeRequestId, {
      status: outcome,
      status_reason:
        outcome === "rejected"
          ? "the user rejected this merge request"
          : "the user requested changes before merge",
      updated_at: at,
    });
    return this.toMergeRequestView(
      this.requireMergeRequest(workspaceId, projectId, mergeRequestId),
    );
  }

  /**
   * Execute an APPROVED merge (the composition's approval executor is the
   * only caller). Guards, in order:
   *  1. the linked approval request must be resolved `approved` — the runtime
   *     never merges on its own initiative (G2/G6);
   *  2. the merge request must still be awaiting execution (idempotent on
   *     replay — a second call answers the merged row);
   *  3. the target working copy must be clean (a dirty tree refuses typed).
   *
   * The merge is a plain `git merge --no-ff` — no rebase, no force (E6). An
   * execution-time conflict ABORTS the merge (the target branch is left
   * exactly as it was) and records the failure on the row (G5).
   */
  async performMerge(input: {
    workspace_id: string;
    project_id: string;
    merge_request_id: string;
  }): Promise<MergeRequestView> {
    const promise = this.performMergeInner(input).finally(() => {
      this.mergeOutcomes.delete(input.merge_request_id);
    });
    // Registered synchronously so the deciding surface can await the outcome
    // right after the (synchronous) decision callback returns.
    this.mergeOutcomes.set(input.merge_request_id, promise);
    // The deciding surface normally awaits takeMergeOutcome; when it does
    // not (the S20 decision route path), the rejection must not become an
    // unhandled one — the row records it (G5), so a silent branch is safe.
    promise.catch(() => {});
    return promise;
  }

  /** The in-flight merge's promise, or null when none is running. */
  takeMergeOutcome(mergeRequestId: string): Promise<MergeRequestView> | null {
    return this.mergeOutcomes.get(mergeRequestId) ?? null;
  }

  private async performMergeInner(input: {
    workspace_id: string;
    project_id: string;
    merge_request_id: string;
  }): Promise<MergeRequestView> {
    const row = this.deps.projects.findMergeRequest(
      input.workspace_id,
      input.project_id,
      input.merge_request_id,
    );
    if (row === null) {
      throw new GitServiceError(
        "GIT_MERGE_REQUEST_NOT_FOUND",
        "state",
        "no merge request with this id exists for the project",
      );
    }
    if (row.status === "merged") {
      return this.toMergeRequestView(row);
    }
    if (row.status !== "awaiting_approval" && row.status !== "approved") {
      throw new GitServiceError(
        "GIT_MERGE_REQUEST_INVALID",
        "state",
        `the merge request is ${row.status} and cannot be merged`,
      );
    }

    // G2/G6: the runtime merges ONLY what the user approved. The linked D9
    // request must exist and be resolved approved.
    if (row.approval_id === null) {
      throw new GitServiceError(
        "GIT_MERGE_NOT_APPROVED",
        "forbidden",
        "the merge request has no linked approval",
      );
    }
    const request = this.deps.approvalsRepository.getRequest(input.workspace_id, row.approval_id);
    if (request === null || request.status !== "approved") {
      throw new GitServiceError(
        "GIT_MERGE_NOT_APPROVED",
        "forbidden",
        "the linked approval is not approved; the runtime never merges without a valid approval",
      );
    }

    const project = this.requireProject(input.workspace_id, input.project_id);
    const repo = this.git(project.repo_path);

    const status = await repo.status();
    if (!status.isClean()) {
      throw new GitServiceError(
        "GIT_REPO_DIRTY",
        "state",
        "the target working copy has uncommitted changes; resolve them before merging",
      );
    }

    try {
      // Plain merge only: no rebase, no force (E6, PRD §10).
      await repo.merge(["--no-ff", "--no-edit", row.source_branch]);
    } catch {
      // Abort restores the target branch and index exactly (G5: the conflict
      // queues as a recorded failure — never a half-merged tree).
      await repo.raw(["merge", "--abort"]).catch(() => {});
      const at = this.now();
      this.deps.projects.updateMergeRequest(
        input.workspace_id,
        input.project_id,
        input.merge_request_id,
        {
          status: "failed",
          status_reason:
            "the merge conflicted at execution time; the target branch was left untouched",
          updated_at: at,
        },
      );
      this.fault("s19_merge_conflict", {
        workspace_id: input.workspace_id,
        project_id: input.project_id,
        merge_request_id: input.merge_request_id,
      });
      throw new GitServiceError(
        "GIT_MERGE_CONFLICT",
        "state",
        "the merge conflicted at execution time; the target branch was left untouched",
      );
    }

    const mergedCommit = String(await repo.revparse(["HEAD"])).trim();
    const at = this.now();
    this.deps.projects.updateMergeRequest(
      input.workspace_id,
      input.project_id,
      input.merge_request_id,
      {
        status: "merged",
        merged_commit: mergedCommit,
        updated_at: at,
      },
    );
    // Post-merge release: the slot frees for the queue (the branch is safely
    // deleted). A release failure is a recorded fault, never a failed merge —
    // the merge itself is durable truth.
    try {
      await this.releaseWorktree({
        workspace_id: input.workspace_id,
        project_id: input.project_id,
        worktree_id: await this.activeWorktreeIdForTask(
          input.workspace_id,
          input.project_id,
          row.task_id,
        ),
        outcome: "merged",
      });
    } catch {
      this.fault("s19_worktree_release_failed", {
        workspace_id: input.workspace_id,
        project_id: input.project_id,
        merge_request_id: input.merge_request_id,
      });
    }
    return this.toMergeRequestView(
      this.requireMergeRequest(input.workspace_id, input.project_id, input.merge_request_id),
    );
  }

  private async activeWorktreeIdForTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
  ): Promise<string> {
    const active = this.deps.projects.findActiveWorktreeByTask(workspaceId, projectId, taskId);
    return active?.worktree_id ?? "";
  }

  private toMergeRequestView(row: MergeRequestRow): MergeRequestView {
    return toMergeRequestView(row);
  }

  // -------------------------------------------------------------------------
  // Credentials (D22/E9) — encrypt at store, decrypt at call, mask in views
  // -------------------------------------------------------------------------

  async storeCredential(input: {
    workspace_id: string;
    project_id: string;
    actor: { type: string; id: string };
    credential_kind: ProjectCredentialRow["credential_kind"];
    username?: string | null;
    secret: string;
  }): Promise<CredentialView> {
    this.requireProject(input.workspace_id, input.project_id);
    if (input.secret.length === 0) {
      throw new GitServiceError(
        "GIT_CREDENTIAL_INVALID",
        "validation",
        "the credential secret must not be empty",
      );
    }
    const sealed = this.deps.vault.encrypt(input.secret);
    const at = this.now();
    const row: ProjectCredentialRow = {
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      credential_id: `cred_${randomUUID()}`,
      credential_kind: input.credential_kind,
      username: input.username ?? null,
      secret_ciphertext: sealed.ciphertext,
      secret_iv: sealed.iv,
      secret_tag: sealed.tag,
      key_version: sealed.key_version,
      created_by_type: input.actor.type,
      created_by_id: input.actor.id,
      created_at: at,
      revoked_at: null,
    };
    try {
      this.deps.projects.insertCredential(row);
    } catch (error) {
      // One ACTIVE credential per (project, kind): replace = revoke first.
      if (error instanceof ProjectCredentialActiveExistsError) {
        throw new GitServiceError(
          "GIT_CREDENTIAL_ACTIVE_EXISTS",
          "state",
          "an active credential of this kind already exists; revoke it before storing a replacement",
        );
      }
      throw error;
    }
    return this.toCredentialView(row);
  }

  listCredentials(workspaceId: string, projectId: string): CredentialView[] {
    this.requireProject(workspaceId, projectId);
    return this.deps.projects
      .listCredentials(workspaceId, projectId)
      .map((row) => this.toCredentialView(row));
  }

  /**
   * The CALL-TIME decryption seam (D22): only the git operations that need a
   * secret (clone/fetch with an https URL) consume this. Revoked credentials
   * fail safely — a typed refusal, never a silent fall-back.
   */
  async resolveCredential(
    workspaceId: string,
    projectId: string,
    credentialId: string,
  ): Promise<{ username: string | null; secret: string }> {
    const row = this.deps.projects.findCredential(workspaceId, projectId, credentialId);
    if (row === null) {
      throw new GitServiceError(
        "GIT_CREDENTIAL_NOT_FOUND",
        "state",
        "no credential with this id exists for the project",
      );
    }
    if (row.revoked_at !== null) {
      throw new GitServiceError(
        "GIT_CREDENTIAL_REVOKED",
        "state",
        "the credential has been revoked and can no longer be used",
      );
    }
    return {
      username: row.username,
      secret: this.deps.vault.decrypt({
        ciphertext: row.secret_ciphertext,
        iv: row.secret_iv,
        tag: row.secret_tag,
        key_version: row.key_version,
      }),
    };
  }

  async revokeCredential(
    workspaceId: string,
    projectId: string,
    credentialId: string,
  ): Promise<void> {
    const revoked = this.deps.projects.revokeCredential(
      workspaceId,
      projectId,
      credentialId,
      this.now(),
    );
    if (!revoked) {
      throw new GitServiceError(
        "GIT_CREDENTIAL_NOT_FOUND",
        "state",
        "no active credential with this id exists for the project",
      );
    }
  }

  /**
   * The view decrypts ONLY to compute the masked display value — the last
   * four characters, the D22 "masked value" surface. The plaintext never
   * leaves this call frame and never enters any response or log (G3).
   */
  private toCredentialView(row: ProjectCredentialRow): CredentialView {
    let masked = "••••••";
    try {
      masked = maskSecret(
        this.deps.vault.decrypt({
          ciphertext: row.secret_ciphertext,
          iv: row.secret_iv,
          tag: row.secret_tag,
          key_version: row.key_version,
        }),
      );
    } catch {
      // An unreadable ciphertext still answers metadata — revocation and
      // replacement work; the mask simply cannot improve (G5: visible via
      // the generic mask, never a thrown read).
    }
    return {
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      credential_id: row.credential_id,
      credential_kind: row.credential_kind,
      username: row.username,
      masked_hint: masked,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    };
  }
}
