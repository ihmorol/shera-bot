/**
 * S23 live-provider connection test (issue #24 AC9; G7) — OPT-IN ONLY.
 *
 * This suite is deliberately OUTSIDE every default vitest include pattern
 * (pinned by live-suite-exclusion.test.ts): `pnpm test` NEVER runs it, CI
 * never runs it, and nothing here can execute without the owner's explicit
 * environment. It makes REAL network calls to a REAL provider endpoint using
 * the owner's key.
 *
 * Run manually, with the owner's own credentials:
 *
 *   SHERA_LIVE_PROVIDER_PROTOCOL=openai \
 *   SHERA_LIVE_PROVIDER_MODEL=gpt-4o-mini \
 *   SHERA_LIVE_PROVIDER_API_KEY=sk-... \
 *   node_modules/.bin/vitest run apps/user-runtime/live/providers-live.test.ts
 *
 * Optional: SHERA_LIVE_PROVIDER_BASE_URL (required for ollama /
 * openai-compatible protocols), SHERA_LIVE_PROVIDER_ORGANIZATION,
 * SHERA_LIVE_PROVIDER_PROJECT. Every value stays in this process: the suite
 * builds the SAME adapter seam the runtime calls use (ProviderAdapters +
 * runConnectionTest), asserts the honest typed result, and prints nothing
 * but the typed outcome — the key never appears in output (G3).
 */
import { describe, expect, it } from "vitest";

import type { ProviderRow } from "../src/adapters/sqlite/providers-repository.ts";
import { runConnectionTest } from "../src/modules/providers/connection-test.ts";

const PROTOCOL = process.env["SHERA_LIVE_PROVIDER_PROTOCOL"];
const API_KEY = process.env["SHERA_LIVE_PROVIDER_API_KEY"] ?? null;
const BASE_URL = process.env["SHERA_LIVE_PROVIDER_BASE_URL"] ?? null;
const MODEL = process.env["SHERA_LIVE_PROVIDER_MODEL"];
const ORGANIZATION = process.env["SHERA_LIVE_PROVIDER_ORGANIZATION"] ?? null;
const PROJECT = process.env["SHERA_LIVE_PROVIDER_PROJECT"] ?? null;

const CONFIGURED = Boolean(PROTOCOL && MODEL);

/** A synthetic row carrying the owner's live configuration (never persisted). */
function liveRow(): ProviderRow {
  return {
    id: "prov_live_optin",
    workspace_id: "ws_live_optin",
    display_name: "Owner live check",
    protocol: PROTOCOL as ProviderRow["protocol"],
    base_url: BASE_URL,
    api_mode: "api_key",
    default_model_id: MODEL as string,
    organization: ORGANIZATION,
    project: PROJECT,
    headers_json: "{}",
    request_params_json: "{}",
    origin: "user",
    status: "enabled",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as ProviderRow;
}

describe.skipIf(!CONFIGURED)("live provider check (owner opt-in, G7)", () => {
  it("one real minimal request reports the honest typed result", { timeout: 60_000 }, async () => {
    const result = await runConnectionTest(liveRow(), API_KEY);
    // The assertion is the HONESTY contract, not a success demand: a wrong
    // key or a down endpoint must produce the typed failure — the one thing
    // this suite refuses is a result that is neither.
    if (result.ok) {
      expect(result.checked_model).toBe(MODEL);
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      console.log(`[live] OK — ${result.checked_model} answered in ${result.latency_ms} ms`);
    } else {
      expect(result.code).toMatch(/^PROVIDER_(CONNECTION_TEST|CONFIG|CREDENTIAL)/);
      expect(result.safe_message.length).toBeGreaterThan(0);
      // G3: the typed failure never carries the key or the raw response.
      if (API_KEY) expect(result.safe_message).not.toContain(API_KEY);
      console.log(`[live] typed failure — ${result.code}: ${result.safe_message}`);
    }
  });
});
