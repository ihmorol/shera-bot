/**
 * Shared primitives for the S02 contracts.
 *
 * Governing records: D25 (Zod-first contracts, strict unknown-field discipline),
 * D23 rule 2 (no infrastructure leakage — no SQL, no filesystem paths, no
 * transport coupling here), E12 (every product-state record carries
 * workspace_id), D9 (risk classes), D26 (redaction classes).
 *
 * Zod-first (D25): every exported type below is inferred from its Zod schema.
 * No hand-written duplicate types.
 */
import { z } from "zod";

/** E12: every product-state record is scoped by workspace_id. */
export const WorkspaceId = z.string().min(1).max(128);
export type WorkspaceId = z.infer<typeof WorkspaceId>;

/** Stable opaque identifiers (D2: domain records get stable IDs). */
export const Id = z.string().min(1).max(256);
export type Id = z.infer<typeof Id>;

/** ISO 8601 timestamp (UTC designator or explicit offset). */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** SHA-256 hex digest, used for pack/operation/artifact content hashes (D28, D29). */
export const Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected a 64-char lowercase sha256 hex digest");

/** Semver-ish version string for packs, operations, and tools (D18, D28). */
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/, "expected MAJOR.MINOR.PATCH");

/**
 * Resource URIs inside the user container (phase0 plan §5). These are
 * workspace-scheme URIs, not filesystem paths — D23 rule 2 keeps host path
 * assumptions out of shared contracts.
 */
export const ResourceUri = z
  .string()
  .regex(
    /^workspace:\/\/\S+$|^agent:\/\/[a-z0-9_-]+\/\S+$/,
    "expected a workspace:// or agent:// URI",
  );
export type ResourceUri = z.infer<typeof ResourceUri>;

/** Principal kinds for actors on commands and events (D4, D23 rule 6). */
export const ACTOR_TYPES = ["user", "agent", "runtime", "admin", "system"] as const;
export const ActorType = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorType>;

export const Actor = z.strictObject({
  type: ActorType,
  id: z.string().min(1).max(256),
});
export type Actor = z.infer<typeof Actor>;

/** PRD §3.3 resource tiers. */
export const ResourceTier = z.enum(["light", "balanced", "heavy"]);
export type ResourceTier = z.infer<typeof ResourceTier>;

/** D26 redaction classification for events; secrets never appear at all (G3). */
export const RedactionClass = z.enum(["public", "internal", "restricted"]);
export type RedactionClass = z.infer<typeof RedactionClass>;

/** D9 risk levels, verbatim from the decision record. */
export const RISK_CLASSES = [
  "READ_ONLY",
  "LOCAL_MUTATION",
  "DESTRUCTIVE_LOCAL",
  "EXTERNAL_WRITE",
  "CREDENTIAL_ACCESS",
  "DEPLOYMENT",
  "FINANCIAL_OR_IRREVERSIBLE",
] as const;
export const RiskClass = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClass>;

/**
 * Free-form JSON object: tool input/output JSON Schema documents (D38) and
 * internal error diagnostics (D23 rule 4). Deliberately an object with unknown
 * leaf values, not a recursive JSON-value union — the OpenAPI generator cannot
 * render self-referential schemas, and every current consumer (tool schemas,
 * error details) is an object anyway. Recorded as an S02 engineering
 * trade-off in the slice evidence pack.
 */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.output<typeof JsonObject>;

/** A JSON Schema document describing tool input/output (D38). Stored as data. */
export const JsonSchema = JsonObject;
export type JsonSchema = z.infer<typeof JsonSchema>;
