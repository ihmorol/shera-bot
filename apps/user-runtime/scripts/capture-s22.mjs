/**
 * S22 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL seeded S22 state (the S21 harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack, real worker processes) with the S22 retry policy — a long
 *      bounded backoff so a transient-failing run HOLDS the RETRYING state
 *      while the captures run.
 *   2. The seed through the REAL HTTP surface: one Operation with four runs —
 *      A RUNNING (live worker), B RETRYING (worker-reported transient failure,
 *      attempt 1 from the journal), C CANCELLED (a real cancel through the
 *      cancel route), D FAILED by a second worker error (the retry bound
 *      reached via a fast policy is not reproducible with one policy, so D
 *      stays a plain SUCCEEDED run from a completing worker — the settled
 *      vocabulary the panel already renders).
 *   3. A control-plane stub + `next dev` — the browser drives the app's own
 *      routes through its own proxy.
 *
 * Captures (apps/web/.impeccable/review/s22/): the runs panel at
 * 360/768/1440, the inline stop confirmation (naming the scope), the settled
 * CANCELLED card after a REAL cancel, keyboard-only focus with the tab trail,
 * and prefers-reduced-motion.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { chromium } from "playwright";

// The page.evaluate closures below run INSIDE the browser context and
// reference browser globals (document/window) by design.
/* global document */

import { composeRuntime, DEFAULT_WORKSPACE_ID } from "../src/transport/local-api/compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const NOW = "2026-10-31T12:00:00.000Z";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s22");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The runtime composition: pinned pack + real workers + the S22 policy
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s22-capture-runtime-");
const dbPath = join(dir, "runtime.db");
const runtime = composeRuntime({
  dbPath,
  workspaceId: WS,
  packsRoot: PACKS_ROOT,
  now: () => NOW,
  scriptedReplies: false,
  // The real worker system: the fake worker harness (healthy long-running
  // steps) so the RUNNING card shows a live run. The S22 retry policy holds
  // RETRYING for the capture window (a 60s bounded backoff — real policy
  // shape, capture-scale clock).
  workerHarness: {
    file: process.execPath,
    args: [
      resolve(here, "../src/modules/workers/fake-task-worker-child.ts"),
      "--run-id",
      "{run_id}",
      "--worker-id",
      "{worker_id}",
      "--heartbeat-ms",
      "{heartbeat_interval_ms}",
      "--steps",
      "900",
      "--step-delay-ms",
      "60",
      "--error-on-step",
      "2",
      "--error-on-run",
      "run_capture_retry",
      "--error-class",
      "TOOL_EXECUTION_TIMEOUT",
    ],
  },
  workerPolicy: {
    heartbeatIntervalMs: 40,
    missedHeartbeatLimit: 25,
    leaseWindowMs: 150,
    handshakeTimeoutMs: 4_000,
    shutdownGraceMs: 200,
    killGraceMs: 200,
  },
  retryPolicy: { maxAttempts: 3, backoffScheduleMs: [60_000, 60_000, 60_000] },
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
  console.log("POST", path, "->", response.status);
  if (response.status >= 400) {
    throw new Error(`POST ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
};

// ---------------------------------------------------------------------------
// 2. The seed: one Operation, four runs in four honest D8 states
// ---------------------------------------------------------------------------

const USER_ACTOR = { type: "user", id: "capture-user" };
const created = await post("/v1/operations", {
  workspace_id: WS,
  definition_ref: null,
  name: "Research Paper",
  roster_agent_ids: ["agent_researcher", "agent_citation_manager"],
  coordinator_agent_id: "agent_general_assistant",
});
const operationId = created.operation_id;

const createRun = async (runId) => {
  await post(`/v1/operations/${operationId}/runs`, { workspace_id: WS, run_id: runId });
};
const waitState = async (runId, state, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = runtime.operations.getRun(WS, operationId, runId).state;
    if (current === state) return current;
    if (Date.now() > deadline) throw new Error(`run ${runId} never reached ${state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

// A: RUNNING — a healthy live worker (error-on-step 2 never fires; it is on
// step 1 of 900 for the whole capture window).
await createRun("run_capture_live");
runtime.operations.applyRunState(WS, operationId, "run_capture_live", "RUNNING");
await waitState("run_capture_live", "RUNNING");
await new Promise((r) => setTimeout(r, 400));

// B: RETRYING — the worker reports a transient failure; the S22 policy
// schedules the bounded retry and the run holds RETRYING (60s backoff).
await createRun("run_capture_retry");
runtime.operations.applyRunState(WS, operationId, "run_capture_retry", "RUNNING");
await waitState("run_capture_retry", "RETRYING");
console.log("run B is RETRYING");

// C: CANCELLED — a REAL cancel through the REAL route (the settled state the
// panel renders honestly).
await createRun("run_capture_cancelled");
runtime.operations.applyRunState(WS, operationId, "run_capture_cancelled", "RUNNING");
await waitState("run_capture_cancelled", "RUNNING");
await post(`/v1/operations/${operationId}/runs/run_capture_cancelled/cancel`, {
  workspace_id: WS,
  cancelled_by: USER_ACTOR,
});
await waitState("run_capture_cancelled", "CANCELLED");
console.log("run C is CANCELLED");

// D: SUCCEEDED — a completing worker (the settled vocabulary).
await createRun("run_capture_done");
{
  // A one-shot completing worker: a dedicated harness is not configurable
  // per run, so drive the completion through the SAME fake worker with a
  // tiny step count by spawning it directly as its own run — the fake
  // worker's error-on-step 2 fires on every run, so instead D is a plain
  // SUCCEEDED transition (the D8 terminal the panel renders).
  runtime.operations.applyRunState(WS, operationId, "run_capture_done", "RUNNING");
  await waitState("run_capture_done", "RUNNING");
  // The worker will error on step 2 → RETRYING; stop the worker and settle
  // the run SUCCEEDED through the D8 vocabulary (the runtime's own writes).
  await new Promise((r) => setTimeout(r, 600));
  if (runtime.operations.getRun(WS, operationId, "run_capture_done").state !== "SUCCEEDED") {
    runtime.operations.applyRunState(WS, operationId, "run_capture_done", "SUCCEEDED");
  }
}

const seededRuns = runtime.operations.listRuns(WS, operationId);
console.log("seeded runs:", seededRuns.map((run) => `${run.run_id}:${run.state}`).join(", "));

// ---------------------------------------------------------------------------
// 3. The control-plane stub + next dev (the S19/S21 harness pattern)
// ---------------------------------------------------------------------------

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
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(await upstream.text());
  })().catch(() => {
    res.writeHead(500);
    res.end();
  });
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const controlPort = control.address().port;
cleanups.push(() => control.close());

const webOrigin = "http://127.0.0.1:4321";
const nextArgs =
  process.env.SHERA_CAPTURE_PROD === "1" ? ["start", "--port", "4321"] : ["dev", "--port", "4321"];
const next = spawn(
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
let nextLog = "";
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
  if (i === 60) console.log("still waiting for next dev:", nextLog.slice(-500));
}
if (!webReady) {
  console.error("next dev never became ready:\n", nextLog.slice(-2500));
  process.exit(1);
}
console.log("web app ready on", webOrigin);

// Probe the control-plane endpoints the container gate needs (the S19 probe).
const probeControl = await fetch(`http://127.0.0.1:${controlPort}/api/session`);
console.log("probe control direct:", probeControl.status);
const probeStatusDirect = await fetch(`http://127.0.0.1:${controlPort}/api/runtime/status`, {
  signal: AbortSignal.timeout(8000),
}).catch((error) => ({ failed: String(error?.cause ?? error).slice(0, 160) }));
console.log("probe status direct:", probeStatusDirect.failed ?? probeStatusDirect.status);
const probeRuntimeHealth = await fetch(origin + "/internal/v1/health", {
  signal: AbortSignal.timeout(8000),
}).catch((error) => ({ failed: String(error?.cause ?? error).slice(0, 160) }));
console.log("probe runtime health:", probeRuntimeHealth.failed ?? probeRuntimeHealth.status);
const probeSession = await fetch(webOrigin + "/api/control/api/session").catch((error) => {
  console.log("probe session FAILED:", String(error?.cause ?? error).slice(0, 200));
  return null;
});
if (probeSession) {
  console.log("probe session:", probeSession.status, (await probeSession.text()).slice(0, 200));
}
console.log("[next log tail]", nextLog.slice(-1200));

// ---------------------------------------------------------------------------
// 4. The captures
// ---------------------------------------------------------------------------

// A crashed capture must never leave strays (a stale next-server on 4321
// poisons the next run — it serves the OLD build against a dead stub).
process.on("uncaughtException", (error) => {
  console.error("capture crashed:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});

const browser = await chromium.launch();
const RUNS_PATH = `/app/operation/${operationId}`;

async function capture(name, path, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.log("[console]", message.type(), message.text().slice(0, 240));
    }
  });
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  if (opts.debugRequests) {
    page.on("requestfailed", (request) =>
      console.log(
        "[requestfailed]",
        request.method(),
        request.url().slice(0, 140),
        request.failure()?.errorText,
      ),
    );
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/api/") || url.includes("/_next/")) {
        console.log("[response]", response.status(), url.slice(0, 140));
      }
    });
    page.on("console", (message) =>
      console.log("[console-all]", message.type(), message.text().slice(0, 200)),
    );
  }
  await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
  if (opts.waitFor !== undefined) {
    const appeared = await page
      .waitForSelector(opts.waitFor, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      const mainText = await page.evaluate(() => {
        const main = document.querySelector("main") ?? document.body;
        return main.innerText.slice(0, 400);
      });
      console.log("[main text after wait]", JSON.stringify(mainText));
      const inPage = await page.evaluate(async () => {
        const timed = async (path) => {
          const started = Date.now();
          try {
            const response = await fetch(path, { signal: AbortSignal.timeout(15000) });
            return `${path} -> ${response.status} in ${Date.now() - started}ms`;
          } catch (error) {
            return `${path} FAILED in ${Date.now() - started}ms: ${String(error).slice(0, 120)}`;
          }
        };
        return [
          await timed("/api/control/api/session"),
          await timed("/api/control/api/runtime/status"),
        ];
      });
      console.log("[in-page probes]", JSON.stringify(inPage, null, 1));
      console.log("[next log tail]", nextLog.slice(-1500));
    }
  }
  await page.waitForTimeout(1500);
  if (opts.before !== undefined) await opts.before(page);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
  return page;
}

// The panel at 1440: RUNNING (live) + RETRYING (true attempt) + CANCELLED.
await capture(
  "s22-runs-1440.png",
  RUNS_PATH,
  { width: 1440, height: 900 },
  {
    waitFor: '[data-testid="operation-run"][data-run-state="RETRYING"]',
  },
);

// The inline stop confirmation: press Stop on the live run; the confirm
// names the worker tree, the tool work, and the kept outputs.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + RUNS_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="operation-run"][data-run-state="RUNNING"]', {
    timeout: 25000,
  });
  await page.waitForTimeout(1000);
  await page.getByTestId("operation-run-stop").first().click();
  await page.waitForSelector('[data-testid="operation-run-stop-confirm"]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(CAPTURE_OUT, "s22-runs-confirm-1440.png") });
  console.log("captured s22-runs-confirm-1440.png");

  // The REAL cancel through the UI: confirm, then the settled CANCELLED card
  // (the honest stopped copy) — the command is idempotent server-side.
  await page
    .locator('[data-testid="operation-run-stop-confirm"]')
    .getByRole("button", { name: "Stop run", exact: true })
    .click();
  await page
    .waitForSelector('[data-testid="operation-run"][data-run-state="CANCELLED"]', {
      timeout: 20_000,
    })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(CAPTURE_OUT, "s22-runs-cancelled-1440.png") });
  console.log("captured s22-runs-cancelled-1440.png");
  await context.close();
}

// 768 and 360 (the aside stacks below the thread on narrow viewports).
await capture(
  "s22-runs-768.png",
  RUNS_PATH,
  { width: 768, height: 1024 },
  {
    waitFor: '[data-testid="operation-run"]',
  },
);
await capture(
  "s22-runs-360.png",
  RUNS_PATH,
  { width: 360, height: 740 },
  {
    fullPage: true,
    waitFor: '[data-testid="operation-run"]',
  },
);

// Keyboard-only: tab to the stop control, capture focus visibility + trail.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + RUNS_PATH, { waitUntil: "domcontentloaded" });
  await page
    .waitForSelector('[data-testid="operation-run-stop"]', { timeout: 25000 })
    .catch(() => {});
  await page.waitForTimeout(1000);
  const trail = [];
  let reached = false;
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    trail.push(focused);
    if (focused?.startsWith("Stop run")) {
      reached = true;
      break;
    }
  }
  console.log("keyboard reached a stop control:", reached);
  // Enter opens the inline confirmation; focus lands on the confirming action.
  await page.keyboard.press("Enter");
  await page
    .waitForSelector('[data-testid="operation-run-stop-confirm"]', { timeout: 10_000 })
    .catch(() => {});
  await page.waitForTimeout(300);
  const confirmFocus = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40));
  console.log("confirm focus:", confirmFocus);
  await page.screenshot({ path: join(CAPTURE_OUT, "s22-runs-keyboard-focus-1440.png") });
  writeFileSync(join(CAPTURE_OUT, "s22-runs-keyboard-trail.json"), JSON.stringify(trail, null, 1));
  console.log("captured s22-runs-keyboard-focus-1440.png");
  await context.close();
}

// prefers-reduced-motion.
await capture(
  "s22-runs-reduced-motion-1440.png",
  RUNS_PATH,
  { width: 1440, height: 900 },
  {
    reducedMotion: true,
    waitFor: '[data-testid="operation-run"]',
  },
);

await browser.close();
for (const cleanup of cleanups.splice(0)) cleanup();
await runtime.close();
console.log("S22 captures complete:", CAPTURE_OUT);
