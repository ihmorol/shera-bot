/**
 * S25 parse-bomb caps (consolidated fix round; issue #26 AC3; G3/G4) — the
 * pins the reviews consolidated against the UPLOADED-file surfaces:
 *
 *   1. The INPUT byte cap per tool: a hostile oversized upload is the typed
 *      `RESEARCH_INPUT_INVALID` refusal BEFORE any parser runs (the PDF
 *      decoder never sees the hostile bytes; the vision model is never
 *      called; the workbook is never decoded) — never an unbounded in-process
 *      parse.
 *   2. The DERIVED artifact cap: a parse whose output exceeds the derived
 *      budget is truncated with the honest marker (the artifact holds the
 *      real head, its size bounded, the cut recorded — G4), never an
 *      unbounded derived artifact.
 *
 * Every leg runs through the ONE execution path (the executor) with REAL
 * oversized fixtures — the honest end-to-end posture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
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
import { registerResearchTools } from "../../transport/local-api/s25-research-api.ts";

const WS = "ws_default_01";
const TASK = "task_s25_caps";
const CONV = "conv_s25_caps";
const AGENT = "agent_researcher";
const NOW = "2026-11-02T12:00:00.000Z";

/** The review-round caps under pin (the tools' own declared defaults). */
const INPUT_CAP_BYTES = 20 * 1024 * 1024;
const DERIVED_CAP_CHARS = 4 * 1024 * 1024;

const tempDirs: string[] = [];

/** The vision mock's call log — the caps must refuse BEFORE any model call. */
let generateCalls: Array<Record<string, unknown>> = [];

function makeVisionModel(): LanguageModel {
  return new MockLanguageModelV3({
    provider: "fixture-vision",
    modelId: "fixture-vision-model",
    doGenerate: async (options) => {
      generateCalls.push(options as unknown as Record<string, unknown>);
      return {
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
          totalTokens: { total: 2 },
        },
        content: [{ type: "text" as const, text: "A small diagram of a data pipeline." }],
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}

interface CapsRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  tools: ToolsRepository;
  artifacts: ArtifactsRepository;
  files: WorkspaceFilesRepository;
}

function buildRuntime(): CapsRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-s25-caps-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const tools = new ToolsRepository(conn.db);
  const artifacts = new ArtifactsRepository(tx);
  const files = new WorkspaceFilesRepository(tx, new WriteLeasesRepository(tx));
  const registry = new ToolRegistry();
  registerResearchTools(registry, WS, {
    searxng: null,
    artifacts,
    files,
    visionModel: () => makeVisionModel(),
  });
  const executor = new ToolExecutor({
    registry,
    tools,
    tx,
    nowMs: () => 1_000,
    now: () => NOW,
  });
  return { executor, registry, tools, artifacts, files };
}

function makeRun(): TaskRun {
  return {
    task_id: TASK,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s25_caps" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "e".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function seedFile(rt: CapsRuntime, uri: string, bytes: Uint8Array): void {
  rt.files.write(WS, uri, { type: "user", id: "user_owner" }, bytes, null, {});
}

function proposal(
  rt: CapsRuntime,
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
      proposal_summary: `run ${toolId} against the hostile fixture`,
    },
    run: makeRun(),
    agent_id: AGENT,
    rawArgs,
  });
}

async function settled(
  outcome: ReturnType<ToolExecutor["executeProposal"]>,
): Promise<{ ok: true; result_summary: string } | { ok: false; error_code: string }> {
  if (outcome.outcome !== "dispatched")
    throw new Error(`expected dispatched, got ${outcome.outcome}`);
  const result = await outcome.completion;
  if (result.outcome === "executed") {
    return { ok: true, result_summary: result.result_summary };
  }
  if (result.outcome === "execution_failed") {
    return { ok: false, error_code: result.error_code };
  }
  throw new Error(`unexpected outcome ${result.outcome}`);
}

/** One hostile fixture: `prefix` followed by filler bytes up to `size`. */
function hostileBytes(size: number, prefix: string): Uint8Array {
  const buffer = Buffer.alloc(size, 0x61);
  buffer.write(prefix, 0, "utf8");
  return new Uint8Array(buffer);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the parse INPUT caps (review fix F5/F6)", () => {
  it("refuses a document over the input cap BEFORE any parser runs", async () => {
    generateCalls = [];
    const rt = buildRuntime();
    const size = INPUT_CAP_BYTES + 1024;
    seedFile(rt, "workspace://hostile/bomb.txt", hostileBytes(size, ""));
    const outcome = await settled(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://hostile/bomb.txt",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the over-cap document to refuse");
    expect(outcome.error_code).toBe("RESEARCH_INPUT_INVALID");
    expect(rt.artifacts.listArtifactsByRun(TASK)).toHaveLength(0); // nothing parsed, nothing written
  });

  it("refuses a hostile PDF over the input cap before the PDF decoder sees it", async () => {
    const rt = buildRuntime();
    const size = INPUT_CAP_BYTES + 1024;
    seedFile(rt, "workspace://hostile/bomb.pdf", hostileBytes(size, "%PDF-1.4\n"));
    const outcome = await settled(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://hostile/bomb.pdf",
      }),
    );
    // The parse-bomb refusal is the INPUT cap, not a decoder error: the
    // hostile bytes never reach unpdf/pdf.js.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the over-cap PDF to refuse");
    expect(outcome.error_code).toBe("RESEARCH_INPUT_INVALID");
    expect(rt.artifacts.listArtifactsByRun(TASK)).toHaveLength(0);
  });

  it("refuses a spreadsheet over the input cap BEFORE the workbook is decoded", async () => {
    const rt = buildRuntime();
    const size = INPUT_CAP_BYTES + 1024;
    seedFile(rt, "workspace://hostile/bomb.csv", hostileBytes(size, "a,a,"));
    const outcome = await settled(
      proposal(rt, "tool_spreadsheet_analyze", "research.analyze.spreadsheet", {
        path: "workspace://hostile/bomb.csv",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the over-cap spreadsheet to refuse");
    expect(outcome.error_code).toBe("RESEARCH_INPUT_INVALID");
    expect(rt.artifacts.listArtifactsByRun(TASK)).toHaveLength(0);
  });

  it("refuses an image over the payload cap BEFORE any vision model call", async () => {
    generateCalls = [];
    const rt = buildRuntime();
    const size = INPUT_CAP_BYTES + 1024;
    seedFile(rt, "workspace://hostile/bomb.png", hostileBytes(size, ""));
    const outcome = await settled(
      proposal(rt, "tool_image_understand", "research.describe.image", {
        path: "workspace://hostile/bomb.png",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the over-cap image to refuse");
    expect(outcome.error_code).toBe("RESEARCH_INPUT_INVALID");
    // The vision provider was never called with the hostile payload.
    expect(generateCalls).toHaveLength(0);
    expect(rt.artifacts.listArtifactsByRun(TASK)).toHaveLength(0);
  });
});

describe("the DERIVED artifact caps (review fix F5)", () => {
  it("truncates an over-budget parsed text into the artifact with the honest marker", async () => {
    const rt = buildRuntime();
    // Under the input cap (so the parse runs) but over the derived budget.
    const size = DERIVED_CAP_CHARS - 1024 * 1024;
    seedFile(rt, "workspace://hostile/wide.txt", hostileBytes(size, ""));
    const outcome = await settled(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://hostile/wide.txt",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected the under-cap parse to execute");
    const ref = rt.artifacts.listArtifactsByRun(TASK)[0]!;
    const text = Buffer.from(rt.artifacts.getArtifact(WS, ref.artifact_id)!.content).toString(
      "utf8",
    );
    // The artifact holds the real head and the honest cut marker — its size
    // is bounded, never the whole hostile payload.
    expect(text).toContain("truncated");
    expect(text).toContain("truncated at the");
    expect(text.length).toBeLessThanOrEqual(DERIVED_CAP_CHARS + 4096);
    expect(outcome.result_summary).toContain("truncated");
  });

  it("truncates an over-budget CSV artifact with the honest marker", async () => {
    const rt = buildRuntime();
    const size = DERIVED_CAP_CHARS - 1024 * 1024;
    seedFile(rt, "workspace://hostile/wide.csv", hostileBytes(size, "a,a,"));
    const outcome = await settled(
      proposal(rt, "tool_spreadsheet_analyze", "research.analyze.spreadsheet", {
        path: "workspace://hostile/wide.csv",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected the under-cap analysis to execute");
    const ref = rt.artifacts.listArtifactsByRun(TASK)[0]!;
    const csv = Buffer.from(rt.artifacts.getArtifact(WS, ref.artifact_id)!.content).toString(
      "utf8",
    );
    expect(csv).toContain("truncated");
    expect(csv).toContain("truncated at the");
    expect(csv.length).toBeLessThanOrEqual(DERIVED_CAP_CHARS + 4096);
    expect(outcome.result_summary).toContain("truncated");
  });
});
