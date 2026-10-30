/**
 * Provider adapters (S23 chunk 3; PRD §9, AC10, D17, G2/G3/G4) — the
 * provider-neutral seam over the embedded Vercel AI SDK (E15: permissively
 * licensed, Apache-2.0, exact-pinned).
 *
 * EVERY protocol resolves to the same AI SDK `LanguageModelV4` shape, so the
 * runtime consumes one interface regardless of the provider behind it:
 *
 *   - openai / anthropic / google   → the native AI SDK provider factories
 *     (their endpoints are the protocols' own; a stored base_url for a native
 *     adapter is a typed configuration error — the prototype registry never
 *     reroutes a platform key to a caller-chosen host);
 *   - ollama / openai-compatible    → `createOpenAICompatible` (the recorded
 *     leverage note: one factory covers local Ollama, generic
 *     OpenAI-compatible endpoints, and user-defined custom providers).
 *
 * CREDENTIALS (G3): the resolved model NEVER embeds the key in a persisted
 * shape. `resolveLanguageModel` receives the plaintext exactly once, at call
 * assembly, from the custody service's single call-time decryption path; the
 * AI SDK carries it only inside the outgoing request. Custom headers are
 * scanned for credential-shaped values and REFUSED before any request is
 * built — the API-key field is the only credential channel (the recorded
 * prototype limitation: providers needing a custom auth header are not
 * configurable in v1; E34 records this).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ProviderProtocol, ProviderRow } from "../../adapters/sqlite/providers-repository.ts";

export class ProviderConfigurationError extends Error {
  readonly code:
    | "PROVIDER_CONFIG_INVALID"
    | "PROVIDER_CREDENTIAL_REVOKED"
    | "PROVIDER_HEADER_CREDENTIAL_REJECTED";

  constructor(code: (typeof ProviderConfigurationError.prototype)["code"], message: string) {
    super(`provider configuration: ${message}`);
    this.name = "ProviderConfigurationError";
    this.code = code;
  }
}

/** The protocols whose endpoints are the protocol's own (no base URL field). */
const NATIVE_PROTOCOLS: readonly ProviderProtocol[] = ["openai", "anthropic", "google"];

/**
 * Header names (and value shapes) that would carry credential material. A
 * header with any of these names — or a value that reads like a bearer/cookie
 * payload — is refused: the API-key field is the only credential channel (G3;
 * recorded as the v1 prototype limitation in the slice's engineering record).
 */
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "private-token",
]);

const CREDENTIAL_VALUE_SHAPES: RegExp[] = [
  /^bearer\s+\S+/i,
  /^basic\s+\S+/i,
  /^token\s+\S+/i,
  /(?:^|;\s*)(?:session|auth|token|sid)[a-z0-9_-]*=\s*\S+/i,
];

export function assertCustomHeadersSafe(headersJson: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson);
  } catch {
    throw new ProviderConfigurationError(
      "PROVIDER_CONFIG_INVALID",
      "headers_json is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderConfigurationError("PROVIDER_CONFIG_INVALID", "headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ProviderConfigurationError(
        "PROVIDER_CONFIG_INVALID",
        "header values must be strings",
      );
    }
    if (CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) {
      throw new ProviderConfigurationError(
        "PROVIDER_HEADER_CREDENTIAL_REJECTED",
        "a credential-shaped header name is not allowed — use the API key field",
      );
    }
    if (CREDENTIAL_VALUE_SHAPES.some((shape) => shape.test(value))) {
      throw new ProviderConfigurationError(
        "PROVIDER_HEADER_CREDENTIAL_REJECTED",
        "a credential-shaped header value is not allowed — use the API key field",
      );
    }
    headers[name] = value;
  }
  return headers;
}

/** Parse the stored request-params JSON into generate-call settings. */
function requestParamsFrom(requestParamsJson: string): Record<string, string | number | boolean> {
  try {
    const parsed: unknown = JSON.parse(requestParamsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string | number | boolean>;
  } catch {
    return {};
  }
}

export const ProviderAdapters = {
  /** True for the protocols that take no configurable base URL. */
  isNative(protocol: ProviderProtocol): boolean {
    return NATIVE_PROTOCOLS.includes(protocol);
  },

  /**
   * Validate and decode the stored custom headers. Credential-shaped names
   * and values are REFUSED before any request is built — the API-key field is
   * the only credential channel (G3; the recorded v1 prototype limitation).
   */
  customHeaders(entry: Pick<ProviderRow, "headers_json">): Record<string, string> {
    return assertCustomHeadersSafe(entry.headers_json);
  },

  /** Parse the stored request-params JSON into generate-call settings. */
  requestParams(
    entry: Pick<ProviderRow, "request_params_json">,
  ): Record<string, string | number | boolean> {
    return requestParamsFrom(entry.request_params_json);
  },

  /**
   * Resolve ONE provider request's language model. `credential` is the
   * call-time plaintext from the custody service (null for no_key mode) — it
   * is consumed here, in-process, and never persisted anywhere (G3).
   */
  resolveLanguageModel(
    entry: ProviderRow,
    credential: string | null,
    modelId: string,
  ): LanguageModel {
    if (entry.api_mode === "api_key" && credential === null) {
      throw new ProviderConfigurationError(
        "PROVIDER_CREDENTIAL_REVOKED",
        `provider ${entry.id} has no stored credential`,
      );
    }
    if (NATIVE_PROTOCOLS.includes(entry.protocol) && entry.base_url !== null) {
      throw new ProviderConfigurationError(
        "PROVIDER_CONFIG_INVALID",
        `native protocol ${entry.protocol} does not take a base URL`,
      );
    }
    if (!NATIVE_PROTOCOLS.includes(entry.protocol) && entry.base_url === null) {
      throw new ProviderConfigurationError(
        "PROVIDER_CONFIG_INVALID",
        `protocol ${entry.protocol} requires a base URL`,
      );
    }
    const headers = assertCustomHeadersSafe(entry.headers_json);
    switch (entry.protocol) {
      case "openai": {
        // exactOptionalPropertyTypes: the conditional spreads keep every
        // unset key OUT of the settings object (never an explicit undefined).
        const provider = createOpenAI({
          ...(credential !== null ? { apiKey: credential } : {}),
          ...(entry.organization ? { organization: entry.organization } : {}),
          ...(entry.project ? { project: entry.project } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        return provider.chat(modelId);
      }
      case "anthropic": {
        const provider = createAnthropic({
          ...(credential !== null ? { apiKey: credential } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        return provider(modelId);
      }
      case "google": {
        const provider = createGoogleGenerativeAI({
          ...(credential !== null ? { apiKey: credential } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        return provider(modelId);
      }
      case "ollama":
      case "openai-compatible": {
        // Ollama rides the OpenAI-compatible shape (the recorded leverage
        // note); the base URL is required for these protocols (checked above).
        const provider = createOpenAICompatible({
          name: entry.id,
          baseURL: entry.base_url as string,
          ...(entry.api_mode === "api_key" && credential !== null ? { apiKey: credential } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        return provider(modelId);
      }
      default: {
        // The discriminated union makes this unreachable; a rogue protocol
        // value is a typed configuration error, never an undefined factory.
        throw new ProviderConfigurationError(
          "PROVIDER_CONFIG_INVALID",
          `protocol ${(entry as { protocol?: string }).protocol ?? "unknown"} has no adapter`,
        );
      }
    }
  },
};
