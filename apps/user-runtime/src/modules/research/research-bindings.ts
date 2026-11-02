/**
 * Research and data tool bindings (S25; issue #26; PRD §5.1–5.3, §7; D15,
 * D23 rule 8, D27, D35, G2/G3/G6).
 *
 * The research family is the NETWORK-ALLOWED side of the probed D27
 * separation (E36): research/browser operations are capability-based
 * (`research.*` capabilities) and may open sockets; code execution stays
 * network-disabled inside its sandbox. These bindings are READ_ONLY
 * (the D35 ladder executes them automatically) and IN-PROCESS — but their
 * effects are network I/O, which must never run inside the caller's SQLite
 * transaction. They therefore implement the executor's OPTIONAL async
 * binding seam (the S26-dispatched family): the sync `execute` is the typed
 * refusal, the async dispatch runs the fetch outside the transaction, and
 * the executor's cancel seam (ctx.signal) aborts in-flight requests.
 *
 * Tool-history honesty (the issue's recorded rules): arguments are recorded
 * only through the executor's redacted digest + bounded summary (G3 — the
 * bindings never see a history write); results are bounded texts; large
 * fetched content becomes an artifact with provenance instead of entering
 * any prompt (D15, D23 rule 8 — chunk 2); every failure is a typed error
 * whose retryable flag is data (research-errors.ts).
 */
import type { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import {
  PrivateScopeDeniedError,
  WorkspaceNodeNotFoundError,
  WorkspacePathError,
  type WorkspaceFilesRepository,
} from "../../adapters/sqlite/workspace-files-repository.ts";
import {
  assertExecutionAuthority,
  type ToolBinding,
  type ToolBindingResult,
  type ToolExecutionContext,
} from "../tools/tool-binding.ts";
import { searxngSearch, type SearxngSearchOutcome } from "./searxng-search.ts";
import { assertFetchableUrl, fetchReadablePage, PAGE_MAX_BODY_BYTES } from "./page-fetch.ts";
import { parseDocumentBytes } from "./document-parse.ts";
import { analyzeSpreadsheetBytes } from "./spreadsheet-analysis.ts";
import {
  DEFAULT_IMAGE_PROMPT,
  describeImageBytes,
  imageMediaType,
} from "./image-understand.ts";
import { ResearchToolError } from "./research-errors.ts";
import { redactArtifactText } from "../tools/tool-redaction.ts";
import type { LanguageModel } from "ai";

/** The composition's research-tool dependencies (all configuration, G4). */
export interface ResearchToolDeps {
  /**
   * The configured SearXNG endpoint. `null` (no configuration) means the
   * search tool does not exist in this container — the inventory answers
   * truthfully without it (G4: absent configuration is never a fake tool).
   */
  searxng: { baseUrl: string } | null;
  /** The HTTP fetch seam (the platform fetch by default; tests inject). */
  fetchImpl?: typeof fetch;
  /**
   * The S17 artifact sink: large fetched content becomes an artifact with
   * provenance (chunk 2+). `null` disables artifact writes (unit tests).
   */
  artifacts: Pick<ArtifactsRepository, "insertArtifact"> | null;
  /**
   * The S17 row-based workspace file store (chunk 3): the uploaded-file
   * tools read through the SAME repository surface as the panel. `null`
   * (no store) means those tools do not exist (G4).
   */
  files: Pick<WorkspaceFilesRepository, "read"> | null;
  /**
   * The configured vision-model resolver (chunk 4): the AI SDK LanguageModel
   * image understanding describes through. `null` (nothing configured)
   * means the image tool does not exist (G4).
   */
  visionModel: (() => LanguageModel) | null;
}

/** Query length budget (characters). */
const QUERY_MAX_CHARS = 512;
/**
 * The search HTTP body cap (AC3): a larger response is refused typed — the
 * search JSON cannot be truncated at a semantic boundary, so the policy for
 * search is refusal, not artifact.
 */
const SEARCH_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** How many results the bounded result text carries. */
const SEARCH_MAX_RESULTS = 10;
/** The result-text head budget (the prompt payload stays bounded, AC4). */
const RESEARCH_RESULT_HEAD_CHARS = 8_192;

/** The sync refusal every research binding raises (AC1: dispatch-only). */
function refuseSyncExecute(): ToolBindingResult {
  throw new ResearchToolError(
    "RESEARCH_INPUT_INVALID",
    "RESEARCH_INPUT_INVALID: research bindings run only through the executor's async dispatch (network I/O never runs inside the caller's transaction)",
  );
}

/** The bounded, human-readable result text for one search outcome. */
export function searchResultText(outcome: SearxngSearchOutcome): string {
  const results = outcome.results.slice(0, SEARCH_MAX_RESULTS);
  const lines = [
    `SearXNG search "${outcome.query}" — ${results.length} result${results.length === 1 ? "" : "s"}${outcome.numberOfResults > results.length ? ` (of ${outcome.numberOfResults})` : ""}`,
  ];
  results.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   ${item.url}`);
    if (item.snippet !== "") {
      lines.push(`   ${item.snippet}`);
    }
    lines.push(`   engine: ${item.engine}`);
  });
  return lines.join("\n");
}

/** Cooperative deadline check (the in-process family's timeout posture). */
function assertDeadlineLeft(ctx: ToolExecutionContext): number {
  const remaining = ctx.deadline - ctx.nowMs();
  if (remaining <= 0) {
    throw new ResearchToolError("TRANSIENT_NETWORK", "the tool's deadline passed before the request started");
  }
  return remaining;
}

/**
 * The web-search binding (tool_web_search). Arguments: `query` (required),
 * optional `language`. The search runs against the configured SearXNG
 * endpoint (D27: the network-allowed side); the result text is bounded and
 * engine-attributed; every failure is the typed research error.
 */
export function makeWebSearchBinding(deps: ResearchToolDeps): ToolBinding {
  const searxng = deps.searxng;
  if (searxng === null) {
    throw new Error("RESEARCH_CONFIG_MISSING: the web-search binding requires a SearXNG endpoint");
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return {
    name: "research-web-search",
    preview() {
      return null; // read-only: no preview ceremony (G6/D35)
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "" || query.length > QUERY_MAX_CHARS) {
        throw new ResearchToolError(
          "RESEARCH_INPUT_INVALID",
          `the query must be 1..${QUERY_MAX_CHARS} characters`,
        );
      }
      const language = typeof args.language === "string" && args.language !== "" ? args.language : null;
      const timeoutMs = assertDeadlineLeft(ctx);
      const outcome = await searxngSearch(
        { baseUrl: searxng.baseUrl, fetchImpl, signal: ctx.signal },
        { query, language, timeoutMs, maxBodyBytes: SEARCH_MAX_BODY_BYTES },
      );
      if (ctx.nowMs() > ctx.deadline) {
        return {
          ok: false,
          errorCode: "TOOL_EXECUTION_TIMEOUT",
          message: `the search exceeded its deadline`,
        };
      }
      const text = searchResultText(outcome).slice(0, RESEARCH_RESULT_HEAD_CHARS);
      return { ok: true, text };
    },
  };
}

/**
 * The page-fetch binding (tool_page_fetch). Arguments: `url` (required,
 * http/https). The page is fetched with the tool's own deadline and byte
 * cap; readability + turndown extract the readable content as markdown;
 * content that does not fit the bounded result head — or a download the
 * cap truncated — becomes an artifact with provenance (D15, D23 rule 8),
 * its bytes REDACTED before the sink (G3), and the result carries the
 * pointer, never the payload.
 */
export function makePageFetchBinding(deps: ResearchToolDeps): ToolBinding {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return {
    name: "research-page-fetch",
    preview() {
      return null; // read-only: no preview ceremony (G6/D35)
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (url === "" || url.length > 2048) {
        throw new ResearchToolError(
          "RESEARCH_INPUT_INVALID",
          "the url must be a non-empty http(s) URL of at most 2048 characters",
        );
      }
      // The scheme guard runs BEFORE any fetch leaves the process.
      assertFetchableUrl(url);
      const timeoutMs = assertDeadlineLeft(ctx);
      const page = await fetchReadablePage({
        fetchImpl,
        url,
        timeoutMs,
        maxBodyBytes: PAGE_MAX_BODY_BYTES,
        signal: ctx.signal,
      });
      if (ctx.nowMs() > ctx.deadline) {
        return {
          ok: false,
          errorCode: "TOOL_EXECUTION_TIMEOUT",
          message: "the fetch exceeded its deadline",
        };
      }

      // G3: the artifact bytes are REDACTED before the sink — one redaction
      // boundary before every sink (the S26 posture); the executor's own
      // pass still covers the result head (defense in depth).
      const truncationMarker = page.truncated
        ? `\n[content truncated at the ${Math.round(PAGE_MAX_BODY_BYTES / 1024)} KiB fetch cap]`
        : "";
      let artifactNote = "";
      if (
        deps.artifacts !== null &&
        (page.chars > RESEARCH_RESULT_HEAD_CHARS - 512 || page.truncated)
      ) {
        try {
          const redacted = redactArtifactText(page.markdown);
          const ref = deps.artifacts.insertArtifact({
            workspace_id: ctx.execution.workspace_id,
            name: `page-fetch-${ctx.execution.execution_id}`,
            artifact_type: "research_page_content",
            mime_type: "text/markdown; charset=utf-8",
            content: Buffer.from(redacted, "utf8"),
            producer_agent_id: ctx.execution.agent_id,
            producer_task_id: ctx.execution.task_id,
          });
          artifactNote = `\n[full content (${page.chars} chars) captured as artifact ${ref.artifact_id.slice(0, 17)}…]`;
        } catch {
          // The artifact sink failing never fails the read — the bounded
          // head still records the result honestly (the S26 posture).
          artifactNote = "\n[artifact capture unavailable]";
        }
      }

      const header = `Read ${page.url}${page.title !== null ? ` — "${page.title}"` : ""} (${page.chars} chars extracted)`;
      const headBudget = Math.max(
        0,
        RESEARCH_RESULT_HEAD_CHARS - header.length - truncationMarker.length - artifactNote.length,
      );
      const head = page.markdown.slice(0, headBudget);
      // The pointer LEADS (the executor bounds the recorded result summary:
      // the artifact reference must survive the bound — the content head
      // follows it, never the other way around).
      const text = `${header}${artifactNote}${truncationMarker}\n${head}`.trimEnd();
      return { ok: true, text };
    },
  };
}

/**
 * Read one uploaded file's bytes from the S17 ROW-BASED workspace store
 * (the shared workspace:// scope — the same surface the panel reads). The
 * storage layer's own typed errors map onto the research vocabulary; the
 * executing Agent is the storage actor, so another Agent's private folder
 * stays the typed denial it already is (D39) — and these tools read the
 * shared scope only.
 */
function readWorkspaceFileBytes(
  deps: ResearchToolDeps,
  ctx: ToolExecutionContext,
  uri: string,
): Uint8Array {
  if (deps.files === null) {
    throw new ResearchToolError(
      "RESEARCH_INPUT_INVALID",
      "the workspace file store is not available in this container",
    );
  }
  if (!uri.startsWith("workspace://")) {
    throw new ResearchToolError(
      "RESEARCH_INPUT_INVALID",
      "the path must be a workspace:// URI in the shared scope (the prototype's document and data tools read the shared workspace)",
    );
  }
  try {
    return deps.files.read(ctx.execution.workspace_id, uri, {
      type: "agent",
      id: ctx.execution.agent_id,
    }).content;
  } catch (error) {
    if (error instanceof WorkspacePathError || error instanceof PrivateScopeDeniedError) {
      throw new ResearchToolError(
        "RESEARCH_INPUT_INVALID",
        `the path is outside the readable scope: ${error.message}`,
      );
    }
    if (error instanceof WorkspaceNodeNotFoundError) {
      throw new ResearchToolError(
        "RESEARCH_SOURCE_NOT_FOUND",
        "the file does not exist in the workspace",
      );
    }
    throw error;
  }
}

/** One artifact insert with redacted bytes and the run + agent provenance. */
function insertResearchArtifact(
  deps: ResearchToolDeps,
  ctx: ToolExecutionContext,
  input: { name: string; artifactType: string; mimeType: string; text: string },
): string | null {
  if (deps.artifacts === null) {
    return null;
  }
  const ref = deps.artifacts.insertArtifact({
    workspace_id: ctx.execution.workspace_id,
    name: input.name,
    artifact_type: input.artifactType,
    mime_type: input.mimeType,
    // G3: the artifact bytes are REDACTED before the sink — one redaction
    // boundary before every sink (the S26 posture).
    content: Buffer.from(redactArtifactText(input.text), "utf8"),
    producer_agent_id: ctx.execution.agent_id,
    producer_task_id: ctx.execution.task_id,
  });
  return ref.artifact_id;
}

/**
 * The document-parse binding (tool_document_parse). Arguments: `path`
 * (required — a workspace:// URI in the shared scope). PDFs through unpdf,
 * text documents as themselves; the parsed text becomes an artifact with
 * provenance on EVERY parse (the issue's "structured text artifacts with
 * provenance") and the result carries the bounded head plus the pointer.
 */
export function makeDocumentParseBinding(deps: ResearchToolDeps): ToolBinding {
  return {
    name: "research-document-parse",
    preview() {
      return null; // read-only: no preview ceremony (G6/D35)
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (path === "" || path.length > 4096) {
        throw new ResearchToolError(
          "RESEARCH_INPUT_INVALID",
          "the path must be a workspace:// URI of at most 4096 characters",
        );
      }
      const bytes = readWorkspaceFileBytes(deps, ctx, path);
      const parsed = await parseDocumentBytes(path, bytes);
      const text = parsed.text;
      const artifactId = insertResearchArtifact(deps, ctx, {
        name: `document-parse-${ctx.execution.execution_id}`,
        artifactType: "research_document_text",
        mimeType: "text/plain; charset=utf-8",
        text,
      });
      const header = `Parsed ${path} — ${parsed.kind === "pdf" ? `PDF, ${parsed.pages ?? "?"} page(s)` : "text"} (${text.length} chars)`;
      const artifactNote =
        artifactId !== null
          ? `\n[full text (${text.length} chars) captured as artifact ${artifactId.slice(0, 17)}…]`
          : "";
      const headBudget = Math.max(0, RESEARCH_RESULT_HEAD_CHARS - header.length - artifactNote.length);
      const head = text.slice(0, headBudget);
      return { ok: true, text: `${header}${artifactNote}\n${head}`.trimEnd() };
    },
  };
}

/**
 * The spreadsheet-analysis binding (tool_spreadsheet_analyze). Arguments:
 * `path` (required — a workspace:// URI), optional `sheet`. SheetJS CE
 * decodes the workbook; the deterministic statistics run over the rows;
 * the full table becomes the structured CSV artifact (provenance-stamped)
 * and the result carries the bounded summary plus the pointer.
 */
export function makeSpreadsheetAnalyzeBinding(deps: ResearchToolDeps): ToolBinding {
  return {
    name: "research-spreadsheet-analyze",
    preview() {
      return null; // read-only: no preview ceremony (G6/D35)
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (path === "" || path.length > 4096) {
        throw new ResearchToolError(
          "RESEARCH_INPUT_INVALID",
          "the path must be a workspace:// URI of at most 4096 characters",
        );
      }
      const sheet = typeof args.sheet === "string" && args.sheet !== "" ? args.sheet : null;
      const bytes = readWorkspaceFileBytes(deps, ctx, path);
      const analysis = analyzeSpreadsheetBytes(path, bytes, sheet);
      const statLines = analysis.numericStats.map(
        (stat) =>
          `${stat.column}: n=${stat.count} min=${formatNumber(stat.min)} max=${formatNumber(stat.max)} sum=${formatNumber(stat.sum)} mean=${formatNumber(stat.mean)}`,
      );
      const header = `Analysed ${path} — sheet "${analysis.sheetName}" of [${analysis.sheetNames.join(", ")}]: ${analysis.rowCount} rows × ${analysis.columnCount} columns`;
      const artifactId = insertResearchArtifact(deps, ctx, {
        name: `spreadsheet-analysis-${ctx.execution.execution_id}`,
        artifactType: "research_table_data",
        mimeType: "text/csv; charset=utf-8",
        text: analysis.csv,
      });
      const artifactNote =
        artifactId !== null
          ? `\n[full table (${analysis.csv.length} chars CSV) captured as artifact ${artifactId.slice(0, 17)}…]`
          : "";
      const headBudget = Math.max(
        0,
        RESEARCH_RESULT_HEAD_CHARS -
          header.length -
          artifactNote.length -
          statLines.join("\n").length -
          2,
      );
      const head = analysis.csv.slice(0, headBudget);
      const text = `${header}\n${statLines.join("\n")}${artifactNote}\n${head}`.trimEnd();
      return { ok: true, text };
    },
  };
}

/** One bounded number for the stats line (integers plain, else 2 decimals). */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * The image-understanding binding (tool_image_understand). Arguments: `path`
 * (required — a workspace:// URI in the shared scope), optional `prompt`.
 * The bytes ride the AI SDK vision seam as a file part (ONE honest request,
 * maxRetries: 0); the description becomes the derived artifact with
 * provenance and the bounded result text. Registered only where a vision
 * model is configured (G4); its E13 recovery class stays OMITTED — the
 * needs_human default — because a provider call's retry semantics are the
 * genuinely ambiguous case (the call may have consumed quota).
 */
export function makeImageUnderstandBinding(deps: ResearchToolDeps): ToolBinding {
  const resolveVisionModel = deps.visionModel;
  if (resolveVisionModel === null) {
    throw new Error(
      "RESEARCH_CONFIG_MISSING: the image-understanding binding requires a configured vision model",
    );
  }
  return {
    name: "research-image-understand",
    preview() {
      return null; // read-only: no preview ceremony (G6/D35)
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (path === "" || path.length > 4096) {
        throw new ResearchToolError(
          "RESEARCH_INPUT_INVALID",
          "the path must be a workspace:// URI of at most 4096 characters",
        );
      }
      const prompt =
        typeof args.prompt === "string" && args.prompt.trim() !== ""
          ? args.prompt
          : DEFAULT_IMAGE_PROMPT;
      const bytes = readWorkspaceFileBytes(deps, ctx, path);
      const mediaType = imageMediaType(path);
      const timeoutMs = assertDeadlineLeft(ctx);
      const { description } = await describeImageBytes({
        model: resolveVisionModel(),
        bytes,
        mediaType,
        prompt,
        timeoutMs,
        signal: ctx.signal,
      });
      if (ctx.nowMs() > ctx.deadline) {
        return {
          ok: false,
          errorCode: "TOOL_EXECUTION_TIMEOUT",
          message: "the image description exceeded its deadline",
        };
      }
      const artifactId = insertResearchArtifact(deps, ctx, {
        name: `image-description-${ctx.execution.execution_id}`,
        artifactType: "research_image_description",
        mimeType: "text/plain; charset=utf-8",
        text: description,
      });
      const header = `Described ${path} (${mediaType}, ${bytes.byteLength} bytes)`;
      const artifactNote =
        artifactId !== null
          ? `\n[full description (${description.length} chars) captured as artifact ${artifactId.slice(0, 17)}…]`
          : "";
      const headBudget = Math.max(0, RESEARCH_RESULT_HEAD_CHARS - header.length - artifactNote.length);
      const head = description.slice(0, headBudget);
      return { ok: true, text: `${header}${artifactNote}\n${head}`.trimEnd() };
    },
  };
}
