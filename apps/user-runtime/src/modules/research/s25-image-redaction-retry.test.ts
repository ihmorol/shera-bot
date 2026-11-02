/**
 * S25 image understanding + tool-history honesty + retry posture (chunk 4;
 * issue #26 AC5/AC6; PRD §5.1, §7, §16; D15, D17, D22, D27, D35, E13, E33,
 * G3/G6/G7).
 *
 * Pinned here:
 *   1. Image understanding through the S23 AI SDK vision seam (one-shot
 *      generateText with maxRetries: 0 — the E33-era lesson: silent SDK
 *      retries would multiply provider calls; the RUNTIME owns retry
 *      decisions). Default CI drives a deterministic mock model (G7).
 *   2. AC5 — secrets in fetched content or uploaded files are redacted in
 *      history and NEVER enter memory or events: the fetched-content leg
 *      byte-scans the whole runtime.db (+WAL), because the secret entered
 *      the runtime ONLY through the tool; the uploaded-file leg pins the
 *      derived surfaces (history rows, journal payloads, artifact bytes) —
 *      the user's own uploaded row keeps the user's bytes by design.
 *   3. AC6 — the typed retryability is ONE truth: the error shapes' flags
 *      and the S22 retry classification agree per code; a transient
 *      failure retries per the bounded policy and a permanent one fails
 *      immediately; a re-propose after a transient failure executes.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import type { TaskRun } from "@shera-bot/contracts";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { WorkspaceFilesRepository } from "../../adapters/sqlite/workspace-files-repository.ts";
import { ToolExecutor, canonicalArgsDigest } from "../tools/tool-executor.service.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { classifyFailure, decideRetry, DEFAULT_RETRY_POLICY } from "../tasks/retry-policy.ts";
import { RESEARCH_FAILURE_SHAPES } from "./research-errors.ts";
import { registerResearchTools } from "../../transport/local-api/s25-research-api.ts";

const WS = "ws_default_01";
const TASK = "task_s25_image";
const CONV = "conv_s25_image";
const AGENT = "agent_researcher";
const NOW = "2026-11-02T12:00:00.000Z";

const tempDirs: string[] = [];

/** A real 1x1 transparent PNG (the deterministic image fixture). */
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** The planted secret vocabulary (every shape the recorded redaction covers). */
const PLANTED_SECRETS = [
  "sk-live-abc123DEF456ghi789JKLmno",
  "hunter2-hunter2-hunter2",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "8f14e45fceea167a5a36dedd4bea2543",
  "c2FtcGxlMTIzNDU2Nzg5MGFiY2RlZg",
];

/** A page whose body embeds every planted shape. */
const SECRET_PAGE_HTML = `<!doctype html><html><head><title>Leaky Page</title></head><body>
<article><h1>Leaky Page</h1>
<p>Config dump: api_key = ${PLANTED_SECRETS[0]}</p>
<p>Creds: {"password": "${PLANTED_SECRETS[1]}"}</p>
<p>Authorization: Bearer ${PLANTED_SECRETS[2]}</p>
<p>Set-Cookie: sessionid=${PLANTED_SECRETS[3]}</p>
<p>Token: ${PLANTED_SECRETS[4]}</p>
</article></body></html>`;

const SECRET_CSV = `name,note\nalpha,api_key=${PLANTED_SECRETS[0]}\nbeta,"password": "${PLANTED_SECRETS[1]}"\n`;

/** The vision mock's call log (the prompt-shape pin). */
let generateCalls: Array<Record<string, unknown>> = [];

function makeVisionModel(description: string): LanguageModel {
  return new MockLanguageModelV3({
    provider: "fixture-vision",
    modelId: "fixture-vision-model",
    doGenerate: async (options) => {
      generateCalls.push(options as unknown as Record<string, unknown>);
      return {
        finishReason: "stop",
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
          totalTokens: { total: 2 },
        },
        content: [{ type: "text", text: description }],
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}

interface S25Runtime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  tools: ToolsRepository;
  artifacts: ArtifactsRepository;
  files: WorkspaceFilesRepository;
  dbPath: string;
  tx: SqliteTransactions;
}

interface RuntimeOptions {
  visionDescription?: string;
  visionModel?: LanguageModel | null;
  searxng?: { baseUrl: string } | null;
}

function buildRuntime(options: RuntimeOptions = {}): S25Runtime {
  const dir = mkdtempSync(join(tmpdir(), "shera-s25-image-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "runtime.db");
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const tools = new ToolsRepository(conn.db);
  const artifacts = new ArtifactsRepository(tx);
  const files = new WorkspaceFilesRepository(tx, new WriteLeasesRepository(tx));
  const registry = new ToolRegistry();
  registerResearchTools(registry, WS, {
    searxng: options.searxng ?? null,
    artifacts,
    files,
    visionModel:
      options.visionModel === undefined
        ? () => makeVisionModel(options.visionDescription ?? "A small diagram of a data pipeline.")
        : options.visionModel,
  });
  const executor = new ToolExecutor({
    registry,
    tools,
    tx,
    nowMs: () => 1_000,
    now: () => NOW,
  });
  return { executor, registry, tools, artifacts, files, dbPath, tx };
}

function makeRun(taskId = TASK): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s25_image" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "d".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function seedFile(rt: S25Runtime, uri: string, bytes: Uint8Array): void {
  rt.files.write(WS, uri, { type: "user", id: "user_owner" }, bytes, null, {});
}

function propose(
  rt: S25Runtime,
  toolId: string,
  capability: string,
  rawArgs: Record<string, unknown>,
) {
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: toolId,
      tool_version: "1.0.0",
      capability,
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: `run ${toolId}`,
    },
    run: makeRun(),
    agent_id: AGENT,
    rawArgs,
  });
}

async function settled(
  outcome: ReturnType<ToolExecutor["executeProposal"]>,
): Promise<{ ok: true; result_summary: string } | { ok: false; error_code: string }> {
  if (outcome.outcome !== "dispatched") throw new Error(`expected dispatched, got ${outcome.outcome}`);
  const result = await outcome.completion;
  if (result.outcome === "executed") {
    return { ok: true, result_summary: result.result_summary };
  }
  if (result.outcome === "execution_failed") {
    return { ok: false, error_code: result.error_code };
  }
  throw new Error(`unexpected outcome ${result.outcome}`);
}

let fixture: Server;
let fixtureOrigin = "";

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    req.resume();
    req.on("end", () => {
      if (url.pathname === "/leaky") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(SECRET_PAGE_HTML);
        return;
      }
      res.writeHead(404);
      res.end();
    });
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

describe("image understanding (S25 chunk 4)", () => {
  it("registers the vision tool only where a vision model is configured (G4), defaulting its recovery", () => {
    const withModel = buildRuntime();
    const record = withModel.registry.resolve(WS, "tool_image_understand", "1.0.0");
    expect(record).not.toBeNull();
    expect(record!.definition.risk_class).toBe("READ_ONLY");
    expect(record!.definition.capabilities).toEqual(["research.describe.image"]);
    expect(record!.definition.approval_policy).toBe("auto_read_only");
    // The provider call's retry semantics are the genuinely ambiguous case
    // (E13): the class is OMITTED — the stored needs_human default applies.
    expect(record!.definition.recovery).toBe("needs_human");
    const withoutModel = buildRuntime({ visionModel: null });
    expect(withoutModel.registry.resolve(WS, "tool_image_understand", "1.0.0")).toBeNull();
  });

  it("describes an uploaded image through the AI SDK vision seam with the bytes as a file part", async () => {
    generateCalls = [];
    const rt = buildRuntime({ visionDescription: "A small diagram of a data pipeline." });
    seedFile(rt, "workspace://images/pipeline.png", PNG_1X1);
    const outcome = await settled(
      propose(rt, "tool_image_understand", "research.describe.image", {
        path: "workspace://images/pipeline.png",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected executed");
    expect(outcome.result_summary).toContain("A small diagram of a data pipeline.");
    // The model call carried the image bytes as a file part (mediaType pinned).
    expect(generateCalls).toHaveLength(1);
    const prompt = generateCalls[0]!.prompt as Array<{
      role: string;
      content: Array<{ type: string; mediaType?: string; data?: unknown }>;
    }>;
    const userMessage = prompt.find((message) => message.role === "user");
    expect(userMessage).toBeDefined();
    const filePart = userMessage!.content.find(
      (part) => part.type === "file" && part.mediaType === "image/png",
    );
    expect(filePart).toBeDefined();
    const data = (filePart!.data as { type: string; data: Uint8Array });
    expect(data.type).toBe("data");
    expect(Buffer.from(data.data).equals(Buffer.from(PNG_1X1))).toBe(true);
    // The description is the derived artifact, provenance-stamped.
    const refs = rt.artifacts.listArtifactsByRun(TASK);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.artifact_type).toBe("research_image_description");
    expect(refs[0]!.producer_agent_id).toBe(AGENT);
    // Read-only: no approval row (D35/G6).
    expect(rt.tools.listExecutionsByTask(WS, TASK)[0]!.approval_id).toBeNull();
  });

  it("refuses a non-image upload typed before any model call", async () => {
    generateCalls = [];
    const rt = buildRuntime();
    seedFile(rt, "workspace://images/thing.bmp", new Uint8Array([0x42, 0x4d]));
    const outcome = await settled(
      propose(rt, "tool_image_understand", "research.describe.image", {
        path: "workspace://images/thing.bmp",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failed");
    expect(outcome.error_code).toBe("RESEARCH_SOURCE_UNREADABLE");
    expect(generateCalls).toHaveLength(0);
  });
});

describe("AC5: secrets never reach history, events, or memory (S25 chunk 4)", () => {
  it("a fetched page's secrets are redacted everywhere the tool wrote (whole-database byte-scan)", async () => {
    const rt = buildRuntime({ searxng: null, visionModel: null });
    // The page fetch ran with the artifact + history sinks; the secret
    // entered the runtime ONLY through the tool — the whole database
    // (+WAL) must be clean of every planted shape.
    const dispatched = rt.executor.executeProposal({
      proposal: {
        workspace_id: WS,
        task_id: TASK,
        conversation_id: CONV,
        tool_id: "tool_page_fetch",
        tool_version: "1.0.0",
        capability: "research.fetch",
        args_digest: canonicalArgsDigest({ url: `${fixtureOrigin}/leaky` }),
        proposal_summary: "read the leaky page",
      },
      run: makeRun(),
      agent_id: AGENT,
      rawArgs: { url: `${fixtureOrigin}/leaky` },
    });
    if (dispatched.outcome !== "dispatched") throw new Error("expected dispatched");
    const outcome = await dispatched.completion;
    expect(outcome.outcome).toBe("executed");
    const row = rt.tools.listExecutionsByTask(WS, TASK)[0]!;
    for (const secret of PLANTED_SECRETS) {
      expect(row.result_summary).not.toContain(secret);
      expect(row.args_summary).not.toContain(secret);
    }
    // The derived artifact bytes are redacted too.
    const ref = rt.artifacts.listArtifactsByRun(TASK)[0]!;
    const artifactText = Buffer.from(rt.artifacts.getArtifact(WS, ref.artifact_id)!.content).toString("utf8");
    for (const secret of PLANTED_SECRETS) {
      expect(artifactText).not.toContain(secret);
    }
    // The whole-database byte-scan: runtime.db + WAL.
    const dbBytes = readFileSync(rt.dbPath);
    const walPath = `${rt.dbPath}-wal`;
    const walBytes = existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0);
    const everything = Buffer.concat([dbBytes, walBytes]);
    for (const secret of PLANTED_SECRETS) {
      expect(everything.includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
    // Memory: the tools never write agent memory — structural honesty.
    const memoryCount = rt.tx
      .connection()
      .prepare("SELECT COUNT(*) AS n FROM agent_memory_entries")
      .get() as { n: number };
    expect(memoryCount.n).toBe(0);
  });

  it("an uploaded file's secrets are redacted in history, journal, and derived artifacts", async () => {
    const rt = buildRuntime({ visionModel: null });
    seedFile(rt, "workspace://data/leaky.csv", new Uint8Array(Buffer.from(SECRET_CSV, "utf8")));
    const outcome = await settled(
      propose(rt, "tool_spreadsheet_analyze", "research.analyze.spreadsheet", {
        path: "workspace://data/leaky.csv",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected executed");
    const row = rt.tools.listExecutionsByTask(WS, TASK)[0]!;
    for (const secret of PLANTED_SECRETS) {
      expect(row.result_summary).not.toContain(secret);
      expect(row.args_summary).not.toContain(secret);
    }
    // The derived CSV artifact is redacted (the user's uploaded ROW keeps
    // the user's own bytes by design — the derived surfaces do not).
    const ref = rt.artifacts.listArtifactsByRun(TASK)[0]!;
    const artifactText = Buffer.from(rt.artifacts.getArtifact(WS, ref.artifact_id)!.content).toString("utf8");
    for (const secret of PLANTED_SECRETS) {
      expect(artifactText).not.toContain(secret);
    }
    // The journal payloads are clean.
    const journalRows = rt.tx
      .connection()
      .prepare("SELECT payload FROM event_journal WHERE workspace_id = ?")
      .all(WS) as Array<{ payload: string }>;
    const serialized = journalRows.map((entry) => entry.payload).join("\n");
    for (const secret of PLANTED_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("AC6: typed retryability is one truth (S25 chunk 4)", () => {
  it("the research failure shapes and the S22 retry classification agree per code", () => {
    for (const [code, shape] of Object.entries(RESEARCH_FAILURE_SHAPES)) {
      expect(shape.retryable).toBe(classifyFailure(code) === "transient");
      expect(shape.kind).toBe(classifyFailure(code));
    }
  });

  it("a transient failure retries per the bounded policy; a permanent one fails immediately", () => {
    // TRANSIENT_NETWORK: attempt 1..3 retry with the bounded backoff…
    expect(decideRetry({ failureCode: "TRANSIENT_NETWORK", attemptsSoFar: 0, policy: DEFAULT_RETRY_POLICY })).toEqual({
      action: "retry", attempt: 1, delayMs: 1_000,
    });
    expect(decideRetry({ failureCode: "TRANSIENT_NETWORK", attemptsSoFar: 1, policy: DEFAULT_RETRY_POLICY })).toEqual({
      action: "retry", attempt: 2, delayMs: 2_000,
    });
    expect(decideRetry({ failureCode: "TRANSIENT_NETWORK", attemptsSoFar: 2, policy: DEFAULT_RETRY_POLICY })).toEqual({
      action: "retry", attempt: 3, delayMs: 4_000,
    });
    // …and exhaust into the recorded pause.
    expect(decideRetry({ failureCode: "TRANSIENT_NETWORK", attemptsSoFar: 3, policy: DEFAULT_RETRY_POLICY })).toEqual({
      action: "pause", reason: "retry_exhausted",
    });
    // Permanent codes fail immediately at every attempt count.
    for (const code of [
      "RESEARCH_INPUT_INVALID",
      "RESEARCH_RESPONSE_INVALID",
      "RESEARCH_SOURCE_NOT_FOUND",
      "RESEARCH_SOURCE_UNREADABLE",
      "RESEARCH_PROVIDER_UNAVAILABLE",
      "TOOL_RESPONSE_TOO_LARGE",
    ]) {
      expect(decideRetry({ failureCode: code, attemptsSoFar: 0, policy: DEFAULT_RETRY_POLICY })).toEqual({
        action: "fail", code,
      });
    }
  });

  it("a transient fixture failure is typed retryable; the re-propose executes", async () => {
    let failures = 0;
    const flaky = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      req.resume();
      req.on("end", () => {
        if (failures < 2) {
          failures += 1;
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "transient" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: url.searchParams.get("q") ?? "",
            number_of_results: 1,
            results: [
              {
                title: "Recovered result",
                url: "https://example.org/recovered",
                content: "The endpoint recovered after the transient failures.",
                engine: "fixture",
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const flakyOrigin = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
    try {
      const rt = buildRuntime({ searxng: { baseUrl: flakyOrigin }, visionModel: null });
      const args = { query: "flaky endpoint" };
      const first = await settled(propose(rt, "tool_web_search", "research.search", args));
      expect(first.ok).toBe(false);
      if (first.ok) throw new Error("expected the first attempt to fail");
      expect(first.error_code).toBe("TRANSIENT_NETWORK");
      // The failed row carries the typed transient code — the retryable
      // flag the policy reads.
      const rows = rt.tools.listExecutionsByTask(WS, TASK);
      expect(rows[0]!.status).toBe("failed");
      expect(rows[0]!.error_code).toBe("TRANSIENT_NETWORK");
      // The retry policy's re-drive: the SAME proposal executes now.
      const second = await settled(propose(rt, "tool_web_search", "research.search", args));
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected the re-propose to execute");
      expect(second.result_summary).toContain("Recovered result");
      expect(rows).toHaveLength(2);
      expect(rows[1]!.status).toBe("succeeded");
    } finally {
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
    }
  });
});
