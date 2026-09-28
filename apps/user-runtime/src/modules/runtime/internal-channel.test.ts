/**
 * S06 internal-channel tests (issue #7; D2, D11, PRD §16).
 *
 * The internal channel is the ONLY way the control plane talks to a user's
 * runtime gateway: per-container bearer token, deterministic credential check
 * before any command (G2, mirroring the gateway/client authentication shape),
 * constant-time comparison, rejections recorded as security events, and the
 * token value never rendered or logged (G3).
 *
 * These tests run the real Express internal API over real HTTP on loopback —
 * the same surface the container exposes on the management network in
 * Compose. No container engine is involved.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RUNTIME_CREDENTIALS_COMMIT_PATH,
  RUNTIME_CREDENTIALS_PATH,
  RUNTIME_REGISTRATION_PATH,
  RuntimeRegistrationResponse,
} from "@shera-bot/contracts";

import {
  ChannelCredentialStore,
  InMemorySecurityEventRecorder,
  createInternalApi,
  type InternalApi,
} from "./internal-api.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function listen(app: InternalApi["app"]): Promise<{ server: Server; origin: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe("ChannelCredentialStore (deterministic credential check, constant-time)", () => {
  it("verifies the provisioned credential and rejects anything else", () => {
    const store = new ChannelCredentialStore();
    store.admit("token-a");
    expect(store.verifies("token-a")).toBe(true);
    expect(store.verifies("token-b")).toBe(false);
    expect(store.verifies("")).toBe(false);
  });

  it("keeps only digests — the raw credential is never retained or exposed", () => {
    const store = new ChannelCredentialStore();
    store.admit("token-a");
    const dumped = JSON.stringify(store);
    expect(dumped).not.toContain("token-a");
    expect(store.digestCount()).toBe(1);
  });

  it("stages a rotation digest without dropping the current credential (overlap window)", () => {
    const store = new ChannelCredentialStore();
    store.admit("token-old");
    store.stage(sha256("token-new"));
    expect(store.verifies("token-old")).toBe(true);
    expect(store.verifies("token-new")).toBe(true);
  });

  it("commit prunes every digest except the presented (new) one", () => {
    const store = new ChannelCredentialStore();
    store.admit("token-old");
    store.stage(sha256("token-new"));
    store.commitTo(store.digestOf("token-new"));
    expect(store.verifies("token-new")).toBe(true);
    expect(store.verifies("token-old")).toBe(false);
  });

  it("refuses to stage beyond the two-digest rotation bound (fail closed)", () => {
    const store = new ChannelCredentialStore();
    store.admit("token-old");
    store.stage(sha256("token-new"));
    expect(() => store.stage(sha256("token-third"))).toThrow(/rotation bound/i);
  });
});

describe("runtime internal API (authenticated internal channel)", () => {
  let api: InternalApi;
  let server: Server;
  let origin: string;
  const token = "s06-channel-token-0123456789abcdef";
  const recorder = new InMemorySecurityEventRecorder();

  beforeAll(async () => {
    const credentials = new ChannelCredentialStore();
    credentials.admit(token);
    api = createInternalApi({ credentials, securityEvents: recorder });
    const listener = await listen(api.app);
    server = listener.server;
    origin = listener.origin;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function post(
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    }));
  }

  function put(path: string, body: unknown, bearer?: string) {
    return fetch(`${origin}${path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    }));
  }

  const registrationBody = {
    runtime_handle: "rt_" + "a1b2c3d4e5f60718293a4b5c6d7e8f9a",
    account_id: "a1b2c3d4-0000-4000-8000-000000000001",
    tier: "balanced",
    correlation_id: "corr_register_001",
  };

  it("rejects a request without any credential with the typed 401 and records the security event", async () => {
    const response = await post(RUNTIME_REGISTRATION_PATH, registrationBody);
    expect(response.status).toBe(401);
    expect(response.body["code"]).toBe("INTERNAL_CHANNEL_UNAUTHORIZED");
    expect(response.body["internal_details"]).toBeNull();
    // The rejection is recorded as a security event (PRD §16) with no
    // credential material anywhere in the record.
    const events = recorder.list("internal_channel_rejected");
    const latest = events.at(-1);
    expect(latest).toBeDefined();
    expect(JSON.stringify(latest)).not.toContain(token);
  });

  it("rejects an invalid credential (another container's token) and records the event", async () => {
    const response = await post(
      RUNTIME_REGISTRATION_PATH,
      registrationBody,
      "some-other-containers-token",
    );
    expect(response.status).toBe(401);
    expect(response.body["code"]).toBe("INTERNAL_CHANNEL_UNAUTHORIZED");
    const events = recorder.list("internal_channel_rejected");
    expect(events.at(-1)).toBeDefined();
    expect(JSON.stringify(events.at(-1))).not.toContain(token);
  });

  it("rejects a malformed bearer header without processing the command", async () => {
    const response = await fetch(`${origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${token}` },
      body: JSON.stringify(registrationBody),
    });
    expect(response.status).toBe(401);
  });

  it("registers the runtime binding with a valid credential and answers the typed response", async () => {
    const response = await post(RUNTIME_REGISTRATION_PATH, registrationBody, token);
    expect(response.status).toBe(200);
    const parsed = RuntimeRegistrationResponse.parse(response.body);
    expect(parsed.registered).toBe(true);
    expect(parsed.runtime_handle).toBe(registrationBody.runtime_handle);
  });

  it("is idempotent: re-registration for the same account updates the same binding", async () => {
    const first = await post(RUNTIME_REGISTRATION_PATH, registrationBody, token);
    const second = await post(RUNTIME_REGISTRATION_PATH, registrationBody, token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const registrations = api.registrations.list();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.account_id).toBe(registrationBody.account_id);
  });

  it("rejects an unknown body field (D25 strictness on the internal channel)", async () => {
    const response = await post(
      RUNTIME_REGISTRATION_PATH,
      { ...registrationBody, extra: 1 },
      token,
    );
    expect(response.status).toBe(400);
  });

  it("serves the internal health probe behind the same credential check", async () => {
    const denied = await fetch(`${origin}/internal/v1/health`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`${origin}/internal/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  it("performs the documented rotation: stage with current credential, commit with the new one", async () => {
    const newToken = "s06-channel-token-rotated-0fedcba987654321";
    const staged = await put(
      RUNTIME_CREDENTIALS_PATH,
      { credential_sha256: sha256(newToken) },
      token,
    );
    expect(staged.status).toBe(200);
    expect(staged.body).toEqual({ staged: true });

    // Overlap window: both credentials verify while the commit is pending.
    const duringOverlap = await post(RUNTIME_REGISTRATION_PATH, registrationBody, token);
    expect(duringOverlap.status).toBe(200);

    const commit = await post(RUNTIME_CREDENTIALS_COMMIT_PATH, {}, newToken);
    expect(commit.status).toBe(200);
    expect(commit.body).toEqual({ committed: true });

    // The old credential is dead after commit; the new one owns the channel.
    const oldDenied = await post(RUNTIME_REGISTRATION_PATH, registrationBody, token);
    expect(oldDenied.status).toBe(401);
    const newAccepted = await post(RUNTIME_REGISTRATION_PATH, registrationBody, newToken);
    expect(newAccepted.status).toBe(200);
  });

  it("answers unknown routes with the typed 404, never an HTML page (typed error middleware)", async () => {
    const response = await fetch(`${origin}/internal/v1/no-such-route`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("ROUTE_NOT_FOUND");
    expect(body["internal_details"]).toBeNull();
    expect(typeof body["correlation_id"]).toBe("string");
  });

  it("maps an invalid JSON body to the typed 400 validation failure (typed error middleware)", async () => {
    const response = await fetch(`${origin}${RUNTIME_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json at all",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("CONTRACT_VALIDATION_FAILED");
    expect(body["internal_details"]).toBeNull();
    // The parser's own message never crosses the wire (G3).
    expect(JSON.stringify(body)).not.toContain("not json at all");
  });
});
