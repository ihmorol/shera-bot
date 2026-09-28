/**
 * S06 container spec builder tests (issue #7).
 *
 * The spec builder is the pure heart of the local provisioning adapter: it
 * turns PRD §3.3 tier limits into real container limits. These tests run
 * without a container engine — they assert the spec CONTENT that the engine
 * would receive, including the isolation invariants (no host filesystem
 * binds, no published ports, no socket access — D27, PRD §16) and the G3
 * rule that only the credential DIGEST enters the container environment.
 */
import { describe, expect, it } from "vitest";

import { TIER_RESOURCE_LIMITS } from "@shera-bot/contracts";

import { buildLocalContainerSpec, containerNameFor } from "../src/runtime/container-spec.ts";

const ACCOUNT = "a1b2c3d4-0000-4000-8000-000000000001";
const DIGEST = "f".repeat(64);

function specFor(tier: "light" | "balanced" | "heavy") {
  return buildLocalContainerSpec({
    account_id: ACCOUNT,
    tier,
    credential_sha256: DIGEST,
    image: "shera-user-runtime:dev",
    internal_port: 8080,
    network: "shera-internal",
  });
}

describe("local container spec builder (PRD §3.3 tiers as real limits)", () => {
  it("derives a deterministic per-user container name", () => {
    expect(containerNameFor(ACCOUNT)).toBe(`shera-rt-${ACCOUNT}`);
    expect(containerNameFor(ACCOUNT)).toBe(containerNameFor(ACCOUNT));
  });

  it("applies the Balanced limits as hard CPU and memory limits (the prototype default)", () => {
    const spec = specFor("balanced");
    const limits = TIER_RESOURCE_LIMITS.balanced;
    expect(spec.HostConfig.NanoCpus).toBe(limits.cpu_vcpus * 1_000_000_000);
    expect(spec.HostConfig.Memory).toBe(limits.memory_bytes);
    // No swap beyond the memory limit.
    expect(spec.HostConfig.MemorySwap).toBe(limits.memory_bytes);
  });

  it("maps every tier onto the PRD §3.3 table", () => {
    expect(specFor("light").HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(specFor("light").HostConfig.Memory).toBe(2 * 1024 ** 3);
    expect(specFor("heavy").HostConfig.NanoCpus).toBe(4_000_000_000);
    expect(specFor("heavy").HostConfig.Memory).toBe(8 * 1024 ** 3);
    // Storage is recorded per tier (quota enforcement is a storage-driver
    // deployment property; it is never silently claimed as a UI number).
    expect(specFor("light").Labels["shera.storage_bytes"]).toBe(String(10 * 1024 ** 3));
    expect(specFor("balanced").Labels["shera.storage_bytes"]).toBe(String(25 * 1024 ** 3));
    expect(specFor("heavy").Labels["shera.storage_bytes"]).toBe(String(50 * 1024 ** 3));
  });

  it("keeps the credential digest only in the environment — never the raw token (G3)", () => {
    const spec = specFor("balanced");
    expect(spec.Env).toContain(`SHERA_INTERNAL_CHANNEL_CREDENTIAL_SHA256=${DIGEST}`);
    expect(spec.Env).toContain(`SHERA_ACCOUNT_ID=${ACCOUNT}`);
    expect(JSON.stringify(spec)).not.toContain("raw-token-value");
  });

  it("carries the tenancy labels the control plane needs for ownership checks", () => {
    const spec = specFor("balanced");
    expect(spec.Labels["shera.managed"]).toBe("control-plane");
    expect(spec.Labels["shera.account_id"]).toBe(ACCOUNT);
    expect(spec.Labels["shera.tier"]).toBe("balanced");
  });

  it("never mounts host paths, never publishes ports, never exposes the engine socket (D27)", () => {
    const spec = specFor("balanced");
    expect(spec.HostConfig.Binds).toBeUndefined();
    expect(spec.HostConfig.PortBindings).toBeUndefined();
    expect(spec.HostConfig.NetworkMode).toBe("shera-internal");
    expect(JSON.stringify(spec).toLowerCase()).not.toContain(".sock");
    expect(JSON.stringify(spec).toLowerCase()).not.toContain("/var/run");
  });

  it("restarts the container automatically unless explicitly stopped", () => {
    const spec = specFor("balanced");
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
  });

  it("defines an in-container liveness healthcheck (loopback, credential-free)", () => {
    const spec = specFor("balanced");
    expect(spec.Healthcheck).toBeDefined();
    expect(JSON.stringify(spec.Healthcheck)).toContain("127.0.0.1");
  });
});
