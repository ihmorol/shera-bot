/**
 * S21 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL seeded S21 state (the S19 harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack) with the scripted demo tool proposal configured — a LOCAL_MUTATION
 *      note append whose run pauses at WAITING_FOR_APPROVAL with the real
 *      approval request recorded (the executor's pause path, chunk 3).
 *   2. The S21 seed through the REAL HTTP surface: one agent-created tool
 *      created through POST /v1/tools/create (READ_ONLY, auto-active), one
 *      risky tool left in `created` (awaiting the user's activation), and one
 *      built-in disabled through the disable switch (AC6 state).
 *   3. A control-plane stub (the harness identity) + `next dev` — the browser
 *      drives the app's own routes through its own proxy.
 *
 * Captures: apps/web/.impeccable/review/s21/*.png — Settings → Tools at
 * 360/768/1440, keyboard-only focus, prefers-reduced-motion, and the
 * workspace panel's Tool history tab with the paused execution's real row.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { chromium } from "playwright";

// The page.evaluate closures below run INSIDE the browser context and
// reference browser globals (document/window) by design.
/* global document, window */

import { composeRuntime, DEFAULT_WORKSPACE_ID } from "../src/transport/local-api/compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const NOW = "2026-10-29T12:00:00.000Z";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s21");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The runtime composition with the pinned pack + the scripted demo tool
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s21-capture-runtime-");
const dbPath = join(dir, "runtime.db");
const runtime = composeRuntime({
  dbPath,
  workspaceId: WS,
  packsRoot: PACKS_ROOT,
  now: () => NOW,
  scriptedReplies: false,
  // The scripted demo proposal (LOCAL_MUTATION): the run pauses for approval
  // through the S21 executor; the tool history carries the awaiting row with
  // the side-effect preview text (the no-op binding's own posture).
  scriptedToolProposal: {
    agent_id: "agent_researcher",
    tool: {
      tool_id: "tool_capture_append",
      tool_version: "1.0.0",
      capability: "file.write",
      risk_class: "LOCAL_MUTATION",
      resource_scope: "workspace://notes/capture.md",
      side_effect_summary: "Appends the captured digest line to the workspace note.",
    },
    args_digest: `sha256:${"c".repeat(64)}`,
    proposal_summary: "Append the captured digest line to the workspace note.",
  },
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
// 2. The seed: agent-created tools + one disabled built-in, through the API
// ---------------------------------------------------------------------------

const USER_ACTOR = { type: "user", id: "capture-user" };
// A READ_ONLY agent-created tool: auto-activates for its creator (E4).
await post("/v1/tools/create", {
  workspace_id: WS,
  requested_by: { type: "agent", id: "agent_researcher" },
  actor: USER_ACTOR,
  tool: {
    tool_id: "tool_digest_builder",
    name: "Digest builder",
    purpose: "Builds a digest line for a workspace note.",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    capabilities: ["file.read"],
    risk_class: "READ_ONLY",
    inventory_scope: "shared",
  },
});
// A risky agent-created tool: lands in `created` (awaiting activation, AC8).
await post("/v1/tools/create", {
  workspace_id: WS,
  requested_by: { type: "agent", id: "agent_developer" },
  actor: USER_ACTOR,
  tool: {
    tool_id: "tool_custom_append",
    name: "Custom append",
    purpose: "Appends a custom summary line to a note.",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    capabilities: ["file.write"],
    risk_class: "LOCAL_MUTATION",
    inventory_scope: "shared",
  },
});
// The disable switch on a built-in (AC6: the state the inventory shows).
await post("/v1/tools/disable", {
  workspace_id: WS,
  tool_id: "tool_note_read",
  actor: USER_ACTOR,
});
// The Operation + run whose REAL scripted proposal pauses the run through
// the S21 executor: the approval request exists and the tool history carries
// the awaiting row with the diff preview.
// The Operation whose chat hosts the workspace panel: the S15 LAUNCH (D30)
// creates EXACTLY one Operation chat and one first run, and answers the chat
// conversation id the panel route deep-links into.
const operationDefs = await fetch(origin + `/v1/operation-definitions?workspace_id=${WS}`).then(
  (r) => r.json(),
);
console.log("defs:", JSON.stringify(operationDefs).slice(0, 300));
const definitionId = operationDefs.definitions?.[0]?.operation_definition_id;
if (!definitionId) {
  throw new Error("no operation definition resolved from the preview list");
}
const launch = await post("/v1/operations/launch", {
  workspace_id: WS,
  operation_definition_id: definitionId,
  roster_agent_ids: ["agent_researcher", "agent_general_assistant"],
  coordinator_agent_id: "agent_general_assistant",
  idempotency_key: "idem_s21_capture_launch_0001",
  actor: USER_ACTOR,
  issued_at: NOW,
});
console.log("operation", launch.operation_id, "chat", launch.chat_conversation_id);

// The scripted run: a TYPED trigger through the harness seam (the S20 test
// pattern — the operations runs route does not drive the harness; the
// startRun unit journals the proposal and pauses through the S21 executor).
const trigger = {
  event_id: "evt_s21_capture_trigger",
  stream_id: "conversation:conv_s21_capture",
  sequence: 1,
  event_version: 1,
  actor: { type: "system", id: "scheduler" },
  task_id: "task_s21_capture",
  conversation_id: "conv_s21_capture",
  occurred_at: NOW,
  redaction_class: "internal",
  event_type: "trigger.scheduled",
  payload: { schedule_id: "sch_s21_capture", due_at: NOW },
};
const started = runtime.harness.startRun(trigger);
if (!started.ok) {
  throw new Error(`the scripted run refused to start: ${started.code}`);
}
console.log("scripted run", started.task_id, "state", started.state);
await new Promise((r) => setTimeout(r, 200));

const inventory = await fetch(origin + `/v1/tools?workspace_id=${WS}`).then((r) => r.json());
console.log(
  "inventory:",
  inventory.tools.map((t) => `${t.tool_id}:${t.state}:${t.disabled ? "off" : "on"}`).join(", "),
);
const history = await fetch(origin + `/v1/tools/history?workspace_id=${WS}`).then((r) => r.json());
console.log("history rows:", history.history.map((h) => `${h.tool_id}:${h.status}`).join(", "));

// ---------------------------------------------------------------------------
// 3. The control-plane stub + next dev (the S19 harness pattern)
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
          // The opaque handle contract (rt_ + 32 hex) — a drifted stub answer
          // fails the Session/RuntimeStatus zod parse and the gate reports the
          // honest failure instead of the ready state.
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

// Probe the control-plane endpoints the container gate needs (the S19 probe).
const probeSession = await fetch(webOrigin + "/api/control/api/session");
console.log("probe session:", probeSession.status, (await probeSession.text()).slice(0, 160));
const probeStatus = await fetch(webOrigin + "/api/control/api/runtime/status");
console.log("probe status:", probeStatus.status, (await probeStatus.text()).slice(0, 160));

// ---------------------------------------------------------------------------
// 4. The captures
// ---------------------------------------------------------------------------

const browser = await chromium.launch();

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
    }
    if (!appeared && name === "tools-1440.png") {
      const inPage = await page.evaluate(async () => {
        try {
          const session = await fetch("/api/control/api/session");
          const status = await fetch("/api/control/api/runtime/status");
          return { session: session.status, status: status.status };
        } catch (error) {
          return { error: String(error) };
        }
      });
      console.log("[in-page probe after wait]", JSON.stringify(inPage));
      const gateState = await page.evaluate(() => document.body.innerText.slice(0, 200));
      console.log("[gate text after wait]", JSON.stringify(gateState));
      const errors = await page.evaluate(() =>
        window.__NEXT_DATA__ ? "next-data-present" : "no-next-data",
      );
      console.log("[hydration marker]", errors);
    }
  }
  await page.waitForTimeout(1500);
  if (opts.before !== undefined) await opts.before(page);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
}

const TOOLS_PATH = "/app/settings/tools";
await capture(
  "tools-1440.png",
  TOOLS_PATH,
  { width: 1440, height: 900 },
  { waitFor: "[data-tool-id]" },
);
await capture(
  "tools-768.png",
  TOOLS_PATH,
  { width: 768, height: 1024 },
  { waitFor: "[data-tool-id]" },
);
await capture(
  "tools-360.png",
  TOOLS_PATH,
  { width: 360, height: 740 },
  { fullPage: true, waitFor: "[data-tool-id]" },
);
await capture(
  "tools-reduced-motion-1440.png",
  TOOLS_PATH,
  { width: 1440, height: 900 },
  { reducedMotion: true, waitFor: "[data-tool-id]" },
);

// Keyboard-only: tab until a disable switch holds focus, then capture.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + TOOLS_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[role=switch]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const trail = [];
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    trail.push(focused);
    if (focused?.startsWith("Disable") || focused?.startsWith("Enable")) {
      reached = true;
      break;
    }
  }
  console.log("keyboard reached a disable switch:", reached);
  await page.screenshot({ path: join(CAPTURE_OUT, "tools-keyboard-focus-1440.png") });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(CAPTURE_OUT, "tools-keyboard-trail.json"), JSON.stringify(trail, null, 1));
  console.log("captured tools-keyboard-focus-1440.png");
  await context.close();
}

// The workspace panel's Tool history tab (the full-page route, deep-linked).
await capture(
  "tool-history-1440.png",
  `/app/chat/${launch.chat_conversation_id}/workspace/full?tab=tools`,
  { width: 1440, height: 900 },
  { waitFor: "[data-execution-id]" },
);
await capture(
  "tool-history-360.png",
  `/app/chat/${launch.chat_conversation_id}/workspace/full?tab=tools`,
  { width: 360, height: 740 },
  { fullPage: true, waitFor: "[data-execution-id]" },
);

await browser.close();
console.log("DONE — captures in", CAPTURE_OUT);
for (const cleanup of cleanups.reverse()) cleanup();
next.kill();
runtime.close();
process.exit(0);
