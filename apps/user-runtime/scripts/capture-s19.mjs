/**
 * S19 UI-gate capture harness (chunk 2) — drives the REAL web app against
 * the REAL mock runtime with REAL seeded S19 state:
 *
 *   1. The full runtime composition (real SQLite, real HTTP, real projects
 *      surface over the real GitService) with the pinned student pack loaded
 *      so Agents exist and an Operation with a real run can be created.
 *   2. The S19 seed through the REAL services and HTTP API: one Operation
 *      with one run (POST /v1/operations, POST .../runs — the runtime mints
 *      the run id), a project imported through the REAL git service (a real
 *      local origin clone), a worktree allocated for THAT run's id (real
 *      git) with a commit on the task branch — the run card's git line is a
 *      genuine join, not a fixture. Plus, for the merge-review surface: one
 *      merge request prepared through the REAL approvals pause (a scripted
 *      TaskRun — the only fabricated input; the shape the harness produces),
 *      one REJECTED merge request recorded, and one queued worktree entry
 *      (the G5 queue with its visible reason).
 *   3. A control-plane stub (the e2e harness identity) + `next dev`, so the
 *      browser drives the app's own routes through its own proxy.
 *
 * Captures: apps/web/.impeccable/review/s19/*.png — Settings → Git at
 * 360/768/1440, keyboard-only focus, prefers-reduced-motion, and the
 * Operation runs panel with the git-aware run cards.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { simpleGit } from "simple-git";
import { chromium } from "playwright-core";

import { composeRuntime, DEFAULT_WORKSPACE_ID } from "../src/transport/local-api/compose.ts";
import { FakeHarnessAdapter } from "../src/adapters/process/fake-harness-adapter.ts";
import { openDatabase } from "../src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../src/adapters/sqlite/transactions.ts";
import { ProjectsRepository } from "../src/adapters/sqlite/projects-repository.ts";
import { EventJournalRepository } from "../src/adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../src/modules/events/events.service.ts";
import { ApprovalsService } from "../src/modules/approvals/approvals.service.ts";
import { ApprovalsRepository } from "../src/adapters/sqlite/approvals-repository.ts";
import { OperationsRepository } from "../src/adapters/sqlite/operations-repository.ts";
import { CredentialVault } from "../src/modules/projects/credential-vault.ts";
import { GitService } from "../src/modules/git/git.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const NOW = "2026-10-29T12:00:00.000Z";
const USER = { type: "user", id: "user_001" };
const AGENT_ID = "agent_developer";
const CONVERSATION = "conv_s19_capture";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s19");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function makeOrigin(baseDir) {
  const originDir = join(baseDir, "origin");
  mkdirSync(originDir, { recursive: true });
  execSync("git init -q -b main .", { cwd: originDir });
  const git = simpleGit(originDir);
  await git.addConfig("user.email", "origin@example.invalid");
  await git.addConfig("user.name", "Origin Fixture");
  writeFileSync(join(originDir, "README.md"), "# capture origin\n");
  mkdirSync(join(originDir, "src"), { recursive: true });
  writeFileSync(join(originDir, "src", "app.ts"), "export {};\n");
  await git.add(["-A"]);
  await git.commit("initial commit");
  return originDir;
}

function makeRun(taskId, state) {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONVERSATION,
    created_from: { trigger_event_type: "trigger.scheduled", trigger_event_id: "evt_capture" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
    roster: [AGENT_ID],
    state,
    version: 3,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seedGitServices(dbPath) {
  const conn = openDatabase(dbPath);
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
  const dir = makeTempDir("shera-s19-capture-");
  const git = new GitService({
    projects,
    vault: new CredentialVault(join(dir, "project-credentials.key")),
    approvals,
    approvalsRepository,
    tx,
    projectsRoot: join(dir, "projects"),
    clock: () => NOW,
  });
  return { conn, git, approvals, projects, dir };
}

async function commitIn(workDir, relPath, content) {
  const git = simpleGit(workDir);
  await git.addConfig("user.email", "agent@example.invalid");
  await git.addConfig("user.name", "Coding Agent");
  mkdirSync(dirname(join(workDir, relPath)), { recursive: true });
  writeFileSync(join(workDir, relPath), content);
  await git.add(["-A"]);
  await git.commit(`task work: ${relPath}`);
}

// ---------------------------------------------------------------------------
// 1. The runtime composition with the pinned pack
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s19-capture-runtime-");
const dbPath = join(dir, "runtime.db");
const runtime = composeRuntime({
  dbPath,
  workspaceId: WS,
  harnessAdapter: new FakeHarnessAdapter({ now: () => NOW }),
  packsRoot: PACKS_ROOT,
  now: () => NOW,
  scriptedReplies: false,
});
await new Promise((resolveListen) => runtime.httpServer.listen(0, "127.0.0.1", resolveListen));
const runtimePort = runtime.httpServer.address().port;
const origin = `http://127.0.0.1:${runtimePort}`;
console.log("runtime on", origin);

const post = async (path, body) => {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    throw new Error(`POST ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
};
const get = async (path) => {
  const response = await fetch(origin + path);
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    throw new Error(`GET ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
};

// ---------------------------------------------------------------------------
// 2. The seed: a real Operation run joined to real git work + the review state
// ---------------------------------------------------------------------------

const operation = await post("/v1/operations", {
  workspace_id: WS,
  definition_ref: null,
  name: null,
  roster_agent_ids: [AGENT_ID, "agent_general_assistant"],
  coordinator_agent_id: "agent_general_assistant",
});
const operationId = operation.operation_id;
const run = await post(`/v1/operations/${operationId}/runs`, { workspace_id: WS });
const runId = run.run_id;
console.log("operation", operationId, "run", runId);

const seeded = await seedGitServices(dbPath);
{
  const { git, approvals } = seeded;
  const originDir = await makeOrigin(seeded.dir);
  const originUrl = `file:///${originDir.replace(/\\/g, "/")}`;
  const project = await git.importProject({
    workspace_id: WS,
    name: "term-project",
    actor: USER,
    source: { kind: "git_url", url: originUrl },
  });

  // A first task prepared, then REJECTED (target branch untouched) and its
  // worktree released — the decided-review state the settings surface shows.
  const second = await git.allocateWorktree({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_capture_second",
    agent_id: AGENT_ID,
  });
  if (second.outcome !== "allocated") throw new Error("second worktree failed");
  await commitIn(second.worktree.worktree_path, "notes.md", "explore\n");
  const preparedB = await git.prepareMergeRequest({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_capture_second",
    agent_id: AGENT_ID,
    conversation_id: CONVERSATION,
    change_summary: "Explore the notes module.",
    run: makeRun("task_capture_second", "RUNNING"),
  });
  const decidedB = approvals.applyDecision({
    approval_id: preparedB.approval_id,
    choice: "reject-this-action",
    decided_by: USER,
    run: preparedB.run,
    execute: () => {
      throw new Error("a rejected merge must never execute");
    },
  });
  if (decidedB.outcome !== "action_rejected") throw new Error("reject failed");
  git.recordMergeDecision(WS, project.project_id, preparedB.merge_request.merge_request_id, "rejected");
  await git.releaseWorktree({
    workspace_id: WS,
    project_id: project.project_id,
    worktree_id: second.worktree.worktree_id,
    outcome: "released",
  });

  // The Operation run's REAL git work: its own branch + worktree + a commit.
  // Its worktree stays ACTIVE (the awaiting-review merge request holds the
  // slot), so this allocation must follow the release above (G5: one active
  // worktree per project).
  const runWorktree = await git.allocateWorktree({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: runId,
    agent_id: AGENT_ID,
  });
  if (runWorktree.outcome !== "allocated") throw new Error("run worktree failed");
  await commitIn(runWorktree.worktree.worktree_path, "src/login.ts", "export const login = 1;\n");

  // The awaiting-review merge request (scripted run input; real approvals pause).
  const preparedA = await git.prepareMergeRequest({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: runId,
    agent_id: AGENT_ID,
    conversation_id: CONVERSATION,
    change_summary: "Fix the login validation.",
    run: makeRun(runId, "RUNNING"),
  });
  console.log("merge request", preparedA.merge_request.merge_request_id, "validation:", preparedA.merge_request.validation_status);

  // A third task: QUEUED behind the run (G5: the wait is visible).
  const queued = await git.allocateWorktree({
    workspace_id: WS,
    project_id: project.project_id,
    task_id: "task_capture_queued",
    agent_id: AGENT_ID,
  });
  if (queued.outcome !== "queued") throw new Error("expected a queued worktree");
  console.log("seeded project", project.project_id);
}
seeded.conn.close();

// ---------------------------------------------------------------------------
// 3. The control-plane stub + next dev
// ---------------------------------------------------------------------------

const control = createServer((req, res) => {
  void (async () => {
    if (req.url === "/api/session" || req.url === "/api/control/session-unused") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          workspace_id: WS,
          google_sub: "capture-user",
          email: "capture@example.com",
          display_name: "Emon",
          tier: "balanced",
          is_admin: false,
          created_at: "2026-10-01T00:00:00Z",
          last_active_at: "2026-10-01T00:00:00Z",
        }),
      );
      return;
    }
    if (req.url === "/api/runtime/status") {
      // The workspace container is READY (the stub IS the deployment here).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          runtime_handle: "rt_capture",
          account_id: "capture-user",
          tier: "balanced",
          provisioning_status: "running",
          health: "healthy",
          resource_summary: {
            tier: "balanced",
            cpu_vcpus: 4,
            memory_bytes: 8589934592,
            storage_bytes: 107374182400,
          },
          checked_at: NOW,
        }),
      );
      return;
    }
    if (!req.url?.startsWith("/api/runtime/local/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(origin + req.url.slice("/api/runtime/local".length), {
      method: req.method,
      headers: { "content-type": "application/json" },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(await upstream.text());
  })().catch(() => {
    res.writeHead(500);
    res.end();
  });
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const controlPort = control.address().port;
cleanups.push(() => control.close());

const webOrigin = "http://127.0.0.1:4319";
const next = spawn(process.execPath, [join(repoRoot, "apps", "web", "node_modules", "next", "dist", "bin", "next"), "dev", "--port", "4319"], {
  cwd: join(repoRoot, "apps", "web"),
  env: {
    ...process.env,
    CONTROL_PLANE_URL: `http://127.0.0.1:${controlPort}`,
    SHERA_WEB_ORIGIN: webOrigin,
    BROWSER: "none",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let nextLog = "";
next.stdout.on("data", (d) => (nextLog += d.toString()));
next.stderr.on("data", (d) => (nextLog += d.toString()));
cleanups.push(() => next.kill());

let webReady = false;
for (let i = 0; i < 120 && !webReady; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    webReady = (await fetch(webOrigin + "/login")).ok;
  } catch {
    webReady = false;
  }
  if (i === 60) console.log("still waiting for next dev:", nextLog.slice(-500));
}
if (!webReady) {
  console.error("next dev never became ready:\n", nextLog.slice(-2500));
  process.exit(1);
}
console.log("web app ready on", webOrigin);

// Probe the two control-plane endpoints the container gate needs.
const probeSession = await fetch(webOrigin + "/api/control/api/session");
console.log("probe session:", probeSession.status, (await probeSession.text()).slice(0, 240));
const probeStatus = await fetch(webOrigin + "/api/control/api/runtime/status");
console.log("probe status:", probeStatus.status, (await probeStatus.text()).slice(0, 340));

// ---------------------------------------------------------------------------
// 4. The captures
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  // The pre-cached chromium build (playwright-core's registry expects a
  // different revision; the explicit executablePath reuses the cache).
  executablePath: join(process.env["LOCALAPPDATA"] ?? "", "ms-playwright", "chromium-1248", "chrome-win64", "chrome.exe"),
});

async function capture(name, path, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("console", (message) => console.log("[console]", message.type(), message.text().slice(0, 220)));
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  // The surfaces poll on the presence cadence — networkidle never settles.
  await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
  if (opts.waitFor !== undefined) {
    await page.waitForSelector(opts.waitFor, { timeout: 20000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  if (name === "git-review-1440.png") {
    const inPage = await page.evaluate(async () => {
      try {
        const session = await fetch("/api/control/api/session");
        const status = await fetch("/api/control/api/runtime/status");
        return {
          session: session.status,
          status: status.status,
          statusBody: (await status.text()).slice(0, 120),
        };
      } catch (error) {
        return { error: String(error) };
      }
    });
    console.log("[in-page probe]", JSON.stringify(inPage));
    const gateState = await page.evaluate(() => document.body.innerText.slice(0, 400));
    console.log("[gate text]", JSON.stringify(gateState));
  }
  if (opts.before !== undefined) await opts.before(page);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
}

await capture("git-review-1440.png", "/app/settings/git", { width: 1440, height: 900 }, { waitFor: "[data-testid=merge-request-card]" });
await capture("git-review-768.png", "/app/settings/git", { width: 768, height: 1024 }, { waitFor: "[data-testid=merge-request-card]" });
await capture("git-review-360.png", "/app/settings/git", { width: 360, height: 740 }, { fullPage: true, waitFor: "[data-testid=merge-request-card]" });
await capture("git-review-reduced-motion-1440.png", "/app/settings/git", { width: 1440, height: 900 }, { reducedMotion: true, waitFor: "[data-testid=merge-request-card]" });

// Keyboard-only: tab until a decision control holds focus, then capture.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + "/app/settings/git", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=merge-approve]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    if (focused === "merge-approve") {
      reached = true;
      break;
    }
  }
  console.log("keyboard reached merge-approve:", reached);
  await page.screenshot({ path: join(CAPTURE_OUT, "git-review-keyboard-focus-1440.png") });
  console.log("captured git-review-keyboard-focus-1440.png");
  await context.close();
}

// The git-aware run cards on the Operation chat.
await capture("run-cards-git-1440.png", `/app/operation/${operationId}`, { width: 1440, height: 900 }, { waitFor: "[data-testid=operation-run-git]" });
await capture("run-cards-git-360.png", `/app/operation/${operationId}`, { width: 360, height: 740 }, { fullPage: true, waitFor: "[data-testid=operation-run-git]" });
await browser.close();
console.log("DONE — captures in", CAPTURE_OUT);
next.kill();
runtime.close();
process.exit(0);
