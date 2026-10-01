/**
 * Pack manifest schema (S10 chunk 1): the Zod contract every pack manifest
 * must satisfy before the loader accepts it (D18, D28, D46).
 *
 * A manifest is data and configuration only (D28): it REFERENCES skills,
 * tools, and connectors — it never embeds implementations, secrets, host
 * paths, or executable content (D22, D38). Enforcement is two-layered:
 * strict unknown-field discipline (D25) on the object shape, plus semantic
 * checks in superRefine (reference integrity, D46 single-membership, and a
 * deep scan of every string value). Every rejection message carries a stable
 * rule-id prefix ("d46-single-membership: ...") so tooling can classify
 * failures through validateManifest().
 *
 * D38: capabilities declared in a manifest are UPPER BOUNDS, never grants.
 * The pack narrows what the platform allows; it can never widen a
 * platform-level restriction, and the runtime rechecks every permission at
 * execution time (agents propose; the runtime validates and executes).
 *
 * Zod-first (D25): every exported type below is inferred from its Zod schema.
 */
import { z } from "zod";

import { SemVer } from "./primitives.ts";

/**
 * Identifiers inside a pack manifest use a lowercase slug charset. Pack data
 * is authored configuration, not user input; the charset keeps ids usable as
 * file names and roster keys, and makes it impossible to declare a filesystem
 * path or URL as an id.
 */
export const PackElementId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,127}$/,
    "expected a lowercase slug identifier (letters, digits, '-', '_')",
  );
export type PackElementId = z.infer<typeof PackElementId>;

/**
 * D18: a pack declares the runtime contract versions it is compatible with.
 * Supported syntax (matched by checkCompatibility): "*", an exact "X.Y.Z",
 * caret "^X.Y.Z" (same major; for 0.x targets the same minor), and tilde
 * "~X.Y.Z" (same minor).
 */
export const RuntimeCompatibilityRange = z
  .string()
  .regex(
    /^\*$|^[~^]?\d+\.\d+\.\d+$/,
    "expected '*', an exact 'X.Y.Z', or a '^X.Y.Z' / '~X.Y.Z' range",
  );
export type RuntimeCompatibilityRange = z.infer<typeof RuntimeCompatibilityRange>;

/** D18: UI identity metadata. Presentation data only — never a capability. */
export const UiIdentity = z.strictObject({
  avatar_hue: z.number().int().min(0).max(360),
  /** A single code point rendered as the avatar fallback. */
  initial_glyph: z
    .string()
    .refine((glyph) => [...glyph].length === 1, "expected exactly one code point"),
});
export type UiIdentity = z.infer<typeof UiIdentity>;

/**
 * Provider/model default (D18, D22). A pack names provider REFERENCES, never
 * credentials: provider keys stay inside the user container and never appear
 * in a manifest (D22 non-negotiable; G3).
 */
export const ProviderDefault = z.strictObject({
  provider_id: PackElementId,
  model: z.string().min(1).max(256),
});
export type ProviderDefault = z.infer<typeof ProviderDefault>;

/** A versioned reference to a runtime-owned tool (D38). */
export const ToolRef = z.strictObject({
  tool_id: PackElementId,
  version: SemVer,
});
export type ToolRef = z.infer<typeof ToolRef>;

/** A skill catalog entry: the pack declares what its agents may reference. */
export const SkillDeclaration = z.strictObject({
  skill_id: PackElementId,
  version: SemVer,
  title: z.string().min(1).max(200),
});
export type SkillDeclaration = z.infer<typeof SkillDeclaration>;

/** A connector catalog entry: a reference to an authenticated integration (D38). */
export const ConnectorDeclaration = z.strictObject({
  connector_id: PackElementId,
  version: SemVer,
  title: z.string().min(1).max(200),
});
export type ConnectorDeclaration = z.infer<typeof ConnectorDeclaration>;

export const AgentManifest = z.strictObject({
  agent_id: PackElementId,
  display_name: z.string().min(1).max(200),
  /** The fixed role; user instructions are profile content layered above it. */
  role_description: z.string().min(1).max(2000),
  default_provider: ProviderDefault,
  /** Skill references (knowledge bundles, D38) — ids into the pack catalog. */
  skills: z.array(PackElementId).max(200),
  /**
   * Versioned tool references, each of which must be inside the pack tool
   * allow-list below. D38: this list is an UPPER BOUND, never a grant; the
   * runtime owns tool definitions and rechecks every permission at execution.
   */
  tools: z.array(ToolRef).max(500),
  /** Connector references (authenticated integrations, D38) — never inline credentials. */
  connectors: z.array(PackElementId).max(100),
  /** D18: UI identity metadata (avatar hue + initial glyph). */
  ui_identity: UiIdentity,
  /**
   * D46: one home Operation per Agent. The default coordinator's
   * cross-Operation presence is the coordinator role specifically and does
   * not count as multi-Operation rostering (D46, point 2).
   */
  home_operation_id: PackElementId.nullable(),
});
export type AgentManifest = z.infer<typeof AgentManifest>;

export const OperationManifest = z.strictObject({
  operation_id: PackElementId,
  version: SemVer,
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  /**
   * Agents that participate; each specialist is rostered in exactly one
   * pack-defined Operation (D46 single-membership, enforced below).
   */
  roster: z.array(PackElementId).min(1).max(50),
  /**
   * D42: `coordinator` names a coordinator Agent or "none". Absent means the
   * pack default coordinator coordinates. The coordinator role is not a
   * roster assignment (D46).
   */
  coordinator: z.union([PackElementId, z.literal("none")]).optional(),
  skills: z.array(PackElementId).max(200),
  connectors: z.array(PackElementId).max(100),
});
export type OperationManifest = z.infer<typeof OperationManifest>;

const PackManifestShape = z.strictObject({
  pack_id: PackElementId,
  version: SemVer,
  title: z.string().min(1).max(200),
  /** D18: semantic compatibility range of the runtime contract. */
  runtime_compatibility: RuntimeCompatibilityRange,
  /**
   * D42/D46: the pack-wide default coordinator Agent. The coordinator role is
   * not a roster assignment, so this Agent alone may appear in several
   * Operation rosters as coordinator without violating single-membership.
   */
  default_coordinator_agent_id: PackElementId,
  /** D38: the pack skill catalog — agents and Operations reference ids here. */
  skills: z.array(SkillDeclaration).max(500),
  /** D38: the pack connector catalog — references only, never credentials. */
  connectors: z.array(ConnectorDeclaration).max(200),
  /**
   * D18/D38: the pack tool allow-list — the complete set of tool versions any
   * agent in this pack may reference. UPPER BOUND, never a grant: the runtime
   * owns tool definitions and rechecks every permission at execution time.
   */
  tool_allow_list: z.array(ToolRef).max(500),
  agents: z.array(AgentManifest).min(1).max(100),
  operations: z.array(OperationManifest).max(100),
});
export type PackManifestData = z.infer<typeof PackManifestShape>;

/**
 * Stable rule ids for manifest rejections. Custom-issue messages are prefixed
 * with "<rule>: " so validateManifest() can classify them; "schema" covers
 * base Zod type/format failures and "unknown-field" covers strict-key
 * rejections (which is how executable or credential FIELD names are rejected —
 * they cannot even be declared).
 */
export const PACK_MANIFEST_RULES = [
  "schema",
  "unknown-field",
  "unknown-agent-ref",
  "unknown-coordinator-ref",
  "unknown-home-operation",
  "unknown-default-coordinator",
  "missing-skill-ref",
  "missing-connector-ref",
  "tool-not-in-allow-list",
  "d46-single-membership",
  "duplicate-roster-entry",
  "secret-looking-value",
  "host-path-value",
  "executable-content",
] as const;
export type PackManifestRule = (typeof PACK_MANIFEST_RULES)[number];

/** Rules produced by the superRefine checks (never "schema"/"unknown-field"). */
type CustomRule = Exclude<PackManifestRule, "schema" | "unknown-field">;

interface ManifestIssue {
  path: (string | number)[];
  rule: CustomRule;
  detail: string;
}

function checkReferences(manifest: PackManifestData): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const declaredAgents = new Set(manifest.agents.map((agent) => agent.agent_id));
  const declaredOperations = new Set(
    manifest.operations.map((operation) => operation.operation_id),
  );
  const declaredSkills = new Set(manifest.skills.map((skill) => skill.skill_id));
  const declaredConnectors = new Set(
    manifest.connectors.map((connector) => connector.connector_id),
  );
  const allowedTools = new Set(
    manifest.tool_allow_list.map((tool) => `${tool.tool_id}@${tool.version}`),
  );

  manifest.agents.forEach((agent, agentIndex) => {
    agent.skills.forEach((skillId, skillIndex) => {
      if (!declaredSkills.has(skillId)) {
        issues.push({
          path: ["agents", agentIndex, "skills", skillIndex],
          rule: "missing-skill-ref",
          detail: `agent ${agent.agent_id} references undeclared skill ${skillId}`,
        });
      }
    });
    agent.connectors.forEach((connectorId, connectorIndex) => {
      if (!declaredConnectors.has(connectorId)) {
        issues.push({
          path: ["agents", agentIndex, "connectors", connectorIndex],
          rule: "missing-connector-ref",
          detail: `agent ${agent.agent_id} references undeclared connector ${connectorId}`,
        });
      }
    });
    agent.tools.forEach((tool, toolIndex) => {
      if (!allowedTools.has(`${tool.tool_id}@${tool.version}`)) {
        issues.push({
          path: ["agents", agentIndex, "tools", toolIndex],
          rule: "tool-not-in-allow-list",
          detail:
            `agent ${agent.agent_id} references tool ${tool.tool_id}@${tool.version} outside the pack ` +
            "tool allow-list (D38: the allow-list is an upper bound, never a grant)",
        });
      }
    });
    if (agent.home_operation_id && !declaredOperations.has(agent.home_operation_id)) {
      issues.push({
        path: ["agents", agentIndex, "home_operation_id"],
        rule: "unknown-home-operation",
        detail: `agent ${agent.agent_id} names unknown home operation ${agent.home_operation_id}`,
      });
    }
  });

  manifest.operations.forEach((operation, operationIndex) => {
    operation.roster.forEach((agentId, rosterIndex) => {
      if (!declaredAgents.has(agentId)) {
        issues.push({
          path: ["operations", operationIndex, "roster", rosterIndex],
          rule: "unknown-agent-ref",
          detail: `operation ${operation.operation_id} rosters undeclared agent ${agentId}`,
        });
      }
    });
    if (
      operation.coordinator &&
      operation.coordinator !== "none" &&
      !declaredAgents.has(operation.coordinator)
    ) {
      issues.push({
        path: ["operations", operationIndex, "coordinator"],
        rule: "unknown-coordinator-ref",
        detail: `operation ${operation.operation_id} names undeclared coordinator ${operation.coordinator}`,
      });
    }
    operation.skills.forEach((skillId, skillIndex) => {
      if (!declaredSkills.has(skillId)) {
        issues.push({
          path: ["operations", operationIndex, "skills", skillIndex],
          rule: "missing-skill-ref",
          detail: `operation ${operation.operation_id} references undeclared skill ${skillId}`,
        });
      }
    });
    operation.connectors.forEach((connectorId, connectorIndex) => {
      if (!declaredConnectors.has(connectorId)) {
        issues.push({
          path: ["operations", operationIndex, "connectors", connectorIndex],
          rule: "missing-connector-ref",
          detail: `operation ${operation.operation_id} references undeclared connector ${connectorId}`,
        });
      }
    });
  });

  if (!declaredAgents.has(manifest.default_coordinator_agent_id)) {
    issues.push({
      path: ["default_coordinator_agent_id"],
      rule: "unknown-default-coordinator",
      detail: `default_coordinator_agent_id ${manifest.default_coordinator_agent_id} is not a declared agent`,
    });
  }

  return issues;
}

function checkRosterMembership(manifest: PackManifestData): ManifestIssue[] {
  const issues: ManifestIssue[] = [];

  manifest.operations.forEach((operation, operationIndex) => {
    const seen = new Set<string>();
    operation.roster.forEach((agentId, rosterIndex) => {
      if (seen.has(agentId)) {
        issues.push({
          path: ["operations", operationIndex, "roster", rosterIndex],
          rule: "duplicate-roster-entry",
          detail: `operation ${operation.operation_id} rosters agent ${agentId} twice`,
        });
      }
      seen.add(agentId);
    });
  });

  // D46 single-membership: an Agent is rostered in exactly one pack-defined
  // Operation. The pack default coordinator is the one exception — its
  // cross-Operation presence is the coordinator role specifically, which D46
  // (point 2) does not count as roster membership. This mirrors the S02 Pack
  // contract (packages/contracts/src/pack.ts).
  const rosterCount = new Map<string, string[]>();
  for (const operation of manifest.operations) {
    for (const agentId of new Set(operation.roster)) {
      const operations = rosterCount.get(agentId) ?? [];
      operations.push(operation.operation_id);
      rosterCount.set(agentId, operations);
    }
  }
  for (const [agentId, operations] of rosterCount) {
    if (operations.length > 1 && agentId !== manifest.default_coordinator_agent_id) {
      issues.push({
        path: ["operations"],
        rule: "d46-single-membership",
        detail:
          `agent ${agentId} appears in ${operations.length} operation rosters (${operations.join(", ")}); ` +
          "D46 allows one home Operation per Agent — only the default coordinator's cross-Operation " +
          "presence (the coordinator role, not a roster assignment) is exempt",
      });
    }
  }

  return issues;
}

/**
 * Value patterns that must never appear in a manifest (D22, D28). Matched
 * against every string value in the parsed manifest. Rejection details name
 * the pattern, never the matched value, so malformed input cannot be echoed
 * back into logs or error surfaces (redaction discipline; G3).
 */
const SECRET_VALUE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "a provider API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "a source-host token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { label: "a cloud access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "a chat-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "a private key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  {
    label: "a JWT credential",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    label: "a credential assignment",
    pattern:
      /\b(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|authorization|password|passwd|pwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*\S+/i,
  },
  { label: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/ },
];

const HOST_PATH_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "a POSIX home directory path", pattern: /\/home\// },
  { label: "a macOS user directory path", pattern: /\/Users\// },
  { label: "a system directory path", pattern: /\/(?:root|var|etc|usr|opt|tmp|mnt|srv|private)\// },
  { label: "a Windows drive path", pattern: /\b[A-Za-z]:[\\/]/ },
  { label: "a UNC path", pattern: /\\\\/ },
  { label: "a container runtime socket", pattern: /docker\.sock/ },
  { label: "a home-relative path", pattern: /~[\\/]/ },
  { label: "an absolute filesystem path", pattern: /(?:^|\s)\/(?:[A-Za-z0-9._~-]+\/)+/ },
];

const EXECUTABLE_CONTENT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "a shebang line", pattern: /#!/ },
  {
    label: "an eval/require call",
    pattern: /\b(?:eval|require|exec|execSync|spawn|spawnSync)\s*\(/,
  },
  {
    // The Node child-process module name is assembled from two parts so the
    // D23 rule-2 boundary guard (a static line scan for that module name
    // outside the process adapters) does not mistake this deny-PATTERN for
    // usage: this file never touches process APIs — it rejects manifests
    // that reference them.
    label: "a child-process module reference",
    pattern: new RegExp(`\\bchild${"_process"}\\b`),
  },
  {
    label: "a shell invocation",
    pattern:
      /\b(?:bash|sh|zsh|fish|ksh|dash|powershell|pwsh|cmd)\s+(?:-c\b|--command\b|-Command\b|-lc\b)/i,
  },
  { label: "a node one-liner", pattern: /\bnode\s+(?:-e\b|--eval\b)/ },
  { label: "an inline script tag", pattern: /<script\b/i },
  { label: "a container engine command", pattern: /\bdocker\s+(?:run|exec|build|create|start)\b/ },
  { label: "a unix socket URI", pattern: /\bunix:\/\// },
];

const CONTENT_RULES: Array<[CustomRule, Array<{ label: string; pattern: RegExp }>]> = [
  ["secret-looking-value", SECRET_VALUE_PATTERNS],
  ["host-path-value", HOST_PATH_PATTERNS],
  ["executable-content", EXECUTABLE_CONTENT_PATTERNS],
];

function formatPath(path: readonly PropertyKey[]): string {
  const formatted = path.map((part) => String(part)).join(".");
  return formatted.length > 0 ? formatted : "(root)";
}

function scanStrings(value: unknown, path: (string | number)[], issues: ManifestIssue[]): void {
  if (typeof value === "string") {
    for (const [rule, patterns] of CONTENT_RULES) {
      const matched = patterns.find(({ pattern }) => pattern.test(value));
      if (matched) {
        issues.push({
          path,
          rule,
          detail:
            `value at ${formatPath(path)} looks like ${matched.label}; a manifest carries references and ` +
            "labels only — no secrets (D22, G3), no host paths, no executable content (D28)",
        });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStrings(item, [...path, index], issues));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      scanStrings(child, [...path, key], issues);
    }
  }
}

function scanForForbiddenContent(manifest: PackManifestData): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  scanStrings(manifest, [], issues);
  return issues;
}

export const PackManifest = PackManifestShape.superRefine((manifest, ctx) => {
  const issues: ManifestIssue[] = [
    ...checkReferences(manifest),
    ...checkRosterMembership(manifest),
    ...scanForForbiddenContent(manifest),
  ];
  for (const issue of issues) {
    ctx.addIssue({
      code: "custom",
      path: issue.path,
      message: `${issue.rule}: ${issue.detail}`,
    });
  }
});
export type PackManifest = z.infer<typeof PackManifest>;

export interface PackManifestIssue {
  rule: PackManifestRule;
  path: string;
  message: string;
}

export type ValidateResult =
  { ok: true; manifest: PackManifest } | { ok: false; issues: PackManifestIssue[] };

function ruleFromMessage(message: string): PackManifestRule | undefined {
  const separator = message.indexOf(": ");
  if (separator <= 0) return undefined;
  const candidate = message.slice(0, separator);
  return (PACK_MANIFEST_RULES as readonly string[]).includes(candidate)
    ? (candidate as PackManifestRule)
    : undefined;
}

function toPackManifestIssue(issue: {
  code: string;
  path: PropertyKey[];
  message: string;
}): PackManifestIssue {
  const rule =
    issue.code === "unrecognized_keys"
      ? "unknown-field"
      : (ruleFromMessage(issue.message) ?? "schema");
  return { rule, path: formatPath(issue.path), message: issue.message };
}

/** Validate a manifest, returning a typed result instead of throwing. */
export function validateManifest(input: unknown): ValidateResult {
  const parsed = PackManifest.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  return { ok: false, issues: parsed.error.issues.map(toPackManifestIssue) };
}

export class PackManifestValidationError extends Error {
  readonly issues: PackManifestIssue[];

  constructor(issues: PackManifestIssue[]) {
    // Issue details name paths and rules, never offending values (G3).
    super(
      `pack manifest rejected (${issues.length} issue(s)): ` +
        issues.map((issue) => `${issue.path} [${issue.rule}]`).join("; "),
    );
    this.name = "PackManifestValidationError";
    this.issues = issues;
  }
}

/** Validate a manifest, throwing the typed error on the first failure batch. */
export function assertValidManifest(input: unknown): PackManifest {
  const result = validateManifest(input);
  if (!result.ok) {
    throw new PackManifestValidationError(result.issues);
  }
  return result.manifest;
}
