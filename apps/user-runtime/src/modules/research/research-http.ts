/**
 * Shared bounded-HTTP helpers for the research family (S25 chunk 2; AC3,
 * G3) — the byte-capped body reader and the typed abort mapping every
 * research fetch uses. The cap is the "never a crash, never an unbounded
 * memory spike" policy: the reader stops at the byte budget, and the caller
 * decides the tool's own policy for what was read (search refuses typed;
 * page fetch truncates into an artifact).
 */
import { ToolBindingError } from "../tools/tool-binding.ts";
import { ResearchToolError } from "./research-errors.ts";

/** One capped download: the text read, its byte size, and whether the cap cut it. */
export interface DownloadOutcome {
  text: string;
  bytes: number;
  truncated: boolean;
}

/**
 * Read one response body under a hard byte cap. A declared content-length
 * over the cap refuses before the body starts (the body stream is cancelled,
 * never held open); a streamed body that grows past the cap mid-read stops
 * at the cap (the socket is cancelled) and reports `truncated` — the caller
 * applies the tool's own policy.
 */
export async function readBodyWithCap(
  response: Response,
  maxBodyBytes: number,
): Promise<DownloadOutcome> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBodyBytes) {
    // Cancel — the over-cap body is never read, and the socket is released
    // instead of pinned open by an unread stream.
    await cancelResponseBody(response);
    return { text: "", bytes: 0, truncated: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ResearchToolError("TRANSIENT_NETWORK", "the response carried no readable body");
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return { text: `${text}${decoder.decode()}`, bytes, truncated };
}

/**
 * Map one fetch/reader failure to the typed research failure:
 *   - the executor's cancel seam fired            → TOOL_EXECUTION_CANCELLED
 *   - the tool's own deadline abort fired         → TOOL_EXECUTION_TIMEOUT
 *   - anything else (DNS, refused, reset)         → TRANSIENT_NETWORK
 */
export function mapFetchFailure(
  error: unknown,
  opts: { cancelSignal?: AbortSignal | null; timeoutSignal: AbortSignal; what: string },
): ToolBindingError {
  if (opts.cancelSignal?.aborted) {
    return new ToolBindingError(
      "TOOL_EXECUTION_CANCELLED",
      `TOOL_EXECUTION_CANCELLED: ${opts.what} was cancelled before it completed`,
    );
  }
  if (opts.timeoutSignal.aborted) {
    return new ToolBindingError(
      "TOOL_EXECUTION_TIMEOUT",
      `TOOL_EXECUTION_TIMEOUT: ${opts.what} exceeded its deadline`,
    );
  }
  return new ResearchToolError(
    "TRANSIENT_NETWORK",
    `${opts.what} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Cancel one response's body stream (review fix F1): every refusal path —
 * non-2xx statuses, non-readable content types, over-cap declared lengths —
 * releases the socket this way instead of draining the body. Draining an
 * arbitrary (potentially hostile, arbitrarily large) body through
 * `arrayBuffer()` was the unbounded-memory hole the fix round closed: the
 * refusal never reads the body, so its size is irrelevant by construction.
 * The promise never rejects — the body is irrelevant to the refusal.
 */
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // a failed cancel must never mask the typed refusal that follows
  }
}
