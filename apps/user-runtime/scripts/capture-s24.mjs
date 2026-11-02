/**
 * S24 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL ledger state (the S19/S21/S22/S28 harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack, the composed S24 credit ledger).
 *   2. The seed through the REAL machinery — every ledger row is written by
 *      the runtime's own service, never a fixture INSERT: the admin grant
 *      (the S32 top-up seam's ledger leg), run A's reserve → settle (30 of
 *      50, the unused 20 released back), run B's still-active reservation
 *      (the account's 25 reserved), and a custom-provider usage record
 *      (D20: measured locally, zero credit movement).
 *   3. A control-plane stub + the PRODUCTION web build (next start via
 *      SHERA_CAPTURE_PROD=1 — the recorded dev-mode Turbopack gate hang;
 *      S22's harness note).
 *
 * The AC8 truth leg: the harness FAILS unless the rendered remaining /
 * reserved / used-this-month and the per-run drill-down numbers match
 * runtime.credits's own record — the UI asserts against the ledger, not
 * fixtures. The exhausted pass re-checks the truth after the ledger is
 * genuinely driven to exhaustion (reserve 145, settle 145 → available 0)
 * and a trigger carries the D48 insufficient_credits pause.
 *
 * Captures (apps/web/.impeccable/review/s24/): the surface at 360/768/1440,
 * the pill's reserved reveal on hover, the keyboard-only trail (with the
 * focus-within reveal parity check), prefers-reduced-motion, and the
 * exhausted-credit pause card. Screenshots are evidence; the JSON files are
 * the machine-readable truth this gate is judged on.
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
const CREDITS_PATH = "/app/settings/credits";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s24");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The runtime composition: pinned pack + the composed S24 credit ledger
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s24-capture-runtime-");
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

// ---------------------------------------------------------------------------
// 2. The seed: real ledger rows only — the service writes every movement
// ---------------------------------------------------------------------------

const credits = runtime.credits;

// The admin grant (the S32 top-up seam's ledger leg; D47/D20).
const grant = credits.grant({ workspace_id: WS, amount_units: 200, related_id: "topup_capture_seed" });
console.log("granted 200 via", grant.transaction_id);

// Run A: reserve 50, settle 30 — the unused 20 releases back (D20).
const runA = "run_3f8a2c_litreview";
const reservedA = credits.reserveForRun({
  workspace_id: WS,
  task_id: runA,
  estimate_units: 50,
  estimate_basis: "heuristic_capture",
  provider_id: "prov_platform",
  model: "platform-model",
});
if (!reservedA.ok) throw new Error(`run A reservation refused: ${JSON.stringify(reservedA)}`);
const settledA = credits.settleReservation({
  workspace_id: WS,
  reservation_id: reservedA.reservation_id,
  actual_units: 30,
});
if (!settledA.ok) throw new Error(`run A settlement refused: ${JSON.stringify(settledA)}`);
credits.recordUsage({
  workspace_id: WS,
  usage_id: "usage_cap_a",
  task_id: runA,
  provider_id: "prov_platform",
  model: "platform-model",
  provider_origin: "platform",
  input_tokens: 5000,
  output_tokens: 2000,
  latency_ms: 410,
  charged_units: 30,
});
console.log("run A settled: charged 30, released", settledA.released_units);

// Run B: reserve 25 and leave it ACTIVE — the account's honest reserved 25.
const runB = "run_7b91ad_summary";
const reservedB = credits.reserveForRun({
  workspace_id: WS,
  task_id: runB,
  estimate_units: 25,
  estimate_basis: "heuristic_capture",
  provider_id: "prov_platform",
  model: "platform-model",
});
if (!reservedB.ok) throw new Error(`run B reservation refused: ${JSON.stringify(reservedB)}`);
console.log("run B holds an active reservation of 25");

// The custom-provider usage (D20): measured locally, ZERO credit movement.
credits.recordUsage({
  workspace_id: WS,
  usage_id: "usage_cap_custom",
  task_id: "run_c4d21e_digest",
  provider_id: "prov_ollama_local",
  model: "llama3-local",
  provider_origin: "user",
  input_tokens: 12400,
  output_tokens: 3180,
  latency_ms: 650,
  charged_units: 0,
});
console.log("custom-provider usage recorded with zero credit movement");

// One Operation + one schedule trigger for the D48 pause count line.
const created = await post("/v1/operations", {
  workspace_id: WS,
  definition_ref: null,
  name: "Research Paper",
  roster_agent_ids: ["agent_researcher", "agent_citation_manager"],
  coordinator_agent_id: "agent_general_assistant",
});
const operationId = created.operation_id;
const USER_ACTOR = { type: "user", id: "capture-user" };
const trigger = await post("/v1/schedules", {
  workspace_id: WS,
  kind: "schedule",
  name: "nightly dataset refresh",
  target_operation_id: operationId,
  config: { cron: "0 3 * * *", plan: { prompt: "Refresh the dataset indices." } },
  catch_up_policy: "skip",
  actor: USER_ACTOR,
});

const truth = {
  funded_account: credits.accountState(WS),
  run_a_cost: credits.runCost(WS, runA),
  run_b_cost: credits.runCost(WS, runB),
};
writeFileSync(join(CAPTURE_OUT, "s24-ledger-truth.json"), JSON.stringify(truth, null, 2));
console.log(
  "ledger truth: remaining",
  truth.funded_account.available_units,
  "reserved",
  truth.funded_account.reserved_units,
  "used",
  truth.funded_account.used_this_month_units,
);

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

process.on("uncaughtException", (error) => {
  console.error("capture crashed:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});
// Top-level awaits reject as unhandled rejections, not uncaught exceptions —
// the cleanup must run for those too, or the `next start` child outlives the
// gate and the next run hits EADDRINUSE.
process.on("unhandledRejection", (error) => {
  console.error("capture rejected:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});

const browser = await chromium.launch();

async function openCredits(viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + CREDITS_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="credits-remaining"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  return { context, page };
}

// ---------------------------------------------------------------------------
// 4. The AC8 truth leg (funded): the rendered numbers ARE the ledger's record
// ---------------------------------------------------------------------------

const fmt = (n) => n.toLocaleString("en-GB");
{
  const { context, page } = await openCredits({ width: 1440, height: 900 });
  const state = truth.funded_account;
  const rendered = await page.evaluate(() => {
    const pick = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return element?.textContent ?? null;
    };
    return {
      remaining: pick("credits-remaining"),
      reserved: pick("credits-reserved"),
      usedThisMonth: pick("credits-used-this-month"),
      runRows: [...document.querySelectorAll('[data-testid="credits-run-row"]')].map((row) =>
        row.textContent ?? "",
      ),
      pill: document.querySelector('[data-testid="credits-pill"]')?.textContent ?? null,
    };
  });
  const mismatches = [];
  if (rendered.remaining !== fmt(state.available_units)) {
    mismatches.push(`remaining ${rendered.remaining} != ledger ${fmt(state.available_units)}`);
  }
  if (rendered.reserved !== fmt(state.reserved_units)) {
    mismatches.push(`reserved ${rendered.reserved} != ledger ${fmt(state.reserved_units)}`);
  }
  if (rendered.usedThisMonth !== fmt(state.used_this_month_units)) {
    mismatches.push(
      `used-this-month ${rendered.usedThisMonth} != ledger ${fmt(state.used_this_month_units)}`,
    );
  }
  if (!rendered.runRows.some((row) => row.includes(runA))) mismatches.push(`run row ${runA} missing`);
  if (!rendered.runRows.some((row) => row.includes(runB))) mismatches.push(`run row ${runB} missing`);
  const runACost = truth.run_a_cost;
  // The drill-down renders only a run the user actually selects (no
  // fabricated default — G4): select run A through the real control.
  await page.locator('[data-testid="credits-run-row"]', { hasText: runA }).click();
  await page.waitForSelector('[data-testid="credits-run-detail"]', { timeout: 15000 });
  const detailText = await page.locator('[data-testid="credits-run-detail"]').innerText();
  if (detailText === null) {
    mismatches.push("the run detail did not render");
  } else {
    if (!detailText.includes(`${fmt(runACost.charged_units)} charged`)) {
      mismatches.push(`detail charged != ledger ${fmt(runACost.charged_units)}`);
    }
    if (!detailText.includes(`${fmt(runACost.released_units)} released`)) {
      mismatches.push(`detail released != ledger ${fmt(runACost.released_units)}`);
    }
    if (!detailText.includes("5,000 in / 2,000 out")) mismatches.push("usage row tokens missing");
    if (!detailText.includes("410 ms")) mismatches.push("usage row latency missing");
    if (!detailText.includes("the estimate exceeded the actual usage")) {
      mismatches.push("release reason missing");
    }
  }
  if (rendered.pill === null || !rendered.pill.includes(fmt(state.available_units))) {
    mismatches.push(`the pill does not render the ledger's remaining (${rendered.pill})`);
  }
  writeFileSync(join(CAPTURE_OUT, "s24-truth-leg.json"), JSON.stringify({ rendered, mismatches }, null, 2));
  if (mismatches.length > 0) {
    console.error("AC8 TRUTH MISMATCH: the UI does not render the ledger's own record");
    for (const m of mismatches) console.error("  -", m);
    process.exit(1);
  }
  console.log("AC8 truth leg passed: remaining/reserved/used-this-month, run rows, drill-down, and pill all render the ledger's own record");
  await context.close();
}

// ---------------------------------------------------------------------------
// 5. The funded captures: 1440 / 768 / 360
// ---------------------------------------------------------------------------

async function capture(name, viewport, opts = {}) {
  const { context, page } = await openCredits(viewport, opts);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
}

await capture("s24-credits-1440.png", { width: 1440, height: 900 });
await capture("s24-credits-768.png", { width: 768, height: 1024 }, { fullPage: true });
await capture("s24-credits-360.png", { width: 360, height: 740 }, { fullPage: true });
await capture("s24-credits-reduced-motion-1440.png", { width: 1440, height: 900 }, { reducedMotion: true });

// ---------------------------------------------------------------------------
// 6. The pill's reserved reveal: hover AND keyboard focus (§2.1 parity)
// ---------------------------------------------------------------------------

{
  const { context, page } = await openCredits({ width: 1440, height: 900 });
  const reveal = page
    .locator('[data-testid="credits-pill"]')
    .locator("span", { hasText: "reserved for running tasks" })
    .first();
  const displayOf = async () =>
    reveal.evaluate((element) => globalThis.getComputedStyle(element).display);
  const before = await displayOf();
  await page.locator('[data-testid="credits-pill"]').hover();
  await page.waitForTimeout(300);
  const after = await displayOf();
  await page.screenshot({ path: join(CAPTURE_OUT, "s24-pill-hover-1440.png") });
  writeFileSync(
    join(CAPTURE_OUT, "s24-pill-hover.json"),
    JSON.stringify({ revealDisplayBefore: before, revealDisplayAfterHover: after }, null, 2),
  );
  if (before !== "none" || after !== "block") {
    console.error(`PILL HOVER GATE: reveal display before=${before} after=${after} (expected none -> block)`);
    process.exit(1);
  }
  console.log("pill hover reveal: none -> block on hover");
  await context.close();
}

// Keyboard-only: the tab trail from the page top; the pill's reveal must be
// visible on FOCUS too (group-focus-within mirrors the hover path).
{
  const { context, page } = await openCredits({ width: 1440, height: 900 });
  const reveal = page
    .locator('[data-testid="credits-pill"]')
    .locator("span", { hasText: "reserved for running tasks" })
    .first();
  const trail = [];
  let pillIndex = -1;
  let revealOnFocus = null;
  for (let step = 0; step < 60 && pillIndex === -1; step += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(90);
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? globalThis.getComputedStyle(element) : null;
      return {
        tag: element?.tagName ?? "none",
        testId: element?.getAttribute("data-testid") ?? null,
        text: (element?.textContent ?? "").slice(0, 60),
        visibleFocus: element ? style?.outlineStyle !== "none" || (style?.boxShadow ?? "") !== "none" : false,
      };
    });
    trail.push(focused);
    if (focused.testId === "credits-pill") {
      pillIndex = step;
      await page.waitForTimeout(200);
      revealOnFocus = await reveal.evaluate((element) => globalThis.getComputedStyle(element).display);
    }
  }
  const visibleFocusCount = trail.filter((step) => step.visibleFocus).length;
  writeFileSync(
    join(CAPTURE_OUT, "s24-keyboard-trail.json"),
    JSON.stringify({ steps: trail.length, pillFocusedAtStep: pillIndex, revealOnFocus, visibleFocusCount, trail: trail.slice(0, 12) }, null, 2),
  );
  await page.screenshot({ path: join(CAPTURE_OUT, "s24-credits-keyboard-1440.png") });
  if (pillIndex === -1) {
    console.error("KEYBOARD GATE: the credits pill is never reached by Tab from the page top");
    process.exit(1);
  }
  if (revealOnFocus !== "block") {
    console.error(`KEYBOARD GATE: the reserved reveal is not visible on focus (display=${revealOnFocus})`);
    process.exit(1);
  }
  if (visibleFocusCount < 2) {
    console.error("KEYBOARD GATE: fewer than two focused steps showed a visible focus indicator");
    process.exit(1);
  }
  console.log(`keyboard trail: pill focused at step ${pillIndex}, reveal visible on focus, ${visibleFocusCount} visibly-focused steps`);
  await context.close();
}

// ---------------------------------------------------------------------------
// 7. The exhausted pass: drive the ledger to a REAL zero through the service
// ---------------------------------------------------------------------------

// Run D: reserve the remaining 145 and settle the full 145 — available hits 0.
const runD = "run_d8e02f_benchmark";
const stateBefore = credits.accountState(WS);
const reservedD = credits.reserveForRun({
  workspace_id: WS,
  task_id: runD,
  estimate_units: stateBefore.available_units,
  estimate_basis: "heuristic_capture",
  provider_id: "prov_platform",
  model: "platform-model",
});
if (!reservedD.ok) throw new Error(`run D reservation refused: ${JSON.stringify(reservedD)}`);
const settledD = credits.settleReservation({
  workspace_id: WS,
  reservation_id: reservedD.reservation_id,
  actual_units: stateBefore.available_units,
});
if (!settledD.ok) throw new Error(`run D settlement refused: ${JSON.stringify(settledD)}`);
// The D48 trigger pause: the row state the runtime's own firing pipeline
// writes on a refused reservation (the same row the S24 seam writes).
{
  const conn = openDatabase(dbPath);
  const triggers = new TriggersRepository(new SqliteTransactions(conn.db));
  triggers.updateTriggerState(WS, trigger.trigger_id, {
    state: "paused",
    pause_reason: "insufficient_credits",
    updated_at: new Date().toISOString(),
  });
  conn.close();
}
const exhaustedState = credits.accountState(WS);
console.log(
  "exhausted: remaining",
  exhaustedState.available_units,
  "reserved",
  exhaustedState.reserved_units,
);

{
  const { context, page } = await openCredits({ width: 1440, height: 900 });
  await page.waitForSelector('[data-testid="credits-exhausted-card"]', { timeout: 15000 });
  const rendered = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="credits-exhausted-card"]');
    const pick = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    return {
      cardText: card?.textContent ?? null,
      remaining: pick("credits-remaining"),
      pill: document.querySelector('[data-testid="credits-pill"]')?.textContent ?? null,
    };
  });
  const mismatches = [];
  if (exhaustedState.available_units !== 0) mismatches.push("the ledger did not actually reach zero");
  if (rendered.remaining !== "0") mismatches.push(`remaining ${rendered.remaining} != 0`);
  if (rendered.cardText === null || !rendered.cardText.includes("Out of Shera credits")) {
    mismatches.push("the pause card's lead line is missing");
  }
  if (rendered.cardText === null || !rendered.cardText.includes("tops the account up")) {
    mismatches.push("the unblocking path (admin top-up) is missing");
  }
  if (rendered.cardText === null || !rendered.cardText.includes("cancel them from their Operation chat")) {
    mismatches.push("the cancellation path is missing");
  }
  if (rendered.cardText === null || !rendered.cardText.includes("1 scheduled trigger is paused for credits right now.")) {
    mismatches.push("the D48 trigger pause count line is missing");
  }
  if (rendered.pill === null || !rendered.pill.includes("No Shera credits remaining")) {
    mismatches.push("the exhausted pill's unblocking copy is missing");
  }
  await page.screenshot({ path: join(CAPTURE_OUT, "s24-credits-exhausted-1440.png") });
  writeFileSync(join(CAPTURE_OUT, "s24-exhausted-truth.json"), JSON.stringify({ rendered, mismatches }, null, 2));
  if (mismatches.length > 0) {
    console.error("EXHAUSTED TRUTH MISMATCH:");
    for (const m of mismatches) console.error("  -", m);
    process.exit(1);
  }
  console.log("exhausted truth leg passed: the pause card, its unblocking paths, the trigger count, and the amber pill all render the real zero");
  await context.close();
}

// The exhausted surface at 360 (the card leads on the smallest viewport too).
await capture("s24-credits-exhausted-360.png", { width: 360, height: 740 }, { fullPage: true });

await browser.close();
console.log("S24 captures complete under", CAPTURE_OUT);
for (const cleanup of cleanups.splice(0)) cleanup();
await runtime.close();
process.exit(0);
