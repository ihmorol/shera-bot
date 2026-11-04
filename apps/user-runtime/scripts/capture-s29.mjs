/**
 * S29 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL memory state (the S24/S28 harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack, the composed S29 memory service).
 *   2. The seed through the REAL machinery — every memory row is written by
 *      the runtime's own service (proposeCandidate / applyCommand), never a
 *      fixture INSERT: an automatic workspace memory, an Agent-private
 *      memory, a SENSITIVE automatic candidate (which lands PENDING in the
 *      publication queue), a user-added memory, an edit (a second version),
 *      and one REJECTED secret-shaped edit attempt (the rejection is proven
 *      interactively through the page itself).
 *   3. A control-plane stub + the PRODUCTION web build (next start via
 *      SHERA_CAPTURE_PROD=1 — the recorded dev-mode Turbopack hang; S22's
 *      harness note).
 *
 * The truth legs: the harness FAILS unless the rendered per-scope breakdown,
 * publication queue, provenance lines, and toggles all match
 * runtime.memory's own record (the GET /v1/memory read taken by the harness
 * itself); the interactive legs FAIL unless the publication approval really
 * publishes (the runtime's context read flips), the version restore really
 * returns the previous content, and the secret-shaped edit really shows the
 * typed rejection — the UI shows the refusal honestly, never an input that
 * pretends to work (AC2's display leg).
 *
 * Captures (apps/web/.impeccable/review/s29/): the surface at 360/768/1440,
 * reduced motion, the keyboard-only trail, the queue-approval moment, the
 * rejection banner, and the restored card. Screenshots are for the owner's
 * eyes; the JSON files are the machine-readable truth this gate is judged on.
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
const MEMORY_PATH = "/app/settings/memory";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s29");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The runtime composition: pinned pack + the composed S29 memory service
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s29-capture-runtime-");
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

// ---------------------------------------------------------------------------
// 2. The seed: real memory rows only — the runtime's own service writes them
// ---------------------------------------------------------------------------

const memory = runtime.memory;

// One Operation the Agents participate in (the roster drives the D37
// operation-scope visibility and the publication targets).
const created = await fetch(origin + "/v1/operations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    workspace_id: WS,
    definition_ref: null,
    name: "Research Paper",
    roster_agent_ids: ["agent_researcher", "agent_citation_manager"],
    coordinator_agent_id: "agent_general_assistant",
  }),
}).then((r) => r.json());
const operationId = created.operation_id;
console.log("operation", operationId);

// The automatic workspace memory (origin automatic, provenance carried).
const learned = await memory.proposeCandidate({
  workspace_id: WS,
  proposed_by_agent_id: "agent_researcher",
  scope: "workspace",
  summary: "The user prefers concise summaries",
  content: "Learned from corrections: summaries stay under two hundred words.",
  source_refs: [`conversation://${operationId}/messages`],
  confidence: 0.85,
  sensitivity: "normal",
});
console.log("learned workspace memory", learned.entry.memory_id);

// The Agent-private memory (invisible to the other Agents until published).
const priv = await memory.proposeCandidate({
  workspace_id: WS,
  proposed_by_agent_id: "agent_researcher",
  scope: "agent_private",
  operation_id: operationId,
  summary: "Failed extraction heuristic for corpus 3",
  content:
    "The regex-based extraction heuristic loses table rows when the PDF uses spanned cells; use the layout parser instead.",
  source_refs: [`conversation://${operationId}/messages`],
  confidence: 0.8,
  sensitivity: "normal",
});
console.log("learned private memory", priv.entry.memory_id);

// The SENSITIVE automatic candidate — it lands PENDING in the queue (the
// user's approval gate before any Agent sees it).
const sensitive = await memory.proposeCandidate({
  workspace_id: WS,
  proposed_by_agent_id: "agent_researcher",
  scope: "operation",
  operation_id: operationId,
  summary: "Participant health context",
  content: "The cohort includes participant health records; citations need care.",
  source_refs: [`conversation://${operationId}/messages`],
  confidence: 0.8,
  sensitivity: "sensitive",
});
console.log("learned sensitive memory", sensitive.entry.memory_id);

// The user-added memory + one edit (a second version for the restore leg).
const userActor = { type: "user", id: "capture-user" };
const command = async (body) => {
  const response = await fetch(origin + "/v1/memory/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: WS,
      actor: userActor,
      issued_at: new Date().toISOString(),
      ...body,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    return { status: response.status, payload };
  }
  return { status: response.status, payload };
};
const userMemory = await command({
  command_id: "cmd_capture_user_memory",
  idempotency_key: "idem_capture_user_memory",
  type: "memory.create",
  scope: "workspace",
  owner_agent_id: null,
  operation_id: null,
  task_id: null,
  summary: "Sweep methodology",
  content: "Version one: search the corpus with the broad query first.",
  sensitivity: "normal",
  source_refs: ["conversation://direct/capture-user"],
  confidence: 0.7,
  expires_at: null,
});
if (userMemory.status !== 200)
  throw new Error(`user memory create failed: ${JSON.stringify(userMemory)}`);
const userMemoryId = userMemory.payload.entry.memory_id;
const edited = await command({
  command_id: "cmd_capture_user_edit",
  idempotency_key: "idem_capture_user_edit",
  type: "memory.edit",
  memory_id: userMemoryId,
  summary: "Sweep methodology",
  content: "Version two: narrow queries per section, then merge.",
  sensitivity: "normal",
  source_refs: ["conversation://direct/capture-user"],
  confidence: 0.7,
  expires_at: null,
});
if (edited.status !== 200) throw new Error(`user memory edit failed: ${JSON.stringify(edited)}`);
console.log("user memory", userMemoryId, "edited to v2");

// The runtime's OWN record at capture time (the truth legs compare against
// THIS read, never against a local expectation).
const truthView = memory.userView(WS);
writeFileSync(join(CAPTURE_OUT, "s29-memory-truth.json"), JSON.stringify(truthView, null, 2));
const expected = {
  // The per-scope counts come from the runtime's own record — no hardcoded
  // expectation (the truth leg compares rendered against THIS).
  scopeCounts: Object.fromEntries(
    Object.entries(truthView.scopes).map(([scope, rows]) => [scope, rows.length]),
  ),
  queueCount: truthView.publication_queue.length,
  userMemoryId,
  sensitiveId: sensitive.entry.memory_id,
  privateId: priv.entry.memory_id,
  learnedId: learned.entry.memory_id,
};
console.log(
  "memory truth:",
  JSON.stringify(expected.scopeCounts),
  ",",
  expected.queueCount,
  "pending publications",
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
          checked_at: "2026-11-04T12:00:00.000Z",
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
process.on("unhandledRejection", (error) => {
  console.error("capture rejected:", String(error).slice(0, 400));
  console.error("[next log tail]", nextLog.slice(-1200));
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exit(1);
});

const browser = await chromium.launch();

async function openMemory(viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + MEMORY_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="memory-scope-group"]', { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { context, page };
}

// ---------------------------------------------------------------------------
// 4. The truth leg: the rendered surface IS the runtime's own record
// ---------------------------------------------------------------------------

{
  const { context, page } = await openMemory({ width: 1440, height: 900 });
  const rendered = await page.evaluate(() => {
    const pick = (testId) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    return {
      scopeGroups: [...document.querySelectorAll('[data-testid="memory-scope-group"]')].map(
        (group) => ({
          scope: group.getAttribute("data-scope"),
          label: group.querySelector("h2")?.textContent ?? null,
          count: group.querySelector("span.font-mono")?.textContent ?? null,
        }),
      ),
      entryCards: [...document.querySelectorAll('[data-testid="memory-entry-card"]')].map((card) =>
        card.getAttribute("data-memory-id"),
      ),
      provenanceLines: [...document.querySelectorAll('[data-testid="memory-provenance"]')].map(
        (line) => line.textContent ?? "",
      ),
      queue: pick("memory-publication-queue"),
      globalToggle: pick("memory-auto-global-toggle"),
    };
  });

  const mismatches = [];
  if (rendered.scopeGroups.length !== 5) {
    mismatches.push(`expected 5 scope groups, rendered ${rendered.scopeGroups.length}`);
  }
  for (const group of rendered.scopeGroups) {
    const truthCount = expected.scopeCounts[group.scope] ?? 0;
    const renderedCount = Number.parseInt((group.count ?? "0").trim(), 10);
    if (renderedCount !== truthCount) {
      mismatches.push(`scope ${group.scope}: rendered ${renderedCount} != runtime ${truthCount}`);
    }
  }
  for (const id of [expected.learnedId, expected.privateId, expected.userMemoryId]) {
    if (id && !rendered.entryCards.includes(id)) {
      mismatches.push(`entry card ${id} missing`);
    }
  }
  if (!rendered.provenanceLines.some((line) => line.includes("Remembered from"))) {
    mismatches.push("no 'Remembered from' provenance line rendered");
  }
  if (!rendered.provenanceLines.some((line) => line.includes("85% confidence"))) {
    mismatches.push("the confidence figure did not render from the record");
  }
  if (rendered.queue === null || !rendered.queue.includes("Publication queue")) {
    mismatches.push("the publication queue section is missing");
  }
  if (!rendered.queue.includes("Participant health context")) {
    mismatches.push("the pending sensitive publication is not in the queue");
  }
  if (rendered.globalToggle === null || !rendered.globalToggle.includes("Enabled")) {
    mismatches.push("the global auto-memory toggle does not render the runtime's state");
  }
  writeFileSync(
    join(CAPTURE_OUT, "s29-truth-leg.json"),
    JSON.stringify(
      {
        rendered: { scopeGroups: rendered.scopeGroups, queueCount: rendered.queue?.length },
        mismatches,
      },
      null,
      2,
    ),
  );
  if (mismatches.length > 0) {
    console.error("TRUTH MISMATCH: the UI does not render the runtime's own memory record");
    for (const m of mismatches) console.error("  -", m);
    process.exit(1);
  }
  console.log(
    "truth leg passed: scope groups, entry cards, provenance, queue, and toggles render the runtime's record",
  );
  await page.screenshot({ path: join(CAPTURE_OUT, "s29-memory-1440.png") });
  await context.close();
}

// ---------------------------------------------------------------------------
// 5. The interactive legs: approve publishes, restore returns, rejection shows
// ---------------------------------------------------------------------------

// (a) The queue's Approve REALLY publishes: after the click, the sensitive
// entry is visible in the participating Agent's operation context (the
// runtime's own read flips).
{
  const { context, page } = await openMemory({ width: 1440, height: 900 });
  const commandResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/memory/commands")) {
      commandResponses.push({ status: response.status(), url: response.url() });
    }
  });
  await page.locator('[data-testid="memory-approve-publication"]').first().click();
  await page.waitForTimeout(2000);
  console.log("memory command responses:", JSON.stringify(commandResponses));
  const contextAfter = await fetch(
    origin +
      `/v1/agents/agent_researcher/memory/context?workspace_id=${WS}&operation_id=${operationId}`,
  ).then((r) => r.json());
  const visible = contextAfter.entries.some((entry) => entry.memory_id === expected.sensitiveId);
  writeFileSync(
    join(CAPTURE_OUT, "s29-approval-leg.json"),
    JSON.stringify(
      { approvedMemoryId: expected.sensitiveId, visibleInOperationContext: visible },
      null,
      2,
    ),
  );
  if (!visible) {
    console.error(
      "APPROVAL LEG: the approval did not publish the entry into the operation context",
    );
    process.exit(1);
  }
  console.log("approval leg passed: the approved entry is visible in the operation context");
  await page.screenshot({ path: join(CAPTURE_OUT, "s29-approval-1440.png") });
  await context.close();
}

// (b) The restore REALLY returns the previous content (AC4's display leg).
{
  const { context, page } = await openMemory({ width: 1440, height: 900 });
  const card = page.locator(`[data-memory-id="${userMemoryId}"]`);
  await card.locator('[data-testid="memory-restore-button"]').first().click();
  await page.waitForTimeout(1500);
  const viewAfter = memory.userView(WS);
  const restored = viewAfter.scopes.workspace.find((entry) => entry.memory_id === userMemoryId);
  const contentRestored =
    restored?.content === "Version one: search the corpus with the broad query first.";
  const historyKept =
    restored?.versions.map((version) => version.change_kind).join(",") ===
    "created,edited,restored";
  writeFileSync(
    join(CAPTURE_OUT, "s29-restore-leg.json"),
    JSON.stringify(
      {
        contentRestored,
        historyKept,
        changeKinds: restored?.versions.map((version) => version.change_kind) ?? [],
      },
      null,
      2,
    ),
  );
  if (!contentRestored || !historyKept) {
    console.error("RESTORE LEG: the restore did not return v1 or the history was not preserved");
    process.exit(1);
  }
  console.log(
    "restore leg passed: v1 content returned, history preserved (created, edited, restored)",
  );
  await page.screenshot({ path: join(CAPTURE_OUT, "s29-restore-1440.png") });
  await context.close();
}

// (c) The secret-shaped edit shows the typed rejection honestly (AC2's
// display leg): type a credential into the edit form, save, and the banner
// names the refusal — nothing is stored (the runtime read still holds the
// pre-edit content).
{
  const { context, page } = await openMemory({ width: 1440, height: 900 });
  const card = page.locator(`[data-memory-id="${userMemoryId}"]`);
  await card.locator('[data-testid="memory-edit-toggle"]').click();
  await card
    .locator("input")
    .fill(
      "Deployment note with OPENAI_API_KEY=sk-proj-4f9a2b8c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e",
    );
  await card.locator("textarea").fill("The key above must never be stored in memory.");
  await card.locator('button[type="submit"]').click();
  await page.waitForSelector('[data-testid="memory-rejection"]', { timeout: 15000 });
  const banner = await page.locator('[data-testid="memory-rejection"]').first().innerText();
  const viewAfter = memory.userView(WS);
  const still = viewAfter.scopes.workspace.find((entry) => entry.memory_id === userMemoryId);
  const unchanged = still?.content === "Version one: search the corpus with the broad query first.";
  const needle = "sk-proj-4f9a2b8c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e";
  writeFileSync(
    join(CAPTURE_OUT, "s29-rejection-leg.json"),
    JSON.stringify(
      {
        bannerText: banner,
        bannerNamesSecretRule: banner.includes("credential or secret"),
        contentUnchangedAfterRejection: unchanged,
      },
      null,
      2,
    ),
  );
  if (!banner.includes("credential or secret")) {
    console.error("REJECTION LEG: the banner does not name the secret refusal honestly");
    process.exit(1);
  }
  if (!unchanged) {
    console.error("REJECTION LEG: the rejected edit was stored anyway");
    process.exit(1);
  }
  console.log("rejection leg passed: the typed refusal renders, nothing was stored");
  await page.screenshot({ path: join(CAPTURE_OUT, "s29-rejection-1440.png") });
  // The needle must not appear in the RENDERED RECORD (the entry cards —
  // the runtime's own data). The user's own typed input stays in the form
  // box they typed it into; that is the user's browser session, not stored
  // memory.
  const renderedRecord = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid="memory-entry-card"]')]
        .map((card) => card.textContent ?? "")
        .join("\n") +
      " " +
      (document.querySelector('[data-testid="memory-publication-queue"]')?.textContent ?? ""),
  );
  if (renderedRecord.includes(needle)) {
    console.error("REJECTION LEG: the typed secret leaked into the rendered memory record");
    process.exit(1);
  }
  await context.close();
}

// ---------------------------------------------------------------------------
// 6. The captures: 1440 / 768 / 360 + reduced motion + the keyboard trail
// ---------------------------------------------------------------------------

async function capture(name, viewport, opts = {}) {
  const { context, page } = await openMemory(viewport, opts);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
}

await capture("s29-memory-768.png", { width: 768, height: 1024 }, { fullPage: true });
await capture("s29-memory-360.png", { width: 360, height: 740 }, { fullPage: true });
await capture(
  "s29-memory-reduced-motion-1440.png",
  { width: 1440, height: 900 },
  { reducedMotion: true },
);

// Keyboard-only: the tab trail from the page top — visible focus throughout,
// the auto-memory toggle and an entry's edit control both reachable.
{
  const { context, page } = await openMemory({ width: 1440, height: 900 });
  const trail = [];
  let globalToggleIndex = -1;
  let editToggleIndex = -1;
  for (let step = 0; step < 80 && (globalToggleIndex === -1 || editToggleIndex === -1); step += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(80);
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? globalThis.getComputedStyle(element) : null;
      return {
        tag: element?.tagName ?? "none",
        testId: element?.getAttribute("data-testid") ?? null,
        text: (element?.textContent ?? "").slice(0, 60),
        visibleFocus: element
          ? style?.outlineStyle !== "none" || (style?.boxShadow ?? "") !== "none"
          : false,
      };
    });
    trail.push(focused);
    if (focused.testId === "memory-auto-global-toggle" && globalToggleIndex === -1) {
      globalToggleIndex = step;
    }
    if (focused.testId === "memory-edit-toggle" && editToggleIndex === -1) {
      editToggleIndex = step;
    }
  }
  const visibleFocusCount = trail.filter((step) => step.visibleFocus).length;
  writeFileSync(
    join(CAPTURE_OUT, "s29-keyboard-trail.json"),
    JSON.stringify(
      {
        steps: trail.length,
        globalToggleFocusedAtStep: globalToggleIndex,
        editToggleFocusedAtStep: editToggleIndex,
        visibleFocusCount,
        trail,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(CAPTURE_OUT, "s29-memory-keyboard-1440.png") });
  if (globalToggleIndex === -1 || editToggleIndex === -1) {
    console.error(
      "KEYBOARD GATE: the auto-memory toggle or an entry edit control is not reachable by Tab",
    );
    process.exit(1);
  }
  if (visibleFocusCount < 2) {
    console.error("KEYBOARD GATE: fewer than two focused steps showed a visible focus indicator");
    process.exit(1);
  }
  console.log(
    `keyboard trail: global toggle at step ${globalToggleIndex}, edit control at step ${editToggleIndex}, ${visibleFocusCount} visibly-focused steps`,
  );
  await context.close();
}

await browser.close();
console.log("S29 captures complete under", CAPTURE_OUT);
for (const cleanup of cleanups.splice(0)) cleanup();
await runtime.close();
process.exit(0);
