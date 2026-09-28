/**
 * S06 response-scanning tests (issue #7, AC3/AC4).
 *
 * Asserts — by test, not inspection — that NO web-facing response contains a
 * container ID, host path, internal port, internal endpoint, engine image, or
 * the internal channel token. The scan walks every route the web client can
 * reach (authenticated and unauthenticated, success and typed-failure and
 * 404 paths) and additionally proves that the token never reaches the server
 * log (G3), even though the provisioning flow handled it end to end.
 *
 * The backend is the deterministic fake wired to a real user-runtime internal
 * API over real loopback HTTP, so the flow is real; only the engine is faked
 * (no engine exists on this host — verified for real in Compose, S35).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProvisionRuntimeResult, RuntimeStatus } from "@shera-bot/contracts";

import { FakeContainerBackend } from "@shera-bot/test-kit";

import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
} from "../../../apps/user-runtime/src/index.ts";
import {
  randomTestSecret,
  startControlPlaneFixture,
  type ControlPlaneFixture,
} from "./helpers/test-app.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { CookieJar, request, runGoogleSignin } from "./helpers/test-server.ts";
import { startMockGoogleIdp, type MockIdp } from "./helpers/mock-google-idp.ts";

let cluster: TestCluster;
let idp: MockIdp;
let fixture: ControlPlaneFixture;
let origin: string;
let runtimeServer: Server;
let backend: FakeContainerBackend;
const recorder = new InMemorySecurityEventRecorder();
const logLines: string[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  cluster = await startTestCluster("response-scanning");
  idp = await startMockGoogleIdp();

  // The "container": a real user-runtime internal API on loopback, seeded
  // with the credential digest the backend delivers at provisioning.
  const credentials = new ChannelCredentialStore();
  const api = createInternalApi({ credentials, securityEvents: recorder });
  runtimeServer = createServer(api.app);
  await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
  const runtimePort = (runtimeServer.address() as AddressInfo).port;

  backend = new FakeContainerBackend({
    endpointFor: () => `http://127.0.0.1:${runtimePort}`,
    deliverCredential: (_accountId, digest) => credentials.admitDigest(digest),
  });

  const port = await freePort();
  fixture = await startControlPlaneFixture({
    databaseUrl: cluster.connectionString,
    port,
    googleIssuer: idp.origin,
    logSink: (line) => logLines.push(line),
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
  await new Promise<void>((resolve) => runtimeServer?.close(() => resolve()));
  await cluster?.stop();
}, 180_000);

/** Sign in through the mock IdP and return the authenticated cookie jar. */
async function session(sub: string): Promise<CookieJar> {
  idp.setIdentity({
    sub,
    email: `${sub}@example.com`,
    name: "Scan User",
    picture: "https://example.com/avatar.png",
  });
  const jar = new CookieJar();
  await runGoogleSignin({ origin, idpOrigin: idp.origin, jar });
  return jar;
}

describe("no infrastructure identifier or credential ever reaches a web-facing response", () => {
  it("walks every reachable route with an authenticated session and scans body + headers", async () => {
    const jar = await session("scan-sub-001");

    // Provision through the web-facing route (real channel registration).
    const provision = await request(origin, "/api/runtime/provision", { method: "POST", jar });
    expect(provision.status).toBe(200);
    const provisionBody = ProvisionRuntimeResult.parse(JSON.parse(provision.body));

    const runtimePort = (runtimeServer.address() as AddressInfo).port;
    const internal = backend.recordFor(provisionBody.account_id);
    const markers: Array<[string, string]> = [
      ["raw channel token", backend.channelTokensSeen[0] ?? ""],
      ["container id", internal.container_id],
      ["container ref", internal.container_ref],
      ["internal endpoint", internal.internal_endpoint ?? ""],
      ["internal port as url suffix", `:${runtimePort}`],
      ["engine image name", "shera-user-runtime"],
      ["engine socket path", "/var/run/"],
    ];
    for (const [label, value] of markers) {
      expect(
        value.length > 3,
        `marker "${label}" must be non-empty so the scan cannot pass vacuously`,
      ).toBe(true);
    }

    const routes: Array<[string, string]> = [
      ["GET", "/healthz"],
      ["GET", "/api/session"],
      ["GET", "/api/runtime/status"],
      ["POST", "/api/runtime/provision"],
      ["POST", "/api/runtime/restart"],
      ["POST", "/api/runtime/stop"],
      ["GET", "/auth/error?error=AccessDenied"],
      ["GET", "/auth/error"],
      ["GET", "/definitely/not/here"],
      ["GET", "/api/unknown-route"],
    ];
    for (const [method, path] of routes) {
      const response = await request(origin, path, { method, jar });
      const scanned = response.body + JSON.stringify(Object.fromEntries(response.headers));
      for (const [label, value] of markers) {
        expect(scanned.includes(value), `${method} ${path} leaked the ${label}`).toBe(false);
      }
    }

    // The provisioning payload carries exactly the contract shape (strict
    // parse fails on any extra field), and status is equally strict.
    expect(provisionBody.provisioning_status).toBe("running");
    const status = await request(origin, "/api/runtime/status", { method: "GET", jar });
    expect(status.status).toBe(200);
    const parsed = RuntimeStatus.parse(JSON.parse(status.body));
    expect(parsed.runtime_handle).toBe(provisionBody.runtime_handle);
  });

  it("unauthenticated responses (typed 401s) leak nothing either", async () => {
    for (const path of ["/api/runtime/status", "/api/session"]) {
      const response = await request(origin, path);
      expect(response.status).toBe(401);
      for (const token of backend.channelTokensSeen) {
        expect(response.body.includes(token), `${path} leaked the channel token`).toBe(false);
      }
      expect(response.body).not.toContain("shera-rt-");
    }
  });

  it("the internal channel token never reaches the server log (G3)", async () => {
    for (const token of backend.channelTokensSeen) {
      for (const line of logLines) {
        expect(line.includes(token), "raw token found in a log line").toBe(false);
      }
    }
    // Sanity: the sink actually captured the provisioning flow.
    expect(logLines.some((line) => line.includes("control-plane"))).toBe(true);
  });

  it("rejected internal-channel requests are recorded without credential material", () => {
    for (const event of recorder.list("internal_channel_rejected")) {
      for (const token of backend.channelTokensSeen) {
        expect(JSON.stringify(event)).not.toContain(token);
      }
    }
  });
});
