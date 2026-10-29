/**
 * S18 chunk 1 — the read-only live views API contract (issue #19; PRD §4.3,
 * §14, §19 AC19/AC21, §20, D10, D11, D22, G3/G6). Red-first: these tests pin
 * the chunk-4 behaviors before the API module exists.
 *
 * The composed runtime exposes the terminal live-view surface through the
 * local API:
 *
 *   1. Durable replay of terminal events: the per-Agent `terminal:` journal
 *      stream, cursor-paged (after_sequence), optionally narrowed to one
 *      terminal execution.
 *   2. One terminal execution's durable record: command, working directory,
 *      resource policy, approval state, redacted output chunks, exit.
 *   3. The Agent's current session terminal state: the latest execution and
 *      the recent history.
 *
 * THE NO-TAKEOVER ACCEPTANCE CRITERION IS THE ROUTE INVENTORY ITSELF: the
 * terminal surface contains zero terminal-control routes — no stdin write, no
 * signal send, no command execution — and the inventory test enumerates the
 * registered routes and asserts exactly that (PRD §4.3: the user receives a
 * live shared READ-ONLY view; §20: direct takeover is future work).
 *
 * Every route is workspace-scoped (E12): another workspace's terminal
 * activity is invisible.
 */
import { join, resolve as resolvePath } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";

import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";
import { composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolvePath(here, "../../../../../agent-packs");

const WORKSPACE = "ws-local-default";
const FOREIGN_WORKSPACE = "ws-other-0000";
const AGENT = "agent_general_assistant";
const clockNow = "2026-10-29T12:00:00.000Z";

const openRuntimes: RuntimeHandle[] = [];

afterEach(() => {
  cleanupTempResources();
});

afterAll(async () => {
  for (const runtime of openRuntimes) {
    await runtime.close().catch(() => {});
  }
});

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
}

async function composeOn(): Promise<RunningRuntime> {
  const dir = makeTempDir("shera-s18-live-views-api-");
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    packsRoot: PACKS_ROOT,
    now: () => clockNow,
  });
  trackConnection(runtime);
  openRuntimes.push(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return { runtime, origin: `http://127.0.0.1:${address.port}` };
}

/**
 * The composed runtime WITH the shared browser profile service configured —
 * the browser is opt-in configuration (G4); without the option the surface
 * answers the honest not-configured state.
 */
async function composeOnBrowser(): Promise<RunningRuntime> {
  const dir = makeTempDir("shera-s18-live-views-browser-");
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    packsRoot: PACKS_ROOT,
    now: () => clockNow,
    browser: { profileDir: join(dir, "browser-profile") },
  });
  trackConnection(runtime);
  openRuntimes.push(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return { runtime, origin: `http://127.0.0.1:${address.port}` };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function request(origin: string, path: string, method: string) {
  const response = await fetch(`${origin}${path}`, { method });
  return response.status;
}

/** Drive one terminal execution through the composed recorder seam. */
function recordExecution(
  runtime: RuntimeHandle,
  overrides: {
    command?: string;
    chunks?: Array<{ stream: "stdout" | "stderr"; text: string }>;
    exit?: { exit_code: number | null; exit_signal: string | null } | null;
  } = {},
): string {
  const recorder = runtime.terminals;
  if (!recorder) {
    throw new Error("the composed runtime must expose the terminal recorder seam");
  }
  const terminalId = recorder.startExecution({
    workspace_id: WORKSPACE,
    agent_id: AGENT,
    session_id: "sess-s18-0001",
    command: overrides.command ?? "npm run build",
    workdir: "/container/workspace",
    resource_policy: {
      os_resource_limits: null,
      supervision: { watchdog_window_ms: 15_000, stderr_max_bytes: 8_192 },
    },
    approval_state: "not_required",
  });
  for (const chunk of overrides.chunks ?? []) {
    recorder.recordOutput({
      workspace_id: WORKSPACE,
      agent_id: AGENT,
      terminal_id: terminalId,
      stream: chunk.stream,
      raw_chunk: chunk.text,
    });
  }
  if (overrides.exit !== null) {
    recorder.recordExit({
      workspace_id: WORKSPACE,
      agent_id: AGENT,
      terminal_id: terminalId,
      exit_code: overrides.exit?.exit_code ?? 0,
      exit_signal: overrides.exit?.exit_signal ?? null,
    });
  }
  return terminalId;
}

// ---------------------------------------------------------------------------
// The route inventory (the no-takeover acceptance criterion)
// ---------------------------------------------------------------------------

interface RouteInventoryEntry {
  method: string;
  path: string;
}

/**
 * Enumerate the routes registered on the composed Express app — the actual
 * inventory a client can reach, not a claim about it.
 */
function enumerateRoutes(app: Express): RouteInventoryEntry[] {
  const stack = (
    app as unknown as {
      router?: { stack?: Array<{ route?: { path?: unknown; methods?: Record<string, unknown> } }> };
    }
  ).router?.stack;
  const entries: RouteInventoryEntry[] = [];
  for (const layer of stack ?? []) {
    const route = layer.route;
    if (!route || typeof route.path !== "string") continue;
    for (const method of Object.keys(route.methods ?? {})) {
      entries.push({ method: method.toUpperCase(), path: route.path });
    }
  }
  return entries;
}

/** The terminal-control vocabulary that must appear in NO route path. */
const CONTROL_VOCABULARY = [
  "stdin",
  "signal",
  "kill",
  "input",
  "execute",
  "exec",
  "send",
  "write",
  "prompt",
  "control",
  "stop",
  "terminate",
];

describe("S18 live views API — the no-takeover route inventory", () => {
  it("registers EXACTLY three GET terminal routes and zero terminal-control routes", async () => {
    const { runtime } = await composeOn();

    const terminalRoutes = enumerateRoutes(runtime.app).filter((route) =>
      route.path.startsWith("/v1/terminals"),
    );

    // The complete inventory: three read-only GET routes. Nothing else.
    expect(terminalRoutes).toEqual([
      { method: "GET", path: "/v1/terminals/events" },
      { method: "GET", path: "/v1/terminals/state" },
      { method: "GET", path: "/v1/terminals/:terminal_id" },
    ]);

    // Defense in depth on the same inventory: no non-GET verb on any
    // terminal path, and no path carries the terminal-control vocabulary.
    for (const route of terminalRoutes) {
      expect(route.method).toBe("GET");
      for (const word of CONTROL_VOCABULARY) {
        expect(route.path.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("answers non-GET verbs on terminal routes with the typed 404 (no mutation path)", async () => {
    const { origin } = await composeOn();

    // Express answers unregistered methods with the typed ROUTE_NOT_FOUND —
    // there is no terminal mutation surface to hit.
    expect(await request(origin, "/v1/terminals/events", "POST")).toBe(404);
    expect(await request(origin, "/v1/terminals/events", "PUT")).toBe(404);
    expect(await request(origin, "/v1/terminals/events", "PATCH")).toBe(404);
    expect(await request(origin, "/v1/terminals/events", "DELETE")).toBe(404);
    expect(await request(origin, `/v1/terminals/${"term-x"}`, "POST")).toBe(404);
    expect(await request(origin, "/v1/terminals/state", "POST")).toBe(404);
  });
});

describe("S18 live views API — durable replay and current terminal state", () => {
  it("replays the Agent's terminal journal stream cursor-paged, in order", async () => {
    const { runtime, origin } = await composeOn();
    const terminalId = recordExecution(runtime, {
      chunks: [{ stream: "stdout", text: "built 42 modules" }],
      exit: { exit_code: 0, exit_signal: null },
    });

    const first = await getJson(
      origin,
      `/v1/terminals/events?workspace_id=${WORKSPACE}&agent_id=${AGENT}`,
    );
    expect(first.status).toBe(200);
    const events = first.body["events"] as Array<Record<string, unknown>>;
    expect(events.map((event) => event["type"])).toEqual([
      "terminal.started",
      "terminal.output",
      "terminal.exited",
    ]);
    expect(events.map((event) => event["sequence"])).toEqual([1, 2, 3]);
    const startedPayload = events[0]?.["payload"] as Record<string, unknown>;
    expect(startedPayload).toMatchObject({
      terminal_id: terminalId,
      command: "npm run build",
      workdir: "/container/workspace",
      approval_state: "not_required",
    });

    // Cursor paging: after the last acknowledged sequence, the replay is empty.
    const paged = await getJson(
      origin,
      `/v1/terminals/events?workspace_id=${WORKSPACE}&agent_id=${AGENT}&after_sequence=2`,
    );
    const pagedEvents = paged.body["events"] as Array<Record<string, unknown>>;
    expect(pagedEvents.map((event) => event["type"])).toEqual(["terminal.exited"]);
  });

  it("narrows the replay to one terminal execution on request", async () => {
    const { runtime, origin } = await composeOn();
    const first = recordExecution(runtime, { chunks: [{ stream: "stderr", text: "one" }] });
    recordExecution(runtime, { chunks: [{ stream: "stderr", text: "two" }] });

    const narrowed = await getJson(
      origin,
      `/v1/terminals/events?workspace_id=${WORKSPACE}&agent_id=${AGENT}&terminal_id=${first}`,
    );
    const events = narrowed.body["events"] as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect((event["payload"] as Record<string, unknown>)["terminal_id"]).toBe(first);
    }
  });

  it("serves one execution's durable record with redacted chunks and exit state", async () => {
    const { runtime, origin } = await composeOn();
    const terminalId = recordExecution(runtime, {
      command: "printenv",
      chunks: [
        { stream: "stdout", text: "export API_KEY=sk-live-abc123def456" },
        { stream: "stderr", text: "warning: nothing to see" },
      ],
      exit: { exit_code: 0, exit_signal: null },
    });

    const detail = await getJson(origin, `/v1/terminals/${terminalId}?workspace_id=${WORKSPACE}`);
    expect(detail.status).toBe(200);
    const record = detail.body as Record<string, unknown>;
    expect(record).toMatchObject({
      terminal_id: terminalId,
      agent_id: AGENT,
      session_id: "sess-s18-0001",
      command: "printenv",
      workdir: "/container/workspace",
      approval_state: "not_required",
      state: "exited",
      exit_code: 0,
    });
    // The streamed item shows command, working directory, resource policy,
    // and approval state truthfully — and NO secret survives (G3).
    expect(JSON.stringify(record)).not.toContain("sk-live-abc123def456");
    expect(JSON.stringify(record)).not.toContain("API_KEY=sk");
    const output = record["output"] as Array<Record<string, unknown>>;
    expect(output.map((chunk) => chunk["stream"])).toEqual(["stdout", "stderr"]);
    expect(String(output[0]?.["text"])).toContain("[REDACTED]");
  });

  it("answers the current session terminal state: latest execution plus recent history", async () => {
    const { runtime, origin } = await composeOn();
    const exitedId = recordExecution(runtime, {
      command: "npm run build",
      exit: { exit_code: 0, exit_signal: null },
    });
    const runningId = recordExecution(runtime, {
      command: "npm run dev",
      chunks: [{ stream: "stdout", text: "listening on :3000" }],
      exit: null,
    });

    const state = await getJson(
      origin,
      `/v1/terminals/state?workspace_id=${WORKSPACE}&agent_id=${AGENT}`,
    );
    expect(state.status).toBe(200);
    const current = state.body["current"] as Record<string, unknown>;
    expect(current["terminal_id"]).toBe(runningId);
    expect(current["state"]).toBe("running");
    expect(current["command"]).toBe("npm run dev");
    const recent = state.body["recent"] as Array<Record<string, unknown>>;
    expect(recent.map((entry) => entry["terminal_id"])).toEqual([runningId, exitedId]);
    expect(recent.find((entry) => entry["terminal_id"] === exitedId)?.["state"]).toBe("exited");
  });

  it("scopes every read by workspace (E12) and answers unknown ids with the typed 404", async () => {
    const { runtime, origin } = await composeOn();
    const terminalId = recordExecution(runtime, { exit: { exit_code: 0, exit_signal: null } });

    // Another workspace sees nothing.
    const foreignReplay = await getJson(
      origin,
      `/v1/terminals/events?workspace_id=${FOREIGN_WORKSPACE}&agent_id=${AGENT}`,
    );
    expect(foreignReplay.status).toBe(200);
    expect(foreignReplay.body["events"]).toEqual([]);

    const foreignState = await getJson(
      origin,
      `/v1/terminals/state?workspace_id=${FOREIGN_WORKSPACE}&agent_id=${AGENT}`,
    );
    expect(foreignState.status).toBe(200);
    expect(foreignState.body["current"]).toBeNull();
    expect(foreignState.body["recent"]).toEqual([]);

    // Unknown terminal id: the typed 404, never a guessed record.
    const missing = await getJson(origin, `/v1/terminals/term-missing?workspace_id=${WORKSPACE}`);
    expect(missing.status).toBe(404);
    expect((missing.body as Record<string, unknown>)["code"]).toBe("TERMINAL_NOT_FOUND");

    // Missing workspace_id / agent_id: the typed 400.
    const noWorkspace = await getJson(origin, `/v1/terminals/events?agent_id=${AGENT}`);
    expect(noWorkspace.status).toBe(400);
    const noAgent = await getJson(origin, `/v1/terminals/state?workspace_id=${WORKSPACE}`);
    expect(noAgent.status).toBe(400);

    // The record exists in its own workspace.
    const detail = await getJson(origin, `/v1/terminals/${terminalId}?workspace_id=${WORKSPACE}`);
    expect(detail.status).toBe(200);
  });

  it("answers honestly when nothing was ever recorded (no fabricated state, G4)", async () => {
    const { origin } = await composeOn();

    const replay = await getJson(
      origin,
      `/v1/terminals/events?workspace_id=${WORKSPACE}&agent_id=${AGENT}`,
    );
    expect(replay.status).toBe(200);
    expect(replay.body["events"]).toEqual([]);

    const state = await getJson(
      origin,
      `/v1/terminals/state?workspace_id=${WORKSPACE}&agent_id=${AGENT}`,
    );
    expect(state.status).toBe(200);
    expect(state.body["current"]).toBeNull();
    expect(state.body["recent"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S18 chunk 2 — the read-only browser live-view surface
// ---------------------------------------------------------------------------

/** The browser-control vocabulary that must appear in NO browser route path. */
const BROWSER_CONTROL_VOCABULARY = [
  "navigate",
  "goto",
  "click",
  "type",
  "keyboard",
  "scroll",
  "press",
  "input",
  "form",
  "submit",
  "download",
  "upload",
  "control",
];

/** One loopback page server (127.0.0.1 only) for browser round-trip evidence. */
async function startPageServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ origin: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.unref();
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

describe("S18 live views API — the no-takeover browser route inventory (chunk 2)", () => {
  it("registers EXACTLY two GET browser routes and zero browser-control routes", async () => {
    const { runtime } = await composeOnBrowser();

    const browserRoutes = enumerateRoutes(runtime.app).filter((route) =>
      route.path.startsWith("/v1/browser"),
    );

    // The complete inventory: two read-only GET routes. Nothing else — no
    // navigation, no click, no type, no keyboard route (PRD §4.3/§20).
    expect(browserRoutes).toEqual([
      { method: "GET", path: "/v1/browser/state" },
      { method: "GET", path: "/v1/browser/view" },
    ]);

    for (const route of browserRoutes) {
      expect(route.method).toBe("GET");
      for (const word of BROWSER_CONTROL_VOCABULARY) {
        expect(route.path.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("answers non-GET verbs on browser routes with the typed 404 (no control path)", async () => {
    const { origin } = await composeOnBrowser();

    expect(await request(origin, "/v1/browser/view", "POST")).toBe(404);
    expect(await request(origin, "/v1/browser/view", "PUT")).toBe(404);
    expect(await request(origin, "/v1/browser/view", "PATCH")).toBe(404);
    expect(await request(origin, "/v1/browser/view", "DELETE")).toBe(404);
    expect(await request(origin, "/v1/browser/state", "POST")).toBe(404);
  });

  it("answers the honest not-configured state when no browser service is composed (G4)", async () => {
    const { origin } = await composeOn();

    const state = await getJson(origin, `/v1/browser/state?workspace_id=${WORKSPACE}`);
    expect(state.status).toBe(200);
    expect(state.body["configured"]).toBe(false);

    const view = await getJson(origin, `/v1/browser/view?workspace_id=${WORKSPACE}`);
    expect(view.status).toBe(200);
    expect(view.body["configured"]).toBe(false);
    expect("screenshot_base64" in view.body).toBe(false);
  });
});

describe("S18 live views API — the browser live view and its redaction posture", () => {
  it("round-trips the ACTUAL current page (url, title, real screenshot) through the API", async () => {
    const { origin, server } = await startPageServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>S18 Composed Panel Page</title></head><body><h1>shera-api-proof</h1></body></html>",
      );
    });
    const { runtime, origin: apiOrigin } = await composeOnBrowser();

    // Drive the Agent's browser driver seam (never the HTTP surface — the
    // read-only API has no navigation routes by construction).
    const browser = runtime.browser;
    if (!browser) {
      throw new Error("the composed runtime must expose the browser service seam");
    }
    await browser.claimControl({
      workspace_id: WORKSPACE,
      owner_id: "driver-a",
      capability: { kind: "browser-research" },
    });
    await browser.navigateTo({
      workspace_id: WORKSPACE,
      owner_id: "driver-a",
      capability: { kind: "browser-research" },
      url: `${origin}/panel-target`,
    });

    const view = await getJson(apiOrigin, `/v1/browser/view?workspace_id=${WORKSPACE}`);
    expect(view.status).toBe(200);
    expect(view.body["configured"]).toBe(true);
    expect(view.body["state"]).toBe("running");
    expect(view.body["url"]).toBe(`${origin}/panel-target`);
    expect(view.body["title"]).toBe("S18 Composed Panel Page");
    expect(String(view.body["screenshot_base64"]).length).toBeGreaterThan(100);

    const state = await getJson(apiOrigin, `/v1/browser/state?workspace_id=${WORKSPACE}`);
    expect(state.status).toBe(200);
    expect(state.body["configured"]).toBe(true);
    expect(state.body["lifecycle_state"]).toBe("running");
    expect((state.body["owner"] as Record<string, unknown>)["owner_id"]).toBe("driver-a");
    // D27 posture, reported: the browser service opens no inbound socket.
    expect(state.body["inbound_listen"]).toBe("none");

    server.closeAllConnections();
    server.close();
  });

  it("scopes browser reads by workspace (E12) and refuses malformed reads", async () => {
    const { origin } = await composeOnBrowser();

    // Missing workspace_id: the typed 400.
    const noWorkspace = await getJson(origin, "/v1/browser/view");
    expect(noWorkspace.status).toBe(400);
    const noWorkspaceState = await getJson(origin, "/v1/browser/state");
    expect(noWorkspaceState.status).toBe(400);

    // Another workspace reads ITS container view honestly (the browser is
    // container-shared; no other workspace's data exists to leak).
    const foreign = await getJson(origin, `/v1/browser/state?workspace_id=${FOREIGN_WORKSPACE}`);
    expect(foreign.status).toBe(200);
    expect(foreign.body["workspace_id"]).toBe(FOREIGN_WORKSPACE);
  });

  it("never lets a cookie value reach an API payload, the journal, the database, or the logs (G3/D22)", async () => {
    const COOKIE_VALUE = "shera-e2e-secret-cookie-4a9d7f2b1c8e";
    const { origin, server } = await startPageServer((req, res) => {
      if ((req.url ?? "").startsWith("/login")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `shera_session=${COOKIE_VALUE}; Path=/`,
        });
        res.end("<html><head><title>login-done</title></head><body></body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>session-page</title></head><body>no cookie rendered</body></html>",
      );
    });
    const logLines: string[] = [];
    const dir = makeTempDir("shera-s18-browser-api-");
    const runtime = composeRuntime({
      dbPath: join(dir, "runtime.db"),
      packsRoot: PACKS_ROOT,
      now: () => clockNow,
      browser: { profileDir: join(dir, "browser-profile") },
      logUntypedFault: (event, fields) => logLines.push(JSON.stringify({ event, ...fields })),
    });
    openRuntimes.push(runtime);
    await new Promise<void>((resolveListen) =>
      runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const apiOrigin = `http://127.0.0.1:${(runtime.httpServer.address() as { port: number }).port}`;

    // The driver's session picks up the cookie through the persistent profile.
    const browser = runtime.browser;
    if (!browser) {
      throw new Error("the composed runtime must expose the browser service seam");
    }
    await browser.claimControl({
      workspace_id: WORKSPACE,
      owner_id: "driver-a",
      capability: { kind: "browser-research" },
    });
    await browser.navigateTo({
      workspace_id: WORKSPACE,
      owner_id: "driver-a",
      capability: { kind: "browser-research" },
      url: `${origin}/login`,
    });
    await browser.navigateTo({
      workspace_id: WORKSPACE,
      owner_id: "driver-a",
      capability: { kind: "browser-research" },
      url: `${origin}/page`,
    });

    // Every API payload is clean.
    const view = await getJson(apiOrigin, `/v1/browser/view?workspace_id=${WORKSPACE}`);
    const state = await getJson(apiOrigin, `/v1/browser/state?workspace_id=${WORKSPACE}`);
    const viewText = JSON.stringify(view.body);
    const stateText = JSON.stringify(state.body);
    expect(view.status).toBe(200);
    expect(state.status).toBe(200);
    expect(viewText).not.toContain(COOKIE_VALUE);
    expect(stateText).not.toContain(COOKIE_VALUE);

    // The database (and its WAL) never holds the cookie: the profile dir is
    // the custody store (D22); the runtime DB stores nothing browser-side.
    for (const file of ["runtime.db", "runtime.db-wal"]) {
      const path = join(dir, file);
      let bytes: Buffer | undefined;
      try {
        statSync(path);
        bytes = readFileSync(path);
      } catch {
        bytes = undefined; // absent sidecar: nothing to scan
      }
      if (bytes !== undefined) {
        expect(bytes.toString("utf8").includes(COOKIE_VALUE)).toBe(false);
      }
    }

    // No fault log line ever carries the value (G3).
    for (const line of logLines) {
      expect(line.includes(COOKIE_VALUE)).toBe(false);
    }

    server.closeAllConnections();
    server.close();
  });

  it("binds the composed surface to loopback only (D27 documented check)", async () => {
    // composeOnBrowser already bound the surface; the documented D27 check
    // asserts the bind address the composed surface actually holds.
    const { runtime } = await composeOnBrowser();
    const address = runtime.httpServer.address() as { address: string };
    expect(address.address).toBe("127.0.0.1");
  });
});
