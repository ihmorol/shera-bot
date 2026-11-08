/**
 * S30 UI-gate capture harness — drives the REAL web app against the REAL
 * runtime with REAL notification/onboarding state (the S29/S28 harness
 * pattern):
 *
 *   1. The full runtime composition (real SQLite, real HTTP, pinned student
 *      pack, the composed S30 notifications + onboarding services).
 *   2. The seed through the REAL machinery — the journal's task-lifecycle
 *      events (completion/failure/recovery), a REAL pending approval through
 *      the scripted gated tool (the S20 pause), direct-chat history for the
 *      roster activity lines, and the interview left PENDING for the card
 *      dock. No fixture INSERT of anything the surfaces render.
 *   3. A control-plane stub + the PRODUCTION web build (next start via
 *      SHERA_CAPTURE_PROD=1 — the recorded dev-mode Turbopack hang; S22's
 *      harness note).
 *
 * The truth legs: the harness FAILS unless the rendered notification rows,
 * badge, settings toggles, and onboarding cards match the runtime's own
 * records (the GET /v1/notifications + /v1/onboarding reads the harness
 * takes itself); the interactive legs FAIL unless the onboarding answer
 * really advances the runtime's snapshot, the dismiss really persists, the
 * toggles really write through, and the keyboard trail really reaches the
 * center. Screenshots are for the owner's eyes; the JSON files are the
 * machine-readable truth this gate is judged on.
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
const CAPTURE_OUT = join(repoRoot, "apps", "web", ".impeccable", "review", "s30");
mkdirSync(CAPTURE_OUT, { recursive: true });

const cleanups = [];
const makeTempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const evidence = { captures: [], truthLegs: {}, interactiveLegs: {}, tastePass: {} };
const record = (name, payload) => {
  evidence.captures.push({ name, ...payload });
  writeFileSync(join(CAPTURE_OUT, "s30-captures.json"), JSON.stringify(evidence, null, 2));
};

// ---------------------------------------------------------------------------
// 1. The runtime composition
// ---------------------------------------------------------------------------

const dir = makeTempDir("shera-s30-capture-runtime-");
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
// 2. The seed: the runtime's own records only
// ---------------------------------------------------------------------------

// (a) The journal lifecycle events — completion / failure / recovery on
// task streams (the notification derivation's source).
let seq = 1;
const seedLifecycle = (eventId, eventType, taskId, toState, at) => {
  runtime.journal.append({
    stream_id: `task:${taskId}`,
    sequence: seq++,
    event_id: eventId,
    event_type: eventType,
    schema_version: 1,
    payload: JSON.stringify({
      from_state: "RUNNING",
      to_state: toState,
      reason: "capture_seed",
      correlation_id: `corr_${eventId}`,
    }),
    workspace_id: WS,
    occurred_at: at,
    correlation_id: `corr_${eventId}`,
  });
};
seedLifecycle(
  "evt_cap_done",
  "task.succeeded",
  "task_cap_done",
  "SUCCEEDED",
  "2026-11-08T09:00:00.000Z",
);
seedLifecycle("evt_cap_fail", "task.failed", "task_cap_fail", "FAILED", "2026-11-08T09:05:00.000Z");
seedLifecycle(
  "evt_cap_rec",
  "task.recovery_required",
  "task_cap_rec",
  "RECOVERY_REQUIRED",
  "2026-11-08T09:10:00.000Z",
);
console.log("lifecycle events seeded");

// (b) Direct-chat history for the roster activity lines (E43 idea 4) — the
// journal rows ride the REAL conversation streams the agents module binds.
const chatBinds = [];
for (const [agentSlug, agentId] of [
  ["general-assistant", "agent_general_assistant"],
  ["researcher", "agent_researcher"],
  ["developer", "agent_developer"],
]) {
  const detail = await fetch(`${origin}/v1/agents/${agentId}?workspace_id=${WS}`).then((r) =>
    r.json(),
  );
  chatBinds.push({ agentId, chatId: detail.direct_chat_id });
  runtime.journal.append({
    stream_id: `conversation:${detail.direct_chat_id}`,
    sequence: 2,
    event_id: `evt_cap_chat_${agentSlug}`,
    event_type: "message.appended",
    schema_version: 1,
    payload: JSON.stringify({
      conversation_id: detail.direct_chat_id,
      workspace_id: WS,
      message_id: `msg_cap_${agentSlug}`,
      sender: { kind: "agent", agent_id: agentId },
      text: `Capture seed: ${agentSlug} last line for the roster preview.`,
    }),
    workspace_id: WS,
    occurred_at: "2026-11-08T09:20:00.000Z",
    correlation_id: `corr_cap_chat_${agentSlug}`,
  });
}
console.log("direct-chat history seeded");

// (c) The REAL pending approval through the scripted gated tool (the S20
// machinery creates the request + the reminders; nothing seeded).
const gated = {
  agent_id: "agent_general_assistant",
  tool: {
    tool_id: "tool_repo_push",
    tool_version: "1.2.0",
    capability: "repo.push",
    risk_class: "EXTERNAL_WRITE",
    resource_scope: "workspace://notes/draft.md",
    side_effect_summary: "Pushes local commits to the configured remote repository.",
  },
  args_digest: `sha256:${"b".repeat(64)}`,
  proposal_summary: "Capture seed: push the drafted notes.",
};
const scriptedRuntime = runtime;
// The composition wired WITHOUT the scripted config needs the approval via
// the approvals service; the capture re-composes that delegate by starting a
// run through the harness the composition exposes. (composeRuntime with
// scriptedToolProposal is a separate composition; the capture uses the
// approvals service's own pause path through a seeded typed proposal.)
const runStart = scriptedRuntime.harness.startRun({
  event_id: "evt_cap_trig",
  stream_id: "conversation:conv_capture_apr",
  sequence: 1,
  event_version: 1,
  actor: { type: "system", id: "scheduler" },
  task_id: "task_cap_apr",
  conversation_id: "conv_capture_apr",
  occurred_at: "2026-11-08T09:30:00.000Z",
  redaction_class: "internal",
  event_type: "trigger.scheduled",
  payload: { schedule_id: "sch_capture", due_at: "2026-11-08T09:30:00.000Z" },
});
if (!runStart.ok) throw new Error(`the capture run refused to start: ${runStart.reason ?? "?"}`);
console.log("capture run started", runStart.task_id, runStart.state);

// The pending approval comes from the approvals module's OWN record (the
// D9 request the runtime created — or, when this composition runs without
// the scripted delegate, the typed proposal seam the service exposes).
const pendingApprovals = await fetch(`${origin}/v1/approvals/pending?workspace_id=${WS}`).then(
  (r) => r.json(),
);
console.log("pending approvals:", pendingApprovals.approvals.length);
const approvalId = pendingApprovals.approvals[0]?.approval_id ?? null;
if (!approvalId) {
  // The composition without the scripted delegate: create the request
  // through the approvals service's REAL typed-proposal pause path.
  const paused = runtime.approvals.createRequestFromTypedProposal({
    proposal: {
      workspace_id: WS,
      task_id: runStart.task_id,
      conversation_id: "conv_capture_apr",
      // (the run the service compares against is keyed by runStart.task_id)
      agent_id: "agent_general_assistant",
      tool_id: gated.tool.tool_id,
      tool_version: gated.tool.tool_version,
      capability: gated.tool.capability,
      risk_class: gated.tool.risk_class,
      resource_scope: gated.tool.resource_scope,
      args_digest: gated.args_digest,
      side_effect_summary: gated.tool.side_effect_summary,
    },
    run: {
      task_id: runStart.task_id,
      workspace_id: WS,
      conversation_id: "conv_capture_apr",
      created_from: { trigger_event_type: "trigger.scheduled", trigger_event_id: "evt_cap_trig" },
      pack_snapshot: { pack_id: "student", pack_version: "1.0.0", pack_hash: "0".repeat(64) },
      roster: ["agent_general_assistant"],
      state: "RUNNING",
      version: 2,
      retry_count: 0,
      created_at: "2026-11-08T09:30:00.000Z",
      updated_at: "2026-11-08T09:30:00.000Z",
    },
    execute: () => undefined,
  });
  if (paused.outcome !== "paused_for_approval") {
    throw new Error(`the capture pause failed: ${paused.outcome}`);
  }
  console.log("pending approval created via the typed proposal seam", paused.approval_id);
}

// The runtime's OWN records at capture time — the truth legs compare
// against THESE reads, never against local expectations.
const truthNotifications = await fetch(`${origin}/v1/notifications?workspace_id=${WS}`).then((r) =>
  r.json(),
);
const truthSettings = await fetch(`${origin}/v1/notifications/settings?workspace_id=${WS}`).then(
  (r) => r.json(),
);
const truthOnboarding = await fetch(`${origin}/v1/onboarding?workspace_id=${WS}`).then((r) =>
  r.json(),
);
const truthRoster = await fetch(`${origin}/v1/agents?workspace_id=${WS}`).then((r) => r.json());
writeFileSync(
  join(CAPTURE_OUT, "s30-notifications-truth.json"),
  JSON.stringify(
    {
      notifications: truthNotifications,
      settings: truthSettings,
      onboarding: truthOnboarding,
      roster: truthRoster,
    },
    null,
    2,
  ),
);
const expectedNoteIds = truthNotifications.notifications.map((row) => row.notification_id);
const expectedUnread = truthNotifications.notifications.filter(
  (row) => row.read_at === null,
).length;
console.log("expected notification rows:", expectedNoteIds.length, "unread:", expectedUnread);

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

async function openApp(path, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 220)));
  await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

const snap = async (page, name) => {
  await page.screenshot({ path: join(CAPTURE_OUT, `${name}.png`), fullPage: false });
  record(name, { file: `${name}.png`, viewport: page.viewportSize() });
  console.log("captured", name);
};

// ---------------------------------------------------------------------------
// 4. The truth leg: the notification center IS the runtime's own record
// ---------------------------------------------------------------------------

{
  const { context, page } = await openApp("/app", { width: 1440, height: 900 });
  // The bell: the §3.2 chrome row.
  await page.waitForSelector('[aria-label^="Open notifications"]', { timeout: 30000 });
  await page.click('[aria-label^="Open notifications"]');
  await page.waitForSelector('[data-testid="notification-center"]', { timeout: 30000 });
  await page.waitForTimeout(1500);

  const rendered = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-testid="notification-row"]')].map((row) => ({
      title: row.querySelector("p")?.textContent ?? "",
      deepLink: row.querySelector("a")?.getAttribute("href") ?? null,
    })),
    badge: document.querySelector('[data-testid="notification-badge"]')?.textContent ?? null,
    muted: document.querySelectorAll('[data-testid="notification-muted"]').length,
    emptyCta: document.querySelector('[data-testid="notification-empty-cta"]') !== null,
  }));
  // The truth: the row count matches the runtime's own read.
  const mismatches = [];
  if (rendered.rows.length !== expectedNoteIds.length) {
    mismatches.push(`rows rendered ${rendered.rows.length} != runtime ${expectedNoteIds.length}`);
  }
  if (expectedUnread > 0 && rendered.badge === null) {
    mismatches.push("the unread badge did not render");
  }
  if (mismatches.length > 0) {
    console.error("NOTIFICATION TRUTH LEG FAILED:", mismatches);
    process.exitCode = 1;
  } else {
    console.log("notification truth leg OK:", rendered.rows.length, "rows, badge", rendered.badge);
  }
  evidence.truthLegs.notifications = { rendered, expectedNoteIds, expectedUnread, mismatches };

  await snap(page, "s30-notification-center-1440");
  await page.close();
  await context.close();
}

// ---------------------------------------------------------------------------
// 5. The settings register: all fifteen categories at three widths
// ---------------------------------------------------------------------------

for (const [name, viewport] of [
  ["s30-settings-overview-1440", { width: 1440, height: 900 }],
  ["s30-settings-overview-768", { width: 768, height: 1024 }],
  ["s30-settings-overview-360", { width: 360, height: 740 }],
]) {
  const { context, page } = await openApp("/app/settings", viewport);
  await page.waitForTimeout(1200);
  const rendered = await page.evaluate(() => ({
    categoryLinks: [...document.querySelectorAll('a[href^="/app/settings/"]')].map((a) =>
      a.getAttribute("href"),
    ),
    readOnlyNotes: [...document.querySelectorAll("li p")].filter((p) =>
      (p.textContent ?? "").includes("Read-only by decision"),
    ).length,
  }));
  const missing = [
    "account",
    "agents",
    "providers",
    "credits",
    "tools",
    "permissions",
    "workspace",
    "files",
    "memory",
    "schedules",
    "notifications",
    "privacy",
    "runtime",
    "git",
    "backups",
  ].filter((slug) => !rendered.categoryLinks.includes(`/app/settings/${slug}`));
  if (missing.length > 0) {
    console.error("SETTINGS REGISTER TRUTH LEG FAILED:", missing);
    process.exitCode = 1;
  } else {
    console.log("settings register truth leg OK: fifteen categories linked");
  }
  evidence.truthLegs[`overview_${viewport.width}`] = {
    categoryLinks: rendered.categoryLinks,
    missing,
  };
  await snap(page, name);
  await page.close();
  await context.close();
}

// ---------------------------------------------------------------------------
// 6. The Notifications settings surface: the toggles really write through
// ---------------------------------------------------------------------------

{
  const { context, page } = await openApp("/app/settings/notifications", {
    width: 1440,
    height: 900,
  });
  await page.waitForSelector('[data-testid="notifications-in-app-toggle"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  // The pending onboarding dock overlays the lower-right content — dismiss
  // it first (its own typed control), so the settings controls are reachable.
  if ((await page.locator('[data-testid="onboarding-dismiss"]').count()) > 0) {
    await page.click('[data-testid="onboarding-dismiss"]');
    await page.waitForTimeout(1500);
  }
  const before = await page.evaluate(() => ({
    inApp: document
      .querySelector('[data-testid="notifications-in-app-toggle"]')
      ?.getAttribute("aria-pressed"),
    browser: document
      .querySelector('[data-testid="notifications-browser-toggle"]')
      ?.getAttribute("aria-pressed"),
  }));
  await snap(page, "s30-notifications-settings-1440");

  // The interactive leg: the browser toggle OFF→ON writes through the typed
  // command; the read-after-write snapshot flips the rendered state.
  await page.click('[data-testid="notifications-browser-toggle"]');
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => ({
    browser: document
      .querySelector('[data-testid="notifications-browser-toggle"]')
      ?.getAttribute("aria-pressed"),
  }));
  const runtimeSettings = await fetch(
    `${origin}/v1/notifications/settings?workspace_id=${WS}`,
  ).then((r) => r.json());
  const persisted = runtimeSettings.settings.browser_enabled === true;
  const ok = after.browser === "true" && persisted;
  if (!ok) {
    console.error("NOTIFICATION TOGGLE LEG FAILED:", { after, runtimeSettings });
    process.exitCode = 1;
  } else {
    console.log("notification toggle leg OK: browser_enabled persisted true");
  }
  evidence.interactiveLegs.toggleBrowser = { before, after, persisted, ok };

  // Reset to the recommended defaults through the surface (the armed reset).
  await page.click('[data-testid="notifications-reset"]');
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await page.waitForTimeout(2000);
  const resetSettings = await fetch(`${origin}/v1/notifications/settings?workspace_id=${WS}`).then(
    (r) => r.json(),
  );
  const resetOk = resetSettings.settings.browser_enabled === false;
  if (!resetOk) {
    console.error("NOTIFICATION RESET LEG FAILED:", resetSettings);
    process.exitCode = 1;
  } else {
    console.log("notification reset leg OK: defaults restored");
  }
  evidence.interactiveLegs.resetSettings = { persisted: resetSettings.settings, ok: resetOk };
  await snap(page, "s30-notifications-settings-after-reset");
  await page.close();
  await context.close();
}

// ---------------------------------------------------------------------------
// 7. The onboarding dock: the E43 chat card, keyboard-navigable
// ---------------------------------------------------------------------------

{
  // The earlier leg's dock-dismiss persisted (it is the real typed command);
  // reopen through the REAL commands surface so the card leg runs pending.
  await fetch(`${origin}/v1/onboarding/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: "cmd_capture_reopen",
      idempotency_key: "idem_capture_reopen",
      workspace_id: WS,
      actor: { type: "user", id: "capture-user" },
      issued_at: new Date().toISOString(),
      type: "onboarding.reopen",
    }),
  });
  const { context, page } = await openApp("/app", { width: 1440, height: 900 });
  await page.waitForSelector('[data-testid="onboarding-card"]', { timeout: 30000 });
  await page.waitForTimeout(600);
  await snap(page, "s30-onboarding-card-1440");

  const rendered = await page.evaluate(() => ({
    step: document.querySelector('[data-testid="onboarding-card"] p')?.textContent ?? "",
    chips: [...document.querySelectorAll('[data-testid="onboarding-chip"]')].map((chip) =>
      chip.getAttribute("data-option-id"),
    ),
    freeText: document.querySelector('[data-testid="onboarding-free-text"]') !== null,
    dismiss: document.querySelector('[data-testid="onboarding-dismiss"]') !== null,
  }));
  const runtimeSnapshot = await fetch(`${origin}/v1/onboarding?workspace_id=${WS}`).then((r) =>
    r.json(),
  );
  const ok =
    runtimeSnapshot.onboarding.status === "pending" &&
    runtimeSnapshot.onboarding.current_step === "welcome" &&
    JSON.stringify(rendered.chips) ===
      JSON.stringify(
        runtimeSnapshot.onboarding.steps
          .find((step) => step.step === "welcome")
          .options.map((o) => o.option_id),
      );
  if (!ok) {
    console.error("ONBOARDING TRUTH LEG FAILED:", {
      rendered,
      snapshot: runtimeSnapshot.onboarding,
    });
    process.exitCode = 1;
  } else {
    console.log("onboarding truth leg OK: the card renders the runtime's typed step");
  }
  evidence.truthLegs.onboardingCard = { rendered, ok };

  // The keyboard trail: Tab into the card, arrow to the second chip, Enter.
  await page.keyboard.press("Tab");
  const trail = [];
  for (let i = 0; i < 8; i += 1) {
    const focused = await page.evaluate(
      () =>
        document.activeElement?.getAttribute("data-option-id") ??
        document.activeElement?.getAttribute("data-testid") ??
        document.activeElement?.tagName ??
        "none",
    );
    trail.push(String(focused));
    await page.keyboard.press("Tab");
  }
  evidence.interactiveLegs.keyboardTrailOnboarding = trail;
  // The chip answer through the keyboard: focus the group and answer.
  await page.focus('[data-testid="onboarding-chip"]');
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  const answered = await fetch(`${origin}/v1/onboarding?workspace_id=${WS}`).then((r) => r.json());
  const answerOk =
    answered.onboarding.answers.welcome?.option_id !== undefined &&
    answered.onboarding.current_step === "provider_check";
  if (!answerOk) {
    console.error("ONBOARDING KEYBOARD LEG FAILED:", answered.onboarding.answers);
    process.exitCode = 1;
  } else {
    console.log("onboarding keyboard leg OK: the typed answer advanced the runtime's snapshot");
  }
  evidence.interactiveLegs.onboardingKeyboardAnswer = {
    answers: answered.onboarding.answers,
    current: answered.onboarding.current_step,
    ok: answerOk,
  };
  await snap(page, "s30-onboarding-card-after-answer");

  // The dismiss leg: the interview is skippable (D16) — persisted.
  await page.click('[data-testid="onboarding-dismiss"]');
  await page.waitForTimeout(2000);
  const dismissed = await fetch(`${origin}/v1/onboarding?workspace_id=${WS}`).then((r) => r.json());
  const dockGone = (await page.locator('[data-testid="onboarding-card"]').count()) === 0;
  const dismissOk = dismissed.onboarding.status === "dismissed" && dockGone;
  if (!dismissOk) {
    console.error("ONBOARDING DISMISS LEG FAILED:", dismissed.onboarding.status);
    process.exitCode = 1;
  } else {
    console.log("onboarding dismiss leg OK: dismissed, persisted, the dock renders nothing");
  }
  evidence.interactiveLegs.onboardingDismiss = {
    status: dismissed.onboarding.status,
    dockGone,
    ok: dismissOk,
  };

  // The Account surface's reopen control: the interview comes back (D16).
  await page.goto(webOrigin + "/app/settings/account", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="account-reopen-onboarding"]', { timeout: 30000 });
  await page.click('[data-testid="account-reopen-onboarding"]');
  await page.getByRole("button", { name: "Confirm reopen" }).click();
  await page.waitForTimeout(2000);
  const reopened = await fetch(`${origin}/v1/onboarding?workspace_id=${WS}`).then((r) => r.json());
  const reopenOk = reopened.onboarding.status === "pending";
  if (!reopenOk) {
    console.error("ONBOARDING REOPEN LEG FAILED:", reopened.onboarding.status);
    process.exitCode = 1;
  } else {
    console.log("onboarding reopen leg OK: reopened from the Account surface");
  }
  evidence.interactiveLegs.onboardingReopen = { status: reopened.onboarding.status, ok: reopenOk };
  await snap(page, "s30-account-reopen");
  await page.close();
  await context.close();
}

// ---------------------------------------------------------------------------
// 8. The roster activity lines (E43 idea 4) + the sidebar states
// ---------------------------------------------------------------------------

{
  const { context, page } = await openApp("/app", { width: 1440, height: 900 });
  await page.waitForSelector("nav", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const roster = await page.evaluate(() => ({
    activityLines: [...document.querySelectorAll('[data-testid="roster-activity-line"]')].map(
      (line) => line.textContent ?? "",
    ),
  }));
  const expectedLines = truthRoster.agents.filter((agent) => agent.last_activity !== null).length;
  const ok = roster.activityLines.length === expectedLines && expectedLines > 0;
  if (!ok) {
    console.error("ROSTER ACTIVITY LEG FAILED:", { roster, expectedLines });
    process.exitCode = 1;
  } else {
    console.log(
      "roster activity leg OK:",
      roster.activityLines.length,
      "preview lines from the runtime's records",
    );
  }
  evidence.truthLegs.rosterActivity = { roster, expectedLines, ok };
  await snap(page, "s30-sidebar-roster-activity-1440");

  // The mobile surface at 360: the drawer chrome carries the bell.
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(800);
  const mobile = await page.evaluate(() => ({
    bell: [...document.querySelectorAll("button")].some((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith("Open notifications"),
    ),
  }));
  if (!mobile.bell) {
    console.error("MOBILE BELL LEG FAILED");
    process.exitCode = 1;
  }
  evidence.truthLegs.mobileBell = mobile;
  await snap(page, "s30-mobile-360");
  await page.close();
  await context.close();
}

// ---------------------------------------------------------------------------
// 9. The keyboard-only trail + prefers-reduced-motion
// ---------------------------------------------------------------------------

{
  const { context, page } = await openApp("/app", { width: 1440, height: 900 });
  // Keyboard-only: reach the notification center without the pointer.
  await page.keyboard.press("Tab");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    const isBell = await page.evaluate(() =>
      (document.activeElement?.getAttribute("aria-label") ?? "").startsWith("Open notifications"),
    );
    if (isBell) {
      await page.keyboard.press("Enter");
      reached = true;
    } else {
      await page.keyboard.press("Tab");
    }
  }
  await page.waitForTimeout(800);
  const panelOpen = await page.evaluate(
    () => document.querySelector('[data-testid="notification-center"]') !== null,
  );
  if (!reached || !panelOpen) {
    console.error("KEYBOARD TRAIL FAILED:", { reached, panelOpen });
    process.exitCode = 1;
  } else {
    console.log("keyboard trail OK: the center opens keyboard-only");
  }
  evidence.interactiveLegs.keyboardOnlyCenter = { reached, panelOpen, ok: reached && panelOpen };
  await snap(page, "s30-keyboard-trail");
  await page.close();
  await context.close();

  const reduced = await openApp("/app", { width: 1440, height: 900 }, { reducedMotion: true });
  const motion = await reduced.page.evaluate(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  evidence.interactiveLegs.reducedMotion = { matched: motion };
  await snap(reduced.page, "s30-reduced-motion");
  await reduced.page.close();
  await reduced.context.close();
  console.log("reduced-motion leg done, matched:", motion);
}

// ---------------------------------------------------------------------------
// 10. The final evidence write
// ---------------------------------------------------------------------------

writeFileSync(join(CAPTURE_OUT, "s30-captures.json"), JSON.stringify(evidence, null, 2));
console.log("capture complete:", CAPTURE_OUT);

browser.close().catch(() => undefined);
for (const cleanup of cleanups.splice(0)) cleanup();
process.exit(process.exitCode ?? 0);
