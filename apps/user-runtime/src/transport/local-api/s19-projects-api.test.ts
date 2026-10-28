/**
 * S19 chunk 1 — the projects HTTP API contract (issue #20; PRD §10, E6, D6,
 * D22, D35, D9, E12, G2/G3/G5/G6). Red-first: these tests pin the route
 * behaviors before the module exists. The composed runtime exposes the git
 * seam through the local API; merge execution relays into the S20 approval
 * machinery — no parallel approval path.
 *
 *   1. POST /v1/projects registers a clone (file:// origin); a FAILED clone
 *      answers the typed failure and registers nothing.
 *   2. The worktree surface allocates per-task; a second concurrent task on
 *      the same project is QUEUED with its visible reason.
 *   3. The credentials surface stores per-repository secrets and answers
 *      metadata only — masked hint, never the value; a full redaction scan
 *      over every response and the fault log finds no credential material
 *      (G3/D22).
 *   4. The merge-request surface exposes exactly the minimal PRD §10 view
 *      (change summary, changed files, validation status, conflict status,
 *      target branch) plus approval state; the three PRD decisions behave:
 *      approve merges through the S20 machinery (agents never self-approve —
 *      403), reject and request-changes leave the target branch untouched.
 *   5. Every route is workspace-scoped (E12).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import type { TypedExecutionEvent } from "@shera-bot/contracts";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The pinned student pack: the run machinery needs the real pack snapshot. */
const PACKS_ROOT = resolvePath(here, "../../../../../agent-packs");

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const FOREIGN_WORKSPACE = "ws-other-0000";
const USER = { type: "user", id: "user_001" } as const;
const AGENT_ID = "agent_general_assistant";
const SECRET = "ghp_redacted_scan_token_9f8e7d6c";

const clockNow = "2026-10-29T10:00:00.000Z";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  faults: Array<{ event: string; fields: Record<string, unknown> }>;
  /** Monotonic scripted-run counter: unique event ids + conversations. */
  runCounter: number;
  close(): Promise<void>;
}

async function composeOn(): Promise<RunningRuntime> {
  const dir = makeTempDir("shera-s19-projects-api-");
  const faults: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    packsRoot: PACKS_ROOT,
    now: () => clockNow,
    logUntypedFault: (event, fields) => faults.push({ event, fields }),
  });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    faults,
    runCounter: 0,
    close: () => runtime.close(),
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A typed trigger (D34/G2) whose task id and conversation are unique per call. */
function scriptedTrigger(n: number): TypedExecutionEvent {
  return {
    event_id: `evt_s19_trig_${n}`,
    stream_id: `conversation:conv_s19_${n}`,
    sequence: 1,
    event_version: 1,
    actor: { type: "system", id: "scheduler" },
    task_id: `task_s19_trig_${n}`,
    conversation_id: `conv_s19_${n}`,
    occurred_at: clockNow,
    redaction_class: "internal",
    event_type: "trigger.scheduled",
    payload: { schedule_id: `sch_s19_${n}`, due_at: clockNow },
  };
}

function startRun(runtime: RuntimeHandle, n: number): string {
  const result = runtime.harness.startRun(scriptedTrigger(n));
  if (!result.ok) {
    throw new Error(`the scripted run refused to start: ${result.code}`);
  }
  return result.task_id;
}

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

async function commitIn(workDir: string, relPath: string, content: string) {
  const git = simpleGit(workDir);
  await git.addConfig("user.email", "agent@example.invalid");
  await git.addConfig("user.name", "Coding Agent");
  writeFileSync(join(workDir, relPath), content);
  await git.add([relPath]);
  await git.commit("task work");
}

interface Scenario {
  env: RunningRuntime;
  originUrl: string;
  projectId: string;
  repoPath: string;
  taskId: string;
  conversationId: string;
  worktreePath: string;
  mergeRequestId: string;
  mainBefore: string;
}

/** Clone one project, start one run, allocate its worktree, commit one file. */
async function scenarioWithTaskWork(): Promise<Scenario> {
  const env = await composeOn();
  const base = makeTempDir("shera-s19-api-origin-");
  const originUrl = pathToFileURL(await makeOrigin(base, "origin")).href;
  const created = await postJson(env.origin, "/v1/projects", {
    workspace_id: WORKSPACE,
    name: "demo",
    actor: USER,
    source: { kind: "git_url", url: originUrl },
  });
  if (created.status !== 201) throw new Error(`the clone failed: ${JSON.stringify(created.body)}`);
  const project = created.body as Record<string, string>;
  env.runCounter += 1;
  const n = env.runCounter;
  const taskId = startRun(env.runtime, n);
  const allocated = await postJson(env.origin, `/v1/projects/${project.project_id}/worktrees`, {
    workspace_id: WORKSPACE,
    task_id: taskId,
    agent_id: AGENT_ID,
  });
  if (allocated.status !== 201) throw new Error("the worktree allocation failed");
  const allocation = allocated.body as { worktree: { worktree_path: string } };
  await commitIn(allocation.worktree.worktree_path, "src/greet.ts", "export const g = 1;\n");
  return {
    env,
    originUrl,
    projectId: project.project_id!,
    repoPath: project.repo_path!,
    taskId,
    conversationId: `conv_s19_${n}`,
    worktreePath: allocation.worktree.worktree_path,
    mergeRequestId: "",
    mainBefore: "",
  };
}

async function headOf(repoDir: string, ref: string): Promise<string> {
  return String(await simpleGit(repoDir).revparse([ref])).trim();
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe("S19 projects API: import/clone surface", () => {
  let env: RunningRuntime | undefined;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined;
    }
  });

  it("registers a clone and lists the sanitized project", async () => {
    env = await composeOn();
    const base = makeTempDir("shera-s19-api-origin-");
    const url = pathToFileURL(await makeOrigin(base, "origin")).href;
    const created = await postJson(env.origin, "/v1/projects", {
      workspace_id: WORKSPACE,
      name: "demo",
      actor: USER,
      source: { kind: "git_url", url },
    });
    expect(created.status).toBe(201);
    const project = created.body as Record<string, string>;
    expect(project.project_id).toMatch(/^prj_/);
    expect(project.name).toBe("demo");
    expect(project.default_branch).toBe("main");

    const list = await getJson(env.origin, `/v1/projects?workspace_id=${WORKSPACE}`);
    expect(list.status).toBe(200);
    expect((list.body["projects"] as unknown[]).length).toBe(1);

    // E12: another workspace sees nothing and cannot read the detail.
    const foreignList = await getJson(env.origin, `/v1/projects?workspace_id=${FOREIGN_WORKSPACE}`);
    expect((foreignList.body["projects"] as unknown[]).length).toBe(0);
    const foreignDetail = await getJson(
      env.origin,
      `/v1/projects/${project.project_id}?workspace_id=${FOREIGN_WORKSPACE}`,
    );
    expect(foreignDetail.status).toBe(404);
  });

  it("answers the typed failure for a clone that cannot succeed and registers nothing", async () => {
    env = await composeOn();
    const base = makeTempDir("shera-s19-api-origin-");
    const missing = pathToFileURL(join(base, "does-not-exist")).href;
    const failed = await postJson(env.origin, "/v1/projects", {
      workspace_id: WORKSPACE,
      name: "ghost",
      actor: USER,
      source: { kind: "git_url", url: missing },
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const list = await getJson(env.origin, `/v1/projects?workspace_id=${WORKSPACE}`);
    expect((list.body["projects"] as unknown[]).length).toBe(0);
  });
});

describe("S19 projects API: worktrees and the conflict queue", () => {
  let env: RunningRuntime | undefined;
  let base: string | undefined;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined;
    }
  });

  it("allocates the first task's worktree and queues the second with its reason", async () => {
    env = await composeOn();
    base = makeTempDir("shera-s19-api-origin-");
    const url = pathToFileURL(await makeOrigin(base, "origin")).href;
    const created = await postJson(env.origin, "/v1/projects", {
      workspace_id: WORKSPACE,
      name: "demo",
      actor: USER,
      source: { kind: "git_url", url },
    });
    const projectId = (created.body as Record<string, string>).project_id!;

    const taskIdA = startRun(env.runtime, 11);
    const first = await postJson(env.origin, `/v1/projects/${projectId}/worktrees`, {
      workspace_id: WORKSPACE,
      task_id: taskIdA,
      agent_id: AGENT_ID,
    });
    expect(first.status).toBe(201);
    expect((first.body as Record<string, string>)["outcome"]).toBe("allocated");

    const taskIdB = startRun(env.runtime, 12);
    const second = await postJson(env.origin, `/v1/projects/${projectId}/worktrees`, {
      workspace_id: WORKSPACE,
      task_id: taskIdB,
      agent_id: AGENT_ID,
    });
    // Queued, never concurrent: the outcome names the reason (G5).
    expect(second.status).toBe(200);
    expect((second.body as Record<string, string>)["outcome"]).toBe("queued");
    expect(String((second.body as Record<string, unknown>)["reason"])).toContain(taskIdA);
  });
});

describe("S19 projects API: credentials custody (D22/G3)", () => {
  let env: RunningRuntime | undefined;
  let base: string | undefined;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined;
    }
    if (base) {
      rmSync(base, { recursive: true, force: true });
      base = undefined;
    }
  });

  it("stores a credential, answers masked metadata only, and revokes it", async () => {
    env = await composeOn();
    base = makeTempDir("shera-s19-api-origin-");
    const url = pathToFileURL(await makeOrigin(base, "origin")).href;
    const created = await postJson(env.origin, "/v1/projects", {
      workspace_id: WORKSPACE,
      name: "demo",
      actor: USER,
      source: { kind: "git_url", url },
    });
    const projectId = (created.body as Record<string, string>).project_id!;

    const stored = await postJson(env.origin, `/v1/projects/${projectId}/credentials`, {
      workspace_id: WORKSPACE,
      actor: USER,
      credential_kind: "token",
      username: "x-access-token",
      secret: SECRET,
    });
    expect(stored.status).toBe(201);
    const credential = stored.body as Record<string, string>;
    expect(credential.credential_id).toMatch(/^cred_/);
    expect(credential.masked_hint).toBe("••••d6c");

    // The value NEVER appears in any API response (G3 redaction scan).
    const list = await getJson(
      env.origin,
      `/v1/projects/${projectId}/credentials?workspace_id=${WORKSPACE}`,
    );
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(JSON.stringify(stored.body)).not.toContain(SECRET);

    const revoked = await postJson(
      env.origin,
      `/v1/projects/${projectId}/credentials/${credential.credential_id}/revoke`,
      { workspace_id: WORKSPACE },
    );
    expect(revoked.status).toBe(200);
    const after = (list.body["credentials"] as Array<Record<string, unknown>>).length;
    const relisted = await getJson(
      env.origin,
      `/v1/projects/${projectId}/credentials?workspace_id=${WORKSPACE}`,
    );
    const rows = relisted.body["credentials"] as Array<Record<string, unknown>>;
    expect(rows.length).toBe(after);
    expect(JSON.stringify(relisted.body)).not.toContain(SECRET);

    // The fault log (captured through the composition) carries no secret.
    expect(JSON.stringify(env.faults)).not.toContain(SECRET);
  });
});

describe("S19 projects API: merge requests and the PRD decisions", () => {
  let scenario: Scenario | undefined;

  afterEach(async () => {
    if (scenario) {
      await scenario.env.close();
      scenario = undefined;
    }
  });

  async function prepare(): Promise<Scenario> {
    const s = await scenarioWithTaskWork();
    scenario = s;
    const prepared = await postJson(s.env.origin, `/v1/projects/${s.projectId}/merge-requests`, {
      workspace_id: WORKSPACE,
      task_id: s.taskId,
      agent_id: AGENT_ID,
      conversation_id: s.conversationId,
      change_summary: "Add the greeting module.",
    });
    if (prepared.status !== 201) {
      throw new Error(`preparing the merge request failed: ${JSON.stringify(prepared.body)}`);
    }
    s.mergeRequestId = (prepared.body as Record<string, unknown>)["merge_request_id"] as string;
    s.mainBefore = await headOf(s.repoPath, "main");
    return s;
  }

  function decisionPath(s: Scenario) {
    return `/v1/projects/${s.projectId}/merge-requests/${s.mergeRequestId}/decision`;
  }

  it("answers the minimal PRD view and refuses an agent decision (never self-approve)", async () => {
    const s = await prepare();
    const detail = await getJson(
      s.env.origin,
      `/v1/projects/${s.projectId}/merge-requests/${s.mergeRequestId}?workspace_id=${WORKSPACE}`,
    );
    expect(detail.status).toBe(200);
    const mr = detail.body as Record<string, unknown>;
    // Exactly the minimal PRD §10 fields plus approval state.
    expect(mr["change_summary"]).toBe("Add the greeting module.");
    expect(mr["changed_files"]).toEqual(["src/greet.ts"]);
    expect(mr["validation_status"]).toBe("not_run");
    expect(mr["conflict_status"]).toBe("clean");
    expect(mr["target_branch"]).toBe("main");
    expect(mr["status"]).toBe("awaiting_approval");
    expect(String(mr["approval_id"])).toMatch(/^apr_/);

    // An Agent actor can never decide (G6) — 403, nothing merged.
    const agentDecision = await postJson(s.env.origin, decisionPath(s), {
      workspace_id: WORKSPACE,
      choice: "approve",
      decided_by: { type: "agent", id: AGENT_ID },
    });
    expect(agentDecision.status).toBe(403);
    expect(await headOf(s.repoPath, "main")).toBe(s.mainBefore);
  });

  it("approve performs the merge through the S20 machinery; main advances", async () => {
    const s = await prepare();
    const decided = await postJson(s.env.origin, decisionPath(s), {
      workspace_id: WORKSPACE,
      choice: "approve",
      decided_by: USER,
    });
    expect(decided.status).toBe(200);
    expect((decided.body as Record<string, string>)["decision"]).toBe("approved");
    const mr = (decided.body as Record<string, unknown>)["merge_request"] as Record<
      string,
      unknown
    >;
    expect(mr["status"]).toBe("merged");
    // Real git state: the target branch advanced past the prepared base.
    expect(await headOf(s.repoPath, "main")).not.toBe(s.mainBefore);
  });

  it("reject leaves the target branch untouched", async () => {
    const s = await prepare();
    const decided = await postJson(s.env.origin, decisionPath(s), {
      workspace_id: WORKSPACE,
      choice: "reject",
      decided_by: USER,
    });
    expect(decided.status).toBe(200);
    expect((decided.body as Record<string, string>)["decision"]).toBe("rejected");
    const mr = (decided.body as Record<string, unknown>)["merge_request"] as Record<
      string,
      unknown
    >;
    expect(mr["status"]).toBe("rejected");
    expect(await headOf(s.repoPath, "main")).toBe(s.mainBefore);
  });

  it("request-changes leaves the target branch untouched", async () => {
    const s = await prepare();
    const decided = await postJson(s.env.origin, decisionPath(s), {
      workspace_id: WORKSPACE,
      choice: "request_changes",
      decided_by: USER,
    });
    expect(decided.status).toBe(200);
    expect((decided.body as Record<string, string>)["decision"]).toBe("changes_requested");
    const mr = (decided.body as Record<string, unknown>)["merge_request"] as Record<
      string,
      unknown
    >;
    expect(mr["status"]).toBe("changes_requested");
    expect(await headOf(s.repoPath, "main")).toBe(s.mainBefore);
  });
});
