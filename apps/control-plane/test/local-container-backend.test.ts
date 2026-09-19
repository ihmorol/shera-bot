/**
 * LocalContainerBackend tests (S06, issue #7) — the adoption path, with NO
 * container daemon.
 *
 * This host has no usable container daemon (recorded constraint; the real
 * engine path is exercised in Compose, S35). Per the D23 fake strategy the
 * engine client is injected behind the constructor seam and replaced with a
 * deterministic stub that models the engine's observable behavior: create
 * (including 409 name conflicts), inspect, start/stop, remove, and
 * label-filtered listing.
 *
 * The invariants pinned here (review finding BLOCK, 2026-09-20):
 * - I1 handle continuity: after any successful provisionRuntime call, the
 *   returned runtime_handle resolves via byHandle/getRuntimeStatus on the
 *   same engine state.
 * - I2 channel works immediately: after any successful provisionRuntime, the
 *   container's credential digest equals the digest of the token delivered in
 *   THIS call (registration over the channel succeeds right after).
 * - I3 cross-tenant safety: a name-conflicting container owned by a DIFFERENT
 *   account is never adopted or removed — typed RUNTIME_TENANT_MISMATCH.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type Docker from "dockerode";

import type { ProvisionRuntimeInput } from "@shera-bot/contracts";

import { LocalContainerBackend } from "../src/runtime/local-container-backend.ts";
import { containerNameFor } from "../src/runtime/container-spec.ts";
import { generateChannelToken, sha256Hex } from "../src/runtime/channel-token.ts";

// The engine speaks these labels; the backend owns their semantics.
const MANAGED_LABEL = "shera.managed";
const ACCOUNT_LABEL = "shera.account_id";
const HANDLE_LABEL = "shera.runtime_handle";
const CREDENTIAL_ENV = "SHERA_INTERNAL_CHANNEL_CREDENTIAL_SHA256";

const ACCOUNT = "a1b2c3d4-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "b1b2c3d4-0000-4000-8000-000000000002";

interface StubContainerState {
  name: string;
  id: string;
  labels: Record<string, string>;
  env: string[];
  running: boolean;
}

/**
 * Deterministic engine-client stub: keyed by the deterministic container
 * name, 409 on duplicate create, label-filtered listing, mutable running
 * state. Only what the backend actually calls is modeled.
 */
class StubEngine {
  readonly containers = new Map<string, StubContainerState>();
  createAttempts = 0;
  /** Successful creations only (refused 409 attempts are not creations). */
  createCalls = 0;
  removeCalls = 0;
  private nextId = 0;

  async createContainer(spec: {
    name: string;
    Labels: Record<string, string>;
    Env: string[];
  }): Promise<unknown> {
    this.createAttempts += 1;
    if (this.containers.has(spec.name)) {
      throw Object.assign(new Error("Conflict. The container name is already in use"), {
        statusCode: 409,
      });
    }
    this.createCalls += 1;
    this.nextId += 1;
    this.containers.set(spec.name, {
      name: spec.name,
      id: `stub-container-${this.nextId}`,
      labels: { ...spec.Labels },
      env: [...spec.Env],
      running: false,
    });
    return this.asContainer(spec.name);
  }

  /** Pre-seed a container as if an earlier deployment created it. */
  preseed(name: string, labels: Record<string, string>, env: string[]): void {
    this.nextId += 1;
    this.containers.set(name, {
      name,
      id: `stub-container-${this.nextId}`,
      labels,
      env,
      running: false,
    });
  }

  async listContainers(options: { all: boolean; filters: string }): Promise<Array<{ Id: string }>> {
    const parsed = JSON.parse(options.filters) as { label?: string[] };
    const wanted = (parsed.label ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    });
    return [...this.containers.values()]
      .filter((container) => wanted.every(([key, value]) => container.labels[key] === value))
      .map((container) => ({ Id: container.id }));
  }

  getContainer(idOrName: string): unknown {
    return this.asContainer(idOrName);
  }

  /** The single container, failing when the engine holds any other number. */
  only(): StubContainerState {
    if (this.containers.size !== 1) {
      throw new Error(`expected exactly one container, found ${this.containers.size}`);
    }
    return [...this.containers.values()][0];
  }

  private asContainer(idOrName: string) {
    return {
      inspect: async () => {
        const state = this.stateOf(idOrName);
        return {
          Id: state.id,
          State: { Status: state.running ? "running" : "exited", Running: state.running },
          Config: { Labels: state.labels, Env: state.env },
        };
      },
      start: async () => {
        this.stateOf(idOrName).running = true;
      },
      stop: async () => {
        this.stateOf(idOrName).running = false;
      },
      remove: async () => {
        const state = this.stateOf(idOrName);
        this.removeCalls += 1;
        this.containers.delete(state.name);
      },
    };
  }

  private stateOf(idOrName: string): StubContainerState {
    for (const container of this.containers.values()) {
      if (container.name === idOrName || container.id === idOrName) return container;
    }
    throw Object.assign(new Error("no such container"), { statusCode: 404 });
  }
}

function backendWith(engine: StubEngine): LocalContainerBackend {
  return new LocalContainerBackend({
    env: {},
    engineClientFactory: () => engine as unknown as Docker,
  });
}

function provisionRequest(accountId: string): ProvisionRuntimeInput {
  return { account_id: accountId, tier: "balanced", request_id: `req-${randomUUID()}` };
}

function ownedLabels(accountId: string, handle: string): Record<string, string> {
  return {
    [MANAGED_LABEL]: "control-plane",
    [ACCOUNT_LABEL]: accountId,
    "shera.tier": "balanced",
    [HANDLE_LABEL]: handle,
  };
}

describe("LocalContainerBackend adoption path (no daemon; stubbed engine client)", () => {
  function newRig(): { engine: StubEngine; backend: LocalContainerBackend } {
    const engine = new StubEngine();
    return { engine, backend: backendWith(engine) };
  }

  it("adopts an owned container whose credential matches: same handle as its label, byHandle resolves, no second create (stop → provision)", async () => {
    const { engine, backend } = newRig();
    const token = generateChannelToken();

    const first = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: token,
    });
    expect(engine.only().labels[HANDLE_LABEL]).toBe(first.result.runtime_handle);

    await backend.stopRuntime({
      runtime_handle: first.result.runtime_handle,
      request_id: `req-${randomUUID()}`,
    });

    const second = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: token,
    });

    // I1: the returned handle is the one the container actually carries.
    expect(second.result.runtime_handle).toBe(first.result.runtime_handle);
    expect(engine.only().labels[HANDLE_LABEL]).toBe(second.result.runtime_handle);
    // Adoption, not recreation: no second create, no removal.
    expect(engine.createCalls).toBe(1);
    expect(engine.removeCalls).toBe(0);
    // I1: the returned handle resolves on the same engine state.
    const status = await backend.getRuntimeStatus({ runtime_handle: second.result.runtime_handle });
    expect(status.account_id).toBe(ACCOUNT);
    expect(status.provisioning_status).toBe("running");
    // I2: the container's credential digest equals the digest of THIS call's token.
    expect(engine.only().env).toContain(`${CREDENTIAL_ENV}=${sha256Hex(token)}`);
  });

  it("recreates an owned container whose credential differs: old container gone, new handle label and new digest, new handle resolves", async () => {
    const { engine, backend } = newRig();
    const firstToken = generateChannelToken();
    const secondToken = generateChannelToken();

    const first = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: firstToken,
    });

    const second = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: secondToken,
    });

    // Credential recovery: the stale container was removed, the fresh one
    // created under the same deterministic name (one container per user).
    expect(engine.removeCalls).toBe(1);
    expect(engine.createCalls).toBe(2);
    const container = engine.only();
    expect(container.name).toBe(containerNameFor(ACCOUNT));
    expect(container.labels[HANDLE_LABEL]).toBe(second.result.runtime_handle);
    expect(second.result.runtime_handle).not.toBe(first.result.runtime_handle);
    // I2: the fresh container carries exactly this call's digest.
    expect(container.env).toContain(`${CREDENTIAL_ENV}=${sha256Hex(secondToken)}`);
    expect(container.env).not.toContain(`${CREDENTIAL_ENV}=${sha256Hex(firstToken)}`);
    // I1: the new handle resolves; the old handle is gone with the old container.
    const status = await backend.getRuntimeStatus({ runtime_handle: second.result.runtime_handle });
    expect(status.runtime_handle).toBe(second.result.runtime_handle);
    await expect(
      backend.getRuntimeStatus({ runtime_handle: first.result.runtime_handle }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("never adopts or removes a name-conflicting container owned by another account (RUNTIME_TENANT_MISMATCH)", async () => {
    const { engine, backend } = newRig();
    const name = containerNameFor(ACCOUNT);
    engine.preseed(name, ownedLabels(OTHER_ACCOUNT, "rt_" + "c".repeat(32)), [
      `${CREDENTIAL_ENV}=${sha256Hex(generateChannelToken())}`,
    ]);

    await expect(
      backend.provisionRuntime(provisionRequest(ACCOUNT), {
        internal_channel_token: generateChannelToken(),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TENANT_MISMATCH" });

    expect(engine.removeCalls).toBe(0);
    expect(engine.containers.get(name)).toBeDefined();
  });

  it("fails typed instead of minting a handle when the matching owned container carries no handle label", async () => {
    const { engine, backend } = newRig();
    const name = containerNameFor(ACCOUNT);
    const token = generateChannelToken();
    engine.preseed(
      name,
      {
        [MANAGED_LABEL]: "control-plane",
        [ACCOUNT_LABEL]: ACCOUNT,
        "shera.tier": "balanced",
        // No handle label: an unmanaged or hand-made container.
      },
      [`${CREDENTIAL_ENV}=${sha256Hex(token)}`],
    );

    await expect(
      backend.provisionRuntime(provisionRequest(ACCOUNT), { internal_channel_token: token }),
    ).rejects.toMatchObject({ code: "RUNTIME_PROVISION_FAILED" });

    expect(engine.removeCalls).toBe(0);
    expect(engine.createAttempts).toBe(1);
  });
});
