/**
 * Provider connection test (S23 chunk 3; PRD §9 custom-provider field list,
 * AC10, UI_DESIGN S9's "must not always succeed" rule, D17, G3, G4, G7).
 *
 * The test makes ONE real, minimal request (a tiny generate call) through the
 * SAME adapter seam the runtime calls use — so it exercises the full path:
 * endpoint reachability, authentication, and the model id. The answer is
 * honest: success only when a completion actually came back; every failure
 * maps to a TYPED code with a REDACTED safe_message (never the key, never
 * response bodies, never header dumps — G3). There is deliberately NO
 * unconditional success path (pinned by tests + grep).
 *
 * G7: default CI runs this against LOCAL fake endpoints only (they fail on
 * purpose for the configuration-error paths). Live-provider checks against
 * real endpoints are a separately documented, opt-in-only suite.
 */
import { APICallError, generateText } from "ai";

import type { ProviderRow } from "../../adapters/sqlite/providers-repository.ts";
import { ProviderAdapters } from "./provider-adapters.ts";

export type ConnectionTestResult =
  | {
      ok: true;
      checked_model: string;
      latency_ms: number;
    }
  | {
      ok: false;
      code:
        | "PROVIDER_CONNECTION_TEST_UNREACHABLE"
        | "PROVIDER_CONNECTION_TEST_AUTH_FAILED"
        | "PROVIDER_CONNECTION_TEST_NOT_FOUND"
        | "PROVIDER_CONNECTION_TEST_FAILED"
        | "PROVIDER_CONFIG_INVALID"
        | "PROVIDER_CREDENTIAL_REVOKED";
      /** Redacted, display-safe reason (G3) — the ONLY text a UI renders. */
      safe_message: string;
      http_status: number | null;
    };

/** The minimal test prompt: bounded, deterministic, no user content. */
const TEST_PROMPT = "Reply with the single word: ok.";
const TEST_MAX_OUTPUT_TOKENS = 16;
const TEST_TIMEOUT_MS = 15_000;

/** Map one AI SDK APICallError to a typed, redacted result (G3). */
function fromApiCallError(error: APICallError): ConnectionTestResult {
  const status = error.statusCode ?? null;
  // The URL's HOST is display-safe (it is the configured endpoint, not a
  // secret); strip userinfo and any query so nothing credential-adjacent can
  // survive (G3).
  // The URL's HOST is display-safe (it is the configured endpoint, not a
  // secret); strip userinfo and any query so nothing credential-adjacent can
  // survive (G3).
  let host: string | null = null;
  try {
    host = `${new URL(error.url).protocol}//${new URL(error.url).host}`;
  } catch {
    // An unparseable URL contributes no endpoint display text.
  }
  const endpointSuffix = host ? ` Endpoint: ${host}.` : "";
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_AUTH_FAILED",
      safe_message: `The provider rejected the credential (HTTP ${status}). Revoke and replace the key, then test again.${endpointSuffix}`,
      http_status: status,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_NOT_FOUND",
      safe_message: `The endpoint or model was not found (HTTP 404). Check the base URL and model id.${endpointSuffix}`,
      http_status: status,
    };
  }
  if (status !== null && status >= 500) {
    return {
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_FAILED",
      safe_message: `The provider endpoint failed server-side (HTTP ${status}).${endpointSuffix}`,
      http_status: status,
    };
  }
  // A statusless APICallError is a transport-level failure (the AI SDK's
  // "Cannot connect to API" family, wrapped by its retry layer) — the
  // endpoint never answered with HTTP.
  return {
    ok: false,
    code: "PROVIDER_CONNECTION_TEST_UNREACHABLE",
    safe_message:
      "The provider endpoint could not be reached. Check the base URL and that the service is running.",
    http_status: null,
  };
}

/** The node/undici network failure codes that mean "could not connect". */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Walk one error (plus the AI SDK's retry/cause nesting: RetryError →
 * lastError → cause) and classify it honestly. The response body is NEVER
 * surfaced — it can echo keys, headers, or provider internals (G3).
 */
function classifyError(error: unknown): ConnectionTestResult {
  // Collect the nested error chain (bounded).
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    chain.push(current);
    const next =
      (current as { lastError?: unknown }).lastError ?? (current as { cause?: unknown }).cause;
    current = next ?? undefined;
  }
  const apiErrors = chain.filter((item): item is APICallError => APICallError.isInstance(item));
  const withStatus = apiErrors.find((item) => typeof item.statusCode === "number");
  if (withStatus) {
    return fromApiCallError(withStatus);
  }
  const codes = chain
    .flatMap((item) => [
      (item as { cause?: { code?: string } })?.cause?.code,
      (item as { code?: string }).code,
    ])
    .filter((code): code is string => typeof code === "string");
  if (codes.some((code) => NETWORK_CODES.has(code))) {
    return {
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_UNREACHABLE",
      safe_message:
        "The provider endpoint could not be reached. Check the base URL and that the service is running.",
      http_status: null,
    };
  }
  if (chain.some((item) => (item as { name?: string })?.name === "AbortError")) {
    return {
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_FAILED",
      safe_message: "The connection test did not finish within its time window.",
      http_status: null,
    };
  }
  // A statusless APICallError with no network code is still a
  // transport-level failure (the AI SDK's "Cannot connect to API" family).
  if (apiErrors.length > 0) {
    return {
      ok: false,
      code: "PROVIDER_CONNECTION_TEST_UNREACHABLE",
      safe_message:
        "The provider endpoint could not be reached. Check the base URL and that the service is running.",
      http_status: null,
    };
  }
  return {
    ok: false,
    code: "PROVIDER_CONNECTION_TEST_FAILED",
    safe_message: "The connection test failed before a response arrived.",
    http_status: null,
  };
}

/**
 * Run the connection test for one provider entry with ONE call-time
 * credential (null = no-key mode). Success requires a completed request AND
 * a response the adapter accepted.
 */
export async function runConnectionTest(
  entry: ProviderRow,
  credential: string | null,
): Promise<ConnectionTestResult> {
  const modelId = entry.default_model_id;
  let model: ReturnType<typeof ProviderAdapters.resolveLanguageModel>;
  try {
    model = ProviderAdapters.resolveLanguageModel(entry, credential, modelId);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "PROVIDER_CREDENTIAL_REVOKED") {
      return {
        ok: false,
        code: "PROVIDER_CREDENTIAL_REVOKED",
        safe_message: "No stored credential for this provider. Add a key, then test again.",
        http_status: null,
      };
    }
    return {
      ok: false,
      code: "PROVIDER_CONFIG_INVALID",
      safe_message: "The provider configuration is not valid. Check the fields and save again.",
      http_status: null,
    };
  }

  const started = Date.now();
  try {
    await generateText({
      model,
      prompt: TEST_PROMPT,
      maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      // The test is ONE real minimal request (E34): the AI SDK's default
      // retry/backoff would silently turn it into three and stretch an
      // unreachable endpoint's honest failure past any useful budget.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      ...ProviderAdapters.requestParams(entry),
    });
    return { ok: true, checked_model: modelId, latency_ms: Date.now() - started };
  } catch (error) {
    return classifyError(error);
  }
}
