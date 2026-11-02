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
import { makeWebSearchBinding, type ResearchToolDeps } from "../../modules/research/research-bindings.ts";

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
}
