/**
 * S06 provisioning service tests (issue #7) — idempotent lifecycle, truthful
 * failure reporting (G4), tier application, control-plane records (D2), and
 * channel credential handling (G3).
 *
 * These run the real service against the real PostgreSQL schema and the
 * deterministic FakeContainerBackend (test-kit) — no container engine. The
 * REAL LocalContainerBackend is exercised for real in Compose (S35); on this
 * host no engine exists and no test pretends otherwise.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { TIER_RESOURCE_LIMITS, RUNTIME_REGISTRATION_PATH } from "@shera-bot/contracts";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts, controlContainerMappings } from "../src/db/schema.ts";
import { ProvisioningService } from "../src/modules/runtime-provisioning.ts";
import { RuntimeChannelClient } from "../src/runtime/channel-client.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { FakeContainerBackend } from "@shera-bot/test-kit";
import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
} from "../../../apps/user-runtime/src/index.ts";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let backend: FakeContainerBackend;
const channelRecorder = new InMemorySecurityEventRecorder();
const fakeContainers = new Map<
  string,
  { credentials: ChannelCredentialStore; origin: string; server: Server }
>();

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "b1b2c3d4-0000-4000-8000-000000000002";

async function createAccount(id: string, tier: "light" | "balanced" | "heavy" = "balanced") {
  await controlPlane.db
    .insert(controlAccounts)
    .values({ id, name: `User ${id.slice(0, 6)}`, email: `${id.slice(0, 6)}@example.com`, tier })
    .returning();
}

beforeAll(async () => {
  cluster = await startTestCluster("provisioning");

  // One "container" per account: the real user-runtime internal API on
  // loopback, each with its own credential store — the tenancy model. The
  // registration step of provisioning runs over the real channel.
  for (const accountId of [
    A,
    B,
    "c1b2c3d4-0000-4000-8000-000000000003",
    "d1b2c3d4-0000-4000-8000-000000000004",
    "f1b2c3d4-0000-4000-8000-000000000006",
    "9e1b2c3d-0000-4000-8000-000000000007",
    "8f1b2c3d-0000-4000-8000-000000000008",
  ]) {
    const credentials = new ChannelCredentialStore();
    const api = createInternalApi({ credentials, securityEvents: channelRecorder });
    const server = createServer(api.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fakeContainers.set(accountId, {
      credentials,
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      server,
    });
  }

  backend = new FakeContainerBackend({
    endpointFor: (accountId) => fakeContainers.get(accountId)?.origin ?? null,
    deliverCredential: (accountId, digest) => {
      const container = fakeContainers.get(accountId);
      if (!container) throw new Error(`no fake container for ${accountId}`);
      container.credentials.admitDigest(digest);
    },
  });
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
    runtimeBackend: backend,
  });
  await createAccount(A);
  await createAccount(B);
}, 180_000);

afterAll(async () => {
  await controlPlane?.close();
  for (const container of fakeContainers.values()) {
    await new Promise<void>((resolve) => container.server.close(() => resolve()));
  }
  await cluster?.stop();
}, 180_000);

async function mapping(accountId: string) {
  const rows = await controlPlane.db
    .select()
    .from(controlContainerMappings)
    .where(eq(controlContainerMappings.accountId, accountId));
  return rows[0];
}

describe("provisioning lifecycle (idempotent, truthful)", () => {
  it("provisions at first login with the account's Balanced limits applied as real limits", async () => {
    const result = await controlPlane.provisioning.ensureProvisioned(A);

    expect(result.tier).toBe("balanced");
    expect(result.provisioning_status).toBe("running");
    expect(result.resource_summary).toEqual({
      tier: "balanced",
      ...TIER_RESOURCE_LIMITS.balanced,
    });

    // The engine-level spec the backend received carries the same numbers.
    const spec = backend.appliedSpecs.at(-1);
    expect(spec).toBeDefined();
    expect(spec?.account_id).toBe(A);
    expect(spec?.cpu_vcpus).toBe(2);
    expect(spec?.memory_bytes).toBe(4 * 1024 ** 3);
    expect(spec?.storage_bytes).toBe(25 * 1024 ** 3);
  });

  it("records the control-plane mapping with infrastructure identifiers and the credential digest", async () => {
    const row = await mapping(A);
    expect(row).toBeDefined();
    expect(row?.provisioningStatus).toBe("running");
    expect(row?.containerRef).toBe(`shera-rt-${A}`);
    expect(row?.runtimeEndpoint).toContain("http://127.0.0.1:");
    expect(row?.runtimeHandle).toMatch(/^rt_[0-9a-f]{32}$/);
    // The stored credential is the digest (64 hex) — never the raw token.
    expect(row?.internalChannelTokenHash).toMatch(/^[a-f0-9]{64}$/);
    const deliveredDigest = backend.recordFor(A).credential_sha256;
    expect(row?.internalChannelTokenHash).toBe(deliveredDigest);
  });

  it("is idempotent: a repeated provision never creates a second container", async () => {
    const first = await controlPlane.provisioning.ensureProvisioned(A);
    const second = await controlPlane.provisioning.ensureProvisioned(A);
    expect(second.runtime_handle).toBe(first.runtime_handle);
    expect(backend.containersCreated).toBe(1);
  });

  it("restart is idempotent and restart after stop returns to running", async () => {
    const first = await controlPlane.provisioning.restart(A);
    const second = await controlPlane.provisioning.restart(A);
    expect(second.runtime_handle).toBe(first.runtime_handle);
    expect(second.provisioning_status).toBe("running");
    expect(backend.containersCreated).toBe(1);

    await controlPlane.provisioning.stop(A);
    const again = await controlPlane.provisioning.restart(A);
    expect(again.provisioning_status).toBe("running");
  });

  it("stop is idempotent: a repeated stop is a truthful no-op success", async () => {
    await controlPlane.provisioning.restart(A);
    const first = await controlPlane.provisioning.stop(A);
    expect(first.provisioning_status).toBe("stopped");
    const second = await controlPlane.provisioning.stop(A);
    expect(second.provisioning_status).toBe("stopped");
    expect(backend.containersCreated).toBe(1);
    const row = await mapping(A);
    expect(row?.provisioningStatus).toBe("stopped");
  });

  it("getStatus returns truthful state and syncs the control-plane record", async () => {
    await controlPlane.provisioning.restart(A);
    const status = await controlPlane.provisioning.getStatus(A);
    expect(status.provisioning_status).toBe("running");

    // External truth changes (the analogue of an engine-side stop).
    backend.setStopped(A);
    const after = await controlPlane.provisioning.getStatus(A);
    expect(after.provisioning_status).toBe("stopped");
    const row = await mapping(A);
    expect(row?.provisioningStatus).toBe("stopped");
    expect(row?.lastHealthCheckAt).not.toBeNull();
  });
});

describe("failure is surfaced, never faked (G4)", () => {
  it("a failed provision throws the typed error, records 'failed', and logs the security event", async () => {
    const failing = new FakeContainerBackend({ failures: { provision: "engine unavailable" } });
    const failingApp = await createControlPlaneApp({
      databaseUrl: cluster.connectionString,
      env: {},
      runtimeBackend: failing,
    });
    const C = "c1b2c3d4-0000-4000-8000-000000000003";
    await failingApp.db
      .insert(controlAccounts)
      .values({ id: C, name: "User C", email: "c@example.com" })
      .returning();

    await expect(failingApp.provisioning.ensureProvisioned(C)).rejects.toMatchObject({
      name: "RuntimeOperationError",
      sheraError: { code: "RUNTIME_PROVISION_FAILED" },
    });

    const row = await mapping(C);
    expect(row?.provisioningStatus).toBe("failed");
    const events = await failingApp.securityEvents.listByType("runtime_provision_failed");
    expect(events.some((event) => event.accountId === C)).toBe(true);
    await failingApp.close();

    // The retry path: a fresh backend provision succeeds for the same account.
    const result = await controlPlane.provisioning.ensureProvisioned(C);
    expect(result.provisioning_status).toBe("running");
  });

  it("a failed restart throws a typed error and records the operation failure", async () => {
    const D = "d1b2c3d4-0000-4000-8000-000000000004";
    await controlPlane.db
      .insert(controlAccounts)
      .values({ id: D, name: "User D", email: "d@example.com" })
      .returning();
    await controlPlane.provisioning.ensureProvisioned(D);

    backend.injectFailure("resume", "start timed out");
    await expect(controlPlane.provisioning.restart(D)).rejects.toMatchObject({
      sheraError: { code: "RUNTIME_UNAVAILABLE" },
    });
    const events = await controlPlane.securityEvents.listByType("runtime_operation_failed");
    expect(events.some((event) => event.details["operation"] === "restart")).toBe(true);
  });

  it("operations without a mapping surface RUNTIME_NOT_PROVISIONED (no silent auto-create)", async () => {
    const E = "e1b2c3d4-0000-4000-8000-000000000005";
    await controlPlane.db
      .insert(controlAccounts)
      .values({ id: E, name: "User E", email: "e@example.com" })
      .returning();
    await expect(controlPlane.provisioning.restart(E)).rejects.toMatchObject({
      sheraError: { code: "RUNTIME_NOT_PROVISIONED" },
    });
    await expect(controlPlane.provisioning.getStatus(E)).rejects.toMatchObject({
      sheraError: { code: "RUNTIME_NOT_PROVISIONED" },
    });
    await expect(controlPlane.provisioning.stop(E)).rejects.toMatchObject({
      sheraError: { code: "RUNTIME_NOT_PROVISIONED" },
    });
  });
});

describe("tiers and credentials", () => {
  it("applies the account's assigned tier (Heavy maps to the PRD §3.3 Heavy row)", async () => {
    const F = "f1b2c3d4-0000-4000-8000-000000000006";
    await createAccount(F, "heavy");
    const result = await controlPlane.provisioning.ensureProvisioned(F);
    expect(result.tier).toBe("heavy");
    expect(result.resource_summary.memory_bytes).toBe(8 * 1024 ** 3);
    const spec = backend.appliedSpecs.find((entry) => entry.account_id === F);
    expect(spec?.cpu_vcpus).toBe(4);
  });

  it("rotates the channel credential: hash changes, event recorded, raw token never stored", async () => {
    const before = await mapping(A);
    const oldHash = before?.internalChannelTokenHash;
    await controlPlane.provisioning.rotateInternalChannelToken(A);
    const after = await mapping(A);
    expect(after?.internalChannelTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(after?.internalChannelTokenHash).not.toBe(oldHash);
    const events = await controlPlane.securityEvents.listByType("runtime_channel_token_rotated");
    expect(events.some((event) => event.accountId === A)).toBe(true);
  });

  it("records runtime_provisioned as a security event with no credential material", async () => {
    const events = await controlPlane.securityEvents.listByType("runtime_provisioned");
    const ours = events.find((event) => event.accountId === A);
    expect(ours).toBeDefined();
    expect(JSON.stringify(ours)).not.toMatch(new RegExp(backend.channelTokensSeen[0] ?? ".^"));
  });
});

describe("re-provisioning keeps the channel true (adoption invariants I1/I2)", () => {
  it("re-provisioning after stop reuses the in-memory token: same handle, one credential, channel works immediately", async () => {
    const G = "9e1b2c3d-0000-4000-8000-000000000007";
    await createAccount(G);
    const first = await controlPlane.provisioning.ensureProvisioned(G);
    const rowBefore = await mapping(G);
    await controlPlane.provisioning.stop(G);

    const again = await controlPlane.provisioning.ensureProvisioned(G);

    // I1: the same runtime handle — the container was adopted, not recreated.
    expect(again.runtime_handle).toBe(first.runtime_handle);
    const row = await mapping(G);
    expect(row?.runtimeHandle).toBe(first.runtime_handle);
    // The in-memory token was REUSED: two provision calls (create + re-attach)
    // but exactly ONE distinct credential was ever issued.
    const tokens = backend.tokensByAccount.get(G) ?? [];
    expect(tokens.length).toBe(2);
    expect(new Set(tokens).size).toBe(1);
    expect(row?.internalChannelTokenHash).toBe(rowBefore?.internalChannelTokenHash);
    // I2: the channel works immediately with that credential — a replayed
    // registration with the issued token is accepted by the container.
    const container = fakeContainers.get(G);
    const replay = await fetch(`${container?.origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${backend.tokensByAccount.get(G)?.at(-1) ?? ""}`,
      },
      body: JSON.stringify({
        runtime_handle: again.runtime_handle,
        account_id: G,
        tier: "balanced",
      }),
    });
    expect(replay.status).toBe(200);
    // The returned handle resolves truthfully after the re-provision.
    const status = await controlPlane.provisioning.getStatus(G);
    expect(status.runtime_handle).toBe(first.runtime_handle);
    expect(status.provisioning_status).toBe("running");
  });

  it("re-provisioning after token loss (control-plane restart) recreates: new handle, re-established credential and registration", async () => {
    const H = "8f1b2c3d-0000-4000-8000-000000000008";
    await createAccount(H);
    const first = await controlPlane.provisioning.ensureProvisioned(H);
    const rowBefore = await mapping(H);
    await controlPlane.provisioning.stop(H);

    // A fresh service instance models the control-plane restart: it holds no
    // in-memory token, so re-provisioning must recreate the container and
    // re-establish the credential and registration (a REAL recovery, not a
    // report of success over a bricked credential).
    const restarted = new ProvisioningService({
      db: controlPlane.db,
      backend,
      channel: new RuntimeChannelClient(),
      securityEvents: controlPlane.securityEvents,
      registry: controlPlane.registry,
      logger: controlPlane.logger,
    });
    const again = await restarted.ensureProvisioned(H);

    expect(again.runtime_handle).not.toBe(first.runtime_handle);
    const row = await mapping(H);
    expect(row?.runtimeHandle).toBe(again.runtime_handle);
    expect(row?.internalChannelTokenHash).not.toBe(rowBefore?.internalChannelTokenHash);
    // I2: the channel works immediately with the NEW credential — a replayed
    // registration with the newest issued token is accepted.
    const container = fakeContainers.get(H);
    const replay = await fetch(`${container?.origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${backend.tokensByAccount.get(H)?.at(-1) ?? ""}`,
      },
      body: JSON.stringify({
        runtime_handle: again.runtime_handle,
        account_id: H,
        tier: "balanced",
      }),
    });
    expect(replay.status).toBe(200);
    const status = await restarted.getStatus(H);
    expect(status.runtime_handle).toBe(again.runtime_handle);
  });
});

