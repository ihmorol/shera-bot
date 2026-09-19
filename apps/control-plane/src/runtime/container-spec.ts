/**
 * Local container spec builder (S06) — the pure mapping from the PRD §3.3
 * tier table to the engine's container configuration.
 *
 * This file is one of exactly two provisioning-adapter files allowed to
 * contain engine vocabulary (D23 rule 2; enforced by the portability grep
 * test). Everything it outputs is REAL engine configuration: CPU and memory
 * are hard limits, no host filesystem paths are mounted, no ports are
 * published (no inbound public access, PRD §16), and only the channel
 * credential DIGEST enters the container environment (G3).
 */
import { TIER_RESOURCE_LIMITS, type ResourceTier } from "@shera-bot/contracts";

/**
 * The environment key carrying the channel credential DIGEST. Defined here so
 * the spec builder and the adapter's ownership checks read one source of
 * truth: the container environment holds the digest only, never raw material
 * (G3).
 */
export const CREDENTIAL_SHA256_ENV = "SHERA_INTERNAL_CHANNEL_CREDENTIAL_SHA256";

/** Deterministic, per-user container name — the idempotency key of the engine layer. */
export function containerNameFor(accountId: string): string {
  return `shera-rt-${accountId}`;
}

export interface LocalContainerSpecInput {
  account_id: string;
  tier: ResourceTier;
  /** SHA-256 of the channel credential — the ONLY credential material delivered. */
  credential_sha256: string;
  image: string;
  internal_port: number;
  /** Management network name; user containers never join the public edge. */
  network: string;
}

/**
 * The container configuration passed to the engine's create call. `Binds` and
 * `PortBindings` are deliberately absent — their absence is the isolation
 * property (D27) and is asserted by test.
 */
export interface LocalContainerSpec {
  name: string;
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: {
    NanoCpus: number;
    Memory: number;
    /** Memory limit without swap headroom: no swap beyond the tier limit. */
    MemorySwap: number;
    RestartPolicy: { Name: "unless-stopped" };
    NetworkMode: string;
  };
  Healthcheck: {
    Test: string[];
    Interval: number;
    Timeout: number;
    Retries: number;
    StartPeriod: number;
  };
}

/**
 * In-container liveness probe: a loopback TCP connect to the runtime gateway.
 * It needs no credential (the connection is namespace-internal) and proves
 * the gateway process is accepting connections; deeper health arrives via the
 * authenticated channel (S07+).
 */
function livenessProbeCommand(port: number): string[] {
  const script = [
    "const net = require('node:net');",
    `const s = net.connect(${port}, '127.0.0.1');`,
    "const fail = () => process.exit(1);",
    "s.on('connect', () => { s.end(); process.exit(0); });",
    "s.on('error', fail);",
    "setTimeout(fail, 2500);",
  ].join(" ");
  return ["CMD-SHELL", `node -e ${JSON.stringify(script)}`];
}

export function buildLocalContainerSpec(input: LocalContainerSpecInput): LocalContainerSpec {
  const limits = TIER_RESOURCE_LIMITS[input.tier];
  return {
    name: containerNameFor(input.account_id),
    Image: input.image,
    Env: [
      `${CREDENTIAL_SHA256_ENV}=${input.credential_sha256}`,
      `SHERA_ACCOUNT_ID=${input.account_id}`,
      `SHERA_TIER=${input.tier}`,
      `SHERA_INTERNAL_PORT=${input.internal_port}`,
    ],
    Labels: {
      "shera.managed": "control-plane",
      "shera.account_id": input.account_id,
      "shera.tier": input.tier,
      "shera.storage_bytes": String(limits.storage_bytes),
      "shera.tier_cpu_vcpus": String(limits.cpu_vcpus),
      "shera.tier_memory_bytes": String(limits.memory_bytes),
    },
    HostConfig: {
      NanoCpus: limits.cpu_vcpus * 1_000_000_000,
      Memory: limits.memory_bytes,
      MemorySwap: limits.memory_bytes,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: input.network,
    },
    Healthcheck: {
      Test: livenessProbeCommand(input.internal_port),
      Interval: 30_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 3,
      StartPeriod: 15_000_000_000,
    },
  };
}
