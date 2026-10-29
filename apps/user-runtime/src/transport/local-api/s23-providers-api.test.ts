/**
 * S23 chunk 7 — the provider HTTP surface (PRD §9, AC10, D22, E9, E12, G3):
 * the masked list, the custom-provider configure (the credential accepted
 * ONCE in the request and never returned), credential revoke/replace,
 * enable/disable, the connection test, the per-conversation override, the
 * effective readout (the chat header's data source), and the PLATFORM
 * provisioning route (admin-funded, write-only — never displayed back).
 *
 * The connection test in CI runs against LOCAL fake endpoints only (G7): the
 * fixture here uses a dead loopback port — the honest unreachable failure.
 * Live-provider checks are the separately documented opt-in suite.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const WORKSPACE = DEFAULT_WORKSPACE_ID;

afterEach(async () => {
  await cleanupTempResources();
});

interface Running {
  origin: string;
  providers: ReturnType<Awaited<ReturnType<typeof compose>>["providers"]>;
  close(): Promise<void>;
}

const composed: Array<{ close(): void | Promise<void> }> = [];

async function compose(): Promise<
  RuntimeShape & { origin: string; close(): Promise<void> }
> {
  const runtime = composeRuntime({
    dbPath: join(makeTempDir("shera-s23-api-"), "runtime.db"),
    packsRoot: PACKS_ROOT,
    providerEnforcement: true,
  });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  composed.push(runtime);
  return Object.assign(runtime, {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  });
}

type RuntimeShape = Awaited<ReturnType<typeof composeRuntimeFactory>>;
function composeRuntimeFactory(): never {
  throw new Error("type helper only");
}

afterAll(async () => {
  for (const runtime of composed.splice(0).reverse()) {
    await runtime.close();
  }
});

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function putJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const VALID_BODY = {
  workspace_id: WORKSPACE,
  display_name: "Compatible endpoint",
  protocol: "openai-compatible",
  base_url: "https://proxy.example.invalid/v1",
  api_mode: "api_key",
  credential: "sk-fixture-0123456789abcdefSECRET",
  default_model_id: "proxy-model",
  organization: null,
  project: null,
  headers: { "X-Routing": "team-a" },
  request_params: { temperature: 0.2 },
};

describe("the provider HTTP surface (masked everywhere, G3)", () => {
  it("configures a custom provider through POST and answers the masked list", async () => {
    const runtime = await compose();
    const created = await postJson(runtime.origin, "/v1/providers", VALID_BODY);
    expect(created.status).toBe(201);
    const view = created.body as Record<string, unknown>;
    expect(view["protocol"]).toBe("openai-compatible");
    expect(view["credential_hint"]).toBe("••••CRET");
    expect(JSON.stringify(view)).not.toContain("sk-fixture-0123456789abcdefSECRET");
    // The masked list agrees.
    const list = await getJson(runtime.origin, `/v1/providers?workspace_id=${WORKSPACE}`);
    expect(list.status).toBe(200);
    const providers = list.body["providers"] as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(JSON.stringify(providers)).not.toContain("sk-fixture-0123456789abcdefSECRET");
  });

  it("rejects invalid configuration with typed errors before any call", async () => {
    const runtime = await compose();
    const bad = await postJson(runtime.origin, "/v1/providers", {
      ...VALID_BODY,
      display_name: "",
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });
    const secretHeader = await postJson(runtime.origin, "/v1/providers", {
      ...VALID_BODY,
      headers: { Authorization: "Bearer leaked" },
    });
    expect(secretHeader.status).toBe(400);
    expect(secretHeader.body).toMatchObject({ code: "PROVIDER_HEADER_CREDENTIAL_REJECTED" });
    const keyless = await postJson(runtime.origin, "/v1/providers", {
      ...VALID_BODY,
      credential: null,
    });
    expect(keyless.status).toBe(400);
  });

  it("replaces and revokes the credential through the typed routes", async () => {
    const runtime = await compose();
    const created = (await postJson(runtime.origin, "/v1/providers", VALID_BODY))
      .body as Record<string, unknown>;
    const providerId = created["id"] as string;
    const replaced = await postJson(runtime.origin, `/v1/providers/${providerId}/credential`, {
      workspace_id: WORKSPACE,
      credential: "sk-replacement-0123456789abcdefNEW",
    });
    expect(replaced.status).toBe(200);
    expect((replaced.body as Record<string, unknown>)["credential_hint"]).toBe("••••eNEW");
    const revoked = await postJson(runtime.origin, `/v1/providers/${providerId}/revoke`, {
      workspace_id: WORKSPACE,
    });
    expect(revoked.status).toBe(200);
    expect((revoked.body as Record<string, unknown>)["credential_hint"]).toBeNull();
    const disabled = await postJson(runtime.origin, `/v1/providers/${providerId}/status`, {
      workspace_id: WORKSPACE,
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect((disabled.body as Record<string, unknown>)["status"]).toBe("disabled");
  });

  it("runs the connection test and answers the honest unreachable failure", async () => {
    const runtime = await compose();
    const created = await postJson(runtime.origin, "/v1/providers", {
      ...VALID_BODY,
      base_url: "http://127.0.0.1:9/v1",
    });
    const providerId = (created.body as Record<string, unknown>)["id"] as string;
    const test = await postJson(runtime.origin, `/v1/providers/${providerId}/test`, {
      workspace_id: WORKSPACE,
    });
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_UNREACHABLE",
    });
    expect(JSON.stringify(test.body)).not.toContain("sk-fixture-0123456789abcdefSECRET");
  });

  it("sets and clears the per-conversation override and answers the effective readout", async () => {
    const runtime = await compose();
    const created = await postJson(runtime.origin, "/v1/providers", VALID_BODY);
    const providerId = (created.body as Record<string, unknown>)["id"] as string;
    const conversation = await postJson(runtime.origin, "/v1/conversations/commands", {
      workspace_id: WORKSPACE,
      idempotency_key: `idem_${Math.random().toString(36).slice(2)}`,
      type: "conversation.create",
      payload: { title: "Override fixture" },
    });
    const conversationId = (conversation.body as Record<string, unknown>)[
      "conversation_id"
    ] as string;
    const unconfigured = await getJson(
      runtime.origin,
      `/v1/providers/effective?workspace_id=${WORKSPACE}&conversation_id=${conversationId}`,
    );
    expect(unconfigured.body).toMatchObject({ configured: false });
    const set = await postJson(runtime.origin, "/v1/providers/overrides", {
      workspace_id: WORKSPACE,
      conversation_id: conversationId,
      provider_id: providerId,
      model: "proxy-model-override",
    });
    expect(set.status).toBe(200);
    const effective = await getJson(
      runtime.origin,
      `/v1/providers/effective?workspace_id=${WORKSPACE}&conversation_id=${conversationId}`,
    );
    expect(effective.body).toMatchObject({
      configured: true,
      provider_id: providerId,
      model: "proxy-model-override",
      source: "conversation_override",
    });
    const cleared = await postJson(runtime.origin, "/v1/providers/overrides", {
      workspace_id: WORKSPACE,
      conversation_id: conversationId,
      provider_id: null,
      model: null,
    });
    expect(cleared.status).toBe(200);
    const afterClear = await getJson(
      runtime.origin,
      `/v1/providers/effective?workspace_id=${WORKSPACE}&conversation_id=${conversationId}`,
    );
    expect(afterClear.body).toMatchObject({ configured: false });
  });

  it("provisions the platform provider write-only (E9): origin=platform, never read back", async () => {
    const runtime = await compose();
    const provisioned = await putJson(runtime.origin, "/v1/providers/platform", {
      workspace_id: WORKSPACE,
      provider_id: "prov_platform_default",
      display_name: "Platform default provider",
      protocol: "openai",
      api_mode: "api_key",
      credential: "sk-platform-0123456789abcdefADMIN",
      default_model_id: "gpt-4o-mini",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
    });
    expect(provisioned.status).toBe(201);
    expect(provisioned.body).toMatchObject({ origin: "platform" });
    expect(JSON.stringify(provisioned.body)).not.toContain("sk-platform-0123456789abcdefADMIN");
    // Top-up replaces the credential, still write-only.
    const topped = await putJson(runtime.origin, "/v1/providers/platform", {
      workspace_id: WORKSPACE,
      provider_id: "prov_platform_default",
      display_name: "Platform default provider",
      protocol: "openai",
      api_mode: "api_key",
      credential: "sk-platform-0123456789abcdefNEXT",
      default_model_id: "gpt-4o-mini",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
    });
    expect(topped.status).toBe(200);
    expect(JSON.stringify(topped.body)).not.toContain("sk-platform-0123456789abcdefNEXT");
    const list = JSON.stringify(
      (await getJson(runtime.origin, `/v1/providers?workspace_id=${WORKSPACE}`)).body,
    );
    expect(list).not.toContain("sk-platform-0123456789abcdefADMIN");
    expect(list).not.toContain("sk-platform-0123456789abcdefNEXT");
  });
});
