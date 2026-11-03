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
 *
 * The HOST GUARD (review fix F2): the URL's host is validated BEFORE any
 * connect — dangerous IP literals and RESOLVED addresses (loopback, RFC1918
 * private, link-local incl. the cloud-metadata address, unique-local,
 * multicast, and the reserved ranges) are the typed `RESEARCH_INPUT_INVALID`
 * refusal; redirects are followed MANUALLY, at most five hops, with EVERY
 * hop re-validated through the same guard; the outcome reports the FINAL url
 * (the page the tool actually read), never the initially requested one.
 * The broader "which external hosts are allowed" product policy stays the
 * recorded owner item — the code enforces refusal of dangerous targets only
 * (plus the explicitly configured fixture origins, the G7 posture).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { parseHTML } from "linkedom";

import { cancelResponseBody, mapFetchFailure, readBodyWithCap } from "./research-http.ts";
import { ResearchToolError } from "./research-errors.ts";

/** The fetch byte cap (AC3): a larger page is truncated by policy. */
export const PAGE_MAX_BODY_BYTES = 256 * 1024;
/** At most five redirect hops are followed manually; hop six refuses typed. */
export const PAGE_MAX_REDIRECT_HOPS = 5;
/** The statuses whose Location the tool follows (everything else is content). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The marker the extraction fallback prefixes (honest degradation, G4). */
const RAW_FALLBACK_MARKER = "[the page had no readable article; raw page text follows]";

export interface PageFetchOutcome {
  /** The FINAL url the tool actually read (after any followed redirects). */
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

/** The resolver seam: all addresses one hostname resolves to (tests inject). */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/**
 * The default resolver: the platform's DNS, ALL addresses (a multi-address
 * answer is refused if ANY of them is dangerous). IP literals never reach it.
 */
const defaultResolveHost: ResolveHost = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/** Guard options: the explicitly allowed origins + the resolver seam. */
export interface FetchTargetGuardOptions {
  /**
   * Exact `scheme://host:port` origins exempt from the dangerous-target
   * refusal — the default-CI/capture fixture posture (G7) names its loopback
   * fixture origins here; production passes none.
   */
  allowedOrigins?: readonly string[];
  resolveHost?: ResolveHost;
}

// --- the dangerous-address classifier --------------------------------------

type Ipv4Bytes = [number, number, number, number];

function parseIpv4(input: string): Ipv4Bytes | null {
  const parts = input.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
}

/** True when `bytes` falls inside `prefix`/`bits`. */
function inIpv4Range(bytes: Ipv4Bytes, prefix: Ipv4Bytes, bits: number): boolean {
  const fullOctets = Math.floor(bits / 8);
  for (let index = 0; index < fullOctets; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }
  const remainder = bits % 8;
  if (remainder > 0) {
    const mask = 0xff << (8 - remainder);
    if ((bytes[fullOctets]! & mask) !== (prefix[fullOctets]! & mask)) {
      return false;
    }
  }
  return true;
}

/**
 * The non-routable / dangerous IPv4 ranges (RFC 1112/1918/6598/5735/6890 —
 * loopback, private, link-local incl. the cloud-metadata address, CGNAT,
 * IETF-assignment, TEST-NET, benchmarking, multicast, reserved/broadcast).
 */
const FORBIDDEN_IPV4_RANGES: ReadonlyArray<{ prefix: Ipv4Bytes; bits: number }> = [
  { prefix: [0, 0, 0, 0], bits: 8 }, // "this network" (incl. 0.0.0.0)
  { prefix: [10, 0, 0, 0], bits: 8 }, // RFC1918 private
  { prefix: [100, 64, 0, 0], bits: 10 }, // CGNAT (RFC6598)
  { prefix: [127, 0, 0, 0], bits: 8 }, // loopback
  { prefix: [169, 254, 0, 0], bits: 16 }, // link-local (incl. 169.254.169.254)
  { prefix: [172, 16, 0, 0], bits: 12 }, // RFC1918 private
  { prefix: [192, 0, 0, 0], bits: 24 }, // IETF protocol assignments
  { prefix: [192, 0, 2, 0], bits: 24 }, // TEST-NET-1
  { prefix: [192, 88, 99, 0], bits: 24 }, // 6to4 relay anycast (deprecated)
  { prefix: [192, 168, 0, 0], bits: 16 }, // RFC1918 private
  { prefix: [198, 18, 0, 0], bits: 15 }, // benchmarking
  { prefix: [198, 51, 100, 0], bits: 24 }, // TEST-NET-2
  { prefix: [203, 0, 113, 0], bits: 24 }, // TEST-NET-3
  { prefix: [224, 0, 0, 0], bits: 4 }, // multicast
  { prefix: [240, 0, 0, 0], bits: 4 }, // reserved (incl. 255.255.255.255)
];

function forbiddenIpv4(bytes: Ipv4Bytes): boolean {
  return FORBIDDEN_IPV4_RANGES.some((range) => inIpv4Range(bytes, range.prefix, range.bits));
}

/**
 * Parse one IPv6 literal into its eight 16-bit groups (embedded IPv4 tails
 * and `::` compression handled); null when unparsable — the caller fails
 * closed, because an address that cannot be classified is never fetched.
 */
function parseIpv6(input: string): number[] | null {
  let text = input;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    // Embedded IPv4 tail (`::ffff:10.0.0.1`): fold it into two hex groups.
    const v4 = parseIpv4(tail);
    if (v4 === null) {
      return null;
    }
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const sections = text.split("::");
  if (sections.length > 2) {
    return null; // more than one "::" is unparsable
  }
  const head = sections[0] === "" ? [] : sections[0]!.split(":");
  const tailGroups =
    sections.length === 2 ? (sections[1] === "" ? [] : sections[1]!.split(":")) : [];
  const groupPattern = /^[0-9a-fA-F]{1,4}$/;
  if (sections.length === 1) {
    if (head.length !== 8) {
      return null;
    }
  } else if (head.length + tailGroups.length > 7) {
    return null; // "::" must stand for at least one group
  }
  const groups: number[] = [];
  for (const group of [...head, ...tailGroups]) {
    if (!groupPattern.test(group)) {
      return null;
    }
    groups.push(parseInt(group, 16));
  }
  while (groups.length < 8) {
    groups.splice(head.length, 0, 0);
  }
  return groups;
}

/** True when the eight 16-bit groups form a dangerous IPv6 address. */
function forbiddenIpv6(groups: number[]): boolean {
  const allZero = (from: number, to: number) =>
    groups.slice(from, to).every((value) => value === 0);
  if (groups.every((value) => value === 0)) {
    return true; // unspecified ::
  }
  if (allZero(0, 7) && groups[7] === 1) {
    return true; // loopback ::1
  }
  if (allZero(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) {
    // IPv4-mapped ::ffff:0:0/96 (and the deprecated IPv4-compatible ::/96):
    // classify the embedded IPv4 address.
    return forbiddenIpv4([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff]);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && allZero(2, 6)) {
    // NAT64 well-known prefix 64:ff9b::/96: classify the embedded IPv4.
    return forbiddenIpv4([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff]);
  }
  if (groups[0] === 0x2002) {
    // 6to4 2002::/16: the embedded IPv4 address sits in groups 1–2.
    return forbiddenIpv4([groups[1]! >> 8, groups[1]! & 0xff, groups[2]! >> 8, groups[2]! & 0xff]);
  }
  if ((groups[0]! & 0xfe00) === 0xfc00) {
    return true; // unique-local fc00::/7
  }
  if ((groups[0]! & 0xffc0) === 0xfe80) {
    return true; // link-local fe80::/10
  }
  if ((groups[0]! & 0xff00) === 0xff00) {
    return true; // multicast ff00::/8
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
    return true; // documentation 2001:db8::/32
  }
  return false;
}

/**
 * True when one IP address (literal or resolved) is a dangerous target:
 * loopback, private, link-local, unique-local, multicast, or any other
 * reserved range. Unparsable addresses are FORBIDDEN — the guard fails
 * closed (an address we cannot classify is never fetched).
 */
export function isForbiddenIp(address: string): boolean {
  if (address.includes(":")) {
    const groups = parseIpv6(address);
    return groups === null ? true : forbiddenIpv6(groups);
  }
  const bytes = parseIpv4(address);
  return bytes === null ? true : forbiddenIpv4(bytes);
}

/**
 * Validate one fetch target BEFORE any connect (review fix F2): the scheme
 * must be http/https, and the host — by literal or by EVERY resolved
 * address — must be public. An explicitly allowed origin (the configured
 * fixture posture) skips the dangerous-target check; an unresolvable host
 * is the typed transient refusal (fail closed, never fetch-then-see).
 */
export async function assertFetchTargetAllowed(
  url: URL,
  opts: FetchTargetGuardOptions = {},
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResearchToolError(
      "RESEARCH_INPUT_INVALID",
      `only http and https pages can be fetched (got ${url.protocol})`,
    );
  }
  if (opts.allowedOrigins?.includes(url.origin)) {
    return; // the explicitly configured fixture posture (G7)
  }
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  let addresses: readonly string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (opts.resolveHost ?? defaultResolveHost)(hostname);
    } catch (error) {
      throw new ResearchToolError(
        "TRANSIENT_NETWORK",
        `the page host could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (addresses.length === 0) {
      throw new ResearchToolError(
        "TRANSIENT_NETWORK",
        "the page host did not resolve to any address",
      );
    }
  }
  for (const address of addresses) {
    if (isForbiddenIp(address)) {
      throw new ResearchToolError(
        "RESEARCH_INPUT_INVALID",
        `the page host ${url.hostname} is a non-public address (${address}) — refusing the fetch`,
      );
    }
  }
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
 * Fetch and extract one page: deadline-bounded, byte-capped, host-guarded,
 * readability + turndown. Redirects are followed MANUALLY — at most five
 * hops, every hop re-validated (scheme + dangerous-target refusal) before
 * its connect — and every failure is typed; a readability miss degrades
 * honestly to the raw page text with an explicit marker (the content IS
 * there — the marker says the structured extraction found no article). The
 * outcome reports the FINAL url the tool actually read.
 */
export async function fetchReadablePage(deps: {
  fetchImpl: typeof fetch;
  url: string;
  timeoutMs: number;
  maxBodyBytes: number;
  signal?: AbortSignal;
  allowedOrigins?: readonly string[];
  resolveHost?: ResolveHost;
}): Promise<PageFetchOutcome> {
  const initialUrl = assertFetchableUrl(deps.url);
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs);
  const signal =
    deps.signal !== undefined ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal;
  const cancelSignal: AbortSignal | null = deps.signal ?? null;
  const guard: FetchTargetGuardOptions = {
    allowedOrigins: deps.allowedOrigins ?? [],
    ...(deps.resolveHost !== undefined ? { resolveHost: deps.resolveHost } : {}),
  };
  const fetchOptions = {
    method: "GET",
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
    redirect: "manual" as const,
    signal,
  };

  // Follow at most PAGE_MAX_REDIRECT_HOPS hops; every hop — the initial URL
  // AND every redirect target — is validated BEFORE its connect (the
  // redirect Location is exactly as user-influenced as the original url).
  let currentUrl = initialUrl;
  let response: Response | null = null;
  for (let hop = 0; response === null; hop += 1) {
    await assertFetchTargetAllowed(currentUrl, guard);
    let hopResponse: Response;
    try {
      hopResponse = await deps.fetchImpl(currentUrl.href, fetchOptions);
    } catch (error) {
      throw mapFetchFailure(error, {
        cancelSignal,
        timeoutSignal,
        what: `the fetch of ${currentUrl.href}`,
      });
    }
    if (!REDIRECT_STATUSES.has(hopResponse.status)) {
      response = hopResponse;
      break;
    }
    // A redirect: release its body (never drained), then validate the next
    // hop before following it. Hop six refuses typed — no unbounded chains.
    await cancelResponseBody(hopResponse);
    if (hop >= PAGE_MAX_REDIRECT_HOPS) {
      throw new ResearchToolError(
        "RESEARCH_RESPONSE_INVALID",
        `the page redirected more than ${PAGE_MAX_REDIRECT_HOPS} times — refusing to follow the chain`,
      );
    }
    const location = hopResponse.headers.get("location");
    if (location === null || location.trim() === "") {
      throw new ResearchToolError(
        "RESEARCH_RESPONSE_INVALID",
        "the redirect carried no Location header",
      );
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new ResearchToolError(
        "RESEARCH_RESPONSE_INVALID",
        "the redirect Location is not a valid URL",
      );
    }
    currentUrl = nextUrl;
  }

  if (!response.ok) {
    // The refusal path never drains the body: cancel the stream (bounded by
    // construction — the body's size is irrelevant to the refusal).
    await cancelResponseBody(response);
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
    await cancelResponseBody(response);
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
      what: `the download of ${currentUrl.href}`,
    });
  }

  if (kind === "text") {
    return { url: currentUrl.href, title: null, markdown: body, chars: body.length, truncated };
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
  return { url: currentUrl.href, title, markdown, chars: markdown.length, truncated };
}
