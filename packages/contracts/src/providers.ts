/**
 * Provider contracts (S23; PRD §9, §19 AC10/AC11, D17, D20, D22, E9, G3) —
 * the wire shapes and typed error vocabulary for the provider registry.
 *
 * The credential NEVER crosses this boundary: the wire view carries the
 * store-time masked hint only (at most the final four characters), and the
 * typed error codes carry no provider response content. Every effective-
 * provider answer is an honest union — a configured resolution or a named
 * configuration state (D17: never a fabricated completion).
 */
import { z } from "zod";

import { Id, IsoDateTime } from "./primitives.ts";

/** The PRD §9 protocol vocabulary (Ollama rides the OpenAI-compatible shape). */
export const PROVIDER_PROTOCOLS = [
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
] as const;
export const ProviderProtocol = z.enum(PROVIDER_PROTOCOLS);
export type ProviderProtocol = z.infer<typeof ProviderProtocol>;

/** API key mode (custody applies) or no-key mode (local endpoints). */
export const ProviderApiMode = z.enum(["api_key", "no_key"]);
export type ProviderApiMode = z.infer<typeof ProviderApiMode>;

/** Who provisioned the entry (E9: platform credentials are admin-written). */
export const ProviderOrigin = z.enum(["platform", "user"]);
export type ProviderOrigin = z.infer<typeof ProviderOrigin>;

/** Enable/disable (PRD §9; a disabled provider resolves to nothing). */
export const ProviderStatus = z.enum(["enabled", "disabled"]);
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/**
 * The masked wire view of one configured provider entry. There is NO
 * credential field and never will be one — only the store-time hint.
 */
export const ProviderView = z.strictObject({
  id: Id,
  workspace_id: Id,
  display_name: z.string().min(1).max(120),
  protocol: ProviderProtocol,
  base_url: z.string().max(2048).nullable(),
  api_mode: ProviderApiMode,
  default_model_id: z.string().min(1).max(256),
  organization: z.string().max(256).nullable(),
  project: z.string().max(256).nullable(),
  headers: z.record(z.string(), z.string()),
  request_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  origin: ProviderOrigin,
  status: ProviderStatus,
  credential_hint: z.string().max(8).nullable(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ProviderView = z.infer<typeof ProviderView>;

/**
 * The effective provider for one conversation (AC11): a configured
 * resolution — with WHERE it came from — or the honest configuration state
 * (D17). The safe_message is display-safe (G3).
 */
export const EffectiveProvider = z.discriminatedUnion("configured", [
  z.strictObject({
    configured: z.literal(true),
    provider_id: Id,
    display_name: z.string().min(1).max(120),
    protocol: ProviderProtocol,
    model: z.string().min(1).max(256),
    source: z.enum(["conversation_override", "agent_default"]),
  }),
  z.strictObject({
    configured: z.literal(false),
    code: z.enum(["PROVIDER_NOT_CONFIGURED", "PROVIDER_DISABLED", "PROVIDER_CREDENTIAL_REVOKED"]),
    safe_message: z.string().min(1).max(500),
  }),
]);
export type EffectiveProvider = z.infer<typeof EffectiveProvider>;

/**
 * A connection-test answer (PRD §9 custom-provider "connection test"): honest
 * success or a typed, redacted failure. UI_DESIGN S9's recorded rule — a test
 * must not "always succeed" — is the shape's reason for being.
 */
export const ProviderConnectionTestResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    checked_model: z.string().min(1).max(256),
    latency_ms: z.number().int().min(0),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "PROVIDER_CONNECTION_TEST_UNREACHABLE",
      "PROVIDER_CONNECTION_TEST_AUTH_FAILED",
      "PROVIDER_CONNECTION_TEST_NOT_FOUND",
      "PROVIDER_CONNECTION_TEST_FAILED",
      "PROVIDER_CONFIG_INVALID",
      "PROVIDER_CREDENTIAL_REVOKED",
    ]),
    safe_message: z.string().min(1).max(500),
    http_status: z.number().int().min(100).max(599).nullable(),
  }),
]);
export type ProviderConnectionTestResult = z.infer<typeof ProviderConnectionTestResult>;

/**
 * The typed provider-error vocabulary (SCREAMING_SNAKE, D23 rule 4). These
 * codes travel in SheraError rejections; none carries secret material.
 */
export const PROVIDER_ERROR_CODES = [
  "PROVIDER_NOT_FOUND",
  "PROVIDER_ALREADY_EXISTS",
  "PROVIDER_CONFIG_INVALID",
  "PROVIDER_DISABLED",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_CREDENTIAL_REVOKED",
  "PROVIDER_CREDENTIAL_INVALID",
  "PROVIDER_HEADER_CREDENTIAL_REJECTED",
  "PROVIDER_CONNECTION_TEST_FAILED",
  "PROVIDER_OVERRIDE_CONVERSATION_NOT_FOUND",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];
