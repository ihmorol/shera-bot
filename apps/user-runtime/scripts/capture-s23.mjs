/**
 * S23 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL seeded S23 state (the S19/S21 harness pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack) with provider enforcement ON (G4) and NO scripted replies (the
 *      two postures are mutually exclusive in the composition).
 *   2. The S23 seed through the REAL HTTP surface: the E9 platform
 *      provisioning write (one platform OpenAI entry with a sealed credential
 *      and an UNREACHABLE base URL — the honest connection-test failure with
 *      zero live calls, G7), one user custom no-key Ollama entry, and the AC11
 *      override on the General Assistant direct chat.
 *   3. A control-plane stub (the harness identity) + `next dev` — the browser
 *      drives the app's own routes through its own proxy.
 *
 * Captures: apps/web/.impeccable/review/s23/*.png — Settings → Providers &
 * models at 360/768/1440 + prefers-reduced-motion + keyboard-only, the honest
 * connection-test failure, the chat header's model control (open panel) with
 * the effective readout, and the no-provider composer state.
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
/* global document, window */

import { composeRuntime, DEFAULT_WORKSPACE_ID } from "../src/transport/local-api/compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const PACKS_ROOT = resolve(repoRoot, "agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const NOW = "2026-10-31T12:00:00.000Z";
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s23");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// 1. The runtime composition with the pinned pack + provider enforcement
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s23-capture-runtime-");
const dbPath = join(dir, "runtime.db");
const SKIP_RUNTIME = process.env.SHERA_CAPTURE_NO_RUNTIME === "1";
const runtime = SKIP_RUNTIME
  ? null
  : composeRuntime({
      dbPath,
      workspaceId: WS,
      packsRoot: PACKS_ROOT,
      now: () => NOW,
      // Provider enforcement ON and no scripted replies (G4: the composition
      // refuses the combination — unconfigured turns are refused, never faked).
      providerEnforcement: true,
    });
if (runtime) {
  // Seed phase only makes sense against the real runtime; without it the
  // debug run just serves the shell.
}
let runtimePort;
let origin;
if (runtime) {
  await new Promise((resolveListen) => runtime.httpServer.listen(0, "127.0.0.1", resolveListen));
  runtimePort = runtime.httpServer.address().port;
  origin = `http://127.0.0.1:${runtimePort}`;
  console.log("runtime on", origin);
} else {
  console.log("[debug] runtime skipped (SHERA_CAPTURE_NO_RUNTIME=1)");
}

const call = async (path, method, body) => {
  const response = await fetch(origin + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  console.log(method, path, "->", response.status);
  if (response.status >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
};

// ---------------------------------------------------------------------------
// 2. The seed: platform + custom providers and the AC11 override, via the API
// ---------------------------------------------------------------------------

if (runtime) {
  // The E9 platform provisioning write (write-only; not browser-allowlisted).
  // The base URL points at a closed local port: the connection test below fails
  // HONESTLY (one real request to an unreachable endpoint) without any live
  // provider call (G7). The credential is sealed at rest; only the hint returns.
  const platform = await call("/v1/providers/platform", "PUT", {
    workspace_id: WS,
    provider_id: "prov_capture_openai",
    display_name: "Platform OpenAI",
    protocol: "openai-compatible",
    base_url: "http://127.0.0.1:9/v1",
    api_mode: "api_key",
    credential: "sk-capture-sealed-0001",
    default_model_id: "gpt-4o-mini",
    organization: null,
    project: null,
    headers: {},
    request_params: {},
  });
  console.log("platform provider:", platform.id, "hint", platform.credential_hint);

  // A user custom provider: no-key local Ollama shape (enabled).
  const custom = await call("/v1/providers", "POST", {
    workspace_id: WS,
    display_name: "Local Ollama",
    protocol: "ollama",
    base_url: "http://127.0.0.1:11434/v1",
    api_mode: "no_key",
    credential: null,
    default_model_id: "llama3.1:8b",
    organization: null,
    project: null,
    headers: {},
    request_params: {},
  });
  console.log("custom provider:", custom.id, "hint", custom.credential_hint);

  // The General Assistant direct chat id — the EXACT conversation the web app
  // uses: the web surface resolves it through the idempotent seed key (the
  // receipt replay returns the same row every time), so the seed here replays
  // the SAME receipt instead of guessing a binding.
  const gaChat = await call("/v1/conversations/commands", "POST", {
    type: "conversation.create",
    workspace_id: WS,
    idempotency_key: "s09-ga-direct-chat-seed-v1",
    payload: { title: "General Assistant" },
  }).then((r) => r.conversation_id);
  console.log("GA direct chat (web seed receipt):", gaChat);

  // The AC11 override: the GA conversation rides the platform OpenAI entry.
  const override = await call("/v1/providers/overrides", "POST", {
    workspace_id: WS,
    conversation_id: gaChat,
    provider_id: "prov_capture_openai",
    model: "gpt-4o-mini",
  });
  console.log("override effective:", JSON.stringify(override.effective));

  // The effective state for a chat with NO override (the honest D17 state).
  const researcherDetail = await call(`/v1/agents/agent_researcher?workspace_id=${WS}`, "GET");
  const effectiveResearcher = await call(
    `/v1/providers/effective?workspace_id=${WS}&conversation_id=${researcherDetail.direct_chat_id}`,
    "GET",
  );
  console.log("researcher effective (no override):", JSON.stringify(effectiveResearcher));
}

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

// localhost, NOT 127.0.0.1: Next 16 dev blocks "cross-origin" dev resources
// from non-localhost hosts (allowedDevOrigins), which silently strands the
// client chunks below the shell and freezes every surface at its SSR state.
const webOrigin = process.env.SHERA_CAPTURE_WEB_ORIGIN ?? "http://localhost:4321";
const nextArgs =
  process.env.SHERA_CAPTURE_PROD === "1"
    ? ["start", "--port", String(new URL(webOrigin).port)]
    : ["dev", "--port", String(new URL(webOrigin).port)];
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

// ---------------------------------------------------------------------------
// 4. The captures
// ---------------------------------------------------------------------------

let browser;
const cleanupAll = async (code) => {
  try {
    if (browser) await browser.close();
  } catch {
    // Best-effort teardown — the exit code carries the failure.
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Best-effort teardown — never mask the original failure.
    }
  }
  next.kill();
  if (runtime) runtime.close();
  process.exit(code);
};
process.on("uncaughtException", async (error) => {
  console.error("[fatal]", error);
  await cleanupAll(1);
});
process.on("unhandledRejection", async (error) => {
  console.error("[fatal]", error);
  await cleanupAll(1);
});

browser = await chromium.launch();

async function capture(name, path, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  if (process.env.SHERA_CAPTURE_DEBUG === "1") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (event) => {
      const detail = event.exceptionDetails;
      console.log(
        "[cdp-exception]",
        detail.exception?.description ?? detail.text,
        "@",
        detail.url ?? "?",
        detail.lineNumber,
      );
    });
  }
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.log("[console]", message.type(), message.text().slice(0, 240));
    }
  });
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  if (process.env.SHERA_CAPTURE_NET === "1") {
    page.on("response", (r) => {
      if (r.url().includes("/api/") || (r.status() >= 400 && r.url().includes("_next"))) {
        console.log("[net]", r.status(), r.url().slice(webOrigin.length));
      }
    });
    page.on("requestfailed", (r) =>
      console.log("[net-fail]", r.url().slice(webOrigin.length), r.failure()?.errorText),
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
      if (process.env.SHERA_CAPTURE_DEBUG === "1") {
        console.log("[nextLog tail]", nextLog.slice(-1800));
        const debug = await page.evaluate(async () => {
          const inPage = await fetch("/api/control/api/session")
            .then((r) => `session ${r.status}`)
            .catch((e) => `session failed: ${String(e).slice(0, 80)}`);
          return {
            readyState: document.readyState,
            hasNextData: Boolean(window.__NEXT_DATA__),
            hasNextFlight: Array.isArray(window.__next_f),
            scripts: Array.from(document.scripts).length,
            bodyChildren: document.body.children.length,
            inPageFetch: inPage,
            reactVersion: (() => {
              try {
                return document.querySelector("main")?.closest("div") ? "root-exists" : "no-root";
              } catch {
                return "err";
              }
            })(),
          };
        });
        console.log("[debug]", JSON.stringify(debug));
      }
      if (process.env.SHERA_CAPTURE_NET === "1") {
        // Re-check whether ANY /api request has fired by this point via the
        // resource timing buffer (the response listener only sees live ones).
        const timings = await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((n) => n.includes("/api/"))
            .slice(0, 12),
        );
        console.log("[api-timings]", JSON.stringify(timings));
        const chunks = await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .map((e) => `${e.name.slice(webOrigin.length)} ${Math.round(e.transferSize)}B`)
            .slice(0, 30),
        );
        console.log("[resource-timings]", JSON.stringify(chunks, null, 1));
      }
    }
  }
  await page.waitForTimeout(1500);
  if (opts.before !== undefined) await opts.before(page);
  await page.screenshot({ path: join(CAPTURE_OUT, name), fullPage: opts.fullPage ?? false });
  console.log("captured", name);
  await context.close();
}

const PROVIDERS_PATH = "/app/settings/providers";
await capture(
  "providers-1440.png",
  PROVIDERS_PATH,
  { width: 1440, height: 900 },
  {
    waitFor: "[data-provider-id]",
  },
);
await capture(
  "providers-768.png",
  PROVIDERS_PATH,
  { width: 768, height: 1024 },
  {
    waitFor: "[data-provider-id]",
  },
);
await capture(
  "providers-360.png",
  PROVIDERS_PATH,
  { width: 360, height: 740 },
  {
    fullPage: true,
    waitFor: "[data-provider-id]",
  },
);
await capture(
  "providers-reduced-motion-1440.png",
  PROVIDERS_PATH,
  { width: 1440, height: 900 },
  {
    reducedMotion: true,
    waitFor: "[data-provider-id]",
  },
);

// The honest connection-test failure (G7: unreachable local endpoint; G3:
// the redacted message). One real request — captured after the typed
// failure renders.
await capture(
  "providers-connection-test-failure-1440.png",
  PROVIDERS_PATH,
  { width: 1440, height: 900 },
  {
    waitFor: "[data-provider-id]",
    before: async (page) => {
      const row = page.locator('[data-provider-id="prov_capture_openai"]');
      await row.getByRole("button", { name: "Test connection" }).click();
      // The unreachable endpoint answers in a few seconds; the typed failure
      // message is the redacted safe_message (never a stack or a body).
      await page
        .getByText("The provider endpoint could not be reached", { exact: false })
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
    },
  },
);

// The add-provider form (every PRD §9 field).
await capture(
  "providers-add-form-1440.png",
  PROVIDERS_PATH,
  { width: 1440, height: 900 },
  {
    waitFor: "[data-provider-id]",
    before: async (page) => {
      await page.getByRole("button", { name: "Add a custom provider" }).click();
      await page.getByText("Add a custom provider").first().waitFor({ timeout: 10000 });
    },
  },
);

// Keyboard-only pass over the settings surface: tab until a provider action
// button holds focus, then capture (the trail is the tab-order evidence).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(webOrigin + PROVIDERS_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-provider-id]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const trail = [];
  let reached = false;
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
    trail.push(focused);
    if (focused === "Test connection") {
      reached = true;
      break;
    }
  }
  console.log("keyboard reached a Test connection button:", reached);
  await page.screenshot({ path: join(CAPTURE_OUT, "providers-keyboard-focus-1440.png") });
  writeFileSync(join(CAPTURE_OUT, "providers-keyboard-trail.json"), JSON.stringify(trail, null, 1));
  console.log("captured providers-keyboard-focus-1440.png");
  await context.close();
}

// The chat header's model control with the effective readout (AC11), then the
// open override panel.
await capture(
  "chat-model-control-1440.png",
  `/app/agent/general-assistant`,
  { width: 1440, height: 900 },
  {
    waitFor: "header",
  },
);
await capture(
  "chat-model-control-open-1440.png",
  `/app/agent/general-assistant`,
  { width: 1440, height: 900 },
  {
    waitFor: "header",
    before: async (page) => {
      const control = page.locator("header button[aria-haspopup=true]");
      await control.click();
      await page.getByText("Override for this conversation").waitFor({ timeout: 10000 });
    },
  },
);

// 360px: the header keeps identity priority (the control collapses below md).
await capture(
  "chat-360.png",
  `/app/agent/general-assistant`,
  { width: 360, height: 740 },
  {
    fullPage: false,
    waitFor: "header",
  },
);

// The no-provider composer state (D17): the Researcher chat has no override
// and its Agent default does not resolve — the composer is disabled with the
// runtime's own explanation.
await capture(
  "chat-no-provider-composer-1440.png",
  `/app/agent/researcher`,
  { width: 1440, height: 900 },
  {
    waitFor: "header",
  },
);

await browser.close();
console.log("DONE — captures in", CAPTURE_OUT);
for (const cleanup of cleanups.reverse()) cleanup();
next.kill();
if (runtime) runtime.close();
process.exit(0);
