/**
 * S06 integration test (issue #7, AC6/AC7): provision → status → restart →
 * status, deterministic, with NO cloud dependency and NO container engine.
 *
 * What is real here: the control-plane app (real Express + real PostgreSQL +
 * real migrations), the web-facing runtime routes behind the real session
 * gate, the internal channel (real HTTP + per-container bearer token), and
 * the real user-runtime internal API in two separate "containers" (loopback
 * servers with independent credential stores). What is faked: only the
 * engine lifecycle (FakeContainerBackend from test-kit) — no Docker daemon
 * exists on this host; the real LocalContainerBackend is exercised in
 * Compose (S35).
 *
 * The cross-tenant attempts recorded here are inputs for the dedicated
 * security suite (tests/security, S27). Assertions work over HTTP responses
 * and container-side observables; direct database introspection lives in the
 * apps/control-plane suites (which own the drizzle dependency).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RUNTIME_REGISTRATION_PATH } from "@shera-bot/contracts";

import { FakeContainerBackend } from "../../packages/test-kit/src/index.ts";
import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
} from "../../apps/user-runtime/src/index.ts";
import {
  randomTestSecret,
  startControlPlaneFixture,
  type ControlPlaneFixture,
} from "../../apps/control-plane/test/helpers/test-app.ts";
import {
  startTestCluster,
  type TestCluster,
} from "../../apps/control-plane/test/helpers/pg-cluster.ts";
import {
  CookieJar,
  request,
  runGoogleSignin,
} from "../../apps/control-plane/test/helpers/test-server.ts";
import {
  startMockGoogleIdp,
  type MockIdp,
} from "../../apps/control-plane/test/helpers/mock-google-idp.ts";

let cluster: TestCluster;
let idp: MockIdp;
let fixture: ControlPlaneFixture;
let origin: string;
let backend: FakeContainerBackend;

interface FakeContainer {
  credentials: ChannelCredentialStore;
  recorder: InMemorySecurityEventRecorder;
  server: Server;
  origin: string;
  token: string;
}

const containers = new Map<string, FakeContainer>();
const containerPool: FakeContainer[] = [];
const assigned = new Map<string, FakeContainer>();

async function startFakeContainer(token: string): Promise<FakeContainer> {
  const credentials = new ChannelCredentialStore();
  const recorder = new InMemorySecurityEventRecorder();
  const api = createInternalApi({ credentials, securityEvents: recorder });
  const server = createServer(api.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { credentials, recorder, server, origin: `http://127.0.0.1:${port}`, token };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  cluster = await startTestCluster("runtime-integration");
  idp = await startMockGoogleIdp();

  // Two independent "containers" with independent credentials: cross-tenant
  // token use between them must be impossible.
  const tokenA = randomTestSecret();
  const tokenB = randomTestSecret();
  containers.set("A", await startFakeContainer(tokenA));
  containers.set("B", await startFakeContainer(tokenB));

  // Accounts are created by the OAuth flow, so their UUIDs are not known
  // here; containers are assigned to accounts on first provisioning, in
  // creation order, and stay assigned (one container per user).
  for (const container of containers.values()) containerPool.push(container);
  const containerFor = (account_id: string): FakeContainer | null => {
    const known = assigned.get(account_id);
    if (known) return known;
    const next = containerPool.shift();
    if (!next) return null;
    assigned.set(account_id, next);
    return next;
  };

  backend = new FakeContainerBackend({
    endpointFor: (account_id) => containerFor(account_id)?.origin ?? null,
    deliverCredential: (account_id, digest) => {
      const container = containerFor(account_id);
      if (!container) throw new Error(`no fake container for ${account_id}`);
      container.credentials.admitDigest(digest);
    },
  });

  const port = await freePort();
  fixture = await startControlPlaneFixture({
    databaseUrl: cluster.connectionString,
    port,
    googleIssuer: idp.origin,
    runtimeBackend: backend,
    env: {
      AUTH_SECRET: randomTestSecret(),
      GOOGLE_CLIENT_ID: idp.clientId,
      GOOGLE_CLIENT_SECRET: idp.clientSecret,
      AUTH_URL: `https://127.0.0.1:${port}`,
    },
  });
  origin = fixture.origin;
}, 180_000);

afterAll(async () => {
  await fixture?.stop();
  await idp?.close();
  for (const container of containers.values()) {
    await new Promise<void>((resolve) => container.server.close(() => resolve()));
  }
  await cluster?.stop();
}, 180_000);

async function signIn(sub: string): Promise<CookieJar> {
  idp.setIdentity({
    sub,
    email: `${sub}@example.com`,
    name: `User ${sub}`,
    picture: "https://example.com/avatar.png",
  });
  const jar = new CookieJar();
  await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
  return jar;
}

describe("provision → status → restart → status (deterministic, no cloud dependency)", () => {
  it("runs the full lifecycle over the web-facing routes with the real channel", async () => {
    const jar = await signIn("int-sub-A");

    const provision = await request(origin, "/api/runtime/provision", { method: "POST", jar });
    expect(provision.status).toBe(200);
    const provisioned = JSON.parse(provision.body) as {
      runtime_handle: string;
      account_id: string;
      provisioning_status: string;
    };
    expect(provisioned.provisioning_status).toBe("running");

    // Registration reached the container over the real channel (the
    // credential the control plane presented verifies at container A).
    const containerA = assigned.get(provisioned.account_id);
    expect(containerA).toBeDefined();
    const replay = await fetch(`${containerA?.origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${backend.tokensByAccount.get(provisioned.account_id)?.at(-1) ?? ""}`,
      },
      body: JSON.stringify({
        runtime_handle: provisioned.runtime_handle,
        account_id: provisioned.account_id,
        tier: "balanced",
      }),
    });
    expect(replay.status).toBe(200);

    // Idempotent re-provision: same handle, still exactly one container.
    const reprovision = await request(origin, "/api/runtime/provision", { method: "POST", jar });
    expect(reprovision.status).toBe(200);
    expect((JSON.parse(reprovision.body) as { runtime_handle: string }).runtime_handle).toBe(
      provisioned.runtime_handle,
    );
    expect(backend.containersCreated).toBe(1);

    const status1 = await request(origin, "/api/runtime/status", { method: "GET", jar });
    expect(status1.status).toBe(200);
    expect((JSON.parse(status1.body) as { provisioning_status: string }).provisioning_status).toBe(
      "running",
    );

    const restart = await request(origin, "/api/runtime/restart", { method: "POST", jar });
    expect(restart.status).toBe(200);
    expect((JSON.parse(restart.body) as { provisioning_status: string }).provisioning_status).toBe(
      "running",
    );

    const status2 = await request(origin, "/api/runtime/status", { method: "GET", jar });
    expect(status2.status).toBe(200);
    expect((JSON.parse(status2.body) as { runtime_handle: string }).runtime_handle).toBe(
      provisioned.runtime_handle,
    );
  });

  it("a second user provisions an independent runtime (one container per user)", async () => {
    const jarA = await signIn("int-sub-A");
    const statusA = JSON.parse(
      (await request(origin, "/api/runtime/status", { method: "GET", jar: jarA })).body,
    ) as {
      runtime_handle: string;
    };

    const jarB = await signIn("int-sub-B");
    const provision = await request(origin, "/api/runtime/provision", {
      method: "POST",
      jar: jarB,
    });
    expect(provision.status).toBe(200);
    const body = JSON.parse(provision.body) as { runtime_handle: string };
    expect(body.runtime_handle).not.toBe(statusA.runtime_handle);
    expect(backend.containersCreated).toBe(2);
  });
});

describe("internal channel rejects unauthenticated and cross-tenant access (S27 input)", () => {
  it("a request to a container's internal channel without a credential is rejected and recorded", async () => {
    const anyContainer = [...containers.values()][0];
    if (!anyContainer) throw new Error("no fake container");
    const response = await fetch(`${anyContainer.origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime_handle: "rt_" + "0".repeat(32),
        account_id: "A",
        tier: "balanced",
      }),
    });
    expect(response.status).toBe(401);
    const events = anyContainer.recorder.list("internal_channel_rejected");
    expect(events.at(-1)?.reason).toBe("missing_bearer");
  });

  it("another container's token is rejected on the internal channel (cross-tenant)", async () => {
    const [containerA, containerB] = containers.values();
    if (!containerA || !containerB) throw new Error("fake containers missing");
    const response = await fetch(`${containerA.origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${containerB.token}` },
      body: JSON.stringify({
        runtime_handle: "rt_" + "0".repeat(32),
        account_id: "A",
        tier: "balanced",
      }),
    });
    expect(response.status).toBe(401);
    const events = containerA.recorder.list("internal_channel_rejected");
    expect(events.at(-1)?.reason).toBe("invalid_credential");
    // The rejected credential value is never recorded (G3).
    for (const tokens of backend.tokensByAccount.values()) {
      for (const token of tokens) {
        expect(JSON.stringify(events.at(-1))).not.toContain(token);
      }
    }
  });

  it("user B's context can never reach user A's runtime through the control plane", async () => {
    const jarA = await signIn("int-sub-A");
    const jarB = await signIn("int-sub-B");

    const statusA = JSON.parse(
      (await request(origin, "/api/runtime/status", { method: "GET", jar: jarA })).body,
    ) as {
      runtime_handle: string;
    };
    // B's status is B's own runtime — there is no route parameter that could
    // target another user, and a body carrying A's handle is ignored.
    const statusB = JSON.parse(
      (
        await request(origin, "/api/runtime/status", {
          method: "GET",
          jar: jarB,
          headers: { "x-attempted-target": statusA.runtime_handle },
        })
      ).body,
    ) as { runtime_handle: string };
    expect(statusB.runtime_handle).not.toBe(statusA.runtime_handle);

    const restartB = JSON.parse(
      (
        await request(origin, "/api/runtime/restart", {
          method: "POST",
          jar: jarB,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runtime_handle: statusA.runtime_handle }),
        })
      ).body,
    ) as { runtime_handle: string };
    expect(restartB.runtime_handle).toBe(statusB.runtime_handle);
    expect(restartB.runtime_handle).not.toBe(statusA.runtime_handle);
  });
});

describe("credential rotation over the real channel", () => {
  it("rotates user A's channel credential: the old token dies, the channel keeps working", async () => {
    const containerA = containers.get("A");
    if (!containerA) throw new Error("container A missing");

    // Resolve A's account id through the authenticated session surface (the
    // S02 Session projection: workspace_id = "ws_" + account id).
    const jarA = await signIn("int-sub-A");
    const session = JSON.parse(
      (await request(origin, "/api/session", { method: "GET", jar: jarA })).body,
    ) as {
      workspace_id?: string;
    };
    const accountId = session.workspace_id?.replace(/^ws_/, "");
    if (!accountId) throw new Error("no session workspace id");

    // Rotation: stage the new digest with the current credential, commit with
    // the new one. The raw values never leave the control-plane process.
    await fixture.controlPlane.provisioning.rotateInternalChannelToken(accountId);

    // After commit the container pruned every digest except the new one.
    expect(containerA.credentials.digestCount()).toBe(1);

    // The old token is dead on the container (the one issued at provision).
    const oldToken = backend.tokensByAccount.get(accountId)?.at(0) ?? "";
    const oldRejected = await fetch(`${containerA.origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${oldToken}` },
      body: JSON.stringify({
        runtime_handle: "rt_" + "0".repeat(32),
        account_id: accountId,
        tier: "balanced",
      }),
    });
    expect(oldRejected.status).toBe(401);
    expect(containerA.recorder.list("internal_channel_rejected").at(-1)?.reason).toBe(
      "invalid_credential",
    );

    // The channel still works end to end: the control plane (new credential)
    // can restart the runtime.
    const restart = await request(origin, "/api/runtime/restart", { method: "POST", jar: jarA });
    expect(restart.status).toBe(200);
  });
});
