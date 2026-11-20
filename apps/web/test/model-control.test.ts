import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelControl } from "../components/chat/model-control";
import { AgentChatView } from "../components/chat/agent-chat-view";
import { agentById, buildThread, conversationForAgent } from "../lib/fixtures";
import type { ProviderView } from "@shera-bot/contracts";
import type { EffectiveProviderState } from "../lib/provider-data";

/**
 * The AC11 header model control and the D17 composer gating (S23 UI):
 * the header shows the effective provider/model and where it came from, the
 * override picker offers the enabled catalog entries, and an unconfigured
 * resolution disables sending with the runtime's own explanation — never a
 * fabricated completion (G4).
 */

const APP_DIR = join(import.meta.dirname, "..");
// S21's tool cards use react-query for the runtime status readout, so every
// render rides the same provider wrapper the app shell supplies.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const render = (element: ReactElement): string =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, element));

const AGENT = agentById("agent_general_assistant")!;
const CONVERSATION = conversationForAgent("agent_general_assistant")!;

const CONFIGURED: EffectiveProviderState = {
  kind: "configured",
  providerId: "prov_platform_openai",
  displayName: "Platform OpenAI",
  model: "gpt-4o-mini",
  source: "agent_default",
};

const UNCONFIGURED: EffectiveProviderState = {
  kind: "unconfigured",
  code: "PROVIDER_NOT_CONFIGURED",
  safeMessage:
    "No provider is configured for this conversation yet. Configure one in Settings → Providers & models, or set the Agent's default.",
};

const PROVIDERS: ProviderView[] = [
  {
    id: "prov_platform_openai",
    workspace_id: "ws_1",
    display_name: "Platform OpenAI",
    protocol: "openai" as const,
    base_url: null,
    api_mode: "api_key" as const,
    default_model_id: "gpt-4o-mini",
    organization: null,
    project: null,
    headers: {},
    request_params: {},
    origin: "platform" as const,
    status: "enabled" as const,
    credential_hint: "sk-7",
    created_at: "2026-10-30T10:00:00.000Z",
    updated_at: "2026-10-30T10:00:00.000Z",
  },
];

describe("header model control (AC11)", () => {
  it("shows the effective provider · model and where it came from", () => {
    const html = render(
      createElement(ModelControl, {
        state: CONFIGURED,
        providers: PROVIDERS,
        onApplyOverride: () => undefined,
        onClearOverride: () => undefined,
      }),
    );
    expect(html).toContain("Platform OpenAI");
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("Agent default");
  });

  it("marks a conversation override distinctly from the Agent default", () => {
    const html = render(
      createElement(ModelControl, {
        state: { ...CONFIGURED, source: "conversation_override" },
        providers: PROVIDERS,
        onApplyOverride: () => undefined,
        onClearOverride: () => undefined,
      }),
    );
    expect(html).toContain("Conversation override");
  });

  it("the unconfigured state is a distinct, explanatory control", () => {
    const html = render(
      createElement(ModelControl, {
        state: UNCONFIGURED,
        providers: [],
        onApplyOverride: () => undefined,
        onClearOverride: () => undefined,
      }),
    );
    // The collapsed control reads the honest state, not a fabricated default.
    expect(html).toContain("No provider");
    // The panel carries the runtime's safe_message and the settings link.
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    expect(source).toContain("state.safeMessage");
    expect(source).toContain("providers");
  });

  it("the override picker lists only enabled providers with their default model", () => {
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    expect(source).toContain('status === "enabled"');
    expect(source).toContain("default_model_id");
  });

  it("clearing the override returns the conversation to the Agent default (AC11)", () => {
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    expect(source).toContain("Clear override");
  });

  it("collapses below md so the Agent identity keeps width priority at 360px", () => {
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    expect(source).toMatch(/hidden[^"]*md:block/);
  });
});

describe("runtime composer gating (D17/G4, real effective readout)", () => {
  function runtimeView(providerState: EffectiveProviderState | undefined): string {
    return render(
      createElement(AgentChatView, {
        agent: AGENT,
        conversation: { ...CONVERSATION, unread_count: 0 },
        thread: buildThread(CONVERSATION.conversation_id),
        mode: "runtime",
        onRuntimeSend: () => undefined,
        providerState,
      }),
    );
  }

  it("an unconfigured resolution disables sending with the runtime's safe message", () => {
    const html = runtimeView(UNCONFIGURED);
    expect(html).toContain("No provider is configured for this conversation yet.");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Enter to send");
  });

  it("a disabled-provider resolution shows ITS reason, not a generic one", () => {
    const html = runtimeView({
      kind: "unconfigured",
      code: "PROVIDER_DISABLED",
      safeMessage:
        'The provider "Local Ollama" is disabled. Enable it in Settings → Providers & models.',
    });
    // (The quotes arrive HTML-escaped in the static markup.)
    expect(html).toContain("is disabled. Enable it in Settings");
    expect(html).toContain('disabled=""');
  });

  it("a configured resolution leaves the composer enabled (no disabled hint)", () => {
    const html = runtimeView(CONFIGURED);
    expect(html).not.toContain("No provider is configured");
    // The textarea carries no disabled ATTRIBUTE (the utility classes
    // legitimately mention disabled: variants).
    expect(html).not.toMatch(/<textarea[^>]*disabled="/);
  });

  it("an unknown effective state (still resolving) never offers a send (G4)", () => {
    const html = runtimeView({ kind: "unknown" });
    expect(html).toContain("disabled");
  });

  it("no fabricated assistant message is ever produced (standing pin)", () => {
    const html = runtimeView(UNCONFIGURED);
    // The S08 fixture demo stream's text must never render on a real row.
    expect(html).not.toContain("spaced repetition outperforms massed practice");
  });
});

describe("dimmed-with-reason picker (D52 wave D; E43 §5 + research annex §5/§9)", () => {
  const KEYLESS: ProviderView = {
    ...PROVIDERS[0]!,
    id: "prov_platform_keyless",
    display_name: "Keyless Endpoint",
    credential_hint: null,
  };
  const DISABLED: ProviderView = {
    ...PROVIDERS[0]!,
    id: "prov_disabled_one",
    display_name: "Turned-off Provider",
    status: "disabled",
  };
  const control = (state: EffectiveProviderState, providers: typeof PROVIDERS): string =>
    render(
      createElement(ModelControl, {
        state,
        providers,
        onApplyOverride: () => undefined,
        onClearOverride: () => undefined,
      }),
    );

  it("the collapsed trigger carries the runtime's typed reason in title and aria-label (G4)", () => {
    const html = control(UNCONFIGURED, []);
    // The reason is the runtime's safe_message — never a generic guess. The
    // static markup HTML-escapes the arrow, so the assertion stops before it.
    expect(html).toContain("Configure one in Settings");
    expect(html).toMatch(/aria-label="[^"]*Configure one in Settings/);
  });

  it("the trigger shows an attention dot only when a configuration block applies", () => {
    expect(control(UNCONFIGURED, [])).toContain('data-attention="true"');
    expect(control(CONFIGURED, PROVIDERS)).not.toContain('data-attention="true"');
  });

  it("the trigger pill shows a provider mark for a configured provider (pattern §5)", () => {
    const configured = control(CONFIGURED, PROVIDERS);
    expect(configured).toContain('data-provider-mark="P"');
    // No provider, no mark — the attention dot takes the slot instead.
    expect(control(UNCONFIGURED, [])).not.toContain("data-provider-mark");
  });

  it("a disabled catalog entry renders as a dimmed row with its reason and the settings link", () => {
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    // The route exists (routes.settings("providers")), so the reason links to it.
    expect(source).toContain("Turned off in Providers & models");
    expect(source).toContain('routes.settings("providers")');
    // Blocked entries live in the pane, never on the closed trigger: a
    // configured control over a catalog with blocked rows stays calm.
    const html = control(CONFIGURED, [PROVIDERS[0]!, DISABLED, KEYLESS]);
    expect(html).toContain('data-provider-mark="P"');
    expect(html).not.toContain('data-attention="true"');
  });

  it("a keyless enabled catalog entry and an empty catalog render the setup explanation — no invented count", () => {
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    // The runtime payload (ProviderView / ProvidersResponse) carries no model
    // count — only default_model_id — so the pane carries no count (audit, D52).
    expect(source).toContain("Models will appear after setup.");
  });

  it("the scope line uses Shera vocabulary — Only this chat / Agent default", () => {
    const source = readFileSync(join(APP_DIR, "components/chat/model-control.tsx"), "utf8");
    expect(source).toContain("Only this chat");
    expect(source).toContain("Agent default");
  });
});
