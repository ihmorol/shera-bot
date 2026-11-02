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
  assertExecutionAuthority,
  type ToolBinding,
  type ToolBindingResult,
  type ToolExecutionContext,
} from "../tools/tool-binding.ts";
import { searxngSearch, type SearxngSearchOutcome } from "./searxng-search.ts";
import { ResearchToolError } from "./research-errors.ts";

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
