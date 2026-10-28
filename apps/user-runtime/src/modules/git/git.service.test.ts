/**
 * S19 chunk 1 — the git service contract tests (issue #20; PRD §10, E6, D6,
 * D22, D35, G2/G3/G5/G6). Red-first: these tests pin the service behaviors
 * before the module exists. REAL git against local temp directories and
 * file:// URLs — no network, no remote hosts (E8).
 *
 *   1. Import/clone atomicity: a FAILED clone/import leaves NO project row
 *      registered and no leftover project directory.
 *   2. Task-scoped branch + worktree: each admitted coding task gets its own
 *      branch and its own worktree; the repository's default branch is
 *      untouched until an approved merge (asserted against real git state).
 *   3. Conflict queue (D6/E6): a second task that would open a worktree on
 *      the same project while an unmerged one is active is QUEUED with a
 *      visible reason — never concurrent; two tasks can never hold the same
 *      project's active worktree, and the queue admits after release.
 *   4. Merge requests: preparing one computes changed files + conflict
 *      status from real git, files the D9 approval through the SAME
 *      approvals machinery (no parallel path), and the PRD §10 decisions
 *      behave: approve merges (no rebase, no force), reject and
 *      request-changes leave the target branch untouched.
 *   5. Credential custody (D22): secrets are AES-256-GCM encrypted at rest
 *      inside the container, decrypted only at call time, masked in every
 *      surface, and a revoked credential fails safely.
 *   6. No force-push, ever: a static scan over user-runtime source proves no
 *      code path can trigger a force push. STANCE: every dashed force form is
 *      banned — the plain dashed flag, the short flag as a push argument, and
 *      the lease variant alike (it is still a non-fast-forward overwrite
 *      attempt; E6 forbids it). The scan covers string literals, raw command
 *      arrays, and identifiers, in non-test source; the service also has no
 *      push code path at all in this chunk (the only repository mutation is
 *      the local, approval-gated merge).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import type { TaskRun } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ProjectsRepository } from "../../adapters/sqlite/projects-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import {
  buildAuthenticatedUrl,
  CredentialVault,
  CredentialVaultError,
  maskSecret,
  sanitizeGitUrl,
} from "../projects/credential-vault.ts";
import { GitService, GitServiceError } from "./git.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WS = "ws_s19";
const USER = { type: "user", id: "user_001" } as const;
const AGENT_ID = "agent_general_assistant";
const NOW = "2026-10-29T10:00:00.000Z";
const CONVERSATION = "conv_s19_001";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One runtime environment: real SQLite + the real approvals machinery + the git service. */
interface TestEnv {
  dir: string;
  conn: SqliteConnection;
  projects: ProjectsRepository;
  approvals: ApprovalsService;
  approvalsRepository: ApprovalsRepository;
  git: GitService;
  projectsRoot: string;
  faults: Array<{ event: string; fields: Record<string, unknown> }>;
}

function newEnv(): TestEnv {
  const dir = makeTempDir("shera-runtime-s19-git-");
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepository = new ApprovalsRepository(tx);
  const operations = new OperationsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepository,
    operations,
    clock: () => NOW,
  });
  const projects = new ProjectsRepository(tx);
  const projectsRoot = join(dir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  const faults: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const vault = new CredentialVault(join(dir, "project-credentials.key"));
  const git = new GitService({
    projects,
    vault,
    approvals,
    approvalsRepository,
    tx,
    projectsRoot,
    clock: () => NOW,
    logFault: (event, fields) => faults.push({ event, fields }),
  });
  return { dir, conn, projects, approvals, approvalsRepository, git, projectsRoot, faults };
}

const openEnvs: TestEnv[] = [];

function trackedEnv(): TestEnv {
  const env = newEnv();
  openEnvs.push(env);
  return env;
}

afterEach(() => {
  for (const env of openEnvs.splice(0)) {
    env.conn.close();
  }
});

/** Create a real local "origin" repository with one commit on main. */
async function makeOrigin(baseDir: string, name: string): Promise<string> {
  const originDir = join(baseDir, name);
  mkdirSync(originDir, { recursive: true });
  const git = simpleGit(originDir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "origin@example.invalid");
  await git.addConfig("user.name", "Origin Fixture");
  writeFileSync(join(originDir, "README.md"), "# origin\n");
  await git.add(["."]);
  await git.commit("initial commit");
  return originDir;
}

/** Import one project cloned from a real local origin. */
async function importDemo(env: TestEnv, baseDir: string) {
  const originDir = await makeOrigin(baseDir, "origin");
  return env.git.importProject({
    workspace_id: WS,
    name: "demo",
    actor: USER,
    source: { kind: "git_url", url: pathToFileURL(originDir).href },
  });
}

/** Commit one file inside a working tree (the agent's worktree, for instance). */
async function commitFile(workDir: string, relPath: string, content: string, message: string) {
  const git = simpleGit(workDir);
  await git.addConfig("user.email", "agent@example.invalid");
  await git.addConfig("user.name", "Coding Agent");
  mkdirSync(dirname(join(workDir, relPath)), { recursive: true });
  writeFileSync(join(workDir, relPath), content);
  await git.add([relPath]);
  await git.commit(message);
}

function headOf(repoDir: string, ref: string): Promise<string> {
  return simpleGit(repoDir)
    .revparse([ref])
    .then((value) => String(value).trim());
}

/** git prints forward-slash paths; node joins with the platform separator. */
function normalizePath(value: string): string {
  return value.replace(/\\+/g, "/");
}

function makeRun(taskId: string, overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONVERSATION,
    created_from: { trigger_event_type: "trigger.scheduled", trigger_event_id: "evt_s19_001" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
    roster: [AGENT_ID],
    state: "RUNNING",
    version: 3,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

interface ProjectWithWork {
  env: TestEnv;
  project: Awaited<ReturnType<GitService["importProject"]>>;
  worktreePath: string;
  branchName: string;
}

/** Import a project, allocate task A's worktree, and commit one file on the task branch. */
async function projectWithTaskWork(): Promise<ProjectWithWork> {
  const env = trackedEnv();
  const base = makeTempDir("shera-s19-origin-");
  tempDirs.push(base);
  const project = await importDemo(env, base);
  const allocation = await env.git.allocateWorktree({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_A",
    agent_id: AGENT_ID,
  });
  if (allocation.outcome !== "allocated") throw new Error("expected an allocated worktree");
  await commitFile(
    allocation.worktree.worktree_path,
    "src/greet.ts",
    "export const greet = () => 'hi';\n",
    "add greet",
  );
  return {
    env,
    project,
    worktreePath: allocation.worktree.worktree_path,
    branchName: allocation.worktree.branch_name,
  };
}

function prepareInput(project: { project_id: string }) {
  return {
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_A",
    agent_id: AGENT_ID,
    conversation_id: CONVERSATION,
    change_summary: "Add the greeting module.",
    run: makeRun("task_A"),
  };
}

// ---------------------------------------------------------------------------
// 1. Import/clone atomicity
// ---------------------------------------------------------------------------

describe("git.service: project import/clone atomicity", () => {
  it("clones a real file:// origin and registers the project", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-origin-");
    tempDirs.push(base);
    const project = await importDemo(env, base);
    expect(project.project_id).toMatch(/^prj_/);
    expect(project.default_branch).toBe("main");
    expect(project.source_url).not.toContain("@");
    expect(existsSync(join(project.repo_path, "README.md"))).toBe(true);
    expect(env.projects.listProjects(WS)).toHaveLength(1);
  });

  it("leaves NO project row and no leftover directory when the clone fails", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-origin-");
    tempDirs.push(base);
    const missingUrl = pathToFileURL(join(base, "does-not-exist")).href;
    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "ghost",
        actor: USER,
        source: { kind: "git_url", url: missingUrl },
      }),
    ).rejects.toThrow(GitServiceError);
    // Nothing registered, nothing left behind (the atomicity AC).
    expect(env.projects.listProjects(WS)).toEqual([]);
    expect(existsSync(env.projectsRoot)).toBe(true);
    expect(readdirSync(env.projectsRoot)).toEqual([]);
  });

  it("imports a local directory as a fresh repository, atomically", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-srcdir-");
    tempDirs.push(base);
    const srcDir = join(base, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.js"), "console.log(1);\n");

    const project = await env.git.importProject({
      workspace_id: WS,
      name: "sources",
      actor: USER,
      source: { kind: "directory", path: srcDir },
    });
    const log = await simpleGit(project.repo_path).log({ maxCount: 1 });
    expect(log.total).toBe(1);
    // The source directory is NOT mutated into a repository by the import.
    expect(existsSync(join(srcDir, ".git"))).toBe(false);

    // A missing source directory fails the import and registers nothing.
    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "ghost",
        actor: USER,
        source: { kind: "directory", path: join(base, "missing") },
      }),
    ).rejects.toThrow(GitServiceError);
    expect(env.projects.listProjects(WS)).toHaveLength(1);
    expect(readdirSync(env.projectsRoot)).toHaveLength(1);
  });

  it("refuses credential-bearing URLs and never persists or logs the secret (G3/D22)", async () => {
    const env = trackedEnv();
    const secret = "s3cr3t_token_value";
    const credUrl = `https://x-access-token:${secret}@127.0.0.1:1/repo.git`;
    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "private",
        actor: USER,
        source: { kind: "git_url", url: credUrl },
      }),
    ).rejects.toThrow(GitServiceError);
    // The typed failure (and its fault log) carries no credential material.
    const serialized = JSON.stringify(env.faults);
    expect(serialized).not.toContain(secret);
    expect(env.projects.listProjects(WS)).toEqual([]);
    expect(readdirSync(env.projectsRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Task-scoped branch + worktree; the conflict queue
// ---------------------------------------------------------------------------

describe("git.service: task-scoped branch + worktree and the conflict queue", () => {
  it("gives each admitted task its own branch + worktree and leaves the default branch untouched", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-origin-");
    tempDirs.push(base);
    const project = await importDemo(env, base);
    const mainBefore = await headOf(project.repo_path, "main");

    const allocation = await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_A",
      agent_id: AGENT_ID,
    });
    if (allocation.outcome !== "allocated") throw new Error("expected an allocated worktree");
    const worktree = allocation.worktree;
    expect(worktree.branch_name).toBe("shera/task/task_A");
    expect(existsSync(worktree.worktree_path)).toBe(true);

    // Real git state: the task branch exists, the worktree is registered.
    const repo = simpleGit(project.repo_path);
    const branches = await repo.branch(["--list", worktree.branch_name]);
    expect(branches.all).toContain(worktree.branch_name);
    const worktrees = await repo.raw(["worktree", "list"]);
    expect(normalizePath(worktrees)).toContain(normalizePath(worktree.worktree_path));

    // The coding task commits on its branch; main does not move.
    await commitFile(worktree.worktree_path, "src/feature.ts", "export {};\n", "task A work");
    expect(await headOf(project.repo_path, "main")).toBe(mainBefore);
    expect(await headOf(worktree.worktree_path, "HEAD")).not.toBe(mainBefore);

    // Re-requesting the same task's worktree is idempotent (reacquire).
    const again = await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_A",
      agent_id: AGENT_ID,
    });
    expect(again.outcome).toBe("reacquired");
  });

  it("queues a second task instead of granting a concurrent worktree (D6/E6, G5)", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-origin-");
    tempDirs.push(base);
    const project = await importDemo(env, base);
    await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_A",
      agent_id: AGENT_ID,
    });

    const second = await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_B",
      agent_id: AGENT_ID,
    });
    // Refused — and the refusal is a RECORDED queue entry with a visible
    // reason naming what holds the slot (G5).
    expect(second.outcome).toBe("queued");
    if (second.outcome !== "queued") throw new Error("expected a queued outcome");
    expect(second.worktree.status).toBe("queued");
    expect(second.reason).toContain("task_A");
    const queuedRows = env.projects.listQueuedWorktrees(WS, project.project_id);
    expect(queuedRows.map((row) => row.task_id)).toEqual(["task_B"]);

    // Real git state: exactly ONE task worktree exists; task B never got one.
    const worktrees = await simpleGit(project.repo_path).raw(["worktree", "list"]);
    expect(worktrees).not.toContain("task_B");

    // After task A's work merges and releases, the queue admits task B.
    const active = env.projects.findActiveWorktree(WS, project.project_id);
    if (!active) throw new Error("expected the active worktree of task A");
    await env.git.releaseWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      worktree_id: active.worktree_id,
      outcome: "released",
    });
    const third = await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_B",
      agent_id: AGENT_ID,
    });
    expect(third.outcome).toBe("allocated");
    if (third.outcome !== "allocated") throw new Error("expected an allocated worktree");
    // The prior queue entry is visibly admitted, not silently dropped (G5).
    const admitted = env.projects
      .listWorktrees(WS, project.project_id)
      .filter((row) => row.task_id === "task_B" && row.status === "admitted");
    expect(admitted).toHaveLength(1);
  });

  it("refuses a worktree to an Agent the restricted project does not admit", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-origin-");
    tempDirs.push(base);
    const project = await importDemo(env, base);
    env.projects.setProjectAgentAccess(WS, project.project_id, ["agent_dev_1"], NOW);
    env.projects.updateProject(WS, project.project_id, {
      access_mode: "restricted",
      updated_at: NOW,
    });
    await expect(
      env.git.allocateWorktree({
        workspace_id: WS,
        project_id: project.project_id,
        task_id: "task_A",
        agent_id: "agent_stranger",
      }),
    ).rejects.toThrow(GitServiceError);
    // The admitted Agent gets through.
    const allocation = await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_A",
      agent_id: "agent_dev_1",
    });
    expect(allocation.outcome).toBe("allocated");
  });
});

// ---------------------------------------------------------------------------
// 4. Merge requests: prepare through the approval machinery; decide
// ---------------------------------------------------------------------------

describe("git.service: merge requests and the PRD decisions", () => {
  it("prepares a merge request: changed files + conflict status from real git, and a pending D9 approval", async () => {
    const { env, project } = await projectWithTaskWork();
    const prepared = await env.git.prepareMergeRequest(prepareInput(project));

    // The minimal PRD fields, computed from the real repository.
    expect(prepared.merge_request.changed_files).toEqual(["src/greet.ts"]);
    expect(prepared.merge_request.conflict_status).toBe("clean");
    expect(prepared.merge_request.target_branch).toBe("main");
    expect(prepared.merge_request.source_branch).toBe("shera/task/task_A");
    expect(prepared.merge_request.status).toBe("awaiting_approval");

    // The approval rides the SAME D9 machinery (no parallel path): a pending
    // request exists, repository-mutation gated, digest-only (G3).
    const request = env.approvalsRepository.getRequest(WS, prepared.approval_id);
    expect(request?.status).toBe("pending");
    expect(request?.tool_id).toBe("git.merge");
    expect(request?.risk_class).toBe("LOCAL_MUTATION");
    expect(request?.resource_scope).toContain("demo");
    expect(request?.resource_scope).toContain("branches/main");
  });

  it("approve performs the merge (no rebase, no force); the worktree releases and main advances", async () => {
    const { env, project, worktreePath, branchName } = await projectWithTaskWork();
    const mainBefore = await headOf(project.repo_path, "main");
    const prepared = await env.git.prepareMergeRequest(prepareInput(project));

    // The user approves through the D9 decision; the runtime executes the
    // merge as the withheld action — exactly the composition wiring's shape:
    // a fire-and-forget start, awaited afterwards by the deciding surface.
    const decision = env.approvals.applyDecision({
      approval_id: prepared.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: prepared.run,
      execute: () => {
        void env.git
          .performMerge({
            workspace_id: WS,
            project_id: project.project_id,
            merge_request_id: prepared.merge_request.merge_request_id,
          })
          .catch(() => {});
      },
    });
    expect(decision.outcome).toBe("approved");
    const outcome = await env.git.takeMergeOutcome(prepared.merge_request.merge_request_id);
    if (!outcome) throw new Error("expected the merge execution to be recorded");
    expect(outcome.status).toBe("merged");
    expect(outcome.merged_commit).toBeTruthy();

    // Real git state: main advanced with a merge commit; the working tree
    // carries the task's file; the worktree is gone; the branch is deleted.
    const mainAfter = await headOf(project.repo_path, "main");
    expect(mainAfter).not.toBe(mainBefore);
    const log = await simpleGit(project.repo_path).log({ from: mainBefore, to: mainAfter });
    expect(log.total).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(project.repo_path, "src", "greet.ts"))).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    const branches = await simpleGit(project.repo_path).branch(["--list", branchName]);
    expect(branches.all).not.toContain(branchName);
    const row = env.projects.findMergeRequest(
      WS,
      project.project_id,
      prepared.merge_request.merge_request_id,
    );
    expect(row?.status).toBe("merged");
    expect(env.projects.findActiveWorktree(WS, project.project_id)).toBeNull();
  });

  it("reject leaves the target branch untouched and records the rejection", async () => {
    const { env, project } = await projectWithTaskWork();
    const mainBefore = await headOf(project.repo_path, "main");
    const prepared = await env.git.prepareMergeRequest(prepareInput(project));

    const decision = env.approvals.applyDecision({
      approval_id: prepared.approval_id,
      choice: "reject-this-action",
      decided_by: USER,
      run: prepared.run,
      execute: () => {
        throw new Error("a rejected merge must never execute");
      },
    });
    expect(decision.outcome).toBe("action_rejected");
    env.git.recordMergeDecision(
      WS,
      project.project_id,
      prepared.merge_request.merge_request_id,
      "rejected",
    );

    expect(await headOf(project.repo_path, "main")).toBe(mainBefore);
    const row = env.projects.findMergeRequest(
      WS,
      project.project_id,
      prepared.merge_request.merge_request_id,
    );
    expect(row?.status).toBe("rejected");
  });

  it("request-changes leaves the target branch untouched and records the revision state", async () => {
    const { env, project } = await projectWithTaskWork();
    const mainBefore = await headOf(project.repo_path, "main");
    const prepared = await env.git.prepareMergeRequest(prepareInput(project));

    const decision = env.approvals.applyDecision({
      approval_id: prepared.approval_id,
      choice: "reject-this-action",
      decided_by: USER,
      run: prepared.run,
      execute: () => {
        throw new Error("a changes-requested merge must never execute");
      },
    });
    expect(decision.outcome).toBe("action_rejected");
    env.git.recordMergeDecision(
      WS,
      project.project_id,
      prepared.merge_request.merge_request_id,
      "changes_requested",
    );

    expect(await headOf(project.repo_path, "main")).toBe(mainBefore);
    const row = env.projects.findMergeRequest(
      WS,
      project.project_id,
      prepared.merge_request.merge_request_id,
    );
    expect(row?.status).toBe("changes_requested");
  });

  it("refuses to merge without an approved linked approval (the runtime guard)", async () => {
    const { env, project } = await projectWithTaskWork();
    const mainBefore = await headOf(project.repo_path, "main");
    const prepared = await env.git.prepareMergeRequest(prepareInput(project));
    // The pending approval is never decided: the merge must refuse.
    await expect(
      env.git.performMerge({
        workspace_id: WS,
        project_id: project.project_id,
        merge_request_id: prepared.merge_request.merge_request_id,
      }),
    ).rejects.toThrow(GitServiceError);
    expect(await headOf(project.repo_path, "main")).toBe(mainBefore);
  });
});

// ---------------------------------------------------------------------------
// 5. Credential custody (D22)
// ---------------------------------------------------------------------------

describe("credential vault: AES-256-GCM custody inside the container", () => {
  it("round-trips a secret and fails closed on tampering or a foreign key", () => {
    const dirA = makeTempDir("shera-s19-vault-a-");
    const dirB = makeTempDir("shera-s19-vault-b-");
    const vaultA = new CredentialVault(join(dirA, "key"));
    const vaultB = new CredentialVault(join(dirB, "key"));
    const sealed = vaultA.encrypt("ghp_super_secret_value");
    expect(vaultA.decrypt(sealed)).toBe("ghp_super_secret_value");
    // A different container key cannot read the ciphertext (fail closed).
    expect(() => vaultB.decrypt(sealed)).toThrow(CredentialVaultError);
    // Tampered ciphertext fails the GCM authentication check.
    const tampered = { ...sealed, ciphertext: Buffer.from([0]) };
    expect(() => vaultA.decrypt(tampered)).toThrow(CredentialVaultError);
  });

  it("masks secrets for display and strips credentials from persisted URLs", () => {
    expect(maskSecret("ghp_abcdef1234567890")).toBe("••••7890");
    expect(maskSecret("short")).toBe("••••••");
    expect(sanitizeGitUrl("https://user:pass@example.invalid/u/r.git")).toBe(
      "https://example.invalid/u/r.git",
    );
    expect(sanitizeGitUrl("https://example.invalid/u/r.git")).toBe(
      "https://example.invalid/u/r.git",
    );
  });

  it("injects credentials only into https URLs at call time", () => {
    const injected = buildAuthenticatedUrl("https://example.invalid/u/r.git", {
      username: "x-access-token",
      secret: "tok_123",
    });
    expect(injected).toBe("https://x-access-token:tok_123@example.invalid/u/r.git");
    // A local file:// URL never takes a credential.
    expect(() =>
      buildAuthenticatedUrl("file:///tmp/repo", { username: "u", secret: "tok_123" }),
    ).toThrow();
  });

  it("resolves a stored credential at call time; a revoked credential fails safely", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-origin-");
    tempDirs.push(base);
    const project = await importDemo(env, base);
    const stored = await env.git.storeCredential({
      workspace_id: WS,
      project_id: project.project_id,
      actor: USER,
      credential_kind: "token",
      username: "x-access-token",
      secret: "tok_abcd1234",
    });
    expect(stored.masked_hint).toBe("••••1234");
    // Decryption happens only at call time through the internal seam.
    expect(await env.git.resolveCredential(WS, project.project_id, stored.credential_id)).toEqual({
      username: "x-access-token",
      secret: "tok_abcd1234",
    });

    await env.git.revokeCredential(WS, project.project_id, stored.credential_id);
    await expect(
      env.git.resolveCredential(WS, project.project_id, stored.credential_id),
    ).rejects.toThrow(GitServiceError);
    // The stored row carries ciphertext only: no read-back surface exists.
    const row = env.projects.findCredential(WS, project.project_id, stored.credential_id);
    expect(row?.secret_ciphertext.toString("utf8")).not.toContain("tok_abcd1234");

    // G3 at rest: the raw secret appears NOWHERE in the container's durable
    // state — one scan over the SQLite file covers every row AND every
    // journalled event payload, and the key file carries only key material.
    const dbBytes = readFileSync(join(env.dir, "runtime.db"));
    expect(dbBytes.includes(Buffer.from("tok_abcd1234", "utf8"))).toBe(false);
    expect(
      readFileSync(join(env.dir, "project-credentials.key")).includes(
        Buffer.from("tok_abcd1234", "utf8"),
      ),
    ).toBe(false);
    expect(JSON.stringify(env.faults)).not.toContain("tok_abcd1234");
  });
});

// ---------------------------------------------------------------------------
// 6. No force-push, ever (static scan over user-runtime source)
// ---------------------------------------------------------------------------

describe("git.service: no force-push code path exists", () => {
  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        yield full;
      }
    }
  }

  it("non-test user-runtime source contains no force-push form", () => {
    const srcRoot = resolve(here, "..", "..");
    const offenders: string[] = [];
    const dashForce = new RegExp("--" + "force");
    const patterns: Array<{ name: string; re: RegExp }> = [
      // Every dashed force form, anywhere in non-test source (comments count:
      // a documented intent is still an intent). The lease variant carries
      // the same dashed prefix and is covered here too.
      { name: "dashed force flag", re: dashForce },
      { name: "forcePush identifier", re: /\bforcePush\b/ },
      { name: "push call with the short flag", re: /push\s*\([^)]*['"]-f['"]/ },
      { name: "raw push with the short flag", re: /push\s+-f\b/ },
      { name: "raw push with the dashed force flag", re: new RegExp("push\\s+--" + "force") },
    ];
    for (const file of walk(srcRoot)) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const { name, re } of patterns) {
        if (re.test(text)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
