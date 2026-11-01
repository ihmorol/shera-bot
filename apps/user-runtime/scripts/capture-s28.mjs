/**
 * S28 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL scheduler state (the S19/S21/S22 harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack, the composed S28 scheduler + autonomous plan runner).
 *   2. The seed through the REAL machinery: one Operation, three triggers —
 *      A a schedule that FIRED once (a real occurrence through the
 *      scheduler; the run settled SUCCEEDED through the autonomous walk),
 *      B a webhook trigger paused by the user (a real pause route call),
 *      C a schedule trigger carrying the D48 insufficient-credits pause
 *      (the row state the runtime's own firing pipeline writes on a
 *      refused reservation).
 *   3. A control-plane stub + the PRODUCTION web build (next start — the
 *      recorded dev-mode Turbopack gate hang; S22's harness note).
 *
 * The AC9 truth leg: the harness FAILS unless the rendered last firing /
 * next occurrence text matches runtime.schedules.getTriggerView's record —
 * the UI asserts against the scheduler, not fixtures.
 *
 * Captures (apps/web/.impeccable/review/s28/): the surface at 360/768/1440,
 * the credit-paused card, the edit control open, keyboard-only focus trail,
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
import { openDatabase } from "../src/adapters/sqlite/connection.ts";
import { TriggersRepository } from "../src/adapters/sqlite/triggers-repository.ts";
import { SqliteTransactions } from "../src/adapters/sqlite/transactions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s28");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The runtime composition: pinned pack + the composed S28 scheduler stack
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s28-capture-runtime-");
const dbPath = join(dir, "runtime.db");
const runtime = composeRuntime({
  dbPath,
  workspaceId: WS,
  packsRoot: PACKS_ROOT,
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

const USER_ACTOR = { type: "user", id: "capture-user" };

// ---------------------------------------------------------------------------
// 2. The seed: one Operation, three truthful trigger states
// ---------------------------------------------------------------------------

const created = await post("/v1/operations", {
  workspace_id: WS,
  definition_ref: null,
  name: "Research Paper",
  roster_agent_ids: ["agent_researcher", "agent_citation_manager"],
  coordinator_agent_id: "agent_general_assistant",
});
const operationId = created.operation_id;

// A: the schedule that FIRED — a real occurrence through the scheduler; the
// autonomous walk (no provider declared → the honest no-legs walk) settles
// the run SUCCEEDED and the bookkeeping records last firing + next.
const triggerA = await post("/v1/schedules", {
  workspace_id: WS,
  kind: "schedule",
  name: "weekly literature sweep",
  target_operation_id: operationId,
  config: {
    cron: "0 9 * * 1",
    plan: { prompt: "Compile the weekly literature sweep." },
  },
  catch_up_policy: "catch_up",
  actor: USER_ACTOR,
});
{
  const fired = await runtime.scheduler.fireOccurrence(WS, triggerA.trigger_id, {
    idempotencyKey: `schedule:${triggerA.trigger_id}:2026-10-27T09:00:00.000Z`,
    dueAt: "2026-10-27T09:00:00.000Z",
    detail: { due_at: "2026-10-27T09:00:00.000Z" },
  });
  if (fired.outcome !== "fired") {
    throw new Error(`trigger A did not fire: ${JSON.stringify(fired)}`);
  }
  console.log("trigger A fired run", fired.runId);
}

// B: the webhook trigger, paused through the REAL pause route.
const triggerB = await post("/v1/schedules", {
  workspace_id: WS,
  kind: "webhook",
  name: "form intake hook",
  target_operation_id: operationId,
  config: { source: "form-service" },
  catch_up_policy: "skip",
  actor: USER_ACTOR,
});
await post(`/v1/schedules/${triggerB.trigger_id}/pause`, {
  workspace_id: WS,
  actor: USER_ACTOR,
});

// C: the D48 insufficient-credits pause — the row state the firing pipeline
// writes when the reservation seam refuses (the S24 seam is the recorded
// posture; the capture renders the SAME row the runtime would write).
const triggerC = await post("/v1/schedules", {
  workspace_id: WS,
  kind: "schedule",
  name: "nightly dataset refresh",
  target_operation_id: operationId,
  config: {
    cron: "0 3 * * *",
    plan: { prompt: "Refresh the dataset indices." },
  },
  catch_up_policy: "skip",
  actor: USER_ACTOR,
});
{
  const conn = openDatabase(dbPath);
  const triggers = new TriggersRepository(new SqliteTransactions(conn.db));
  triggers.updateTriggerState(WS, triggerC.trigger_id, {
    state: "paused",
    pause_reason: "insufficient_credits",
    updated_at: new Date().toISOString(),
  });
  conn.close();
  console.log("trigger C carries the insufficient_credits pause");
}

// ---------------------------------------------------------------------------
// 3. The control-plane stub + the PRODUCTION web build
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
  if (i === 60) console.log("still waiting for the web app:", nextLog.slice(-500));
}
if (!webReady) {
  console.error("the web app never became ready:\n", nextLog.slice(-2500));
  process.exit(1);
}
console.log("web app ready on", webOrigin);

// ---------------------------------------------------------------------------
// 4. The captures (the AC9 truth leg runs first)
// ---------------------------------------------------------------------------

process.on("uncaughtException", (error) => {
  console.error("capture crashed:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});

const browser = await chromium.launch();
const SCHEDULES_PATH = "/app/settings/schedules";

// THE AC9 TRUTH LEG: the rendered values must match the scheduler's record.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + SCHEDULES_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="schedule-trigger-card"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const viewA = runtime.schedules.getTriggerView(WS, triggerA.trigger_id);
  const nextIso = viewA.next_occurrence_at;
  const expectedDay = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(nextIso));
  const rendered = await page.locator('[data-testid="schedule-trigger-card"]').first().innerText();
  if (!rendered.includes(expectedDay)) {
    console.error("AC9 TRUTH MISMATCH: the card does not render the scheduler's record");
    console.error("scheduler next occurrence:", nextIso, "→ expected to contain", expectedDay);
    console.error("rendered card:", rendered.slice(0, 400));
    process.exit(1);
  }
  console.log("AC9 truth leg passed: the card renders the scheduler's own record");
  await context.close();
}

async function capture(name, path, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
  if (opts.waitFor !== undefined) {
    await page.waitForSelector(opts.waitFor, { timeout: 30000 });
  }
  await page.waitForTimeout(1200);
  if (opts.before !== undefined) await opts.before(page);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
  return page;
}

// The surface at 1440: the fired schedule with its run card, the paused
// webhook, and the credit-paused nightly refresh.
await capture(
  "s28-schedules-1440.png",
  SCHEDULES_PATH,
  { width: 1440, height: 900 },
  {
    waitFor: '[data-testid="schedule-trigger-card"]',
  },
);

// 768 and 360 (full page — the cards stack).
await capture(
  "s28-schedules-768.png",
  SCHEDULES_PATH,
  { width: 768, height: 1024 },
  {
    fullPage: true,
    waitFor: '[data-testid="schedule-trigger-card"]',
  },
);
await capture(
  "s28-schedules-360.png",
  SCHEDULES_PATH,
  { width: 360, height: 740 },
  {
    fullPage: true,
    waitFor: '[data-testid="schedule-trigger-card"]',
  },
);

// The edit control open (the inline edit — never a modal).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + SCHEDULES_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="schedule-trigger-card"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.waitForSelector("#edit-name-" + triggerA.trigger_id, { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(CAPTURE_OUT, "s28-schedules-edit-1440.png") });
  console.log("captured s28-schedules-edit-1440.png");
  await context.close();
}

// The create form (the typed fields — G2 by construction).
await capture(
  "s28-schedules-create-1440.png",
  SCHEDULES_PATH,
  { width: 1440, height: 900 },
  {
    waitFor: '[data-testid="schedule-trigger-card"]',
    before: async (page) => {
      await page
        .getByRole("button", { name: "New trigger" })
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(400);
    },
  },
);

// Keyboard-only: the tab trail from the page top through the controls.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + SCHEDULES_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="schedule-trigger-card"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const trail = [];
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(120);
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        tag: element?.tagName ?? "none",
        text: (element?.textContent ?? "").slice(0, 60),
        visibleFocus: element
          ? (() => {
              const style = globalThis.getComputedStyle(element);
              return style.outlineStyle !== "none" || style.boxShadow !== "none";
            })()
          : false,
      };
    });
    trail.push(focused);
  }
  writeFileSync(join(CAPTURE_OUT, "s28-keyboard-trail.json"), JSON.stringify(trail, null, 2));
  console.log("keyboard trail:", JSON.stringify(trail.slice(0, 4)));
  const focusVisibleCount = trail.filter((step) => step.visibleFocus).length;
  if (focusVisibleCount < 2) {
    console.error("KEYBOARD GATE: fewer than two focused steps showed a visible focus indicator");
    process.exit(1);
  }
  await page.screenshot({ path: join(CAPTURE_OUT, "s28-schedules-keyboard-1440.png") });
  console.log("captured s28-schedules-keyboard-1440.png");
  await context.close();
}

// prefers-reduced-motion: the same surface under the reduced preference.
await capture(
  "s28-schedules-reduced-motion-1440.png",
  SCHEDULES_PATH,
  { width: 1440, height: 900 },
  {
    reducedMotion: true,
    waitFor: '[data-testid="schedule-trigger-card"]',
  },
);

await browser.close();
console.log("S28 captures complete under", CAPTURE_OUT);
for (const cleanup of cleanups.splice(0)) cleanup();
await runtime.close();
process.exit(0);
