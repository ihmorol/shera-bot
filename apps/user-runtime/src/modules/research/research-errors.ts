/**
 * Research-tool typed failures (S25 chunk 1; issue #26 AC6, E13, D35, G2).
 *
 * Every failure a research binding raises is a TYPED error carrying its
 * retryability as data — never prose, never a guess. The vocabulary is the
 * executor's binding failure codes extended by the research family; the
 * runtime retry policy (modules/tasks/retry-policy.ts) classifies the SAME
 * codes, and the two tables are pinned to agree (the retryability flag on
 * the error and the classification in the policy are one truth).
 *
 *   - TRANSIENT_NETWORK: timeouts, connection failures, 429/5xx responses.
 *     Retryable — the network may recover.
 *   - TOOL_RESPONSE_TOO_LARGE: the response body exceeded the tool's byte
 *     cap. Not retryable — the same request returns the same size.
 *   - RESEARCH_INPUT_INVALID: the proposal's arguments were unusable at the
 *     binding boundary. Not retryable.
 *   - RESEARCH_RESPONSE_INVALID: the endpoint answered, but not in the
 *     documented shape. Not retryable (a config/contract fault).
 *   - RESEARCH_SOURCE_NOT_FOUND: the requested page/file does not exist.
 *     Not retryable.
 *   - RESEARCH_SOURCE_UNREADABLE: the source exists but could not be parsed
 *     (PDF text extraction failure, spreadsheet decode failure). Not
 *     retryable.
 *   - RESEARCH_PROVIDER_UNAVAILABLE: no vision model is configured for
 *     image understanding (the D17 configuration gap). Not retryable —
 *     configuration, not chance.
 */
import { ToolBindingError, type ToolBindingFailureCode } from "../tools/tool-binding.ts";

export type ResearchToolFailureCode = Extract<
  ToolBindingFailureCode,
  | "TRANSIENT_NETWORK"
  | "TOOL_RESPONSE_TOO_LARGE"
  | "RESEARCH_INPUT_INVALID"
  | "RESEARCH_RESPONSE_INVALID"
  | "RESEARCH_SOURCE_NOT_FOUND"
  | "RESEARCH_SOURCE_UNREADABLE"
  | "RESEARCH_PROVIDER_UNAVAILABLE"
>;

/** The retryability of one research failure code, as data. */
export const RESEARCH_FAILURE_SHAPES: Readonly<
  Record<ResearchToolFailureCode, { retryable: boolean; kind: "transient" | "permanent" }>
> = Object.freeze({
  TRANSIENT_NETWORK: { retryable: true, kind: "transient" },
  TOOL_RESPONSE_TOO_LARGE: { retryable: false, kind: "permanent" },
  RESEARCH_INPUT_INVALID: { retryable: false, kind: "permanent" },
  RESEARCH_RESPONSE_INVALID: { retryable: false, kind: "permanent" },
  RESEARCH_SOURCE_NOT_FOUND: { retryable: false, kind: "permanent" },
  RESEARCH_SOURCE_UNREADABLE: { retryable: false, kind: "permanent" },
  RESEARCH_PROVIDER_UNAVAILABLE: { retryable: false, kind: "permanent" },
});

/**
 * One research binding failure: the executor's typed binding error shape
 * (the code prefixes the message so the executor's boundary parsing keeps
 * the code verbatim) plus the retryable flag as a carried datum.
 */
export class ResearchToolError extends ToolBindingError {
  readonly retryable: boolean;
  readonly kind: "transient" | "permanent";

  constructor(code: ResearchToolFailureCode, message: string) {
    super(code, message);
    const shape = RESEARCH_FAILURE_SHAPES[code];
    this.retryable = shape.retryable;
    this.kind = shape.kind;
  }
}

/** The codes the research family adds to the executor's binding vocabulary. */
export const RESEARCH_BINDING_CODES: readonly ToolBindingFailureCode[] = Object.freeze([
  "TRANSIENT_NETWORK",
  "TOOL_RESPONSE_TOO_LARGE",
  "RESEARCH_INPUT_INVALID",
  "RESEARCH_RESPONSE_INVALID",
  "RESEARCH_SOURCE_NOT_FOUND",
  "RESEARCH_SOURCE_UNREADABLE",
  "RESEARCH_PROVIDER_UNAVAILABLE",
]);
