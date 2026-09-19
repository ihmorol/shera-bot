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

function digest(accountId: string): string {
  return createHash("sha256").update(`fake-container:${accountId}`, "utf8").digest("hex");
}

export class FakeContainerBackend implements RuntimeBackend {
  private readonly records = new Map<string, ContainerRecord>();
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

    const existing = this.records.get(request.account_id);
    const containerId = digest(request.account_id);
    const credentialSha256 = createHash("sha256")
      .update(secrets.internal_channel_token, "utf8")
      .digest("hex");
    // The endpoint is a property of the container's network configuration and
    // is resolved before the credential is delivered into the environment.
    const endpoint = this.options.endpointFor?.(request.account_id) ?? null;

    // Credential delivery into the container environment (digest only, G3).
    this.options.deliverCredential?.(request.account_id, credentialSha256);

    if (existing) {
      // Idempotent re-attach: never a second container. Bring it to running.
      existing.status = "running";
      existing.health = "healthy";
      existing.tier = request.tier;
    } else {
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
