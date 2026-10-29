/**
 * Tool-surface redaction (S21 chunk 4 logic, shipped with the executor core;
 * PRD §7/§16, D22, D23 rule 4, G3, AC9): every recorded tool surface — the
 * args summary, the result summary, the preview text, and everything the tool
 * history API returns — passes through THIS layer before any row is written
 * or any payload crosses a read boundary.
 *
 * The secret vocabulary is the S18 terminal-boundary layer (the single
 * redaction authority the runtime already trusts — the S18 review round
 * extended it with quoted-key JSON and the `cookie` family); this module
 * reuses it verbatim and adds the tool-surface concerns:
 *
 *   - bounding: a payload over its budget is TRUNCATED with an explicit
 *     marker (never stored whole — AC9's "no unredacted large payloads");
 *   - summarizing: arguments become a bounded, redacted JSON summary — raw
 *     arguments never reach any persisted surface (G3).
 *
 * The layer errs toward over-redaction: a false positive loses one surface's
 * fidelity, a false negative leaks a credential (AC21).
 */
import { redactSecrets } from "../terminals/secret-redaction.ts";

/** The marker a bounded payload is truncated with. */
export const TRUNCATION_MARKER = "…[TRUNCATED";

/**
 * The S21 tool-surface EXTENSION to the S18 vocabulary: high-entropy token
 * runs (24+ chars of base64url-ish material mixing letters and digits). The
 * terminal layer deliberately lacks this pass (terminal output must stay
 * readable); tool results and argument summaries have no such requirement —
 * a bare opaque secret (not shaped `key=value`) is exactly the leak channel
 * AC9 forbids. Word-shaped runs (letters only) and pure numbers survive, so
 * ordinary prose and URIs stay readable. Same bias as the S20 approval-text
 * pass: a false positive loses one surface's fidelity, a false negative
 * leaks a credential.
 */
const TOOL_HIGH_ENTROPY_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{24,}(?![A-Za-z0-9+/=_-])/g;

/**
 * Redact, then bound one text surface to maxBytes (UTF-8). The secret passes
 * run FIRST (S18 vocabulary, then the tool-layer entropy extension) so a
 * truncated-at-the-wrong-moment secret cannot survive in the kept prefix.
 */
export function redactAndBound(text: string, maxBytes: number): string {
  const redacted = redactSecrets(text).replace(TOOL_HIGH_ENTROPY_RUN, (run) =>
    /\d/.test(run) && /[A-Za-z]/.test(run) ? "[REDACTED]" : run,
  );
  const byteLength = Buffer.byteLength(redacted, "utf8");
  if (byteLength <= maxBytes) {
    return redacted;
  }
  // Cut by code units until the payload plus the marker fits the budget.
  const marker = `${TRUNCATION_MARKER} original_bytes=${byteLength}]`;
  let kept = redacted;
  while (Buffer.byteLength(kept + marker, "utf8") > maxBytes && kept.length > 0) {
    kept = kept.slice(0, Math.max(0, kept.length - 64));
  }
  return `${kept}${marker}`;
}

/**
 * One tool execution's arguments summary (G3): the canonical JSON of the
 * arguments, redacted and bounded. Raw arguments never reach a persisted
 * surface — the digest (computed by the executor over the raw values) is the
 * only argument-derived identity the record carries.
 */
export function summarizeArgs(args: unknown, budgetBytes = 512): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "null";
  } catch {
    serialized = "[unserializable arguments]";
  }
  return redactAndBound(serialized, budgetBytes);
}
