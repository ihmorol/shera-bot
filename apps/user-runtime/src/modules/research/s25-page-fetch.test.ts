/**
 * S25 page fetch (chunk 2; issue #26 AC1/AC3/AC4; D15, D23 rule 8, D27, D35,
 * G3/G6/G7) — the read-only page-fetch tool: fetch → @mozilla/readability →
 * turndown markdown, with timeouts, response-size caps, and the artifact
 * policy for large content (never a crash, never an unbounded prompt).
 *
 * Pinned here:
 *   1. AC7 complement — the page-fetch tool DECLARES its recovery class
 *      (idempotent_retry: re-reading a page is safe), the counterpart of
 *      chunk 1's omitted-class default pin.
 *   2. AC1/AC3 — a normal page extracts to markdown end-to-end against the
 *      local deterministic fixture; a streamed body larger than the byte cap
 *      is truncated by policy into an artifact, never a crash.
 *   3. AC4 — large outputs become artifacts with provenance; the prompt
 *      payload (the result text) stays bounded.
 *   4. The deadline is enforced as the typed TOOL_EXECUTION_TIMEOUT; a
 *      non-http scheme is refused typed BEFORE any fetch.
 *   5. The D27 separation: the research family opens sockets (every test
 *      here is a real loopback socket) while the execution family spawns
 *      network-disabled — the reason these tools may open sockets at all.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ToolExecutor, canonicalArgsDigest } from "../tools/tool-executor.service.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { makeExecutionAuthority, type ToolExecutionContext } from "../tools/tool-binding.ts";
import {
  makeCodeExecutionBinding,
  type ExecutionToolDeps,
} from "../execution/execution-tool-binding.ts";
import { registerResearchTools } from "../../transport/local-api/s25-research-api.ts";

const WS = "ws_default_01";
const TASK = "task_s25_fetch";
const CONV = "conv_s25_fetch";
const AGENT = "agent_researcher";
const NOW = "2026-11-02T12:00:00.000Z";

const tempDirs: string[] = [];

/** The canned article the fixture serves for the extraction leg. */
const ARTICLE_HTML = `<!doctype html><html><head><title>Attention Paper Review</title></head>
<body>
<nav>menu noise</nav>
<article><h1>Attention Paper Review</h1>
<p>The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose the Transformer, which dispenses with
recurrence entirely.</p>
</article>
</body></html>`;

/** Build a big HTML page whose text is `paragraphs` repeated blocks. */
function bigHtml(blocks: number): string {
  const paragraph =
    "Evidence tables should cite the source for every claim, keep the quotation attached to its provenance, and mark the confidence explicitly so the reader can audit it. ";
  const body = `<p>${paragraph.repeat(4).trim()}</p>`;
  return `<!doctype html><html><head><title>Large Evidence Report</title></head><body><article>${Array.from(
    { length: blocks },
    () => body,
  ).join("")}</article></body></html>`;
}

interface FixtureRoute {
  match: (url: URL) => boolean;
  handle: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ) => void;
}

let fixture: Server;
let fixtureOrigin = "";
let fetchCalls = 0;
let routes: FixtureRoute[] = [];

function defaultRoutes(): FixtureRoute[] {
  return [
    {
      match: (url) => url.pathname === "/article",
      handle: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(ARTICLE_HTML);
      },
    },
    {
      match: (url) => url.pathname === "/large",
      handle: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(bigHtml(120));
      },
    },
    {
      // AC3: a STREAMED response larger than the tool's byte cap — chunked,
      // with the body intentionally exceeding the fetch cap.
      match: (url) => url.pathname === "/oversized-stream",
      handle: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        const chunk = `<p>${"streamed evidence row. ".repeat(64)}</p>`;
        let sent = 0;
        const timer = setInterval(() => {
          res.write(chunk);
          sent += chunk.length;
          if (sent > 512 * 1024) {
            clearInterval(timer);
            res.end();
          }
        }, 5);
        res.on("close", () => clearInterval(timer));
      },
    },
    {
      // The deadline leg: headers now, body never completes in time.
      match: (url) => url.pathname === "/slow",
      handle: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.write("<p>start");
        const timer = setInterval(() => res.write(" more"), 50);
        res.on("close", () => clearInterval(timer));
      },
    },
  ];
}

beforeAll(async () => {
  routes = defaultRoutes();
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = routes.find((candidate) => candidate.match(url));
    fetchCalls += 1;
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    route.handle(req, res, url);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRun(taskId = TASK): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s25_fetch" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "b".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

interface FetchRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  tools: ToolsRepository;
  artifacts: ArtifactsRepository;
  conn: ReturnType<typeof openDatabase>;
}

function buildRuntime(clockNowMs: () => number = () => 1_000): FetchRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-s25-fetch-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const tools = new ToolsRepository(conn.db);
  const artifacts = new ArtifactsRepository(tx);
  const registry = new ToolRegistry();
  registerResearchTools(registry, WS, {
    searxng: null,
    artifacts,
    files: null,
    visionModel: null,
    // The G7 fixture posture: the deterministic fixtures run on loopback, so
    // the fixture origin is the explicitly allowed one (review fix F2).
    pageFetchAllowedOrigins: [fixtureOrigin],
  });
  const executor = new ToolExecutor({
    registry,
    tools,
    tx,
    nowMs: clockNowMs,
    now: () => NOW,
  });
  return { executor, registry, tools, artifacts, conn };
}

function fetchProposal(rt: FetchRuntime, rawArgs: Record<string, unknown>, taskId = TASK) {
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: taskId,
      conversation_id: CONV,
      tool_id: "tool_page_fetch",
      tool_version: "1.0.0",
      capability: "research.fetch",
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "read the page",
    },
    run: makeRun(taskId),
    agent_id: AGENT,
    rawArgs,
  });
}

afterEach(() => {
  fetchCalls = 0;
});

describe("page-fetch inventory declaration (S25 chunk 2, AC7)", () => {
  it("declares the page-fetch built-in with its recovery class declared", () => {
    const rt = buildRuntime();
    const record = rt.registry.resolve(WS, "tool_page_fetch", "1.0.0");
    expect(record).not.toBeNull();
    const definition = record!.definition;
    expect(definition.risk_class).toBe("READ_ONLY");
    expect(definition.capabilities).toEqual(["research.fetch"]);
    expect(definition.approval_policy).toBe("auto_read_only");
    expect(definition.redaction_policy).toBe("standard");
    expect((definition.input_schema as Record<string, unknown>).required).toContain("url");
    // The declared class (the complement of chunk 1's omitted-default pin):
    // re-reading a page is safe, so the record says idempotent_retry.
    expect(definition.recovery).toBe("idempotent_retry");
  });
});

describe("page fetch executes read-only through the executor (S25 chunk 2)", () => {
  it("extracts a readable article as markdown with no approval row", async () => {
    const rt = buildRuntime();
    const dispatched = fetchProposal(rt, { url: `${fixtureOrigin}/article` });
    expect(dispatched.outcome).toBe("dispatched");
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("executed");
    if (outcome.outcome !== "executed") throw new Error("expected executed");
    const row = rt.tools.listExecutionsByTask(WS, TASK)[0]!;
    expect(row.status).toBe("succeeded");
    expect(row.risk_class).toBe("READ_ONLY");
    expect(row.approval_id).toBeNull();
    expect(row.result_summary).toContain("Attention Paper Review");
    expect(row.result_summary).toContain("Transformer");
    // The navigation noise the readability extraction removes.
    expect(row.result_summary).not.toContain("menu noise");
    expect(row.result_summary).toContain(fixtureOrigin);
  });

  it("AC4: large fetched content becomes an artifact with provenance and the result stays bounded", async () => {
    const rt = buildRuntime();
    const dispatched = fetchProposal(rt, { url: `${fixtureOrigin}/large` });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("executed");
    if (outcome.outcome !== "executed") throw new Error("expected executed");
    // The result text (the prompt payload) is bounded regardless of page size.
    expect(outcome.result_summary.length).toBeLessThanOrEqual(9_000);
    expect(outcome.result_summary).toContain("captured as artifact");
    // The artifact exists with the producing run + agent as provenance.
    const runArtifacts = rt.artifacts.listArtifactsByRun(TASK);
    expect(runArtifacts).toHaveLength(1);
    const ref = runArtifacts[0]!;
    expect(ref.producer_task_id).toBe(TASK);
    expect(ref.producer_agent_id).toBe(AGENT);
    expect(ref.size).toBeGreaterThan(64 * 1024);
    const withContent = rt.artifacts.getArtifact(WS, ref.artifact_id)!;
    const text = Buffer.from(withContent.content).toString("utf8");
    expect(text).toContain("Evidence tables should cite the source");
    expect(withContent.size).toBe(ref.size);
    // The history row carries the pointer, not the payload (G3/D23 rule 8).
    const row = rt.tools.listExecutionsByTask(WS, TASK)[0]!;
    expect(row.result_summary!.length).toBeLessThanOrEqual(9_000);
    // The pointer LEADS the result positionally (review F9): the artifact
    // reference lands BEFORE the content head, so the executor's summary
    // bound can never cut the pointer and keep the payload.
    const pointerAt = outcome.result_summary.indexOf("captured as artifact");
    const contentAt = outcome.result_summary.indexOf("Evidence tables should cite the source");
    expect(pointerAt).toBeGreaterThanOrEqual(0);
    expect(contentAt).toBeGreaterThan(pointerAt);
    expect(outcome.result_summary.indexOf("Read ")).toBeLessThan(pointerAt);
  });

  it("AC3: a streamed response over the byte cap is truncated by policy, never a crash", async () => {
    const rt = buildRuntime();
    const dispatched = fetchProposal(rt, { url: `${fixtureOrigin}/oversized-stream` });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    // The policy for an over-cap PAGE is truncate + artifact, not refusal:
    // the readable head is real content the tool actually read.
    expect(outcome.outcome).toBe("executed");
    if (outcome.outcome !== "executed") throw new Error("expected executed");
    expect(outcome.result_summary).toContain("truncated");
    expect(outcome.result_summary.length).toBeLessThanOrEqual(9_000);
    expect(rt.artifacts.listArtifactsByRun(TASK).length).toBe(1);
  });

  it("fails typed TOOL_EXECUTION_TIMEOUT when the fetch exceeds the tool's deadline", async () => {
    // The stateful clock: the executor's first read mints the deadline
    // (1000 + 45_000); the binding's remaining-time read lands 100 ms
    // before it — so the fixture's slow stream hits a REAL deadline abort,
    // fast.
    let firstRead = true;
    const rt = buildRuntime(() => {
      if (firstRead) {
        firstRead = false;
        return 1_000;
      }
      return 45_900;
    });
    const dispatched = fetchProposal(rt, { url: `${fixtureOrigin}/slow` });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("execution_failed");
    if (outcome.outcome !== "execution_failed") throw new Error("expected failed");
    expect(outcome.error_code).toBe("TOOL_EXECUTION_TIMEOUT");
    const row = rt.tools.listExecutionsByTask(WS, TASK)[0]!;
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("TOOL_EXECUTION_TIMEOUT");
  });

  it("refuses non-http schemes typed BEFORE any fetch is attempted", async () => {
    const rt = buildRuntime();
    const before = fetchCalls;
    const dispatched = fetchProposal(rt, { url: "file:///etc/passwd" });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("execution_failed");
    if (outcome.outcome !== "execution_failed") throw new Error("expected failed");
    expect(outcome.error_code).toBe("RESEARCH_INPUT_INVALID");
    expect(fetchCalls).toBe(before); // nothing left the process
  });
});

describe("the page-fetch host guard through the executor (review fix F2)", () => {
  it("refuses a loopback target PRE-connect with the typed input refusal through the ONE path", async () => {
    // A port that is momentarily bound and then released: a guaranteed-closed
    // loopback endpoint, so the RED state (no guard) fails with the transient
    // connect refusal — never the typed pre-connect refusal the fix enforces.
    const grab = createServer();
    await new Promise<void>((resolve) => grab.listen(0, "127.0.0.1", resolve));
    const closedPort = (grab.address() as AddressInfo).port;
    await new Promise<void>((resolve) => grab.close(() => resolve()));
    const rt = buildRuntime();
    const before = fetchCalls;
    const dispatched = fetchProposal(rt, { url: `http://127.0.0.1:${closedPort}/internal` });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("execution_failed");
    if (outcome.outcome !== "execution_failed") throw new Error("expected failed");
    expect(outcome.error_code).toBe("RESEARCH_INPUT_INVALID");
    expect(fetchCalls).toBe(before); // the fixture was never contacted
    const row = rt.tools.listExecutionsByTask(WS, TASK)[0]!;
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("RESEARCH_INPUT_INVALID");
  });
});

describe("the D27 network separation (S25 chunk 2)", () => {
  it("the research family opens sockets; the execution family spawns network-disabled", async () => {
    // Research side: the fetch above reached a real loopback socket; this leg
    // asserts it again against the composed binding directly.
    const rt = buildRuntime();
    const before = fetchCalls;
    const dispatched = fetchProposal(rt, { url: `${fixtureOrigin}/article` });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("executed");
    expect(fetchCalls).toBe(before + 1);

    // Execution side (E36's probed envelope): the code-exec binding hands the
    // spawn adapter a request with networkDisabled true — the kernel-level
    // route-table separation is pinned in S26's own suite; here the REQUEST
    // shape is pinned so the reason research tools may open sockets stays
    // written down next to the code that may not.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "shera-s25-d27-"));
    tempDirs.push(workspaceRoot);
    const requests: Array<{ networkDisabled: boolean }> = [];
    const deps: ExecutionToolDeps = {
      spawn: (request) => {
        requests.push({ networkDisabled: request.networkDisabled });
        return {
          pid: -1,
          waitForExit: async () => ({
            code: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            limitDeath: null,
            verifiedLimits: null,
            cgroupApplied: null,
            spawnError: null,
          }),
          cancel: () => {},
        };
      },
      workspaceRoots: { [WS]: workspaceRoot },
      terminalRecorder: null,
      artifacts: null,
      logFault: () => {},
    };
    const binding = makeCodeExecutionBinding(deps);
    const ctx: ToolExecutionContext = {
      authority: makeExecutionAuthority(),
      deadline: Date.now() + 30_000,
      nowMs: () => Date.now(),
      maxResponseBytes: 65_536,
      resourceLimits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      signal: new AbortController().signal,
      execution: {
        execution_id: "exe_d27_probe",
        workspace_id: WS,
        task_id: TASK,
        conversation_id: CONV,
        agent_id: AGENT,
        capability: "code.execute",
        approval_id: null,
        grant_id: null,
      },
    };
    if (binding.executeAsync === undefined) {
      throw new Error("expected the async dispatch seam");
    }
    const result = await binding.executeAsync({ language: "shell", code: "true" }, ctx);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.networkDisabled).toBe(true);
  });
});
