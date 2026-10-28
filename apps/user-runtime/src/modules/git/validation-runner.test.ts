/**
 * S19 chunk 2 — the validation runner (issue #20; PRD §10, E6, G2). Red-first:
 * these tests pin the runner's behaviors before the module exists. REAL git
 * against local temp directories and REAL command execution — no network, no
 * remote hosts (E8).
 *
 * WHAT THE RUNNER IS: the runtime-side "agents propose; the runtime validates"
 * seam for merge requests (G2). The coordinating Agent prepares a merge
 * request; the RUNNER executes the project's DECLARED validation inside the
 * task's own worktree and attaches the result to the merge request row —
 * validation_status passed/failed plus a summary note. A validation failure is
 * RECORDED, never swallowed and never blocking on its own: the approval gate
 * (G6) remains the only merge authority.
 *
 * THE DETECTION HEURISTIC (this slice, documented): a repository "declares"
 * validation through its package.json scripts — the Node ecosystem's own
 * declaration surface. The runner runs, in a fixed priority order, the
 * scripts it finds among `test`, `lint`, `typecheck`, using the repository's
 * lockfile to pick the package manager (pnpm-lock.yaml → pnpm, yarn.lock →
 * yarn, otherwise npm). A repository without a package.json declares nothing:
 * validation_status stays `not_run` with an explanatory note. Other
 * ecosystems (Makefiles, tox.ini, cargo, …) are future work and deliberately
 * out of this heuristic.
 *
 * REDACTION (G3): a failing command's output is condensed and pushed through
 * the SAME deterministic secret-redaction pass the approval boundary uses —
 * the validation note is durable product state and must never carry
 * secret-shaped material.
 *
 *   1. A passing repository: every declared script exits 0 → `passed`, with
 *      the exact commands recorded in the note.
 *   2. A failing repository: the first failing command is recorded with its
 *      exit code and condensed output; secret-shaped output is redacted (G3).
 *   3. A repository that declares nothing: `not_run` with the honest note.
 *   4. The worktree is the execution root: the task's own checkout, not the
 *      main repository, and never the runtime's own cwd.
 *   5. Guard rails: an unknown merge request, a released worktree, and a
 *      hung command (per-command timeout) each fail typed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { CredentialVault } from "../projects/credential-vault.ts";
import { GitService } from "./git.service.ts";
import {
  DEFAULT_VALIDATION_LIMITS,
  VALIDATION_SCRIPT_PRIORITY,
  detectValidationPlan,
  ValidationRunner,
} from "./validation-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WS = "ws_s19_validation";
const USER = { type: "user", id: "user_001" } as const;
const AGENT_ID = "agent_general_assistant";
const NOW = "2026-10-29T12:00:00.000Z";
const CONVERSATION = "conv_s19_validation";

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

interface TestEnv {
  dir: string;
  conn: SqliteConnection;
  projects: ProjectsRepository;
  git: GitService;
  runner: ValidationRunner;
  projectsRoot: string;
}

function newEnv(limits?: Partial<typeof DEFAULT_VALIDATION_LIMITS>): TestEnv {
  const dir = makeTempDir("shera-runtime-s19-validation-");
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepository = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepository,
    operations: new OperationsRepository(tx),
    clock: () => NOW,
  });
  const projects = new ProjectsRepository(tx);
  const projectsRoot = join(dir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  const git = new GitService({
    projects,
    vault: new CredentialVault(join(dir, "project-credentials.key")),
    approvals,
    approvalsRepository,
    tx,
    projectsRoot,
    clock: () => NOW,
  });
  const runner = new ValidationRunner({
    projects,
    clock: () => NOW,
    ...(limits ? { limits } : {}),
  });
  return { dir, conn, projects, git, runner, projectsRoot };
}

const openEnvs: TestEnv[] = [];

function trackedEnv(limits?: Partial<typeof DEFAULT_VALIDATION_LIMITS>): TestEnv {
  const env = newEnv(limits);
  openEnvs.push(env);
  return env;
}

afterEach(() => {
  for (const env of openEnvs.splice(0)) {
    env.conn.close();
  }
});

function makeRun(taskId: string): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONVERSATION,
    created_from: { trigger_event_type: "trigger.scheduled", trigger_event_id: "evt_s19_val" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
    roster: [AGENT_ID],
    state: "RUNNING",
    version: 3,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** Create a real local origin with a package.json declaring the given scripts. */
async function makeOrigin(
  baseDir: string,
  scripts: Record<string, string>,
  files: Record<string, string> = {},
): Promise<string> {
  const originDir = join(baseDir, "origin");
  mkdirSync(originDir, { recursive: true });
  const git = simpleGit(originDir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "origin@example.invalid");
  await git.addConfig("user.name", "Origin Fixture");
  writeFileSync(
    join(originDir, "package.json"),
    `${JSON.stringify({ name: "declared", version: "1.0.0", scripts }, null, 2)}\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(originDir, name)), { recursive: true });
    writeFileSync(join(originDir, name), content);
  }
  writeFileSync(join(originDir, "README.md"), "# origin\n");
  await git.add(["-A"]);
  await git.commit("initial commit");
  return originDir;
}

interface PreparedMergeRequest {
  env: TestEnv;
  projectId: string;
  mergeRequestId: string;
  worktreePath: string;
}

/** Import an origin, allocate the task's worktree, prepare one merge request. */
async function preparedMergeRequest(
  scripts: Record<string, string>,
  files: Record<string, string> = {},
): Promise<PreparedMergeRequest> {
  const env = trackedEnv();
  const base = makeTempDir("shera-s19-val-origin-");
  tempDirs.push(base);
  const originUrl = pathToFileURL(await makeOrigin(base, scripts, files)).href;
  const project = await env.git.importProject({
    workspace_id: WS,
    name: "declared",
    actor: USER,
    source: { kind: "git_url", url: originUrl },
  });
  const allocation = await env.git.allocateWorktree({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_A",
    agent_id: AGENT_ID,
  });
  if (allocation.outcome !== "allocated") throw new Error("expected an allocated worktree");
  const prepared = await env.git.prepareMergeRequest({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_A",
    agent_id: AGENT_ID,
    conversation_id: CONVERSATION,
    change_summary: "Add the module.",
    run: makeRun("task_A"),
  });
  return {
    env,
    projectId: project.project_id,
    mergeRequestId: prepared.merge_request.merge_request_id,
    worktreePath: allocation.worktree.worktree_path,
  };
}

describe("validation runner: detection heuristic (documented Node package.json shape)", () => {
  it("runs found scripts in the fixed priority order (test, lint, typecheck)", () => {
    const dir = makeTempDir("shera-s19-plan-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint", test: "vitest" } }),
    );
    const plan = detectValidationPlan(dir);
    expect(plan?.commands).toEqual(["test", "lint", "typecheck"]);
    expect(VALIDATION_SCRIPT_PRIORITY).toEqual(["test", "lint", "typecheck"]);
  });

  it("picks the package manager from the repository's lockfile", () => {
    const dir = makeTempDir("shera-s19-plan-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(detectValidationPlan(dir)?.manager).toBe("npm");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectValidationPlan(dir)?.manager).toBe("pnpm");
    rmSync(join(dir, "pnpm-lock.yaml"));
    writeFileSync(join(dir, "yarn.lock"), "");
    expect(detectValidationPlan(dir)?.manager).toBe("yarn");
  });

  it("answers null when the repository declares nothing", () => {
    const dir = makeTempDir("shera-s19-plan-");
    expect(detectValidationPlan(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(detectValidationPlan(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "x" } }));
    expect(detectValidationPlan(dir)).toBeNull();
  });
});

describe("validation runner: real execution inside the task worktree", () => {
  it("records `passed` with the exact commands when every declared script exits 0", async () => {
    const { env, projectId, mergeRequestId, worktreePath } = await preparedMergeRequest({
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
    });
    const view = await env.runner.runForMergeRequest(WS, projectId, mergeRequestId);
    expect(view.validation_status).toBe("passed");
    expect(view.validation_note).toContain("npm run test");
    expect(view.validation_note).toContain("npm run lint");
    const row = env.projects.findMergeRequest(WS, projectId, mergeRequestId);
    expect(row?.validation_status).toBe("passed");
  });

  it("records `failed` with the failing command, exit code, and redacted condensed output (G3)", async () => {
    const secret = "sk-supersecretvalue123456";
    const { env, projectId, mergeRequestId } = await preparedMergeRequest(
      { test: `node -e "console.log('boom: token=${secret}'); process.exit(3)"` },
      {},
    );
    const view = await env.runner.runForMergeRequest(WS, projectId, mergeRequestId);
    expect(view.validation_status).toBe("failed");
    expect(view.validation_note).toContain("npm run test");
    expect(view.validation_note).toContain("3");
    expect(view.validation_note).toContain("boom");
    // G3: the durable note never carries secret-shaped material.
    expect(view.validation_note).not.toContain(secret);
    expect(view.validation_note).toContain("[REDACTED]");
    const row = env.projects.findMergeRequest(WS, projectId, mergeRequestId);
    expect(row?.validation_status).toBe("failed");
  });

  it("stops at the first failing command and does not run the rest", async () => {
    const { env, projectId, mergeRequestId } = await preparedMergeRequest({
      test: 'node -e "process.exit(1)"',
      lint: 'node -e "process.exit(0)"',
    });
    const view = await env.runner.runForMergeRequest(WS, projectId, mergeRequestId);
    expect(view.validation_status).toBe("failed");
    expect(view.validation_note).toContain("npm run test");
    expect(view.validation_note).not.toContain("npm run lint");
  });

  it("leaves `not_run` with an honest note when the repository declares nothing", async () => {
    // makeOrigin writes a scripts-less package.json here: the file exists, so
    // it IS a Node repository, but it declares no validation — the heuristic
    // must answer `not_run`, never invent commands.
    const { env, projectId, mergeRequestId } = await preparedMergeRequest({});
    const view = await env.runner.runForMergeRequest(WS, projectId, mergeRequestId);
    expect(view.validation_status).toBe("not_run");
    expect(view.validation_note).toBeTruthy();
    const row = env.projects.findMergeRequest(WS, projectId, mergeRequestId);
    expect(row?.validation_status).toBe("not_run");
  });

  it("executes in the worktree, not in the runtime's own cwd", async () => {
    const { env, projectId, mergeRequestId, worktreePath } = await preparedMergeRequest({
      test: 'node -e "console.log(process.cwd())"',
    });
    const view = await env.runner.runForMergeRequest(WS, projectId, mergeRequestId);
    expect(view.validation_status).toBe("passed");
    // The recorded output carries the WORKTREE path (forward slashes in git
    // style are irrelevant here — node prints the platform form).
    expect(view.validation_note).toContain(worktreePath);
  });

  it("fails typed when a declared command hangs (per-command timeout)", async () => {
    const env = trackedEnv({ perCommandTimeoutMs: 400 });
    const base = makeTempDir("shera-s19-val-origin-");
    tempDirs.push(base);
    const originUrl = pathToFileURL(
      await makeOrigin(base, { test: 'node -e "setTimeout(() => process.exit(0), 15000)"' }),
    ).href;
    const project = await env.git.importProject({
      workspace_id: WS,
      name: "hung",
      actor: USER,
      source: { kind: "git_url", url: originUrl },
    });
    const allocation = await env.git.allocateWorktree({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_A",
      agent_id: AGENT_ID,
    });
    if (allocation.outcome !== "allocated") throw new Error("expected an allocated worktree");
    const prepared = await env.git.prepareMergeRequest({
      workspace_id: WS,
      project_id: project.project_id,
      task_id: "task_A",
      agent_id: AGENT_ID,
      conversation_id: CONVERSATION,
      change_summary: "Hangs.",
      run: makeRun("task_A"),
    });
    const view = await env.runner.runForMergeRequest(
      WS,
      project.project_id,
      prepared.merge_request.merge_request_id,
    );
    expect(view.validation_status).toBe("failed");
    expect(view.validation_note).toContain("timed out");
  });
});

describe("validation runner: guard rails", () => {
  it("fails typed for an unknown merge request", async () => {
    const env = trackedEnv();
    await expect(env.runner.runForMergeRequest(WS, "prj_unknown", "mr_unknown")).rejects.toThrow(
      /merge request/i,
    );
  });

  it("fails typed when the task holds no active worktree (nothing to validate)", async () => {
    const { env, projectId, mergeRequestId } = await preparedMergeRequest({
      test: 'node -e "process.exit(0)"',
    });
    const active = env.projects.findActiveWorktreeByTask(WS, projectId, "task_A");
    if (!active) throw new Error("expected the active worktree");
    await env.git.releaseWorktree({
      workspace_id: WS,
      project_id: projectId,
      worktree_id: active.worktree_id,
      outcome: "released",
    });
    await expect(env.runner.runForMergeRequest(WS, projectId, mergeRequestId)).rejects.toThrow(
      /worktree/i,
    );
  });
});
