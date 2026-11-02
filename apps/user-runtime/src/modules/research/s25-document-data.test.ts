/**
 * S25 document and data tools (chunk 3; issue #26; PRD §5.1–5.3, §7; D15,
 * D23 rule 8, D35, G3/G4/G6) — the uploaded-file families:
 *
 *   - tool_document_parse: uploaded PDFs (unpdf) and text documents →
 *     structured text artifacts with provenance;
 *   - tool_spreadsheet_analyze: uploaded spreadsheets and CSV (SheetJS CE)
 *     → table artifacts with the bounded statistical summary.
 *
 * The files live in the S17 ROW-BASED workspace store (workspace_nodes
 * BLOBs — no filesystem behind the tree, so traversal is impossible at the
 * storage layer by construction). The tools read through the SAME
 * repository surface as the panel (the executing Agent is the storage
 * actor: the shared workspace:// scope is readable, another Agent's
 * private folder is the typed denial), and every parse writes its result
 * artifact REDACTED before the sink (G3) with the producing run + agent as
 * provenance.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

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
const TASK = "task_s25_docs";
const CONV = "conv_s25_docs";
const AGENT = "agent_researcher";
const NOW = "2026-11-02T12:00:00.000Z";

const tempDirs: string[] = [];

/** Build a minimal valid single-page PDF carrying one text line. */
function minimalPdf(textLine: string): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${0} >>\nstream\nBT /F1 12 Tf 72 720 Td (${textLine}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const streamStart = pdf.indexOf("stream\n") + "stream\n".length;
  const streamEnd = pdf.indexOf("endstream");
  const length = streamEnd - streamStart - 1;
  pdf = pdf.replace("<< /Length 0 >>", `<< /Length ${length} >>`);
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "utf8"));
}

/** Build a small deterministic xlsx workbook (the same SheetJS CE the tool uses). */
function smallXlsx(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const rows = [
    ["city", "population", "area_km2"],
    ["Lisbon", 545245, 100.05],
    ["Porto", 231800, 41.42],
    ["Braga", 193324, 183.51],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Cities");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

const SMALL_CSV = "region,quota\nnorth,120\nsouth,240\n";

interface DocsRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  tools: ToolsRepository;
  artifacts: ArtifactsRepository;
  files: WorkspaceFilesRepository;
}

function buildRuntime(withFiles: boolean = true): DocsRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-s25-docs-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const tools = new ToolsRepository(conn.db);
  const artifacts = new ArtifactsRepository(tx);
  const files = withFiles
    ? new WorkspaceFilesRepository(tx, new WriteLeasesRepository(tx))
    : (null as unknown as WorkspaceFilesRepository);
  const registry = new ToolRegistry();
  registerResearchTools(registry, WS, {
    searxng: null,
    artifacts,
    files: withFiles ? files : null,
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

function makeRun(taskId = TASK): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s25_docs" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "c".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** Seed one workspace file (the same write surface the panel upload uses). */
function seedFile(rt: DocsRuntime, uri: string, bytes: Uint8Array): void {
  rt.files.write(WS, uri, { type: "user", id: "user_owner" }, bytes, null, {});
}

function proposal(
  rt: DocsRuntime,
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

async function executed(
  outcome: ReturnType<ToolExecutor["executeProposal"]>,
): Promise<{ ok: true; result_summary: string } | { ok: false; error_code: string }> {
  if (outcome.outcome !== "dispatched") throw new Error(`expected dispatched, got ${outcome.outcome}`);
  const settled = await outcome.completion;
  if (settled.outcome === "executed") {
    return { ok: true, result_summary: settled.result_summary };
  }
  if (settled.outcome === "execution_failed") {
    return { ok: false, error_code: settled.error_code };
  }
  throw new Error(`unexpected outcome ${settled.outcome}`);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("document and data tool declarations (S25 chunk 3, AC7)", () => {
  it("declares both uploaded-file tools with their recovery classes", () => {
    const rt = buildRuntime();
    const doc = rt.registry.resolve(WS, "tool_document_parse", "1.0.0");
    const sheet = rt.registry.resolve(WS, "tool_spreadsheet_analyze", "1.0.0");
    expect(doc).not.toBeNull();
    expect(sheet).not.toBeNull();
    expect(doc!.definition.risk_class).toBe("READ_ONLY");
    expect(doc!.definition.capabilities).toEqual(["research.parse.document"]);
    expect(doc!.definition.approval_policy).toBe("auto_read_only");
    expect(doc!.definition.recovery).toBe("replayable");
    expect((doc!.definition.input_schema as Record<string, unknown>).required).toContain("path");
    expect(sheet!.definition.risk_class).toBe("READ_ONLY");
    expect(sheet!.definition.capabilities).toEqual(["research.analyze.spreadsheet"]);
    expect(sheet!.definition.recovery).toBe("replayable");
  });

  it("registers neither tool without the workspace file store (G4)", () => {
    const rt = buildRuntime(false);
    expect(rt.registry.resolve(WS, "tool_document_parse", "1.0.0")).toBeNull();
    expect(rt.registry.resolve(WS, "tool_spreadsheet_analyze", "1.0.0")).toBeNull();
  });
});

describe("document parsing (S25 chunk 3)", () => {
  it("parses an uploaded PDF into a text artifact with provenance and a bounded result", async () => {
    const rt = buildRuntime();
    seedFile(rt, "workspace://papers/attention.pdf", minimalPdf("Hello S25 document parse"));
    const outcome = await executed(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://papers/attention.pdf",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected executed");
    expect(outcome.result_summary).toContain("Hello S25 document parse");
    expect(outcome.result_summary).toContain("captured as artifact");
    expect(outcome.result_summary.length).toBeLessThanOrEqual(9_000);
    // The artifact: the parsed text, provenance-stamped to the run + agent.
    const refs = rt.artifacts.listArtifactsByRun(TASK);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.producer_task_id).toBe(TASK);
    expect(refs[0]!.producer_agent_id).toBe(AGENT);
    expect(refs[0]!.artifact_type).toBe("research_document_text");
    const withContent = rt.artifacts.getArtifact(WS, refs[0]!.artifact_id)!;
    expect(Buffer.from(withContent.content).toString("utf8")).toContain("Hello S25 document parse");
    // Read-only: no approval row anywhere.
    expect(rt.tools.listExecutionsByTask(WS, TASK)[0]!.approval_id).toBeNull();
    expect(rt.tools.listExecutionsByTask(WS, TASK)[0]!.status).toBe("succeeded");
  });

  it("parses an uploaded text document as itself", async () => {
    const rt = buildRuntime();
    seedFile(
      rt,
      "workspace://notes/literature.md",
      new Uint8Array(Buffer.from("# Literature\n\nEvidence-backed claim one.\n", "utf8")),
    );
    const outcome = await executed(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://notes/literature.md",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected executed");
    expect(outcome.result_summary).toContain("Evidence-backed claim one.");
  });

  it("refuses an unsupported document format typed", async () => {
    const rt = buildRuntime();
    seedFile(rt, "workspace://notes/thing.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const outcome = await executed(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://notes/thing.docx",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failed");
    expect(outcome.error_code).toBe("RESEARCH_SOURCE_UNREADABLE");
    expect(rt.artifacts.listArtifactsByRun(TASK)).toHaveLength(0);
  });

  it("refuses a missing file and a scope-escaping path typed, reading nothing", async () => {
    const rt = buildRuntime();
    const missing = await executed(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://notes/absent.pdf",
      }),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected failed");
    expect(missing.error_code).toBe("RESEARCH_SOURCE_NOT_FOUND");

    const escape = await executed(
      proposal(rt, "tool_document_parse", "research.parse.document", {
        path: "workspace://a/../../etc/passwd",
      }),
    );
    expect(escape.ok).toBe(false);
    if (escape.ok) throw new Error("expected failed");
    expect(escape.error_code).toBe("RESEARCH_INPUT_INVALID");
  });
});

describe("spreadsheet analysis (S25 chunk 3)", () => {
  it("analyses an uploaded xlsx into a table artifact with a bounded statistical summary", async () => {
    const rt = buildRuntime();
    seedFile(rt, "workspace://data/cities.xlsx", smallXlsx());
    const outcome = await executed(
      proposal(rt, "tool_spreadsheet_analyze", "research.analyze.spreadsheet", {
        path: "workspace://data/cities.xlsx",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected executed");
    // The bounded summary names the sheet, the shape, and the numeric stats.
    expect(outcome.result_summary).toContain("Cities");
    expect(outcome.result_summary).toContain("4 rows");
    expect(outcome.result_summary).toContain("population");
    expect(outcome.result_summary).toContain("captured as artifact");
    // The artifact: the full structured table (CSV), provenance-stamped.
    const refs = rt.artifacts.listArtifactsByRun(TASK);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.artifact_type).toBe("research_table_data");
    const withContent = rt.artifacts.getArtifact(WS, refs[0]!.artifact_id)!;
    const csv = Buffer.from(withContent.content).toString("utf8");
    expect(csv).toContain("city,population,area_km2");
    expect(csv).toContain("Lisbon,545245,100.05");
    expect(refs[0]!.producer_task_id).toBe(TASK);
    expect(rt.tools.listExecutionsByTask(WS, TASK)[0]!.approval_id).toBeNull();
  });

  it("analyses an uploaded CSV with the same bounded summary", async () => {
    const rt = buildRuntime();
    seedFile(rt, "workspace://data/quotas.csv", new Uint8Array(Buffer.from(SMALL_CSV, "utf8")));
    const outcome = await executed(
      proposal(rt, "tool_spreadsheet_analyze", "research.analyze.spreadsheet", {
        path: "workspace://data/quotas.csv",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected executed");
    expect(outcome.result_summary).toContain("3 rows");
    expect(outcome.result_summary).toContain("quota");
  });

  it("refuses a non-tabular file typed", async () => {
    const rt = buildRuntime();
    seedFile(
      rt,
      "workspace://data/report.pdf",
      minimalPdf("not a spreadsheet"),
    );
    const outcome = await executed(
      proposal(rt, "tool_spreadsheet_analyze", "research.analyze.spreadsheet", {
        path: "workspace://data/report.pdf",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failed");
    expect(outcome.error_code).toBe("RESEARCH_SOURCE_UNREADABLE");
  });
});
