/**
 * Runtime backend contract (S06, D12) and the internal channel (D2, PRD §16).
 *
 * D12: the web app talks to a typed RuntimeBackend contract; local container,
 * remote container, and managed cloud backends implement it. The frontend
 * never learns infrastructure identifiers — no container IDs, no host paths,
 * no internal service ports, no channel credentials. Everything web-facing in
 * this file is deliberately opaque: an opaque runtime handle plus a resource
 * summary built from the PRD §3.3 tier table.
 *
 * Portability (PRD §6.1): this surface is infrastructure-neutral. It names no
 * concrete container engine, no engine API fields, and no host paths, so a
 * remote/cloud backend can implement the exact same contract later. The
 * adapter that talks to the local engine lives in apps/control-plane (the
 * provisioning adapter; D23 rule 2 keeps engine APIs out of every other
 * module). A portability test greps this file, the user-runtime sources, and
 * the generated clients for engine-specific vocabulary.
 *
 * Zod-first (D25): every wire shape below is a strict Zod schema; types are
 * inferred, never hand-written. The backend operation types (RuntimeBackend,
 * ProvisionBackendOutcome, RuntimeInternalMetadata, RuntimeProvisionSecrets)
 * are process-internal TypeScript types — they are intentionally NOT Zod
 * schemas and never enter the OpenAPI document, because they carry
 * infrastructure identifiers that must stay server-side.
 */
import { z } from "zod";

import { Id, IsoDateTime, ResourceTier, Sha256Hex, WorkspaceId } from "./primitives.ts";

/**
 * PRD §3.3 resource tiers as machine-applicable constants. These numbers are
 * the single shared source of truth: the provisioning service records them in
 * the resource summary, and the local infrastructure adapter applies them as
 * real engine-level limits on the container (CPU and memory as hard limits;
 * storage recorded per tier, enforced when the backing storage driver
 * supports per-container quota — a deployment property, not a UI number).
 *
 * CPU is expressed in whole vCPUs; memory and storage in bytes (GiB = 1024^3).
 */
export const VCPU = 1_000_000_000; // one vCPU in nanocores, engine-unit mapping lives in the adapter
export const GIB = 1024 ** 3;

export const TierResourceLimits = z.strictObject({
  /** Whole vCPUs (PRD §3.3 "CPU" column). */
  cpu_vcpus: z.number().int().positive(),
  memory_bytes: z.number().int().positive(),
  storage_bytes: z.number().int().positive(),
});
export type TierResourceLimits = z.infer<typeof TierResourceLimits>;

export const TIER_RESOURCE_LIMITS: Readonly<Record<ResourceTier, TierResourceLimits>> = {
  light: { cpu_vcpus: 1, memory_bytes: 2 * GIB, storage_bytes: 10 * GIB },
  balanced: { cpu_vcpus: 2, memory_bytes: 4 * GIB, storage_bytes: 25 * GIB },
  heavy: { cpu_vcpus: 4, memory_bytes: 8 * GIB, storage_bytes: 50 * GIB },
} as const;

/** D23 rule 3: typed backend kinds (D12 backends). */
export const RUNTIME_BACKEND_KINDS = [
  "local_container",
  "remote_container",
  "managed_cloud",
] as const;
export const RuntimeBackendKind = z.enum(RUNTIME_BACKEND_KINDS);
export type RuntimeBackendKind = z.infer<typeof RuntimeBackendKind>;

/** Provisioning state machine (D2 provisioning state; kept minimal and honest). */
export const PROVISIONING_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "failed",
] as const;
export const ProvisioningStatus = z.enum(PROVISIONING_STATUSES);
export type ProvisioningStatus = z.infer<typeof ProvisioningStatus>;

/** Health as observed by the backend/runtime channel; "unknown" is a state, not a guess (G4). */
export const RUNTIME_HEALTH_STATES = ["unknown", "healthy", "unhealthy"] as const;
export const RuntimeHealthState = z.enum(RUNTIME_HEALTH_STATES);
export type RuntimeHealthState = z.infer<typeof RuntimeHealthState>;

/**
 * Opaque runtime handle (D12): the ONLY runtime identifier that crosses the
 * user boundary. Not a container ID, not a name — a control-plane-generated
 * opaque token ("rt_" + 32 hex).
 */
export const OpaqueRuntimeHandle = z
  .string()
  .regex(/^rt_[0-9a-f]{32}$/, "expected an opaque runtime handle (rt_ + 32 hex)");
export type OpaqueRuntimeHandle = z.infer<typeof OpaqueRuntimeHandle>;

/** Bounded resource summary (D2 "resource summary"; PRD §15 admin view). */
export const ResourceSummary = z.strictObject({
  tier: ResourceTier,
  cpu_vcpus: z.number().int().positive(),
  memory_bytes: z.number().int().positive(),
  storage_bytes: z.number().int().positive(),
});
export type ResourceSummary = z.infer<typeof ResourceSummary>;

/** Service → backend: create (or idempotently re-attach to) this user's runtime. */
export const ProvisionRuntimeInput = z.strictObject({
  account_id: Id,
  tier: ResourceTier,
  /** Idempotency key (D23 rule 6): one provisioning attempt. */
  request_id: Id,
  correlation_id: Id.optional(),
});
export type ProvisionRuntimeInput = z.infer<typeof ProvisionRuntimeInput>;

/** Web-facing provisioning result — opaque handle + resource summary only (D12). */
export const ProvisionRuntimeResult = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  account_id: Id,
  tier: ResourceTier,
  provisioning_status: ProvisioningStatus,
  health: RuntimeHealthState,
  resource_summary: ResourceSummary,
  provisioned_at: IsoDateTime,
});
export type ProvisionRuntimeResult = z.infer<typeof ProvisionRuntimeResult>;

/** Service → backend: bring the runtime to running (idempotent; never creates a second container). */
export const ResumeRuntimeInput = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  request_id: Id,
  correlation_id: Id.optional(),
});
export type ResumeRuntimeInput = z.infer<typeof ResumeRuntimeInput>;

export const ResumeRuntimeResult = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  provisioning_status: ProvisioningStatus,
  health: RuntimeHealthState,
  checked_at: IsoDateTime,
});
export type ResumeRuntimeResult = z.infer<typeof ResumeRuntimeResult>;

/** Service → backend: stop the runtime (idempotent; already-stopped is success). */
export const StopRuntimeInput = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  request_id: Id,
  correlation_id: Id.optional(),
});
export type StopRuntimeInput = z.infer<typeof StopRuntimeInput>;

export const StopRuntimeResult = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  provisioning_status: ProvisioningStatus,
  health: RuntimeHealthState,
  checked_at: IsoDateTime,
});
export type StopRuntimeResult = z.infer<typeof StopRuntimeResult>;

/** Service → backend: truthful current state. */
export const GetRuntimeStatusInput = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  correlation_id: Id.optional(),
});
export type GetRuntimeStatusInput = z.infer<typeof GetRuntimeStatusInput>;

/** Web-facing status (AC: truthful state + resource summary; D12 opaque surface). */
export const RuntimeStatus = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  account_id: Id,
  tier: ResourceTier,
  provisioning_status: ProvisioningStatus,
  health: RuntimeHealthState,
  resource_summary: ResourceSummary,
  checked_at: IsoDateTime,
});
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;

// ---------------------------------------------------------------------------
// Control plane ↔ container internal channel (D2, D11, PRD §16).
// Per-container bearer token issued at provisioning; stored hashed; presented
// as `Authorization: Bearer <raw>` on every internal call. The token value
// never appears in any schema, log, event, or response (G3) — only its
// SHA-256 digest is ever persisted or delivered to the container.
// ---------------------------------------------------------------------------

/** The only path the runtime gateway exposes to the control plane (internal, authenticated). */
export const RUNTIME_REGISTRATION_PATH = "/internal/v1/registration" as const;

/** Rotation staging path: authenticated with the CURRENT token, stages a new digest. */
export const RUNTIME_CREDENTIALS_PATH = "/internal/v1/credentials" as const;

/** Rotation commit path: authenticated with the NEW token, prunes every other digest. */
export const RUNTIME_CREDENTIALS_COMMIT_PATH = "/internal/v1/credentials/commit" as const;

/** Container → control plane binding call body (internal channel, authenticated). */
export const RuntimeRegistrationRequest = z.strictObject({
  runtime_handle: OpaqueRuntimeHandle,
  account_id: Id,
  tier: ResourceTier,
  correlation_id: Id.optional(),
});
export type RuntimeRegistrationRequest = z.infer<typeof RuntimeRegistrationRequest>;

export const RuntimeRegistrationResponse = z.strictObject({
  registered: z.literal(true),
  runtime_handle: OpaqueRuntimeHandle,
  registered_at: IsoDateTime,
});
export type RuntimeRegistrationResponse = z.infer<typeof RuntimeRegistrationResponse>;

/**
 * Rotation staging: the control plane proves the CURRENT credential (bearer)
 * and names the NEW credential's digest. Only a digest crosses the wire —
 * never the new raw token (G3).
 */
export const RuntimeCredentialRotationRequest = z.strictObject({
  credential_sha256: Sha256Hex,
});
export type RuntimeCredentialRotationRequest = z.infer<typeof RuntimeCredentialRotationRequest>;

export const RuntimeCredentialRotationResponse = z.strictObject({
  staged: z.literal(true),
});
export type RuntimeCredentialRotationResponse = z.infer<typeof RuntimeCredentialRotationResponse>;

/** Rotation commit: authenticated with the NEW token; the container prunes all other digests. */
export const RuntimeCredentialCommitRequest = z.strictObject({});
export type RuntimeCredentialCommitRequest = z.infer<typeof RuntimeCredentialCommitRequest>;

export const RuntimeCredentialCommitResponse = z.strictObject({
  committed: z.literal(true),
});
export type RuntimeCredentialCommitResponse = z.infer<typeof RuntimeCredentialCommitResponse>;

// ---------------------------------------------------------------------------
// S32 admin commands over the internal channel (issue #33, D47; PRD §15).
// The SAME authenticated per-container channel as registration/rotation —
// no second control-plane→runtime path exists or is invented here. Every
// admin command names its workspace (tenant-checked runtime-side) and the
// admin actor the control plane attributes (the token id).
// ---------------------------------------------------------------------------

/** Emergency cancel-all: stop every non-terminal run of the targeted workspace. */
export const RUNTIME_ADMIN_CANCEL_ALL_PATH = "/internal/v1/admin/cancel-all" as const;

export const RuntimeAdminCancelAllRequest = z.strictObject({
  workspace_id: WorkspaceId,
  actor: z.strictObject({ type: z.literal("admin"), id: Id }),
});
export type RuntimeAdminCancelAllRequest = z.infer<typeof RuntimeAdminCancelAllRequest>;

/** The per-run outcome vocabulary is the S22 RunCancellationService's. */
export const RUNTIME_ADMIN_RUN_OUTCOMES = [
  "cancelled",
  "already_cancelled",
  "already_settled",
  "actor_refused",
  "not_found",
] as const;
export const RuntimeAdminRunOutcome = z.enum(RUNTIME_ADMIN_RUN_OUTCOMES);

export const RuntimeAdminCancelAllResponse = z.strictObject({
  workspace_id: WorkspaceId,
  results: z.array(z.strictObject({ run_id: Id, outcome: RuntimeAdminRunOutcome })),
});
export type RuntimeAdminCancelAllResponse = z.infer<typeof RuntimeAdminCancelAllResponse>;

// ---------------------------------------------------------------------------
// Process-internal backend types (NOT wire schemas — never serialized to the
// user boundary; never registered into OpenAPI).
// ---------------------------------------------------------------------------

/**
 * G3: secret-bearing parameter. The control plane issues the per-container
 * channel token and hands it to the backend exactly once at provisioning; the
 * backend delivers its DIGEST into the container environment. This type must
 * never appear inside a Zod schema, response, event, or log line.
 */
export interface RuntimeProvisionSecrets {
  internal_channel_token: string;
}

/**
 * Infrastructure identifiers the control-plane service persists internally
 * (D2 container placement / runtime endpoint metadata). Never web-facing.
 */
export interface RuntimeInternalMetadata {
  /** Engine-scoped container reference (internal bookkeeping only). */
  container_ref: string;
  /** Engine-scoped container ID (internal bookkeeping only). */
  container_id: string;
  /** Internal endpoint of the runtime gateway on the management network. */
  internal_endpoint: string | null;
}

export interface ProvisionBackendOutcome {
  result: ProvisionRuntimeResult;
  internal: RuntimeInternalMetadata;
}

/**
 * Typed backend failure (G4, D23 rule 4): a backend that cannot complete an
 * operation throws this instead of reporting success. `detail` is a bounded,
 * redaction-safe description for server logs — it must never carry secrets,
 * host paths, or engine identifiers.
 */
export type RuntimeBackendFailureCode =
  "RUNTIME_PROVISION_FAILED" | "RUNTIME_UNAVAILABLE" | "RUNTIME_TENANT_MISMATCH";

export class RuntimeBackendFailure extends Error {
  readonly code: RuntimeBackendFailureCode;
  readonly detail: string;

  constructor(code: RuntimeBackendFailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RuntimeBackendFailure";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The D12 backend contract. S06 implements provisionRuntime, resumeRuntime,
 * getRuntimeStatus, and stopRuntime (stop is required by the lifecycle AC);
 * the remaining D12 operations (getRuntimeCapabilities, openSession,
 * sendCommand, subscribeEvents, requestFileOrArtifact, pauseRuntime,
 * cancelTask) join this same interface with the session/transport slices
 * (S07+) — the shape stays backend-neutral so remote/cloud backends can
 * implement it unchanged.
 */
export interface RuntimeBackend {
  provisionRuntime(
    request: ProvisionRuntimeInput,
    secrets: RuntimeProvisionSecrets,
  ): Promise<ProvisionBackendOutcome>;
  resumeRuntime(request: ResumeRuntimeInput): Promise<ResumeRuntimeResult>;
  stopRuntime(request: StopRuntimeInput): Promise<StopRuntimeResult>;
  getRuntimeStatus(request: GetRuntimeStatusInput): Promise<RuntimeStatus>;
}
