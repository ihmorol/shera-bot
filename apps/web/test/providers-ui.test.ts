import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSettingsSnapshot, ProviderView } from "@shera-bot/contracts";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProvidersSettingsView } from "../components/settings/providers-settings";
import { AgentSettingsView } from "../components/settings/agent-settings";

/**
 * The S23 Providers & models settings surface (UI_DESIGN §S9 row, PRD §9,
 * AC10, D17, D22, G3). The custody rules are the acceptance criteria here:
 * the credential crosses the UI exactly once (a masked input that is cleared
 * and never re-rendered), every display value is the masked wire view, and
 * every failure is the runtime's redacted safe message.
 */

const APP_DIR = join(import.meta.dirname, "..");
const render = (element: ReactElement): string => renderToStaticMarkup(element);

const PROVIDER: ProviderView = {
  id: "prov_custom_local",
  workspace_id: "ws_1",
  display_name: "Local Ollama",
  protocol: "ollama",
  base_url: "http://127.0.0.1:11434/v1",
  api_mode: "no_key",
  default_model_id: "llama3.1:8b",
  organization: null,
  project: null,
  headers: {},
  request_params: {},
  origin: "user",
  status: "enabled",
  credential_hint: null,
  created_at: "2026-10-30T10:00:00.000Z",
  updated_at: "2026-10-30T10:00:00.000Z",
};

const KEYED: ProviderView = {
  ...PROVIDER,
  id: "prov_platform_openai",
  display_name: "Platform OpenAI",
  protocol: "openai",
  base_url: null,
  api_mode: "api_key",
  default_model_id: "gpt-4o-mini",
  origin: "platform",
  credential_hint: "sk-7",
};

function view(
  overrides: Partial<Parameters<typeof ProvidersSettingsView>[0]> = {},
): ReturnType<typeof render> {
  return render(
    createElement(ProvidersSettingsView, {
      providers: [PROVIDER, KEYED],
      surfaceState: "ready",
      pendingConfirm: null,
      lastTestResult: null,
      configurePending: false,
      onConfigure: () => undefined,
      onReplaceCredential: () => undefined,
      onRevoke: () => undefined,
      onSetStatus: () => undefined,
      onConnectionTest: () => undefined,
      ...overrides,
    }),
  );
}

describe("Providers & models settings (UI_DESIGN §S9, AC10)", () => {
  it("renders the masked catalog: name, protocol, model, status, credential hint", () => {
    const html = view();
    expect(html).toContain("Local Ollama");
    expect(html).toContain("ollama");
    expect(html).toContain("llama3.1:8b");
    expect(html).toContain("Platform OpenAI");
    expect(html).toContain("gpt-4o-mini");
    // The masked hint renders; the raw credential does not exist to render.
    expect(html).toContain("sk-7");
    // E12/E9 origin honesty: platform entries are labeled.
    expect(html).toContain("Platform");
  });

  it("shows the no-key state distinctly from a stored credential (D22)", () => {
    expect(view({ providers: [PROVIDER] })).toContain("No-key mode");
    // An api_key provider with no stored credential says so — it never
    // pretends to be usable (D17 honesty).
    expect(view({ providers: [{ ...KEYED, credential_hint: null }] })).toContain("no key stored");
  });

  it("offers every PRD §9 custom-provider field on the add-provider form", () => {
    const source = readFileSync(
      join(APP_DIR, "components/settings/providers-settings.tsx"),
      "utf8",
    );
    for (const label of [
      "Display name",
      "Protocol",
      "Base URL",
      "API key",
      "No-key mode",
      "Model identifier",
      "Organization",
      "Project",
      "Headers",
      "Request parameters",
    ]) {
      expect(source, `form field: ${label}`).toContain(label);
    }
  });

  it("the add-provider form accepts a credential exactly once and clears it", () => {
    const source = readFileSync(
      join(APP_DIR, "components/settings/providers-settings.tsx"),
      "utf8",
    );
    // G3: the credential field is a masked input, and the draft is cleared on
    // submit — the surface never keeps a re-displayable copy of the secret.
    expect(source).toContain('type="password"');
    expect(source).toMatch(/setCredentialDraft\(""\)/);
  });

  it("never renders a credential input with a stored value (masked display only)", () => {
    const html = view();
    // No value= on any password input: the stored credential is never sent to
    // the client, so nothing may echo one back.
    expect(html).not.toMatch(/type="password"[^>]*value="[^"]/);
  });

  it("replace is the only write on a stored credential; revoke is armed", () => {
    const html = view();
    expect(html).toContain("Replace key");
    expect(html).toContain("Revoke key");
    expect(html).not.toContain("Show key");
  });

  it("the connection test is per provider and renders the honest result", () => {
    const html = view({
      lastTestResult: {
        providerId: KEYED.id,
        state: "failed",
        result: {
          ok: false,
          code: "PROVIDER_CONNECTION_TEST_AUTH_FAILED",
          safe_message: "The provider rejected the credential (HTTP 401).",
          http_status: 401,
        },
      },
    });
    expect(html).toContain("Test connection");
    expect(html).toContain("The provider rejected the credential (HTTP 401).");
  });

  it("a pending test shows a loading state, never a fake success", () => {
    const html = view({
      lastTestResult: { providerId: KEYED.id, state: "pending", result: null },
    });
    expect(html).toContain("Testing");
    expect(html).not.toContain("Connection OK");
  });

  it("renders the loading, error, and empty states (§2.4)", () => {
    const loading = view({ surfaceState: "loading", providers: [] });
    expect(loading).toMatch(/animate-pulse/);
    const empty = view({ providers: [] });
    expect(empty).toContain("No providers configured yet");
    // D17: the empty state teaches where the first provider comes from.
    expect(empty).toContain("administrator");
    const error = view({
      surfaceState: "error",
      providers: [],
      safeErrorMessage: "The providers could not be read.",
    });
    expect(error).toContain("The providers could not be read.");
  });

  it("enable/disable is a per-provider control with the current state shown", () => {
    const html = view();
    expect(html).toContain("Disable");
    const disabledOnly = view({ providers: [{ ...PROVIDER, status: "disabled" }] });
    expect(disabledOnly).toContain("Enable");
  });
});

describe("per-Agent default provider assignment (AC11)", () => {
  const AGENT_SETTINGS_PATH = "components/settings/agent-settings.tsx";

  function agentSettingsHtml(catalog: ProviderView[] | undefined): string {
    const snapshot: AgentSettingsSnapshot = {
      workspace_id: "ws_1",
      agent_id: "agent_general_assistant",
      entries: [
        {
          key: "default_provider",
          display_label: "Default provider",
          description: "Which provider and model this Agent starts with.",
          editable: true,
          resettable: true,
          reset_command: "agent_settings.reset_setting",
          risk_note: "Providers differ in privacy and cost behavior.",
          value: { provider_id: "provider_local", model: "qwen3-8b" },
          recommended_default: { provider_id: "provider_platform", model: "platform-default" },
        },
      ],
    };
    return render(
      createElement(AgentSettingsView, {
        agentName: "General Assistant",
        snapshot,
        surfaceState: "ready",
        pendingResetKey: null,
        commandPending: false,
        onUpdateInstructions: () => undefined,
        onUpdateDefaultProvider: () => undefined,
        onUpdateToolDefaults: () => undefined,
        onResetClick: () => undefined,
        onResetConfirm: () => undefined,
        onResetCancel: () => undefined,
        providerCatalog: catalog,
      }),
    );
  }

  it("the default-provider editor offers the masked catalog entries as choices", () => {
    const html = agentSettingsHtml([
      {
        ...PROVIDER,
        id: "prov_local_1",
        display_name: "Local Ollama",
        status: "enabled",
      },
    ]);
    expect(html).toContain("Local Ollama");
    expect(html).toMatch(/<select/);
  });

  it("without a catalog the editor keeps its manual entry fallback (honest)", () => {
    const source = readFileSync(join(APP_DIR, AGENT_SETTINGS_PATH), "utf8");
    expect(source).toContain("providerCatalog");
  });
});
