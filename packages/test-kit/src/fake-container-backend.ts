/**
 * FakeContainerBackend (S06) — the deterministic RuntimeBackend fake.
 *
 * D23 testing strategy: deterministic fakes are mandatory test-kit components.
 * This fake implements the exact typed RuntimeBackend contract
 * (packages/contracts) with none of the real engine involved: no daemon, no
 * socket, no image. It records every applied spec so tests can assert that
 * tier limits were applied as real limits (not UI numbers), supports
 * one-shot deterministic failure injection for the G4 path, and exposes the
 * raw channel credential it was handed so security tests can assert that the
 * value never reaches any web-facing response or log.
 *
 * Adoption semantics (aligned with the real adapter's invariants): a
 * re-provision with the SAME credential re-attaches to the existing record
 * and returns the SAME handle; a re-provision with a DIFFERENT credential
 * recreates the record — new handle, fresh credential — so the "container's
 * credential equals this call's digest" invariant (I2) holds after every
 * successful provision, exactly as the real engine path behaves.
 *
 * The fake is deliberately container-engine-neutral: it speaks the contract,
 * nothing else (a portability test greps this package for engine vocabulary).
 */
import { createHash } from "node:crypto";

import {
  OpaqueRuntimeHandle,
  ProvisionRuntimeResult,
  type RuntimeBackend,
  RuntimeBackendFailure,
  RuntimeHealthState,
  RuntimeStatus,
  StopRuntimeResult,
  ResumeRuntimeResult,
  TIER_RESOURCE_LIMITS,
  type ProvisionBackendOutcome,
  type ProvisionRuntimeInput,
  type ProvisioningStatus,
  type ResourceTier,
  type ResumeRuntimeInput,
  type RuntimeInternalMetadata,
  type GetRuntimeStatusInput,
  type StopRuntimeInput,
  type RuntimeProvisionSecrets,
} from "@shera-bot/contracts";

import { z } from "zod";

/** One applied container spec, recorded for test assertions. */
export interface AppliedSpec {
  account_id: string;
  tier: ResourceTier;
  cpu_vcpus: number;
  memory_bytes: number;
  storage_bytes: number;
  /** The SHA-256 digest delivered into the container environment (never the raw token). */
  credential_sha256: string;
  labels: Readonly<Record<string, string>>;
}

interface ContainerRecord {
  account_id: string;
  runtime_handle: z.infer<typeof OpaqueRuntimeHandle>;
  tier: ResourceTier;
  status: ProvisioningStatus;
  health: RuntimeHealthState;
  container_ref: string;
  container_id: string;
  internal_endpoint: string | null;
  credential_sha256: string;
}

export interface FakeContainerBackendOptions {
  /** Maps an account to the internal endpoint of its (test-hosted) runtime gateway. */
  endpointFor?: (account_id: string) => string | null;
  /**
   * Credential delivery seam — the analogue of the engine putting the
   * credential digest into the container environment at creation. Throwing
   * here makes provisioning fail truthfully.
   */
  deliverCredential?: (account_id: string, credential_sha256: string) => void;
  /** One-shot deterministic failure injection (G4 path); consumed on first use. */
  failures?: { provision?: string; resume?: string; stop?: string };
}

export class FakeContainerBackend implements RuntimeBackend {
  private readonly records = new Map<string, ContainerRecord>();
  /** Per-account creation counter: recreations mint a fresh handle. */
  private readonly creations = new Map<string, number>();
  private readonly applied: AppliedSpec[] = [];
  private readonly failures: { provision?: string; resume?: string; stop?: string };
  private readonly options: FakeContainerBackendOptions;
  /** Raw credentials handed to the backend at provisioning (security-test seam). */
  readonly channelTokensSeen: string[] = [];
  /** Raw credentials per account, in provisioning order (security-test seam). */
  readonly tokensByAccount = new Map<string, string[]>();
  readonly opCounts = { provision: 0, resume: 0, stop: 0, status: 0 };

  constructor(options: FakeContainerBackendOptions = {}) {
    this.options = options;
    this.failures = options.failures ?? {};
  }

  async provisionRuntime(
    request: ProvisionRuntimeInput,
    secrets: RuntimeProvisionSecrets,
  ): Promise<ProvisionBackendOutcome> {
    this.opCounts.provision += 1;
    this.channelTokensSeen.push(secrets.internal_channel_token);
    const seen = this.tokensByAccount.get(request.account_id) ?? [];
    seen.push(secrets.internal_channel_token);
    this.tokensByAccount.set(request.account_id, seen);

    const injected = this.failures.provision;
    if (injected !== undefined) {
      delete this.failures.provision;
      throw new RuntimeBackendFailure("RUNTIME_PROVISION_FAILED", injected);
    }

    const credentialSha256 = createHash("sha256")
      .update(secrets.internal_channel_token, "utf8")
      .digest("hex");
    const endpoint = this.options.endpointFor?.(request.account_id) ?? null;

    const existing = this.records.get(request.account_id);
    let create: boolean;
    if (existing) {
      if (existing.credential_sha256 === credentialSha256) {
        // Re-attach: the container already carries exactly this credential —
        // never a second container, never a new handle (I1). Bring it to
        // running.
        existing.status = "running";
        existing.health = "healthy";
        existing.tier = request.tier;
        create = false;
      } else {
        // Credential recovery: the stored digest does not match this call's
        // token — recreate (the analogue of removing the owned container and
        // creating it fresh): a new handle and a fresh credential (I2), still
        // one container per user.
        this.records.delete(request.account_id);
        create = true;
      }
    } else {
      create = true;
    }

    if (create) {
      // Credential delivery into the container environment (digest only, G3)
      // happens at creation — the analogue of the engine writing the digest
      // into the environment of the (re)created container.
      this.options.deliverCredential?.(request.account_id, credentialSha256);
      const creation = this.creations.get(request.account_id) ?? 0;
      this.creations.set(request.account_id, creation + 1);
      const seed = creation === 0 ? request.account_id : `${request.account_id}#${creation}`;
      const containerId = createHash("sha256")
        .update(`fake-container:${seed}`, "utf8")
        .digest("hex");
      this.records.set(request.account_id, {
        account_id: request.account_id,
        runtime_handle: `rt_${containerId.slice(0, 32)}`,
        tier: request.tier,
        status: "running",
        health: "healthy",
        container_ref: `shera-rt-${request.account_id}`,
        container_id: containerId,
        internal_endpoint: endpoint,
        credential_sha256: credentialSha256,
      });
    }

    const record = this.records.get(request.account_id);
    if (!record)
      throw new RuntimeBackendFailure("RUNTIME_PROVISION_FAILED", "record missing after provision");

    this.applied.push({
      account_id: request.account_id,
      tier: request.tier,
      ...TIER_RESOURCE_LIMITS[request.tier],
      credential_sha256: credentialSha256,
      labels: {
        "shera.managed": "control-plane",
        "shera.account_id": request.account_id,
        "shera.tier": request.tier,
      },
    });

    const result: ProvisionRuntimeResult = {
      runtime_handle: record.runtime_handle,
      account_id: record.account_id,
      tier: record.tier,
      provisioning_status: record.status,
      health: record.health,
      resource_summary: { tier: record.tier, ...TIER_RESOURCE_LIMITS[record.tier] },
      provisioned_at: new Date().toISOString(),
    };
    const internal: RuntimeInternalMetadata = {
      container_ref: record.container_ref,
      container_id: record.container_id,
      internal_endpoint: record.internal_endpoint,
    };
    return { result, internal };
  }

  async resumeRuntime(request: ResumeRuntimeInput): Promise<ResumeRuntimeResult> {
    this.opCounts.resume += 1;
    const injected = this.failures.resume;
    if (injected !== undefined) {
      delete this.failures.resume;
      throw new RuntimeBackendFailure("RUNTIME_UNAVAILABLE", injected);
    }
    const record = this.byHandle(request.runtime_handle);
    // Idempotent: running stays running; stopped starts; no second container.
    record.status = "running";
    record.health = "healthy";
    return {
      runtime_handle: record.runtime_handle,
      provisioning_status: record.status,
      health: record.health,
      checked_at: new Date().toISOString(),
    };
  }

  async stopRuntime(request: StopRuntimeInput): Promise<StopRuntimeResult> {
    this.opCounts.stop += 1;
    const injected = this.failures.stop;
    if (injected !== undefined) {
      delete this.failures.stop;
      throw new RuntimeBackendFailure("RUNTIME_UNAVAILABLE", injected);
    }
    const record = this.byHandle(request.runtime_handle);
    // Idempotent: already-stopped is a truthful no-op success.
    record.status = "stopped";
    record.health = "unknown";
    return {
      runtime_handle: record.runtime_handle,
      provisioning_status: record.status,
      health: record.health,
      checked_at: new Date().toISOString(),
    };
  }

  async getRuntimeStatus(request: GetRuntimeStatusInput): Promise<RuntimeStatus> {
    this.opCounts.status += 1;
    const record = this.byHandle(request.runtime_handle);
    return {
      runtime_handle: record.runtime_handle,
      account_id: record.account_id,
      tier: record.tier,
      provisioning_status: record.status,
      health: record.health,
      resource_summary: { tier: record.tier, ...TIER_RESOURCE_LIMITS[record.tier] },
      checked_at: new Date().toISOString(),
    };
  }

  // --- test seams -----------------------------------------------------------

  /** One-shot deterministic failure for the next call of this operation (G4 path). */
  injectFailure(op: "provision" | "resume" | "stop", detail: string): void {
    this.failures[op] = detail;
  }

  /** Truthful state mutation for status tests (the analogue of an external stop). */
  setStopped(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record) throw new Error(`no record for ${accountId}`);
    record.status = "stopped";
    record.health = "unknown";
  }

  recordFor(accountId: string): ContainerRecord {
    const record = this.records.get(accountId);
    if (!record) throw new Error(`no record for ${accountId}`);
    return record;
  }

  get appliedSpecs(): readonly AppliedSpec[] {
    return this.applied;
  }

  get containersCreated(): number {
    return this.records.size;
  }

  private byHandle(handle: string): ContainerRecord {
    for (const record of this.records.values()) {
      if (record.runtime_handle === handle) return record;
    }
    throw new RuntimeBackendFailure("RUNTIME_UNAVAILABLE", `unknown runtime handle ${handle}`);
  }
}
