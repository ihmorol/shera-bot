/**
 * The page-fetch extraction pipeline (S25 chunk 2; issue #26 AC1/AC3/AC4;
 * D15, D23 rule 8, D27, G7) — fetch a public web page and extract its
 * readable content as markdown through the adopted open-source stack:
 * @mozilla/readability 0.6.0 (Apache-2.0) over a linkedom 0.18.15 (ISC) DOM,
 * converted by turndown 7.2.4 (MIT) — all exact-pinned, recorded as E-notes.
 *
 * The download is deadline-bounded and byte-capped (AC3): a streamed body
 * larger than the cap stops AT the cap and reports truncated — the readable
 * head is real content the tool actually read, and the artifact policy
 * records it honestly (never a crash, never an unbounded buffer).
 */
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { parseHTML } from "linkedom";

import { drainResponse, mapFetchFailure, readBodyWithCap } from "./research-http.ts";
import { ResearchToolError } from "./research-errors.ts";

/** The fetch byte cap (AC3): a larger page is truncated by policy. */
export const PAGE_MAX_BODY_BYTES = 256 * 1024;
/** The marker the extraction fallback prefixes (honest degradation, G4). */
const RAW_FALLBACK_MARKER = "[the page had no readable article; raw page text follows]";

export interface PageFetchOutcome {
  url: string;
  title: string | null;
  markdown: string;
  /** Characters of extracted markdown before any tool-level slicing. */
  chars: number;
  /** True when the fetch cap cut the body mid-download. */
  truncated: boolean;
}

/** The URL scheme guard (D27: research operations are http/https reads). */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResearchToolError("RESEARCH_INPUT_INVALID", `the url is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ResearchToolError(
      "RESEARCH_INPUT_INVALID",
      `only http and https pages can be fetched (got ${parsed.protocol})`,
    );
  }
  return parsed;
}

function extractionContentType(contentType: string): "html" | "text" | null {
  const lowered = contentType.toLowerCase();
  if (lowered.includes("html") || lowered.includes("xml")) {
    return "html";
  }
  if (lowered.startsWith("text/")) {
    return "text";
  }
  return null;
}

/** Markdown of an HTML fragment (turndown; headings atx, fenced code). */
function toMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return turndown.turndown(html);
}

/**
 * Fetch and extract one page: deadline-bounded, byte-capped, readability +
 * turndown. Every failure is typed; a readability miss degrades honestly to
 * the raw page text with an explicit marker (the content IS there — the
 * marker says the structured extraction found no article).
 */
export async function fetchReadablePage(deps: {
  fetchImpl: typeof fetch;
  url: string;
  timeoutMs: number;
  maxBodyBytes: number;
  signal?: AbortSignal;
}): Promise<PageFetchOutcome> {
  const parsed = assertFetchableUrl(deps.url);
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs);
  const signal =
    deps.signal !== undefined ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal;
  const cancelSignal: AbortSignal | null = deps.signal ?? null;
  let response: Response;
  try {
    response = await deps.fetchImpl(parsed.href, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
      redirect: "follow",
      signal,
    });
  } catch (error) {
    throw mapFetchFailure(error, {
      cancelSignal,
      timeoutSignal,
      what: `the fetch of ${parsed.href}`,
    });
  }
  if (!response.ok) {
    await drainResponse(response);
    if (response.status === 404 || response.status === 410) {
      throw new ResearchToolError(
        "RESEARCH_SOURCE_NOT_FOUND",
        `the page answered HTTP ${response.status}`,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ResearchToolError(
        "TRANSIENT_NETWORK",
        `the page answered HTTP ${response.status} (transient)`,
      );
    }
    throw new ResearchToolError(
      "RESEARCH_RESPONSE_INVALID",
      `the page refused the request with HTTP ${response.status}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "text/plain";
  const kind = extractionContentType(contentType);
  if (kind === null) {
    await drainResponse(response);
    throw new ResearchToolError(
      "RESEARCH_SOURCE_UNREADABLE",
      `the page's content type (${contentType.split(";")[0] ?? contentType}) is not a readable document`,
    );
  }
  let body: string;
  let truncated: boolean;
  try {
    const download = await readBodyWithCap(response, deps.maxBodyBytes);
    body = download.text;
    truncated = download.truncated;
  } catch (error) {
    if (error instanceof ResearchToolError) {
      throw error; // already typed (e.g. the no-readable-body refusal)
    }
    throw mapFetchFailure(error, {
      cancelSignal,
      timeoutSignal,
      what: `the download of ${parsed.href}`,
    });
  }

  if (kind === "text") {
    return { url: parsed.href, title: null, markdown: body, chars: body.length, truncated };
  }
  // HTML/XML: readability over the linkedom DOM, turndown to markdown.
  const { document } = parseHTML(body);
  let title: string | null =
    typeof document.title === "string" && document.title.trim() !== ""
      ? document.title.trim()
      : null;
  let markdown: string | null = null;
  try {
    const article = new Readability(document).parse();
    if (article !== null && typeof article.content === "string" && article.content !== "") {
      title = article.title ?? title;
      markdown = toMarkdown(article.content);
    }
  } catch {
    // extraction failed — the fallback below still records the raw text
  }
  if (markdown === null || markdown.trim() === "") {
    const bodyText = document.body?.textContent ?? body;
    markdown = `${RAW_FALLBACK_MARKER}\n${bodyText}`;
  }
  return { url: parsed.href, title, markdown, chars: markdown.length, truncated };
}
