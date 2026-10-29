/**
 * The D35 risk-class ladder as DATA (S21 chunk 2; D9, D35, PRD §7, G2/G6).
 *
 * "Classification is data, never prose inference": the ladder is one
 * deterministic table over the D9 risk classes — every class maps to its
 * execution posture (READ_ONLY runs automatically; every other class is gated
 * behind the approval machinery) and its preview kind (what the UI shows
 * BEFORE anything executes). The executor consults this table; nothing in the
 * runtime derives a class or a posture from proposal text (G2).
 *
 * The D35 ladder's middle rows are capability-shaped, not class-shaped:
 * "code execution → show command, working directory, resource policy" and
 * "repository mutation → show diff/branch/worktree" refine the preview of the
 * class they run under. Those refinements are the PREFIX_PREVIEW_KINDS table —
 * still data (a capability prefix → preview kind mapping), never inference.
 */

import type { RiskClass } from "@shera-bot/contracts";

/** The execution posture one risk class prescribes. */
export interface LadderEntry {
  /** automatic = no approval; gated = the S20 approval machinery decides. */
  execution: "automatic" | "gated";
  /** Approval tier for copy and UI: none / standard (D35 middle rows) / explicit. */
  approval_tier: "none" | "standard" | "explicit";
  /** What the preview shows before execution, when one is required. */
  preview_kind: "none" | "diff" | "command" | "repo" | "target_effect";
  /** UI-safe ladder label (§7 product copy — never internal prose). */
  label: string;
}

/**
 * The ladder, verbatim from D35:
 *   Read-only tool        → execute automatically
 *   Local file mutation   → show preview and request approval
 *   Code execution        → show command, working directory, resource policy
 *   Repository mutation   → show diff/branch/worktree and request approval
 *   External write        → request approval
 *   Destructive/irreversible → request explicit approval
 */
export const RISK_CLASS_LADDER: Readonly<Record<RiskClass, LadderEntry>> = Object.freeze({
  READ_ONLY: {
    execution: "automatic",
    approval_tier: "none",
    preview_kind: "none",
    label: "Runs automatically",
  },
  LOCAL_MUTATION: {
    execution: "gated",
    approval_tier: "standard",
    preview_kind: "diff",
    label: "Preview, then approval",
  },
  DESTRUCTIVE_LOCAL: {
    execution: "gated",
    approval_tier: "explicit",
    preview_kind: "target_effect",
    label: "Explicit approval",
  },
  EXTERNAL_WRITE: {
    execution: "gated",
    approval_tier: "explicit",
    preview_kind: "target_effect",
    label: "Explicit approval",
  },
  CREDENTIAL_ACCESS: {
    execution: "gated",
    approval_tier: "explicit",
    preview_kind: "target_effect",
    label: "Explicit approval",
  },
  DEPLOYMENT: {
    execution: "gated",
    approval_tier: "explicit",
    preview_kind: "target_effect",
    label: "Explicit approval",
  },
  FINANCIAL_OR_IRREVERSIBLE: {
    execution: "gated",
    approval_tier: "explicit",
    preview_kind: "target_effect",
    label: "Explicit approval",
  },
} satisfies Record<RiskClass, LadderEntry>);

/**
 * Capability-prefix → preview-kind refinements (the D35 code-execution and
 * repository-mutation rows). The FIRST matching prefix wins; unmapped
 * capabilities keep the class's own preview kind. Data — a table, not prose.
 */
const PREFIX_PREVIEW_KINDS: ReadonlyArray<{
  prefix: string;
  preview_kind: LadderEntry["preview_kind"];
}> = Object.freeze([
  { prefix: "code.", preview_kind: "command" },
  { prefix: "repo.", preview_kind: "repo" },
]);

/**
 * Resolve the preview kind for one proposal: the capability refinement when a
 * prefix matches, otherwise the risk class's own ladder kind. READ_ONLY stays
 * preview-free whatever its capabilities claim — the class is the authority
 * (G6: read-only tools run automatically, no preview ceremony).
 */
export function resolvePreviewKind(
  riskClass: RiskClass,
  capabilities: readonly string[],
): LadderEntry["preview_kind"] {
  if (riskClass === "READ_ONLY") {
    return "none";
  }
  for (const { prefix, preview_kind } of PREFIX_PREVIEW_KINDS) {
    if (capabilities.some((capability) => capability.startsWith(prefix))) {
      return preview_kind;
    }
  }
  return RISK_CLASS_LADDER[riskClass].preview_kind;
}
