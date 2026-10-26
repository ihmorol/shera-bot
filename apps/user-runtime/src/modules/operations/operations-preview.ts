/**
 * S15 chunk 1 — PURE derivation helpers for the Operation launch preview read
 * model (D30). No I/O, no repository access, no error throwing, no mutation
 * path: the OperationsService resolves the definition and roster (read-only)
 * and calls these helpers to assemble the eight D30 groups. Everything here
 * is an honest, documented mapping — the preview never invents a capability,
 * a connection, a provider, or a price.
 *
 * Governing decisions: D30 (eight preview groups), D38 (skills/connectors are
 * pack references; connectors never auto-install; the runtime owns tool risk
 * classes), D20 (credits are a bounded estimate with settlement; custom
 * providers consume no Shera credits), D35 (the risk ladder; read-only tools
 * execute automatically, the other classes request approval), G3 (the preview
 * shows configuration, never credentials).
 */
import type {
  D35RiskClass,
  OperationPreviewApprovalClass,
  OperationPreviewCreditsEstimate,
  OperationPreviewExpectedOutputs,
} from "@shera-bot/contracts";

/**
 * The prototype's placeholder platform provider id — the value the pack
 * manifests seed and the agents repository defaults to. D20: requests on any
 * OTHER (custom) provider consume no Shera credits. S23 owns real providers;
 * nothing here is a credential (G3).
 */
export const PLATFORM_PROVIDER_ID = "provider_platform";

/**
 * D20 estimate formula (policy placeholder until the providers slice owns
 * real pricing): a bounded range derived ONLY from the roster size on the
 * platform provider — min 1 credit per such Agent, max 5 credits per such
 * Agent. The estimate is a RANGE, never a promise, and the settlement note
 * says what actually happens (reserve → settle → release unused).
 */
export const CREDITS_MIN_PER_PLATFORM_AGENT = 1;
export const CREDITS_MAX_PER_PLATFORM_AGENT = 5;

export const CREDITS_FORMULA_NOTE =
  "Policy placeholder (D20): min = 1 credit per platform-provider Agent, max = 5 credits per " +
  "platform-provider Agent; Agents on custom providers consume no Shera credits. The providers " +
  "slice (S23) replaces this with real pricing.";

export const CREDITS_SETTLEMENT_NOTE =
  "The runtime reserves a bounded estimate before execution, settles against actual usage, and " +
  "releases unused reservations (D20). The preview itself consumes nothing.";

export const CONNECTOR_PREVIEW_NOTE =
  "Recommended connector, not installed. Connect it yourself before launch if you want it available.";

export const PROVIDER_PREVIEW_NOTE =
  "Not configured: no live provider is wired in this prototype (S23 owns provider wiring); the " +
  "pair shown is the Agent's saved default.";

/**
 * D35 default tool ladder (the documented mapping used when the pack's tool
 * references carry no risk class of their own — the runtime owns tool
 * definitions and re-derives every class at execution time, D38). Tool ids
 * NOT in this table default to the conservative end: external-write, which
 * requests approval.
 */
export const D35_TOOL_DEFAULT_LADDER: Readonly<Record<string, D35RiskClass>> = {
  tool_web_search: "read-only",
  tool_file_read: "read-only",
  tool_file_write: "local-mutation",
  tool_code_exec: "code-execution",
  tool_repo_push: "repository-mutation",
};

/** D35: the ladder's only automatic class; every other class requests approval. */
export const D35_AUTO_CLASSES: readonly D35RiskClass[] = ["read-only"];

export const D35_UNMAPPED_TOOL_CLASS: D35RiskClass = "external-write";

export const D35_MAPPING_NOTE =
  "The pinned pack references tools without risk classes (the runtime owns tool definitions, " +
  "D38); this preview applies the documented D35 default ladder to tool ids, and the runtime " +
  "re-derives every class at execution time. Read-only tools execute automatically; the other " +
  "ladder classes request approval (D35).";

export const PURPOSE_DERIVED_OUTPUTS_REASON =
  "The pinned pack's definition carries no expected outputs field.";

/**
 * Map the roster's reachable tool ids onto the D35 ladder (group 7). Returns
 * the classes present, the subset that pauses for approval, and the per-class
 * mapping with the tool ids behind it — named classes, never promised
 * outcomes (D30/D35).
 */
export function classifyToolRiskClasses(toolIds: readonly string[]): {
  risk_classes: D35RiskClass[];
  classes_requiring_approval: D35RiskClass[];
  mapping: OperationPreviewApprovalClass[];
} {
  const byClass = new Map<D35RiskClass, string[]>();
  for (const toolId of toolIds) {
    const riskClass = D35_TOOL_DEFAULT_LADDER[toolId] ?? D35_UNMAPPED_TOOL_CLASS;
    const bucket = byClass.get(riskClass) ?? [];
    if (!bucket.includes(toolId)) {
      bucket.push(toolId);
    }
    byClass.set(riskClass, bucket);
  }
  // Deterministic order: the ladder's own class order, not map insertion order.
  const ladderOrder: readonly D35RiskClass[] = [
    "read-only",
    "local-mutation",
    "code-execution",
    "repository-mutation",
    "external-write",
    "destructive-irreversible",
  ];
  const mapping: OperationPreviewApprovalClass[] = [];
  for (const riskClass of ladderOrder) {
    const tool_ids = byClass.get(riskClass);
    if (tool_ids === undefined) {
      continue;
    }
    mapping.push({
      risk_class: riskClass,
      tool_ids,
      behavior: D35_AUTO_CLASSES.includes(riskClass) ? "auto_execute" : "approval_required",
    });
  }
  return {
    risk_classes: mapping.map((entry) => entry.risk_class),
    classes_requiring_approval: mapping
      .filter((entry) => entry.behavior === "approval_required")
      .map((entry) => entry.risk_class),
    mapping,
  };
}

/**
 * The D20 credits estimate (group 6): the bounded range from the documented
 * placeholder formula over the platform-provider Agent count, with the
 * settlement note and the custom-provider Agents called out separately
 * (they consume no Shera credits, D20).
 */
export function estimateCredits(
  platformAgentCount: number,
  customProviderAgentIds: readonly string[],
): OperationPreviewCreditsEstimate {
  return {
    currency: "shera_credits",
    min_credits: CREDITS_MIN_PER_PLATFORM_AGENT * platformAgentCount,
    max_credits: CREDITS_MAX_PER_PLATFORM_AGENT * platformAgentCount,
    formula: CREDITS_FORMULA_NOTE,
    settlement_note: CREDITS_SETTLEMENT_NOTE,
    custom_provider_agents: [...customProviderAgentIds],
  };
}

/**
 * Group 8, honest fallback: the student pack's definitions carry NO expected
 * outputs field, so the statement is derived from the definition's purpose
 * and marked "purpose_derived" with the reason — never invented. (The
 * statement is capped at the schema's 2000-char bound; the purpose itself is
 * capped at 2000, so the prefix is trimmed away first if ever needed.)
 */
export function purposeDerivedOutputs(purpose: string): OperationPreviewExpectedOutputs {
  const prefix = "From the definition's purpose: ";
  const budget = 2000 - prefix.length;
  const statement = `${prefix}${purpose.slice(Math.max(0, purpose.length - budget))}`;
  return {
    statement,
    source: "purpose_derived",
    reason: PURPOSE_DERIVED_OUTPUTS_REASON,
  };
}

/**
 * The definition reference the confirmed launch will carry on the Operation
 * record (D29/D41). S13 treats `definition_ref` as an opaque string; THIS
 * format is the preview's documented, deterministic rendering of a pinned
 * pack definition — the same string chunk 3's launch resolves back.
 */
export function operationDefinitionRef(
  packId: string,
  packVersion: string,
  operationId: string,
  operationVersion: string,
): string {
  return `agent-packs/${packId}/v${packVersion}/operations/${operationId}@${operationVersion}`;
}
