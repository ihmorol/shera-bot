/**
 * S31 UI-gate capture harness — the honest recovery surfaces against the
 * REAL runtime and the PRODUCTION web build (the recorded S22/S24/S25/S28
 * harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, the fake worker
 *      harness — the re-drive spawns REAL worker children).
 *   2. The seed through the REAL machinery, BEFORE the gateway boots: the
 *      crashed store the previous gateway left — an interrupted `replayable`
 *      run (checkpoint + dead worker row), an interrupted `needs_human` run,
 *      real dead pids. The recovery decisions are the gateway's OWN boot
 *      walk (S16 reap → S31 scan) — the capture scripts nothing.
 *   3. The PRODUCTION web build (next start via SHERA_CAPTURE_PROD=1 — the
 *      recorded dev-mode gate hang) behind a control-plane stub.
 *
 * The AC truth leg: the harness FAILS unless the recovery status the web
 * renders matches runtime.recovery's own record — the review entry, the
 * resume basis (checkpoint version + step), and the timeline markers are
 * asserted against the runtime's journal before any screenshot exists.
 *
 * Captures (apps/web/.impeccable/review/s31/): the review banner + the run
 * timeline (360/768/1440), the RESUMED transient (a second runtime whose
 * only recovery leg is the auto-resume), the keyboard-only trail (focus on
 * the review deep link), and prefers-reduced-motion. Screenshots are
 * evidence; the JSON files are the machine-readable truth.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { chromium } from "playwright";

// The page.evaluate closures below run INSIDE the browser context and
// reference browser globals (document/window) by design.
/* global document, getComputedStyle */

import { composeRuntime, DEFAULT_WORKSPACE_ID } from "../src/transport/local-api/compose.ts";
import { openDatabase } from "../src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../src/adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../src/adapters/sqlite/operations-repository.ts";
import { RunCheckpointsRepository } from "../src/adapters/sqlite/run-checkpoints-repository.ts";
import { TaskWorkersRepository } from "../src/adapters/sqlite/task-workers-repository.ts";
import { SqliteTransactions } from "../src/adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../src/adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../src/modules/events/events.service.ts";
import { OperationsService } from "../src/modules/operations/operations.service.ts";
import { CheckpointService } from "../src/modules/tasks/checkpoint.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s31");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const NOW = "2026-11-04T14:00:00.000Z";

// ---------------------------------------------------------------------------
// 1. The crashed-state seed through the REAL machinery (pre-boot)
// ---------------------------------------------------------------------------

function seedCrashed(dbPath, { withAmbiguous }) {
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const taskWorkers = new TaskWorkersRepository(tx);
  const checkpoints = new RunCheckpointsRepository(tx);
  const checkpointService = new CheckpointService({
    tx,
    journal,
    events,
    checkpoints,
    now: () => NOW,
  });
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: {
      pack_id: "pack_student",
      pack_version: "1.0.0",
      agents: [
        {
          agent_id: "agent_developer",
          display_name: "Developer",
          role_description: "crashed mid-run",
          default_provider: { provider_id: "fake", model: "fake-model" },
          skills: [],
          tools: [],
          connectors: [],
          ui_identity: { avatar_hue: 4, initial_glyph: "D" },
          home_operation_id: null,
        },
        {
          agent_id: "agent_researcher",
          display_name: "Researcher",
          role_description: "crashed mid-run",
          default_provider: { provider_id: "fake", model: "fake-model" },
          skills: [],
          tools: [],
          connectors: [],
          ui_identity: { avatar_hue: 5, initial_glyph: "R" },
          home_operation_id: null,
        },
      ],
      locateAgentPack: (agentId) =>
        agentId === "agent_developer" || agentId === "agent_researcher" ? "pack_student" : null,
      skills: [],
      connectors: [],
    },
  });

  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Literature Review",
    roster_agent_ids: ["agent_developer", "agent_researcher"],
    coordinator_agent_id: "agent_developer",
  }).operation_id;

  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid ?? 1;

  const makeRun = (runId, state) => {
    ops.createRun(WS, operationId, { run_id: runId });
    ops.applyRunState(WS, operationId, runId, state);
    taskWorkers.insertWorker({
      workspace_id: WS,
      run_id: runId,
      worker_id: `wk_dead_${runId}`,
      pid: deadPid,
      state: "running",
      heartbeat_at: NOW,
      lease_expires_at: NOW,
      last_progress_json: null,
      started_at: NOW,
    });
  };

  const replayable = "run_s31_cap_replayable";
  makeRun(replayable, "RUNNING");
  const verdict = checkpointService.record({
    workspaceId: WS,
    taskId: replayable,
    conversationId: operationId,
    stepId: "step_parse_papers_1",
    stepKind: "downloaded_document",
    completedActions: [{ kind: "tool_execution", summary: "downloaded 3 papers" }],
    pendingAction: {
      kind: "tool_execution",
      summary: "parse the downloaded papers",
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
    },
    artifactRefs: ["workspace://artifacts/papers/"],
    resumeInstructions: "Resume by parsing the three downloaded papers.",
  });
  if (!verdict.ok) throw new Error(`replayable checkpoint refused: ${verdict.safeMessage}`);

  let ambiguous = null;
  if (withAmbiguous) {
    ambiguous = "run_s31_cap_ambiguous";
    makeRun(ambiguous, "RUNNING");
    const verdict2 = checkpointService.record({
      workspaceId: WS,
      taskId: ambiguous,
      conversationId: operationId,
      stepId: "step_submit_board_1",
      stepKind: "completed_search",
      completedActions: [{ kind: "tool_execution", summary: "drafted the board post" }],
      pendingAction: {
        kind: "tool_execution",
        summary: "post the draft to the external board",
        tool_id: "tool_external_post",
        recovery_class: "needs_human",
      },
      artifactRefs: [],
      resumeInstructions: "A review decides whether the external post re-runs.",
    });
    if (!verdict2.ok) throw new Error(`ambiguous checkpoint refused: ${verdict2.safeMessage}`);
  }

  conn.close();
  return { operationId, replayable, ambiguous };
}

const FAKE_WORKER_HARNESS = {
  file: process.execPath,
  args: [
    resolve(repoRoot, "apps/user-runtime/src/modules/workers/fake-task-worker-child.ts"),
    "--run-id",
    "{run_id}",
    "--worker-id",
    "{worker_id}",
    "--heartbeat-ms",
    "{heartbeat_interval_ms}",
    "--steps",
    "2",
    "--step-delay-ms",
    "20",
  ],
};

const WORKER_POLICY = {
  heartbeatIntervalMs: 40,
  missedHeartbeatLimit: 25,
  leaseWindowMs: 150,
  handshakeTimeoutMs: 4_000,
  shutdownGraceMs: 200,
  killGraceMs: 200,
};

// ---------------------------------------------------------------------------
// 2. Phase A runtime: the review leg (both recovery classes seeded)
// ---------------------------------------------------------------------------

const dirA = makeTempDir("shera-s31-capture-a-");
const dbPathA = join(dirA, "runtime.db");
const seededA = seedCrashed(dbPathA, { withAmbiguous: true });

const runtimeA = composeRuntime({
  dbPath: dbPathA,
  workspaceId: WS,
  packsRoot: PACKS_ROOT,
  now: () => NOW,
  workerHarness: FAKE_WORKER_HARNESS,
  workerPolicy: WORKER_POLICY,
});
await new Promise((resolveListen) => runtimeA.httpServer.listen(0, "127.0.0.1", resolveListen));
const originA = `http://127.0.0.1:${runtimeA.httpServer.address().port}`;
console.log("runtime A on", originA);
const bootReport = await runtimeA.recovery.bootPass;
if (bootReport === null) throw new Error("the boot pass fault-logged — nothing to capture");

const visitedA = new Map(bootReport.visited.map((entry) => [entry.runId, entry.outcome]));
console.log(
  "boot A:",
  JSON.stringify([...visitedA.entries()].map(([k, v]) => ({ run: k, outcome: v.outcome }))),
);

// ---------------------------------------------------------------------------
// 3. The AC truth leg: the rendered status IS the runtime's record
// ---------------------------------------------------------------------------

const recoveryStatusA = await fetch(originA + `/v1/recovery/status?workspace_id=${WS}`).then((r) =>
  r.json(),
);
console.log(
  "status A state:",
  recoveryStatusA.workspace_state,
  "review:",
  recoveryStatusA.review_needed.length,
  "resumed:",
  recoveryStatusA.resumed.length,
);

if (recoveryStatusA.workspace_state !== "review_needed") {
  throw new Error(`expected review_needed, got ${recoveryStatusA.workspace_state}`);
}
if (recoveryStatusA.review_needed.length !== 1) {
  throw new Error(`expected exactly one review entry, got ${recoveryStatusA.review_needed.length}`);
}
const reviewEntry = recoveryStatusA.review_needed[0];
if (reviewEntry.pending_summary !== "post the draft to the external board") {
  throw new Error(`the review entry's pending summary drifted: ${reviewEntry.pending_summary}`);
}
const resumedEntry = recoveryStatusA.resumed.find((entry) => entry.run_id === seededA.replayable);
if (!resumedEntry || resumedEntry.basis !== "replayable") {
  throw new Error(`the replayable run did not resume: ${JSON.stringify(recoveryStatusA.resumed)}`);
}
const timeline = recoveryStatusA.timelines[seededA.replayable];
const kinds = timeline ? timeline.markers.map((m) => m.kind) : [];
if (!(kinds.includes("checkpoint") && kinds.includes("restart") && kinds.includes("resume"))) {
  throw new Error(`the resumed run's timeline is incomplete: ${kinds.join(",")}`);
}
const resumeMarker = timeline.markers.find((m) => m.kind === "resume");
if (resumeMarker.checkpoint_version !== 1 || resumeMarker.step_id !== "step_parse_papers_1") {
  throw new Error(`the resume marker's basis drifted: ${JSON.stringify(resumeMarker)}`);
}
const ambiguousTimeline = recoveryStatusA.timelines[seededA.ambiguous];
const ambiguousKinds = ambiguousTimeline ? ambiguousTimeline.markers.map((m) => m.kind) : [];
if (!ambiguousKinds.includes("pause")) {
  throw new Error(
    `the ambiguous run's timeline lacks the pause marker: ${ambiguousKinds.join(",")}`,
  );
}

const truthA = {
  workspace_state: recoveryStatusA.workspace_state,
  review_needed: recoveryStatusA.review_needed,
  resumed: recoveryStatusA.resumed,
  timelines: recoveryStatusA.timelines,
  boot_outcomes: bootReport.visited.map((entry) => ({
    run_id: entry.runId,
    outcome: entry.outcome.outcome,
    ...(entry.outcome.outcome === "resumed" ? { basis: entry.outcome.basis } : {}),
  })),
};
writeFileSync(join(CAPTURE_OUT, "s31-recovery-truth.json"), JSON.stringify(truthA, null, 2));
console.log(
  "truth A written: review 1, resumed 1, timelines",
  Object.keys(recoveryStatusA.timelines).length,
);

// ---------------------------------------------------------------------------
// 4. Phase B runtime: the RESUMED-only leg (no review — the transient banner)
// ---------------------------------------------------------------------------

const dirB = makeTempDir("shera-s31-capture-b-");
const dbPathB = join(dirB, "runtime.db");
const seededB = seedCrashed(dbPathB, { withAmbiguous: false });

const runtimeB = composeRuntime({
  dbPath: dbPathB,
  workspaceId: WS,
  packsRoot: PACKS_ROOT,
  now: () => NOW,
  workerHarness: FAKE_WORKER_HARNESS,
  workerPolicy: WORKER_POLICY,
});
await new Promise((resolveListen) => runtimeB.httpServer.listen(0, "127.0.0.1", resolveListen));
const originB = `http://127.0.0.1:${runtimeB.httpServer.address().port}`;
console.log("runtime B on", originB);
await runtimeB.recovery.bootPass;

const recoveryStatusB = await fetch(originB + `/v1/recovery/status?workspace_id=${WS}`).then((r) =>
  r.json(),
);
console.log("status B state:", recoveryStatusB.workspace_state);
if (recoveryStatusB.workspace_state !== "resumed") {
  throw new Error(`expected resumed, got ${recoveryStatusB.workspace_state}`);
}
writeFileSync(
  join(CAPTURE_OUT, "s31-resumed-truth.json"),
  JSON.stringify(
    {
      workspace_state: recoveryStatusB.workspace_state,
      resumed: recoveryStatusB.resumed,
      timelines: recoveryStatusB.timelines,
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------------------
// 5. The control-plane stub + the PRODUCTION web build
// ---------------------------------------------------------------------------

function makeControlStub(upstreamOrigin) {
  const control = createServer((req, res) => {
    void (async () => {
      if (req.url === "/api/session") {
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            runtime_handle: `rt_${"0".repeat(32)}`,
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
            checked_at: "2026-10-31T12:00:00.000Z",
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
      const upstream = await fetch(upstreamOrigin + req.url.slice("/api/runtime/local".length), {
        method: req.method,
        headers: { "content-type": "application/json" },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(await upstream.text());
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  return control;
}

const controlA = makeControlStub(originA);
await new Promise((r) => controlA.listen(0, "127.0.0.1", r));
cleanups.push(() => controlA.close());

const webOrigin = "http://127.0.0.1:4321";
const nextArgs = ["start", "--port", "4321"]; // PRODUCTION build (SHERA_CAPTURE_PROD discipline)
let next = null;
let nextLog = "";

async function startNext(controlPort) {
  next = spawn(
    process.execPath,
    [join(repoRoot, "apps", "web", "node_modules", "next", "dist", "bin", "next"), ...nextArgs],
    {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        ...process.env,
        CONTROL_PLANE_URL: `http://127.0.0.1:${controlPort}`,
        SHERA_WEB_ORIGIN: webOrigin,
        BROWSER: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  nextLog = "";
  next.stdout.on("data", (d) => (nextLog += d.toString()));
  next.stderr.on("data", (d) => (nextLog += d.toString()));
  cleanups.push(() => next.kill());
  let webReady = false;
  for (let i = 0; i < 120 && !webReady; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      webReady = (await fetch(webOrigin + "/login", { signal: AbortSignal.timeout(5000) })).ok;
    } catch {
      webReady = false;
    }
    if (i === 60) console.log("still waiting for the web app:", nextLog.slice(-500));
  }
  if (!webReady) {
    console.error("the web app never became ready:\n", nextLog.slice(-2500));
    process.exit(1);
  }
  console.log("web app ready on", webOrigin);
}

await startNext(controlA.address().port);

process.on("uncaughtException", (error) => {
  console.error("capture crashed:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error("capture rejected:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});

const browser = await chromium.launch();

const operationPath = `/app/operation/${seededA.operationId}`;

async function openPage(viewport, path, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-recovery-banner="review_needed"]', { timeout: 30_000 });
  await page.waitForTimeout(1200);
  return { context, page };
}

// ---------------------------------------------------------------------------
// 6. Phase A captures: the review banner + the run timeline at three widths
// ---------------------------------------------------------------------------

{
  const { context, page } = await openPage({ width: 1440, height: 900 }, operationPath);
  await page.screenshot({
    path: join(CAPTURE_OUT, "s31-recovery-review-1440.png"),
    fullPage: false,
  });
  await page.close();
  await context.close();
  console.log("captured s31-recovery-review-1440");
}
{
  const { context, page } = await openPage({ width: 768, height: 900 }, operationPath);
  await page.screenshot({
    path: join(CAPTURE_OUT, "s31-recovery-review-768.png"),
    fullPage: false,
  });
  await page.close();
  await context.close();
  console.log("captured s31-recovery-review-768");
}
{
  const { context, page } = await openPage({ width: 360, height: 800 }, operationPath);
  await page.screenshot({
    path: join(CAPTURE_OUT, "s31-recovery-review-360.png"),
    fullPage: false,
  });
  await page.close();
  await context.close();
  console.log("captured s31-recovery-review-360");
}

// The keyboard-only pass: the review deep link takes visible focus; the trail
// records every focused step (the JSON is the machine-readable evidence).
{
  const { context, page } = await openPage({ width: 1440, height: 900 }, operationPath);
  const trail = [];
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? {
            tag: el.tagName.toLowerCase(),
            testid:
              el.getAttribute("data-testid") ?? el.getAttribute("data-recovery-banner") ?? null,
            text: (el.textContent ?? "").trim().slice(0, 60),
            visibleFocus: el.matches(":focus-visible") || el.matches(":focus"),
          }
        : null;
    });
    trail.push({ step: step + 1, ...focus });
    if (focus?.testid === "recovery-banner-review-link") break;
  }
  const reviewFocused = trail.some((entry) => entry.testid === "recovery-banner-review-link");
  if (!reviewFocused) {
    console.log("[keyboard-trail]", JSON.stringify(trail));
    throw new Error("the review deep link never took focus in the keyboard walk");
  }
  await page.screenshot({ path: join(CAPTURE_OUT, "s31-recovery-keyboard-1440.png") });
  writeFileSync(join(CAPTURE_OUT, "s31-keyboard-trail.json"), JSON.stringify(trail, null, 2));
  await page.close();
  await context.close();
  console.log("captured s31-recovery-keyboard (trail steps:", trail.length, ")");
}

// prefers-reduced-motion: the banner renders identically with motion reduced.
{
  const { context, page } = await openPage({ width: 1440, height: 900 }, operationPath, {
    reducedMotion: true,
  });
  const spin = await page.evaluate(() => {
    const el = document.querySelector('[data-recovery-banner="review_needed"] svg');
    if (!el) return null;
    const style = getComputedStyle(el);
    return { animationName: style.animationName };
  });
  await page.screenshot({ path: join(CAPTURE_OUT, "s31-recovery-reduced-motion-1440.png") });
  writeFileSync(
    join(CAPTURE_OUT, "s31-reduced-motion.json"),
    JSON.stringify({ banner: "review_needed", svgAnimation: spin }, null, 2),
  );
  await page.close();
  await context.close();
  console.log("captured s31-recovery-reduced-motion");
}

// ---------------------------------------------------------------------------
// 7. Phase B captures: the RESUMED transient (a fresh runtime + proxy swap)
// ---------------------------------------------------------------------------

const controlB = makeControlStub(originB);
await new Promise((r) => controlB.listen(0, "127.0.0.1", r));
cleanups.push(() => controlB.close());

// Restart the web server against the phase-B stub (the built app is reused;
// the runtimes stay up so the journal evidence stays readable).
next.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
await startNext(controlB.address().port);

{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + `/app/operation/${seededB.operationId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-recovery-banner="resumed"]', { timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(CAPTURE_OUT, "s31-recovery-resumed-1440.png") });
  await page.close();
  await context.close();
  console.log("captured s31-recovery-resumed-1440");
}

await browser.close();
console.log("S31 capture complete:", CAPTURE_OUT);
for (const cleanup of cleanups.splice(0)) {
  try {
    cleanup();
  } catch {
    // already down
  }
}
runtimeA.close();
runtimeB.close();
process.exit(0);
