/**
 * LocalContainerBackend (S06) — the D12 RuntimeBackend implementation for the
 * local Docker Compose deployment (PRD §6.1).
 *
 * This is one of exactly two provisioning-adapter files allowed to speak
 * engine vocabulary (D23 rule 2; enforced by the portability grep test). It
 * maps the backend-neutral contract onto real engine configuration: the tier
 * limits from PRD §3.3 are applied as hard CPU/memory limits via the spec
 * builder, the container joins only the management network (no published
 * ports, no inbound public access), no host paths are mounted, and the
 * container never sees the engine socket (D27).
 *
 * Isolation/idempotency posture:
 * - One container per user: deterministic container name keyed by account id;
 *   a name conflict is resolved by ADOPTING the existing container only when
 *   its ownership label matches the requesting account — otherwise a typed
 *   tenant-mismatch failure (a cross-tenant attempt can never adopt).
 * - start/stop tolerate the engine's "already started/stopped" (304) answer —
 *   idempotency at the engine boundary.
 * - Ownership of a runtime handle is resolved through the control-plane
 *   label, so the backend survives control-plane restarts.
 * - Failures throw typed RuntimeBackendFailure — a failed provision is never
 *   reported as success (G4).
 *
 * NOTE (recorded environment constraint, 2026-09-19): this host has no
 * container daemon, so this backend is exercised by the contract/fake suites
 * here and for real in Compose (S35). Nothing in this file pretends success.
 */
import { randomBytes } from "node:crypto";

import Docker from "dockerode";
import type { Container, ContainerInspectInfo } from "dockerode";

import {
  RuntimeBackendFailure,
  TIER_RESOURCE_LIMITS,
  type GetRuntimeStatusInput,
  type ProvisionBackendOutcome,
  type ProvisionRuntimeInput,
  type ProvisioningStatus,
  type ResourceTier,
  type ResumeRuntimeInput,
  type RuntimeBackend,
  type RuntimeHealthState,
  type RuntimeInternalMetadata,
  type RuntimeProvisionSecrets,
  type StopRuntimeInput,
} from "@shera-bot/contracts";

import { buildLocalContainerSpec, containerNameFor } from "./container-spec.ts";

const MANAGED_LABEL = "shera.managed";
const ACCOUNT_LABEL = "shera.account_id";
const HANDLE_LABEL = "shera.runtime_handle";

export interface LocalContainerBackendOptions {
  /** Environment reference map; defaults to process.env (G3: no literals). */
  env?: NodeJS.ProcessEnv;
}

export interface LocalContainerBackendConfig {
  image: string;
  internal_port: number;
  network: string;
}

export function readLocalBackendConfig(env: NodeJS.ProcessEnv): LocalContainerBackendConfig {
  return {
    image: env.SHERA_RUNTIME_IMAGE ?? "shera-user-runtime:dev",
    internal_port: Number(env.SHERA_RUNTIME_INTERNAL_PORT ?? "8080"),
    network: env.SHERA_RUNTIME_NETWORK ?? "shera-internal",
  };
}

function opaqueHandle(): string {
  return `rt_${randomBytes(16).toString("hex")}`;
}

function mapStatus(state: ContainerInspectInfo["State"]): ProvisioningStatus {
  switch (state.Status) {
    case "running":
      return "running";
    case "exited":
    case "paused":
      return "stopped";
    case "dead":
      return "failed";
    default:
      // created | restarting | removing: creation or transition in progress.
      return "provisioning";
  }
}

function mapHealth(state: ContainerInspectInfo["State"]): RuntimeHealthState {
  const health = state.Health?.Status;
  if (health === "healthy") return "healthy";
  if (health === "unhealthy") return "unhealthy";
  return "unknown";
}

/** Swallow the engine's "already in the desired state" (304) answers. */
async function ignoreAlreadyState(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const code = (error as { statusCode?: number }).statusCode;
    if (code !== 304) throw error;
  }
}

export class LocalContainerBackend implements RuntimeBackend {
  private readonly docker: Docker;
  private readonly config: LocalContainerBackendConfig;

  constructor(options: LocalContainerBackendOptions = {}) {
    const env = options.env ?? process.env;
    this.config = readLocalBackendConfig(env);
    // The engine client reads its connection configuration from the standard
    // environment references (DOCKER_HOST et al.); it connects lazily.
    this.docker = new Docker();
  }

  async provisionRuntime(
    request: ProvisionRuntimeInput,
    secrets: RuntimeProvisionSecrets,
  ): Promise<ProvisionBackendOutcome> {
    const name = containerNameFor(request.account_id);
    const { createHash } = await import("node:crypto");
    const credentialSha256 = createHash("sha256")
      .update(secrets.internal_channel_token, "utf8")
      .digest("hex");
    const handle = opaqueHandle();

    const spec = buildLocalContainerSpec({
      account_id: request.account_id,
      tier: request.tier,
      credential_sha256: credentialSha256,
      image: this.config.image,
      internal_port: this.config.internal_port,
      network: this.config.network,
    });
    // The handle rides on the labels so the backend can resolve ownership
    // after a control-plane restart.
    spec.Labels[HANDLE_LABEL] = handle;

    let container: Container;
    try {
      container = await this.docker.createContainer({ ...spec, name });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) {
        throw new RuntimeBackendFailure(
          "RUNTIME_PROVISION_FAILED",
          `the engine refused container creation (${error instanceof Error ? error.name : "error"})`,
        );
      }
      // Name conflict: the deterministic name already exists. Adopt it only
      // if it is provably this account's container (cross-tenant guard).
      container = await this.adoptOwnedContainer(name, request.account_id);
    }

    await ignoreAlreadyState(() => container.start());
    const inspected = await container.inspect();
    if (!inspected.State.Running) {
      throw new RuntimeBackendFailure(
        "RUNTIME_PROVISION_FAILED",
        "the container did not reach the running state",
      );
    }

    const internal: RuntimeInternalMetadata = {
      container_ref: name,
      container_id: inspected.Id,
      internal_endpoint: `http://${name}:${this.config.internal_port}`,
    };
    return {
      result: {
        runtime_handle: handle,
        account_id: request.account_id,
        tier: request.tier,
        provisioning_status: "running",
        health: mapHealth(inspected.State),
        resource_summary: { tier: request.tier, ...TIER_RESOURCE_LIMITS[request.tier] },
        provisioned_at: new Date().toISOString(),
      },
      internal,
    };
  }

  async resumeRuntime(request: ResumeRuntimeInput) {
    const container = await this.byHandle(request.runtime_handle);
    await ignoreAlreadyState(() => container.start());
    const inspected = await container.inspect();
    return {
      runtime_handle: request.runtime_handle,
      provisioning_status: mapStatus(inspected.State),
      health: mapHealth(inspected.State),
      checked_at: new Date().toISOString(),
    };
  }

  async stopRuntime(request: StopRuntimeInput) {
    const container = await this.byHandle(request.runtime_handle);
    await ignoreAlreadyState(() => container.stop({ t: 10 }));
    const inspected = await container.inspect();
    return {
      runtime_handle: request.runtime_handle,
      provisioning_status: mapStatus(inspected.State),
      health: mapHealth(inspected.State),
      checked_at: new Date().toISOString(),
    };
  }

  async getRuntimeStatus(request: GetRuntimeStatusInput) {
    const container = await this.byHandle(request.runtime_handle);
    const inspected = await container.inspect();
    const accountLabel: string | undefined = inspected.Config?.Labels?.[ACCOUNT_LABEL];
    const tierLabel: string | undefined = inspected.Config?.Labels?.["shera.tier"];
    const tier: ResourceTier | undefined =
      tierLabel === "light" || tierLabel === "balanced" || tierLabel === "heavy"
        ? tierLabel
        : undefined;
    if (!accountLabel || !tier) {
      throw new RuntimeBackendFailure(
        "RUNTIME_UNAVAILABLE",
        "the container lacks its control-plane labels",
      );
    }
    return {
      runtime_handle: request.runtime_handle,
      account_id: accountLabel,
      tier,
      provisioning_status: mapStatus(inspected.State),
      health: mapHealth(inspected.State),
      resource_summary: { tier, ...TIER_RESOURCE_LIMITS[tier] },
      checked_at: new Date().toISOString(),
    };
  }

  private async adoptOwnedContainer(name: string, accountId: string): Promise<Container> {
    const container = this.docker.getContainer(name);
    const inspected = await container.inspect().catch(() => {
      throw new RuntimeBackendFailure(
        "RUNTIME_PROVISION_FAILED",
        "the existing container could not be inspected",
      );
    });
    if (inspected.Config?.Labels?.[ACCOUNT_LABEL] !== accountId) {
      throw new RuntimeBackendFailure(
        "RUNTIME_TENANT_MISMATCH",
        "a container with this name exists under a different owner",
      );
    }
    return container;
  }

  private async byHandle(handle: string): Promise<Container> {
    const found = await this.docker
      .listContainers({
        all: true,
        filters: JSON.stringify({
          label: [`${MANAGED_LABEL}=control-plane`, `${HANDLE_LABEL}=${handle}`],
        }),
      })
      .catch(() => {
        throw new RuntimeBackendFailure("RUNTIME_UNAVAILABLE", "the engine could not be reached");
      });
    const summary = found[0];
    if (!summary) {
      throw new RuntimeBackendFailure(
        "RUNTIME_UNAVAILABLE",
        "no container exists for this runtime handle",
      );
    }
    return this.docker.getContainer(summary.Id);
  }
}
