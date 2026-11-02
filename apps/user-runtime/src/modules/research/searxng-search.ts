/**
 * The SearXNG JSON client (S25 chunk 1; issue #26, D27, G7).
 *
 * Web search runs through an unmodified EXTERNAL SearXNG container spoken to
 * over its documented JSON API (`/search?q=…&format=json`) — HTTP calls
 * only, no code linking (the AGPL posture the slice records). The base URL
 * is CONFIGURATION; default CI speaks the same API shape from a local
 * deterministic fixture server (G7: no live network in default CI), and the
 * real-container integration is the recorded NOT-VERIFIED owner item.
 *
 * The client is bounded by construction (AC3): the request carries an abort
 * deadline, the response body is read incrementally under a hard byte cap —
 * an oversized response is a typed refusal, never a memory spike — and the
 * documented response shape is validated before any result is returned.
 */
import { ToolBindingError } from "../tools/tool-binding.ts";
import { ResearchToolError } from "./research-errors.ts";

/** The documented SearXNG JSON result item (the fields the tool consumes). */
export interface SearxngResultItem {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  score: number | null;
}

/** The bounded search outcome the binding turns into result text. */
export interface SearxngSearchOutcome {
  query: string;
  numberOfResults: number;
  results: SearxngResultItem[];
}

/** One search request's client-side knobs (all per-tool data, never global). */
export interface SearxngSearchInput {
  query: string;
  language?: string | null;
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface SearxngSearchDeps {
  /** The configured SearXNG base URL (e.g. http://searxng:8080). */
  baseUrl: string;
  /** The HTTP seam (the platform fetch; tests inject). */
  fetchImpl: typeof fetch;
  /** The executor's cancel seam — aborting it aborts the in-flight request. */
  signal?: AbortSignal;
}

/** Field budgets for one search result (the result text stays bounded). */
const TITLE_MAX_CHARS = 300;
const SNIPPET_MAX_CHARS = 400;

function searchUrl(baseUrl: string, input: SearxngSearchInput): string {
  const base = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    q: input.query,
    format: "json",
    safesearch: "1",
  });
  if (input.language !== null && input.language !== undefined && input.language !== "") {
    params.set("language", input.language);
  }
  return `${base}/search?${params.toString()}`;
}

/** Read the response body under a hard byte cap (AC3: bounded by policy). */
async function readBodyWithCap(
  response: Response,
  maxBodyBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBodyBytes) {
    throw new ToolBindingError(
      "TOOL_RESPONSE_TOO_LARGE",
      `TOOL_RESPONSE_TOO_LARGE: the search response declares ${declaredLength} bytes, over the ${maxBodyBytes}-byte cap`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ResearchToolError(
      "TRANSIENT_NETWORK",
      "the search response carried no readable body",
    );
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        throw new ToolBindingError(
          "TOOL_RESPONSE_TOO_LARGE",
          `TOOL_RESPONSE_TOO_LARGE: the search response exceeded the ${maxBodyBytes}-byte cap at ${bytes} bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return `${text}${decoder.decode()}`;
}

/** Map an HTTP status to the typed research failure (retryability is data). */
function statusError(status: number): ResearchToolError {
  if (status === 429 || status >= 500) {
    return new ResearchToolError(
      "TRANSIENT_NETWORK",
      `the search endpoint answered HTTP ${status} (transient)`,
    );
  }
  if (status === 404) {
    return new ResearchToolError(
      "RESEARCH_SOURCE_NOT_FOUND",
      "the search endpoint path does not exist (check the configured base URL)",
    );
  }
  return new ResearchToolError(
    "RESEARCH_RESPONSE_INVALID",
    `the search endpoint refused the request with HTTP ${status}`,
  );
}

/** Validate the documented shape; skip malformed entries, refuse wrong types. */
function parseSearxngResponse(body: string, query: string): SearxngSearchOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ResearchToolError(
      "RESEARCH_RESPONSE_INVALID",
      "the search response is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ResearchToolError(
      "RESEARCH_RESPONSE_INVALID",
      "the search response is not a JSON object",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new ResearchToolError(
      "RESEARCH_RESPONSE_INVALID",
      "the search response has no results array (is format=json supported by this endpoint?)",
    );
  }
  const results: SearxngResultItem[] = [];
  for (const entry of record.results) {
    if (typeof entry !== "object" || entry === null) {
      continue; // a malformed entry is skipped, never a crash
    }
    const item = entry as Record<string, unknown>;
    const url = typeof item.url === "string" ? item.url : "";
    if (url === "") {
      continue; // a result without a URL cannot be cited — skip it
    }
    results.push({
      title: typeof item.title === "string" ? item.title.slice(0, TITLE_MAX_CHARS) : url,
      url,
      snippet: typeof item.content === "string" ? item.content.slice(0, SNIPPET_MAX_CHARS) : "",
      engine: typeof item.engine === "string" ? item.engine : "unknown",
      score: typeof item.score === "number" ? item.score : null,
    });
  }
  const numberOfResults =
    typeof record.number_of_results === "number" ? record.number_of_results : results.length;
  return { query, numberOfResults, results };
}

/**
 * Run one search against the configured SearXNG endpoint: deadline-bounded,
 * byte-capped, shape-validated. Every failure is the typed research error.
 */
export async function searxngSearch(
  deps: SearxngSearchDeps,
  input: SearxngSearchInput,
): Promise<SearxngSearchOutcome> {
  const url = searchUrl(deps.baseUrl, input);
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal =
    deps.signal !== undefined ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal;
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (deps.signal?.aborted) {
      throw new ToolBindingError(
        "TOOL_EXECUTION_CANCELLED",
        "TOOL_EXECUTION_CANCELLED: the search was cancelled before it completed",
      );
    }
    throw new ResearchToolError(
      "TRANSIENT_NETWORK",
      `the search endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    // Drain (bounded) so the socket is released, then refuse typed.
    try {
      await response.arrayBuffer();
    } catch {
      // the body is irrelevant to the refusal
    }
    throw statusError(response.status);
  }
  const body = await readBodyWithCap(response, input.maxBodyBytes);
  return parseSearxngResponse(body, input.query);
}
