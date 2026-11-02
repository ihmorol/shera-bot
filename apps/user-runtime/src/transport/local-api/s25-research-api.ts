/**
 * Research tools composition (S25 chunk 1; issue #26; PRD §5.1–5.3, §7, D27,
 * D35, E13, G2/G4/G6) — the composition-owned registration of the research
 * and data tool families as platform built-ins, the same posture as the S21
 * note tools and the S26 execution tools.
 *
 * Every research tool is READ_ONLY (the D35 ladder executes it
 * automatically — no approval row, no preview ceremony) with the full
 * contracts declaration: version, input/output schema, capabilities,
 * risk class, timeout, resource limits, redaction policy. The E13 recovery
 * class is DATA: tools with confident retry semantics declare it
 * (search/fetch → idempotent_retry; parsers → replayable); the tool whose
 * retry semantics are genuinely ambiguous (image understanding — a provider
 * call whose cost may already be spent) OMITS the class and carries the
 * stored default needs_human (AC7 pins the default).
 *
 * G4: a tool registers only where its configuration exists — without a
 * SearXNG endpoint the search tool does not exist and the inventory answers
 * truthfully without it.
 */
import type { ToolRegistry } from "../../modules/tools/tool-registry.ts";
import {
  makeDocumentParseBinding,
  makePageFetchBinding,
  makeSpreadsheetAnalyzeBinding,
  makeWebSearchBinding,
  type ResearchToolDeps,
} from "../../modules/research/research-bindings.ts";

/**
 * The research tools' resource envelope (record data). The family is
 * in-process (no child processes, no code execution) and its network I/O
 * is abort-bounded; the limits are the honest small envelope.
 */
export const RESEARCH_TOOL_RESOURCE_LIMITS = {
  max_memory_mb: 256,
  max_cpu_seconds: 30,
  max_processes: 4,
  max_disk_mb: 64,
} as const;

/** The search tool's response budget (the executor enforces it per tool). */
const SEARCH_MAX_RESPONSE_BYTES = 65_536;

/** The page-fetch tool's response budget (the result head + pointer). */
const PAGE_FETCH_MAX_RESPONSE_BYTES = 65_536;

/** The document-parse tool's response budget (the result head + pointer). */
const DOC_PARSE_MAX_RESPONSE_BYTES = 65_536;

/** The spreadsheet tool's response budget (the summary + pointer). */
const SHEET_ANALYZE_MAX_RESPONSE_BYTES = 65_536;

/**
 * Register the S25 research built-ins for one workspace. Chunk 1 ships the
 * web-search family; the page-fetch, document/spreadsheet, and image
 * families register here as their bindings land (chunks 2–4).
 */
export function registerResearchTools(
  registry: ToolRegistry,
  workspaceId: string,
  deps: ResearchToolDeps,
): void {
  if (deps.searxng !== null) {
    registry.registerBinding("research-web-search", makeWebSearchBinding(deps));
    registry.registerBuiltinTool({
      definition: {
        tool_id: "tool_web_search",
        workspace_id: workspaceId,
        version: "1.0.0",
        name: "Web search",
        purpose:
          "Search the public web through the configured SearXNG endpoint and return bounded, engine-attributed results. Read-only: runs automatically without approval.",
        owner: { kind: "platform" } as const,
        inventory_scope: "shared" as const,
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 512 },
            language: { type: "string" },
          },
          required: ["query"],
        },
        output_schema: { type: "object" },
        capabilities: ["research.search"],
        risk_class: "READ_ONLY" as const,
        timeout_ms: 30_000,
        resource_limits: RESEARCH_TOOL_RESOURCE_LIMITS,
        redaction_policy: "standard" as const,
        approval_policy: "auto_read_only" as const,
        created_at: new Date().toISOString(),
      },
      enabled: true,
      max_response_bytes: SEARCH_MAX_RESPONSE_BYTES,
      bindingName: "research-web-search",
    });
  }

  // The page-fetch tool needs no endpoint configuration (any http(s) page
  // the container can reach): it registers unconditionally. Readability +
  // turndown extract the readable content; large content becomes an
  // artifact with provenance (D15, D23 rule 8).
  registry.registerBinding("research-page-fetch", makePageFetchBinding(deps));
  registry.registerBuiltinTool({
    definition: {
      tool_id: "tool_page_fetch",
      workspace_id: workspaceId,
      version: "1.0.0",
      name: "Page fetch",
      purpose:
        "Fetch a public web page and extract its readable content as markdown. Large content becomes an artifact with provenance instead of entering a prompt. Read-only: runs automatically without approval.",
      owner: { kind: "platform" } as const,
      inventory_scope: "shared" as const,
      input_schema: {
        type: "object",
        properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
        required: ["url"],
      },
      output_schema: { type: "object" },
      capabilities: ["research.fetch"],
      risk_class: "READ_ONLY" as const,
      timeout_ms: 45_000,
      resource_limits: RESEARCH_TOOL_RESOURCE_LIMITS,
      redaction_policy: "standard" as const,
      approval_policy: "auto_read_only" as const,
      // E13 recovery class DECLARED: re-reading a page is safe (a GET has
      // no external effect), so transient failures may re-run — the
      // counterpart of the search tool's omitted-class default pin (AC7).
      recovery: "idempotent_retry" as const,
      created_at: new Date().toISOString(),
    },
    enabled: true,
    max_response_bytes: PAGE_FETCH_MAX_RESPONSE_BYTES,
    bindingName: "research-page-fetch",
  });

  // The uploaded-file tools (chunk 3) read the S17 row-based workspace
  // store: they exist only where a store is wired (G4). Both are pure
  // functions of the file's bytes — the E13 recovery class is replayable
  // (re-running a parse over the same bytes reproduces the same result).
  if (deps.files !== null) {
    registry.registerBinding("research-document-parse", makeDocumentParseBinding(deps));
    registry.registerBuiltinTool({
      definition: {
        tool_id: "tool_document_parse",
        workspace_id: workspaceId,
        version: "1.0.0",
        name: "Document parse",
        purpose:
          "Parse an uploaded document from the shared workspace (PDF text through unpdf; text/markdown as themselves) into a structured text artifact with provenance. Read-only: runs automatically without approval.",
        owner: { kind: "platform" } as const,
        inventory_scope: "shared" as const,
        input_schema: {
          type: "object",
          properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
          required: ["path"],
        },
        output_schema: { type: "object" },
        capabilities: ["research.parse.document"],
        risk_class: "READ_ONLY" as const,
        timeout_ms: 60_000,
        resource_limits: RESEARCH_TOOL_RESOURCE_LIMITS,
        redaction_policy: "standard" as const,
        approval_policy: "auto_read_only" as const,
        recovery: "replayable" as const,
        created_at: new Date().toISOString(),
      },
      enabled: true,
      max_response_bytes: DOC_PARSE_MAX_RESPONSE_BYTES,
      bindingName: "research-document-parse",
    });
    registry.registerBinding("research-spreadsheet-analyze", makeSpreadsheetAnalyzeBinding(deps));
    registry.registerBuiltinTool({
      definition: {
        tool_id: "tool_spreadsheet_analyze",
        workspace_id: workspaceId,
        version: "1.0.0",
        name: "Spreadsheet analysis",
        purpose:
          "Read and analyse an uploaded spreadsheet or CSV from the shared workspace (SheetJS CE): sheet shape, deterministic per-column statistics, and the full table as a CSV artifact with provenance. Read-only: runs automatically without approval.",
        owner: { kind: "platform" } as const,
        inventory_scope: "shared" as const,
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            sheet: { type: "string" },
          },
          required: ["path"],
        },
        output_schema: { type: "object" },
        capabilities: ["research.analyze.spreadsheet"],
        risk_class: "READ_ONLY" as const,
        timeout_ms: 60_000,
        resource_limits: RESEARCH_TOOL_RESOURCE_LIMITS,
        redaction_policy: "standard" as const,
        approval_policy: "auto_read_only" as const,
        recovery: "replayable" as const,
        created_at: new Date().toISOString(),
      },
      enabled: true,
      max_response_bytes: SHEET_ANALYZE_MAX_RESPONSE_BYTES,
      bindingName: "research-spreadsheet-analyze",
    });
  }
}
