/**
 * S23 chunk 3 provider adapter + connection-test tests (PRD §9, AC10, D17,
 * G4, G7): the provider-neutral adapter seam resolves an AI SDK LanguageModel
 * for every recorded protocol, and the connection test makes ONE real,
 * minimal request and reports honest success/failure with a REDACTED
 * safe_message — no unconditional success path exists.
 *
 * The HTTP fixture is a LOCAL fake OpenAI-compatible endpoint (no live
 * provider is ever called — G7). It deliberately fails on purpose for the
 * configuration-error paths: a wrong key answers 401, and an unreachable
 * endpoint refuses the connection. The native adapters (openai, anthropic,
 * google) are exercised at the construction + request-shaping layer; their
 * live calls are the documented opt-in-only suite (G7).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProviderRow } from "../../adapters/sqlite/providers-repository.ts";
import { ProviderAdapters, ProviderConfigurationError } from "./provider-adapters.ts";
import { runConnectionTest, type ConnectionTestResult } from "./connection-test.ts";

const FIXTURE_KEY = "sk-fixture-0123456789abcdefSECRET";
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${FIXTURE_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Invalid key ${FIXTURE_KEY} presented`, type: "auth" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion",
          created: 0,
          model: "fixture-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function entry(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "prov_0001",
    workspace_id: "ws-local-default",
    display_name: "Fixture",
    protocol: "openai-compatible",
    base_url: baseUrl,
    api_mode: "api_key",
    default_model_id: "fixture-model",
    organization: null,
    project: null,
    headers_json: "{}",
    request_params_json: "{}",
    origin: "user",
    status: "enabled",
    created_at: "2026-10-30T12:00:00.000Z",
    updated_at: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("provider adapters (the provider-neutral seam)", () => {
  it("resolves a language model for every recorded protocol", () => {
    for (const protocol of [
      "openai",
      "anthropic",
      "google",
      "ollama",
      "openai-compatible",
    ] as const) {
      const model = ProviderAdapters.resolveLanguageModel(
        entry({
          protocol,
          // Native adapters take no base URL; the compatible ones point at
          // the local fixture.
          base_url:
            protocol === "openai" || protocol === "anthropic" || protocol === "google"
              ? null
              : baseUrl,
        }),
        FIXTURE_KEY,
        "some-model",
      );
      expect(typeof model).toBe("object");
    }
  });

  it("refuses an api_key entry without a credential and a native entry with a foreign base_url", () => {
    expect(() => ProviderAdapters.resolveLanguageModel(entry(), null, "m")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_REVOKED" }),
    );
    // A native adapter (openai) has no configurable base URL in the prototype
    // registry — a stored base_url would silently reroute a platform key to
    // an attacker-chosen host, so it is a typed configuration error.
    expect(() =>
      ProviderAdapters.resolveLanguageModel(
        entry({ protocol: "openai", base_url: "https://proxy.example.invalid/v1" }),
        FIXTURE_KEY,
        "m",
      ),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
  });

  it("rejects credential-shaped custom headers before any request is built (G3)", () => {
    expect(() =>
      ProviderAdapters.customHeaders({
        headers_json: JSON.stringify({ Authorization: "Bearer leaked" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_HEADER_CREDENTIAL_REJECTED" }));
    expect(() =>
      ProviderAdapters.customHeaders({
        headers_json: JSON.stringify({ "X-Route": "a", "X-Api-Key": "leaked" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_HEADER_CREDENTIAL_REJECTED" }));
    expect(() =>
      ProviderAdapters.customHeaders({
        headers_json: JSON.stringify({ cookie: "session=leaked" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_HEADER_CREDENTIAL_REJECTED" }));
    expect(
      ProviderAdapters.customHeaders({
        headers_json: JSON.stringify({ "X-Routing": "team-a" }),
      }),
    ).toEqual({ "X-Routing": "team-a" });
  });

  it("applies stored request params to the generate call", () => {
    const params = ProviderAdapters.requestParams(
      entry({ request_params_json: '{"temperature":0.2,"maxOutputTokens":64}' }),
    );
    expect(params).toEqual({ temperature: 0.2, maxOutputTokens: 64 });
  });
});

describe("connection test (one real minimal request, honest and redacted)", () => {
  it("reports success against a working endpoint with the right key", async () => {
    const result: ConnectionTestResult = await runConnectionTest(entry(), FIXTURE_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checked_model).toBe("fixture-model");
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports an honest, redacted failure for a wrong key", async () => {
    const result = await runConnectionTest(entry(), "sk-wrong-key-not-the-fixture");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_CONNECTION_TEST_AUTH_FAILED");
      // The fixture's 401 body deliberately ECHOES the presented key; the
      // redaction must never surface it (G3).
      expect(result.safe_message).not.toContain("sk-wrong-key-not-the-fixture");
      expect(result.safe_message).not.toContain(FIXTURE_KEY);
      expect(result.http_status).toBe(401);
    }
  });

  it("reports an honest failure for an unreachable base URL", async () => {
    const result = await runConnectionTest(
      entry({ base_url: "http://127.0.0.1:9/v1" }),
      FIXTURE_KEY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_CONNECTION_TEST_UNREACHABLE");
      expect(result.safe_message).not.toContain(FIXTURE_KEY);
    }
  });

  it("refuses to test a no-key entry against a key-requiring path without a call shape lie", async () => {
    // no_key mode still makes a REAL request (local endpoints like Ollama need
    // no Authorization header) — the request simply carries no credential.
    const result = await runConnectionTest(entry({ api_mode: "no_key" }), null);
    // The fixture requires a Bearer key, so the honest answer is a 401.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_CONNECTION_TEST_AUTH_FAILED");
    }
  });

  it("never reports success without a completed request (no unconditional success path)", async () => {
    const unreachable = await runConnectionTest(
      entry({ base_url: "http://127.0.0.1:9/v1" }),
      FIXTURE_KEY,
    );
    expect(unreachable.ok).toBe(false);
  });
});

describe("adapter construction rejections (typed, before any call)", () => {
  it("refuses an openai-compatible entry without a base URL", () => {
    expect(() =>
      ProviderAdapters.resolveLanguageModel(
        entry({ protocol: "openai-compatible", base_url: null }),
        FIXTURE_KEY,
        "m",
      ),
    ).toThrowError(ProviderConfigurationError);
  });
});
