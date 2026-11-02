/**
 * S25 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL executed S25 research-tool state (the S21/S28 harness
 * pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack) with the research tools configured: a LOCAL deterministic
 *      SearXNG-shaped fixture endpoint (the real-container integration is
 *      the recorded NOT-VERIFIED owner item) and a deterministic mock vision
 *      model (G7: no live provider in the gate).
 *   2. The seed through the REAL HTTP surface: a PDF, a CSV, and a PNG
 *      uploaded through POST /v1/workspace/files/upload (the panel's own
 *      route), then all FIVE research tools executed through the ONE
 *      execution path (runtime.tools.executeProposal) — real history rows,
 *      real artifacts with provenance.
 *   3. A control-plane stub (the harness identity) + the web app — the
 *      browser drives the app's own routes through its own proxy.
 *
 * Captures: apps/web/.impeccable/review/s25/*.png — Settings → Tools and the
 * workspace panel's Tool history tab at 360/768/1440, keyboard-only focus,
 * prefers-reduced-motion. AC2 evidence: manual-runs.md (+ manual-runs.json)
 * records one REAL manual run per tool with its transcript.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { chromium } from "playwright";
import { MockLanguageModelV3 } from "ai/test";

import { composeRuntime, DEFAULT_WORKSPACE_ID } from "../src/transport/local-api/compose.ts";
import { canonicalArgsDigest } from "../src/modules/tools/tool-executor.service.ts";

/* global document */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const AGENT = "agent_researcher";
const NOW = "2026-11-02T12:00:00.000Z";
const TASK = "task_s25_capture";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s25");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The local deterministic endpoints (SearXNG shape + one page)
// ---------------------------------------------------------------------------

const ARTICLE_HTML = `<!doctype html><html><head><title>Attention Paper Review</title></head>
<body>
<nav>site navigation</nav>
<article><h1>Attention Paper Review</h1>
<p>The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose the Transformer, which dispenses with
recurrence entirely and relies entirely on an attention mechanism to draw
global dependencies between input and output.</p>
<p>The Transformer allows for significantly more parallelization and can reach
a new state of the art in translation quality after being trained for as little
as twelve hours on eight GPUs.</p>
</article>
</body></html>`;

const fixture = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  req.resume();
  req.on("end", () => {
    if (url.pathname === "/search" && url.searchParams.get("format") === "json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          query: url.searchParams.get("q") ?? "",
          number_of_results: 2,
          results: [
            {
              title: "Attention Is All You Need",
              url: "https://arxiv.org/abs/1706.03762",
              content:
                "The dominant sequence transduction models are based on attention mechanisms.",
              engine: "arxiv",
              score: 3.1,
            },
            {
              title: "SearXNG documentation",
              url: "https://docs.searxng.org/",
              content: "SearXNG is a privacy-respecting metasearch engine.",
              engine: "duckduckgo",
              score: 1.4,
            },
          ],
          answers: [],
          infoboxes: [],
          unresponsive_engines: [],
        }),
      );
      return;
    }
    if (url.pathname === "/article") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
      return;
    }
    if (url.pathname === "/flaky-search" || url.pathname === "/search") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "transient" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
cleanups.push(() => fixture.close());
console.log("fixture on", fixtureOrigin);

// The deterministic vision model (G7: no live provider in the gate).
const visionModel = new MockLanguageModelV3({
  provider: "capture-vision",
  modelId: "capture-vision-model",
  doGenerate: async () => ({
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
      totalTokens: { total: 2 },
    },
    content: [
      {
        type: "text",
        text: "A small architecture diagram: input embeddings flow through stacked attention and feed-forward blocks into a linear softmax output layer.",
      },
    ],
    warnings: [],
  }),
});

// ---------------------------------------------------------------------------
// 2. The runtime composition + the real seeded state
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s25-capture-runtime-");
const dbPath = join(dir, "runtime.db");
const runtime = composeRuntime({
  dbPath,
  workspaceId: WS,
  packsRoot: PACKS_ROOT,
  now: () => NOW,
  scriptedReplies: false,
  researchTools: {
    searxngBaseUrl: fixtureOrigin,
    visionModel: () => visionModel,
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

const USER_ACTOR = { type: "user", id: "capture-user" };

// The chat the workspace-panel route deep-links into: the S15 LAUNCH (D30)
// creates exactly one Operation chat, the same route the panel deep-links.
const operationDefs = await fetch(origin + `/v1/operation-definitions?workspace_id=${WS}`).then(
  (r) => r.json(),
);
const definitionId = operationDefs.definitions?.[0]?.operation_definition_id;
if (!definitionId) {
  throw new Error("no operation definition resolved from the preview list");
}
const launch = await post("/v1/operations/launch", {
  workspace_id: WS,
  operation_definition_id: definitionId,
  roster_agent_ids: [AGENT, "agent_general_assistant"],
  coordinator_agent_id: "agent_general_assistant",
  idempotency_key: "idem_s25_capture_launch_0001",
  actor: USER_ACTOR,
  issued_at: NOW,
});
console.log("operation", launch.operation_id, "chat", launch.chat_conversation_id);

// A minimal valid single-page PDF (the fixture the tool really parses).
function minimalPdf(textLine) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${0} >>\nstream\nBT /F1 12 Tf 72 720 Td (${textLine}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const streamStart = pdf.indexOf("stream\n") + "stream\n".length;
  const streamEnd = pdf.indexOf("endstream");
  pdf = pdf.replace("<< /Length 0 >>", `<< /Length ${streamEnd - streamStart - 1} >>`);
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

await post("/v1/workspace/files/upload", {
  workspace_id: WS,
  path: "workspace://papers/attention.pdf",
  actor: USER_ACTOR,
  content_base64: minimalPdf("Hello S25 document parse").toString("base64"),
  mime_type: "application/pdf",
});
await post("/v1/workspace/files/upload", {
  workspace_id: WS,
  path: "workspace://data/cities.csv",
  actor: USER_ACTOR,
  content_base64: Buffer.from(
    "city,population\nLisbon,545245\nPorto,231800\nBraga,193324\n",
    "utf8",
  ).toString("base64"),
  mime_type: "text/csv",
});
await post("/v1/workspace/files/upload", {
  workspace_id: WS,
  path: "workspace://images/diagram.png",
  actor: USER_ACTOR,
  content_base64: PNG_1X1.toString("base64"),
  mime_type: "image/png",
});

// Execute all five research tools through the ONE execution path.
const RUN = {
  task_id: TASK,
  workspace_id: WS,
  conversation_id: launch.chat_conversation_id,
  created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s25_capture" },
  pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
  roster: [AGENT],
  state: "RUNNING",
  version: 7,
  retry_count: 0,
  created_at: NOW,
  updated_at: NOW,
};

async function runTool(toolId, toolVersion, capability, rawArgs, summary) {
  const dispatched = runtime.tools.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: launch.chat_conversation_id,
      tool_id: toolId,
      tool_version: toolVersion,
      capability,
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: summary,
    },
    run: RUN,
    agent_id: AGENT,
    rawArgs,
  });
  if (dispatched.outcome !== "dispatched") {
    throw new Error(`${toolId}: expected dispatched, got ${dispatched.outcome}`);
  }
  const settled = await dispatched.completion;
  console.log(
    toolId,
    "->",
    settled.outcome,
    settled.outcome === "executed" ? "" : (settled.error_code ?? ""),
  );
  return settled;
}

await runTool(
  "tool_web_search",
  "1.0.0",
  "research.search",
  { query: "transformer architecture literature" },
  "Search the web for transformer architecture literature.",
);
await runTool(
  "tool_page_fetch",
  "1.0.0",
  "research.fetch",
  { url: `${fixtureOrigin}/article` },
  "Read the attention paper review page.",
);
await runTool(
  "tool_document_parse",
  "1.0.0",
  "research.parse.document",
  { path: "workspace://papers/attention.pdf" },
  "Parse the uploaded attention paper PDF.",
);
await runTool(
  "tool_spreadsheet_analyze",
  "1.0.0",
  "research.analyze.spreadsheet",
  { path: "workspace://data/cities.csv" },
  "Analyse the uploaded city populations CSV.",
);
await runTool(
  "tool_image_understand",
  "1.0.0",
  "research.describe.image",
  { path: "workspace://images/diagram.png" },
  "Describe the uploaded architecture diagram.",
);
// One honest failure row (the taste pass sees the typed error rendering):
await runTool(
  "tool_page_fetch",
  "1.0.0",
  "research.fetch",
  { url: "file:///etc/passwd" },
  "Try to read a non-web path.",
);

const history = await fetch(origin + `/v1/tools/history?workspace_id=${WS}`).then((r) => r.json());
console.log("history rows:", history.history.map((h) => `${h.tool_id}:${h.status}`).join(", "));

// ---------------------------------------------------------------------------
// AC2 evidence: one REAL manual run per tool, recorded with its transcript.
// ---------------------------------------------------------------------------

const inventory = await fetch(origin + `/v1/tools?workspace_id=${WS}`).then((r) => r.json());
const artifacts = await fetch(origin + `/v1/workspace/artifacts?workspace_id=${WS}`).then((r) =>
  r.json(),
);
const manualRuns = history.history
  .filter((row) => row.task_id === TASK)
  .map((row) => ({
    tool_id: row.tool_id,
    capability: row.capability,
    status: row.status,
    risk_class: row.risk_class,
    recovery: row.recovery,
    approval_id: row.approval_id,
    error_code: row.error_code,
    args_summary: row.args_summary,
    result_summary: row.result_summary,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }));
writeFileSync(
  join(CAPTURE_OUT, "manual-runs.json"),
  JSON.stringify(
    {
      recorded_at: NOW,
      posture:
        "Each run is a REAL manual execution through the real runtime composition and the ONE execution path (executor.executeProposal), seeded through the real HTTP surface. The SearXNG endpoint and the vision model are the local deterministic fixtures the slice records (the real-container and live-provider integrations are the NOT-VERIFIED owner items).",
      inventory: inventory.tools.map(
        (t) => `${t.tool_id} v${t.version} ${t.state} ${t.risk_class} recovery=${t.recovery}`,
      ),
      artifact_count: (artifacts.artifacts ?? []).length,
      runs: manualRuns,
    },
    null,
    1,
  ),
);
const markdown = [
  "# S25 manual-run evidence (one real run per research tool)",
  "",
  `Recorded: ${NOW} — real runtime composition, real HTTP seeding, real executor.`,
  "The SearXNG endpoint and the vision model are the local deterministic fixtures the slice records;",
  "the real SearXNG container and a live vision provider are the NOT-VERIFIED owner items.",
  "",
  `Tool inventory: ${inventory.tools.map((t) => `${t.tool_id} (${t.state}, ${t.risk_class}, recovery ${t.recovery})`).join("; ")}`,
  "",
  ...manualRuns.map((row) =>
    [
      `## ${row.tool_id}`,
      "",
      `- capability: \`${row.capability}\``,
      `- status: **${row.status}**${row.error_code ? ` (error_code: \`${row.error_code}\`)` : ""}`,
      `- risk class: ${row.risk_class}; recovery: ${row.recovery}; approval row: ${row.approval_id ?? "none (read-only auto-run)"}`,
      `- arguments (redacted summary): \`${row.args_summary}\``,
      `- result (redacted, bounded transcript):`,
      "",
      "```",
      row.result_summary ?? "(no result)",
      "```",
      "",
    ].join("\n"),
  ),
].join("\n");
writeFileSync(join(CAPTURE_OUT, "manual-runs.md"), markdown);
console.log("manual-run evidence written");

// ---------------------------------------------------------------------------
// 3. The control-plane stub + the web app (the S19 harness pattern)
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
for (let i = 0; i < 150 && !webReady; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    webReady = (await fetch(webOrigin + "/login")).ok;
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
// 4. The captures
// ---------------------------------------------------------------------------

const browser = await chromium.launch();

async function capture(name, path, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
  if (opts.waitFor !== undefined) {
    const appeared = await page
      .waitForSelector(opts.waitFor, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      const mainText = await page.evaluate(() => {
        const main = document.querySelector("main") ?? document.body;
        return main.innerText.slice(0, 400);
      });
      console.log("[main text after wait]", JSON.stringify(mainText));
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

// Keyboard-only: tab through the inventory, record the trail, capture focus.
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
  writeFileSync(join(CAPTURE_OUT, "tools-keyboard-trail.json"), JSON.stringify(trail, null, 1));
  console.log("captured tools-keyboard-focus-1440.png");
  await context.close();
}

// The workspace panel's Tool history tab (full-page route, deep-linked).
const HISTORY_PATH = `/app/chat/${launch.chat_conversation_id}/workspace/full?tab=tools`;
await capture(
  "tool-history-1440.png",
  HISTORY_PATH,
  { width: 1440, height: 900 },
  { waitFor: "[data-execution-id]" },
);
await capture(
  "tool-history-768.png",
  HISTORY_PATH,
  { width: 768, height: 1024 },
  { waitFor: "[data-execution-id]" },
);
await capture(
  "tool-history-360.png",
  HISTORY_PATH,
  { width: 360, height: 740 },
  { fullPage: true, waitFor: "[data-execution-id]" },
);
await capture(
  "tool-history-reduced-motion-1440.png",
  HISTORY_PATH,
  { width: 1440, height: 900 },
  { reducedMotion: true, waitFor: "[data-execution-id]" },
);

await browser.close();
console.log("DONE — captures in", CAPTURE_OUT);
for (const cleanup of cleanups.reverse()) cleanup();
next.kill();
runtime.close();
process.exit(0);
