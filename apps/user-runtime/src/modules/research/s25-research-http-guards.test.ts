/**
 * S25 research HTTP guards (consolidated fix round; issue #26 AC3; G3/G7) —
 * the pins the three fresh-context reviews consolidated against the research
 * family's network surfaces:
 *
 *   1. The refusal paths are BOUNDED (no unbounded memory): a refusal
 *      (non-2xx status, non-readable content type, over-cap declared or
 *      streamed body) releases the body — the stream is cancelled or read
 *      under the cap, never drained whole through `arrayBuffer()`.
 *   2. The search over-cap policy is the typed `TOOL_RESPONSE_TOO_LARGE`
 *      refusal, pinned with a small `maxBodyBytes` (it was implemented but
 *      dead-untested); the declared-content-length early refusal cancels the
 *      body before any read.
 *
 * All legs run against injected fetch seams with counting streams — no live
 * network in default CI (G7). The host-guard and parse-bomb pins live in
 * their own suites.
 */
import { describe, expect, it } from "vitest";

import { readBodyWithCap } from "./research-http.ts";
import { searxngSearch } from "./searxng-search.ts";
import { fetchReadablePage } from "./page-fetch.ts";
import { ResearchToolError } from "./research-errors.ts";

/** One chunk of 64 KiB; four MiB total unless overridden. */
const CHUNK_BYTES = 64 * 1024;
const TOTAL_BYTES = 4 * 1024 * 1024;
/**
 * The stream's HWM-1 construction pull enqueues exactly one chunk before any
 * consumer reads — that eager chunk is bounded by construction. Everything
 * beyond it is what a refusal path chose to consume; the "no unbounded
 * memory" point is that a refusal never goes past a few chunks of a hostile
 * body (the pre-fix `arrayBuffer()` drain pulled all four MiB).
 */
const EAGER_CHUNKS = 1;
const BOUNDED_REFUSAL_CHUNKS = 4;

interface CountedResponse {
  response: Response;
  /** Bytes the consumer actually pulled from the body stream. */
  pulledBytes: () => number;
  /** True once the consumer cancelled the stream. */
  cancelled: () => boolean;
}

/**
 * A real `Response` whose body is an endless counting stream: every pull
 * enqueues one 64 KiB chunk. The pins measure what a refusal path did to
 * the body — a bounded refusal pulls (at most) one chunk and cancels; an
 * unbounded drain pulls the whole body.
 */
function countedResponse(init: {
  status: number;
  headers?: Record<string, string>;
  totalBytes?: number;
}): CountedResponse {
  const totalBytes = init.totalBytes ?? TOTAL_BYTES;
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) {
        controller.close();
        return;
      }
      pulled += CHUNK_BYTES;
      controller.enqueue(new Uint8Array(CHUNK_BYTES));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, {
    status: init.status,
    headers: init.headers,
  });
  return { response, pulledBytes: () => pulled, cancelled: () => cancelled };
}

describe("bounded refusal paths (review fix F1)", () => {
  it("refuses an over-cap DECLARED content-length before any read and cancels the body", async () => {
    // The declared length is over the cap: the refusal must happen BEFORE
    // the body starts (pulled stays zero) and the stream must be released
    // (cancelled) — a silent early-return would pin the socket open.
    const counted = countedResponse({
      status: 200,
      headers: { "content-length": String(TOTAL_BYTES), "content-type": "text/html" },
    });
    const outcome = await readBodyWithCap(counted.response, 64 * 1024);
    expect(outcome.truncated).toBe(true);
    expect(counted.pulledBytes()).toBeLessThanOrEqual(EAGER_CHUNKS * CHUNK_BYTES);
    expect(counted.cancelled()).toBe(true);
  });

  it("refuses an oversized non-2xx body boundedly (typed refusal, body cancelled)", async () => {
    // A 500 from ANY host (here a public literal) carries a hostile 4 MiB
    // body: the refusal path must never drain it whole (the pre-fix
    // `drainResponse` pulled all 4 MiB through `arrayBuffer()`).
    const counted = countedResponse({
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    try {
      await fetchReadablePage({
        fetchImpl: async () => counted.response,
        url: "http://93.184.216.34/oversized-error",
        timeoutMs: 1_000,
        maxBodyBytes: 64 * 1024,
      });
      expect.unreachable("expected the 500 to refuse typed");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchToolError);
      expect((error as ResearchToolError).code).toBe("TRANSIENT_NETWORK");
    }
    // Bounded: at most the look-ahead chunks, and the stream was released.
    expect(counted.pulledBytes()).toBeLessThanOrEqual(BOUNDED_REFUSAL_CHUNKS * CHUNK_BYTES);
    expect(counted.cancelled()).toBe(true);
  });

  it("refuses an oversized non-readable 200 body boundedly (typed refusal, body cancelled)", async () => {
    // A 200 with a non-readable content type and a hostile body: the same
    // bounded refusal — the body is cancelled, never drained whole.
    const counted = countedResponse({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    try {
      await fetchReadablePage({
        fetchImpl: async () => counted.response,
        url: "http://93.184.216.34/oversized-binary",
        timeoutMs: 1_000,
        maxBodyBytes: 64 * 1024,
      });
      expect.unreachable("expected the unreadable content type to refuse typed");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchToolError);
      expect((error as ResearchToolError).code).toBe("RESEARCH_SOURCE_UNREADABLE");
    }
    expect(counted.pulledBytes()).toBeLessThanOrEqual(BOUNDED_REFUSAL_CHUNKS * CHUNK_BYTES);
    expect(counted.cancelled()).toBe(true);
  });
});

describe("the search over-cap refusal is pinned, not dead code (review fix F4)", () => {
  it("refuses a streamed search response over a small maxBodyBytes with TOOL_RESPONSE_TOO_LARGE", async () => {
    const counted = countedResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      totalBytes: 8 * CHUNK_BYTES,
    });
    try {
      await searxngSearch(
        {
          baseUrl: "http://93.184.216.34:8080",
          fetchImpl: async () => counted.response,
        },
        { query: "hostile result set", timeoutMs: 1_000, maxBodyBytes: 64 * 1024 },
      );
      expect.unreachable("expected the over-cap search response to refuse typed");
    } catch (error) {
      // The search JSON cannot be truncated at a semantic boundary — the
      // policy is the typed refusal, and the stream is cancelled at the cap.
      expect((error as Error).message).toContain("TOOL_RESPONSE_TOO_LARGE");
    }
    expect(counted.pulledBytes()).toBeLessThanOrEqual(BOUNDED_REFUSAL_CHUNKS * CHUNK_BYTES);
    expect(counted.cancelled()).toBe(true);
  });

  it("refuses an over-cap DECLARED search response before any read and cancels the body", async () => {
    const counted = countedResponse({
      status: 200,
      headers: { "content-length": String(TOTAL_BYTES), "content-type": "application/json" },
    });
    try {
      await searxngSearch(
        {
          baseUrl: "http://93.184.216.34:8080",
          fetchImpl: async () => counted.response,
        },
        { query: "declared hostile result set", timeoutMs: 1_000, maxBodyBytes: 64 * 1024 },
      );
      expect.unreachable("expected the over-cap declared response to refuse typed");
    } catch (error) {
      expect((error as Error).message).toContain("TOOL_RESPONSE_TOO_LARGE");
    }
    expect(counted.pulledBytes()).toBeLessThanOrEqual(EAGER_CHUNKS * CHUNK_BYTES);
    expect(counted.cancelled()).toBe(true);
  });
});
