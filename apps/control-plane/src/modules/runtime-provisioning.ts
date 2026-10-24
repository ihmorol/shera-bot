/**
 * Runtime provisioning service (S06, issue #7; D2, D12, PRD §3.3, §6, §16).
 *
 * The control-plane service that owns the user→container lifecycle: it
 * resolves the account's mapping, issues the per-container channel
 * credential, drives the typed RuntimeBackend (D12), pushes the registration
 * binding over the authenticated internal channel, and keeps the central
 * control-plane records truthful (G4): a failed provision or restart is a
 * typed error plus a security event, never a success.
 *
 * Every lifecycle command is idempotent (D23 rule 6): provisioning keyed by
 * the account mapping (never a second container), resume/stop keyed by the
 * runtime handle and tolerant of already-desired states, and lookups derived
 * from the SESSION account so another user's runtime cannot be targeted.
 *
 * Channel credential handling (G3): the raw token exists only in this
 * process's memory (registered with the secret registry for redaction); the
 * database stores the SHA-256 digest; the container environment receives the
 * digest only. Rotation stages the new digest over the authenticated channel
 * (current credential), then commits with the new credential and prunes the
 * old. If the in-memory token is gone (e.g. control-plane restart), rotation
 * fails closed with a typed error, and re-provisioning is the documented
 * recovery, matching exactly what the code does: with the in-memory token
 * still valid, re-provisioning reuses that token and re-adopts the existing
 * handle; with the token lost, re-provisioning mints a fresh token, the
 * backend recreates the container, and the credential and registration are
 * re-established (a real recovery — the handle changes).
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import {
  type ProvisionRuntimeResult,
  type ResumeRuntimeResult,
  type ResourceTier,
  type RuntimeBackend,
  type RuntimeBackendFailure,
  type StopRuntimeResult,
  type RuntimeStatus,
} from "@shera-bot/contracts";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAccounts, controlContainerMappings } from "../db/schema.ts";
import {
  RuntimeOperationError,
  runtimeNotProvisionedError,
  runtimeProvisionFailedError,
  runtimeProvisionInProgressError,
  runtimeTenantMismatchError,
  runtimeUnavailableError,
} from "../errors.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import type { SecretRegistry } from "../redaction.ts";
import type { SecurityEventService } from "./security-events.ts";
import { ChannelRejected, type RuntimeChannelClient } from "../runtime/channel-client.ts";
import { generateChannelToken, sha256Hex } from "../runtime/channel-token.ts";

export interface ProvisioningServiceDeps {
  db: ControlPlaneDb;
  backend: RuntimeBackend;
  channel: RuntimeChannelClient;
  securityEvents: SecurityEventService;
  registry: SecretRegistry;
  logger: ControlPlaneLogger;
}

export interface RotationOutcome {
  runtime_handle: string;
  rotated_at: string;
}

interface ChannelSecretEntry {
  raw: string;
  sha256: string;
}

interface MappingRow {
  id: string;
  accountId: string;
  runtimeHandle: string | null;
  containerRef: string | null;
  runtimeEndpoint: string | null;
  tier: ResourceTier;
  provisioningStatus: string;
  internalChannelTokenHash: string | null;
  tokenRotatedAt: Date | null;
}

/**
 * SQLSTATE 23505 (unique violation), recognized through Drizzle's
 * DrizzleQueryError wrapper (the driver error rides on `cause`).
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 3; depth += 1) {
    if ((current as Error & { code?: string }).code === "23505") return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export class ProvisioningService {
  private readonly deps: ProvisioningServiceDeps;
  /** In-memory current credentials (digest-keyed by account); redacted at logging. */
  private readonly channelSecrets = new Map<string, ChannelSecretEntry>();

  constructor(deps: ProvisioningServiceDeps) {
    this.deps = deps;
  }

  /**
   * Provision the user's runtime at first login (idempotent). Returns the
   * web-facing provisioning result — opaque handle + resource summary only.
   */
  async ensureProvisioned(
    accountId: string,
    correlationId?: string,
  ): Promise<ProvisionRuntimeResult> {
    // A transaction-scoped database lock survives awaits and releases on crash.
    // Holding it makes a leftover "provisioning" row recoverable without stealing
    // an active request's credential or relying on an arbitrary stale timeout.
    return this.deps.db.transaction(async (tx) => {
      const lock = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${accountId}, 0)) as acquired`,
      );
      if (lock.rows[0]?.["acquired"] !== true) throw runtimeProvisionInProgressError(correlationId);
      return this.ensureProvisionedLocked(accountId, correlationId);
    });
  }

  private async ensureProvisionedLocked(
    accountId: string,
    correlationId?: string,
  ): Promise<ProvisionRuntimeResult> {
    const mapping = await this.loadOrCreateMapping(accountId);

    const existing = mapping.runtimeHandle ? await this.tryStatus(mapping, correlationId) : null;
    if (
      existing &&
      existing.provisioning_status === "running" &&
      this.channelSecrets.get(accountId)?.sha256 === mapping.internalChannelTokenHash
    ) {
      return this.provisionResultFrom(existing);
    }

    // Issue the channel credential. The raw value is redacted everywhere and
    // never persisted; the backend delivers its digest into the container.
    //
    // Re-provisioning credential choice (adoption invariants I1/I2): when the
    // mapping already has a runtime handle AND the in-memory token still
    // verifies against the stored digest, REUSE it — the backend then adopts
    // the existing container and provisioning returns the SAME handle (the
    // stop → re-provision path within one control-plane lifetime). When no
    // in-memory token verifies (e.g. control-plane restart), a fresh token is
    // minted and the backend recreates the container: re-provisioning becomes
    // a REAL credential recovery, not a report of success over a bricked
    // credential.
    const inMemory = this.channelSecrets.get(mapping.accountId);
    const reusable: ChannelSecretEntry | null =
      mapping.runtimeHandle !== null &&
      mapping.internalChannelTokenHash !== null &&
      inMemory !== undefined &&
      inMemory.sha256 === mapping.internalChannelTokenHash
        ? inMemory
        : null;
    const rawToken = reusable ? reusable.raw : generateChannelToken();
    const tokenSha256 = sha256Hex(rawToken);
    if (!reusable) {
      this.deps.registry.register(rawToken, "runtime-channel-token");
      this.channelSecrets.set(mapping.accountId, { raw: rawToken, sha256: tokenSha256 });
    }

    await this.setStatus(mapping.accountId, "provisioning");
    try {
      const outcome = await this.deps.backend.provisionRuntime(
        {
          account_id: mapping.accountId,
          tier: mapping.tier,
          request_id: randomUUID(),
          correlation_id: correlationId ?? undefined,
        },
        { internal_channel_token: rawToken },
      );

      // Registration over the authenticated internal channel: the container
      // must acknowledge the binding before provisioning reports success.
      if (outcome.internal.internal_endpoint) {
        await this.deps.channel.register(outcome.internal.internal_endpoint, rawToken, {
          runtime_handle: outcome.result.runtime_handle,
          account_id: mapping.accountId,
          tier: mapping.tier,
          correlation_id: correlationId ?? undefined,
        });
      } else {
        throw new ChannelRejected("unreachable", "the backend returned no internal endpoint");
      }

      await this.recordProvisioned(mapping, outcome, tokenSha256);
      await this.deps.securityEvents.record({
        eventType: "runtime_provisioned",
        accountId: mapping.accountId,
        details: {
          tier: mapping.tier,
          container_ref: outcome.internal.container_ref,
        },
        correlationId,
        redactionClass: "internal",
      });
      return outcome.result;
    } catch (error) {
      await this.setStatus(mapping.accountId, "failed");
      await this.deps.securityEvents.record({
        eventType: "runtime_provision_failed",
        accountId: mapping.accountId,
        details: {
          reason: this.describeFailure(error),
          channel_rejected: error instanceof ChannelRejected && error.kind === "unauthorized",
        },
        correlationId,
        redactionClass: "internal",
      });
      if (error instanceof ChannelRejected && error.kind === "unauthorized") {
        await this.deps.securityEvents.record({
          eventType: "runtime_channel_auth_failed",
          accountId: mapping.accountId,
          details: { direction: "control_plane_to_container", reason: "credential_rejected" },
          correlationId,
          redactionClass: "restricted",
        });
      }
      this.deps.logger.error("runtime_provision_failed", {
        account_id: mapping.accountId,
        reason: this.describeFailure(error),
        correlation_id: correlationId,
      });
      throw this.toOperationError(error, correlationId);
    }
  }

  /** Bring the runtime to running (idempotent; never creates a second container). */
  async restart(accountId: string, correlationId?: string): Promise<ResumeRuntimeResult> {
    const mapping = await this.requireMapping(accountId, correlationId);
    if (!mapping.runtimeHandle) throw runtimeNotProvisionedError(correlationId);
    try {
      const result = await this.deps.backend.resumeRuntime({
        runtime_handle: mapping.runtimeHandle,
        request_id: randomUUID(),
        correlation_id: correlationId ?? undefined,
      });
      await this.syncStatus(mapping.accountId, result.provisioning_status, result.health);
      return result;
    } catch (error) {
      await this.recordOperationFailure("restart", mapping.accountId, error, correlationId);
      throw this.toOperationError(error, correlationId);
    }
  }

  /** Stop the runtime (idempotent: already-stopped is a truthful success). */
  async stop(accountId: string, correlationId?: string): Promise<StopRuntimeResult> {
    const mapping = await this.requireMapping(accountId, correlationId);
    if (!mapping.runtimeHandle) throw runtimeNotProvisionedError(correlationId);
    try {
      const result = await this.deps.backend.stopRuntime({
        runtime_handle: mapping.runtimeHandle,
        request_id: randomUUID(),
        correlation_id: correlationId ?? undefined,
      });
      await this.syncStatus(mapping.accountId, result.provisioning_status, result.health);
      return result;
    } catch (error) {
      await this.recordOperationFailure("stop", mapping.accountId, error, correlationId);
      throw this.toOperationError(error, correlationId);
    }
  }

  /** Truthful current state; syncs the control-plane record to backend truth. */
  async getStatus(accountId: string, correlationId?: string): Promise<RuntimeStatus> {
    const mapping = await this.requireMapping(accountId, correlationId);
    if (!mapping.runtimeHandle) throw runtimeNotProvisionedError(correlationId);
    const status = await this.tryStatus(mapping, correlationId);
    if (!status) throw runtimeUnavailableError(correlationId);
    return status;
  }

  /**
   * Rotate the per-container channel credential (documented procedure):
   * stage the new digest over the channel authenticated with the CURRENT
   * credential, commit with the NEW credential (the container prunes the old
   * digest), then persist the new digest. The raw token never crosses the
   * wire and never reaches storage (G3).
   */
  async rotateInternalChannelToken(
    accountId: string,
    correlationId?: string,
  ): Promise<RotationOutcome> {
    const mapping = await this.requireMapping(accountId, correlationId);
    if (!mapping.runtimeHandle || !mapping.runtimeEndpoint || !mapping.internalChannelTokenHash) {
      throw runtimeNotProvisionedError(correlationId);
    }
    const current = this.channelSecrets.get(accountId);
    if (!current || current.sha256 !== mapping.internalChannelTokenHash) {
      // Fail closed: without the current credential the channel cannot prove
      // itself. The documented recovery is re-provisioning, and it is real:
      // with the in-memory token still valid, re-provisioning reuses that
      // token and re-adopts the existing handle; with the token lost
      // (control-plane restart), it recreates the container and re-establishes
      // the credential and registration.
      throw runtimeUnavailableError(correlationId);
    }

    const nextRaw = generateChannelToken();
    const nextSha256 = sha256Hex(nextRaw);
    this.deps.registry.register(nextRaw, "runtime-channel-token");
    try {
      await this.deps.channel.stageCredential(mapping.runtimeEndpoint, current.raw, nextSha256);
      await this.deps.channel.commitCredential(mapping.runtimeEndpoint, nextRaw);
    } catch (error) {
      this.deps.logger.error("runtime_channel_rotation_failed", {
        account_id: accountId,
        reason: this.describeFailure(error),
        correlation_id: correlationId,
      });
      throw this.toOperationError(error, correlationId);
    }

    this.channelSecrets.set(accountId, { raw: nextRaw, sha256: nextSha256 });
    await this.deps.db
      .update(controlContainerMappings)
      .set({
        internalChannelTokenHash: nextSha256,
        tokenRotatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(controlContainerMappings.accountId, accountId));
    await this.deps.securityEvents.record({
      eventType: "runtime_channel_token_rotated",
      accountId,
      details: { runtime_handle: mapping.runtimeHandle },
      correlationId,
      redactionClass: "internal",
    });
    return { runtime_handle: mapping.runtimeHandle, rotated_at: new Date().toISOString() };
  }

  /** Server-internal channel target; never serialize this to a browser. */
  async getChannelTarget(accountId: string): Promise<{ endpoint: string; bearer: string }> {
    const mapping = await this.requireMapping(accountId);
    const credential = this.channelSecrets.get(accountId);
    if (
      mapping.provisioningStatus !== "running" ||
      !mapping.runtimeEndpoint ||
      !credential ||
      credential.sha256 !== mapping.internalChannelTokenHash
    ) {
      throw runtimeUnavailableError();
    }
    return { endpoint: mapping.runtimeEndpoint, bearer: credential.raw };
  }

  // --- internals ------------------------------------------------------------

  private async loadOrCreateMapping(accountId: string): Promise<MappingRow> {
    const existing = await this.loadMapping(accountId);
    if (existing) return existing;

    const account = (
      await this.deps.db.select().from(controlAccounts).where(eq(controlAccounts.id, accountId))
    )[0];
    if (!account) {
      throw runtimeNotProvisionedError();
    }
    // PRD §3.2: the account tier governs the container tier; balanced default.
    try {
      await this.deps.db.insert(controlContainerMappings).values({ accountId, tier: account.tier });
    } catch (error) {
      // Two concurrent first logins race on this select-then-insert: the
      // loser's insert hits the account_id unique constraint (SQLSTATE 23505).
      // That is the winner's success, not a fault — re-load the mapping the
      // winner created and continue (single retry). Any other failure, or a
      // still-missing mapping, keeps surfacing as a typed error, never a raw
      // 500.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.loadMapping(accountId);
      if (!raced) throw runtimeProvisionFailedError();
      return raced;
    }
    const created = await this.loadMapping(accountId);
    if (!created) throw runtimeProvisionFailedError();
    return created;
  }

  private async loadMapping(accountId: string): Promise<MappingRow | null> {
    const rows = await this.deps.db
      .select()
      .from(controlContainerMappings)
      .where(eq(controlContainerMappings.accountId, accountId));
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.accountId,
      runtimeHandle: row.runtimeHandle,
      containerRef: row.containerRef,
      runtimeEndpoint: row.runtimeEndpoint,
      tier: row.tier,
      provisioningStatus: row.provisioningStatus,
      internalChannelTokenHash: row.internalChannelTokenHash,
      tokenRotatedAt: row.tokenRotatedAt,
    };
  }

  private async requireMapping(accountId: string, correlationId?: string): Promise<MappingRow> {
    const mapping = await this.loadMapping(accountId);
    if (!mapping) throw runtimeNotProvisionedError(correlationId);
    return mapping;
  }

  private async tryStatus(
    mapping: MappingRow,
    correlationId?: string,
  ): Promise<RuntimeStatus | null> {
    if (!mapping.runtimeHandle) return null;
    try {
      const status = await this.deps.backend.getRuntimeStatus({
        runtime_handle: mapping.runtimeHandle,
        correlation_id: correlationId ?? undefined,
      });
      await this.syncStatus(mapping.accountId, status.provisioning_status, status.health);
      return status;
    } catch (error) {
      const code = (error as RuntimeBackendFailure).code;
      if (code === "RUNTIME_UNAVAILABLE") return null;
      throw error;
    }
  }

  private provisionResultFrom(status: RuntimeStatus): ProvisionRuntimeResult {
    return {
      runtime_handle: status.runtime_handle,
      account_id: status.account_id,
      tier: status.tier,
      provisioning_status: status.provisioning_status,
      health: status.health,
      resource_summary: status.resource_summary,
      provisioned_at: status.checked_at,
    };
  }

  private async setStatus(accountId: string, status: string): Promise<void> {
    await this.deps.db
      .update(controlContainerMappings)
      .set({ provisioningStatus: status, updatedAt: new Date() })
      .where(eq(controlContainerMappings.accountId, accountId));
  }

  private async syncStatus(accountId: string, status: string, health: string): Promise<void> {
    await this.deps.db
      .update(controlContainerMappings)
      .set({
        provisioningStatus: status,
        healthSummary: { provisioning_status: status, health },
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(controlContainerMappings.accountId, accountId));
  }

  private async recordProvisioned(
    mapping: MappingRow,
    outcome: Awaited<ReturnType<RuntimeBackend["provisionRuntime"]>>,
    tokenSha256: string,
  ): Promise<void> {
    await this.deps.db
      .update(controlContainerMappings)
      .set({
        runtimeHandle: outcome.result.runtime_handle,
        containerRef: outcome.internal.container_ref,
        runtimeEndpoint: outcome.internal.internal_endpoint,
        internalChannelTokenHash: tokenSha256,
        provisioningStatus: outcome.result.provisioning_status,
        healthSummary: {
          provisioning_status: outcome.result.provisioning_status,
          health: outcome.result.health,
        },
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(controlContainerMappings.accountId, mapping.accountId));
  }

  private async recordOperationFailure(
    operation: string,
    accountId: string,
    error: unknown,
    correlationId?: string,
  ): Promise<void> {
    await this.deps.securityEvents.record({
      eventType: "runtime_operation_failed",
      accountId,
      details: { operation, reason: this.describeFailure(error) },
      correlationId,
      redactionClass: "internal",
    });
    this.deps.logger.error("runtime_operation_failed", {
      operation,
      account_id: accountId,
      reason: this.describeFailure(error),
      correlation_id: correlationId,
    });
  }

  /** Bounded, redaction-safe failure description for events and logs (G3). */
  private describeFailure(error: unknown): string {
    if (error instanceof ChannelRejected) return `channel_${error.kind}`;
    const code = (error as RuntimeBackendFailure).code;
    if (typeof code === "string") return `backend_${code}`;
    if (error instanceof Error) return error.name;
    return "unknown_error";
  }

  private toOperationError(error: unknown, correlationId?: string): RuntimeOperationError {
    if (error instanceof RuntimeOperationError) return error;
    if (error instanceof ChannelRejected) {
      return error.kind === "unauthorized"
        ? runtimeProvisionFailedError(correlationId)
        : runtimeUnavailableError(correlationId);
    }
    const code = (error as RuntimeBackendFailure).code;
    switch (code) {
      case "RUNTIME_TENANT_MISMATCH":
        return runtimeTenantMismatchError(correlationId);
      case "RUNTIME_PROVISION_FAILED":
        return runtimeProvisionFailedError(correlationId);
      default:
        return runtimeUnavailableError(correlationId);
    }
  }
}
