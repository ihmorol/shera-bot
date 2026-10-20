import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSettingsCommand, AgentSettingsSnapshot } from "@shera-bot/contracts";

import { AgentChatView } from "../components/chat/agent-chat-view";
import { AgentRosterSection, type AgentRosterEntry } from "../components/shell/agent-roster";
import { AgentSettingsView } from "../components/settings/agent-settings";
import {
  buildAgentSettingsCommand,
  fetchAgentRoster,
  fetchAgentSettings,
  newAgentSettingsCommandIds,
  submitAgentSettingsCommand,
} from "../lib/agent-api";
import { agentById, buildThread, conversationForAgent, entitySlug } from "../lib/fixtures";
import { routes } from "../lib/routes";

/**
 * S11 chunk 4 — the Agent identity UI surfaces (§3.2 sidebar, §S3 header,
 * §S9+D16 settings editor), rendered to static markup (node environment, no
 * DOM) like the other component suites. The data comes from the REAL S11
 * local-API surfaces — GET /v1/agents, GET /v1/agents/:id (detail + the
 * get-or-create direct_chat_id), GET/POST /v1/agents/:id/settings — reached
 * through the same-origin runtime proxy; fetch is stubbed at that boundary,
 * and the real round trip is proven in apps/user-runtime.
 */

const APP_DIR = join(import.meta.dirname, "..");
const render = (element: ReactElement): string => renderToStaticMarkup(element);

/**
 * The REAL shipped pack manifest (same source of truth as
 * agent-identity.test.ts): the six seeded Agents the backend roster returns.
 * Roster test data is derived from it, never retyped.
 */
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(join(APP_DIR, "..", "..", "agent-packs", "student", "v1", "manifest.json"), "utf8"),
) as {
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    ui_identity: { avatar_hue: number; initial_glyph: string };
  }>;
};

function rosterEntry(manifestAgent: (typeof STUDENT_MANIFEST.agents)[number]): AgentRosterEntry {
  return {
    agent_id: manifestAgent.agent_id,
    display_name: manifestAgent.display_name,
    role_description: manifestAgent.role_description,
    avatar_hue: manifestAgent.ui_identity.avatar_hue,
    initial_glyph: manifestAgent.ui_identity.initial_glyph,
    has_user_instructions: false,
  };
}

const ROSTER: AgentRosterEntry[] = STUDENT_MANIFEST.agents.map(rosterEntry);

/** The shipped D16 snapshot fixture, validated through the contracts schema. */
const SNAPSHOT: AgentSettingsSnapshot = AgentSettingsSnapshot.parse(
  JSON.parse(
    readFileSync(
      join(APP_DIR, "..", "..", "tests", "fixtures", "s02", "agent-settings-snapshot.json"),
      "utf8",
    ),
  ),
);

/** Slice the rendered HTML down to one setting's card via data-setting-key. */
function cardFor(html: string, key: string): string {
  const marker = `data-setting-key="${key}"`;
  const start = html.indexOf(marker);
  expect(start, `no rendered card for setting key "${key}"`).toBeGreaterThanOrEqual(0);
  // Each card is its own <section>; bound the slice there so the LAST card's
  // slice cannot leak the (interactive) disclosure controls after it.
  const end = html.indexOf("</section>", start);
  return html.slice(start, end === -1 ? html.length : end);
}

// ---------------------------------------------------------------------------
// 1. Sidebar Agents section from GET /v1/agents (§3.2)
// ---------------------------------------------------------------------------

describe("sidebar Agents section (live roster, §3.2)", () => {
  it("renders the six Agents under the Agents category in roster order", () => {
    const html = render(createElement(AgentRosterSection, { entries: ROSTER, state: "ready" }));
    expect(html).toContain("Agents");
    let cursor = 0;
    for (const agent of ROSTER) {
      const at = html.indexOf(agent.display_name, cursor);
      expect(at, `${agent.display_name} out of roster order`).toBeGreaterThan(-1);
      cursor = at;
    }
    // Role lines render beneath the names (SidebarItem anatomy).
    expect(html).toContain(ROSTER[0]!.role_description);
  });

  it("renders each avatar from the authored identity (hue + glyph, #51 pattern)", () => {
    const html = render(createElement(AgentRosterSection, { entries: ROSTER, state: "ready" }));
    // D18 authored values reach the avatar as CSS custom properties — the
    // avatar's own tests pin the mapping; here the roster must not discard it.
    expect(html).toContain("--agent-hue:217");
    expect(html).toContain("--agent-hue:192");
    expect(html).toContain(">G</span>");
    expect(html).toContain(">R</span>");
  });

  it("links every row to that Agent's direct chat route", () => {
    const html = render(createElement(AgentRosterSection, { entries: ROSTER, state: "ready" }));
    for (const agent of ROSTER) {
      const slug = entitySlug(agent.agent_id);
      expect(html, `${agent.display_name} row`).toContain(`href="${routes.agent(slug)}"`);
    }
  });

  it("exposes the §3.2 settings affordance per Agent row", () => {
    const html = render(createElement(AgentRosterSection, { entries: ROSTER, state: "ready" }));
    for (const agent of ROSTER) {
      const slug = entitySlug(agent.agent_id);
      expect(html, `${agent.display_name} settings link`).toContain(
        `href="${routes.settings(`agents/${slug}`)}"`,
      );
      expect(html).toContain(`aria-label="Open ${agent.display_name} settings"`);
    }
  });

  it("fabricates no sidebar states on live rows — no unread/running markers yet", () => {
    // Real read tracking and session states arrive later (S09 chunk 3, S12);
    // the live roster renders quiet rows, never invented unread counts.
    const html = render(createElement(AgentRosterSection, { entries: ROSTER, state: "ready" }));
    expect(html).not.toContain("unread messages");
    expect(html).not.toContain("work in progress");
    expect(html).not.toContain("waiting for your approval");
  });

  it("marks the active Agent's row", () => {
    const html = render(
      createElement(AgentRosterSection, {
        entries: ROSTER,
        state: "ready",
        pathname: routes.agent("researcher"),
      }),
    );
    expect(html).toContain('aria-current="page"');
  });

  it("loading state is a layout-matched skeleton, not names (§2.4)", () => {
    const html = render(createElement(AgentRosterSection, { entries: ROSTER, state: "loading" }));
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("General Assistant");
  });

  it("error state carries the redacted safe_message with retry (§2.4)", () => {
    const html = render(
      createElement(AgentRosterSection, {
        entries: ROSTER,
        state: "error",
        safeErrorMessage: "The Agent roster could not be loaded.",
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The Agent roster could not be loaded.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("General Assistant");
  });

  it("empty state explains the one-line truth with the next action (§2.4)", () => {
    const html = render(createElement(AgentRosterSection, { entries: [], state: "empty" }));
    expect(html).toContain("No Agents are seeded in this workspace yet.");
    expect(html).toContain("Restart");
  });
});

// ---------------------------------------------------------------------------
// 2. Chat header identity (§S3)
// ---------------------------------------------------------------------------

const GA_FIXTURE = agentById("agent_general_assistant")!;
const GA_CONVERSATION = conversationForAgent("agent_general_assistant")!;

function renderChatView(props: Record<string, unknown> = {}): string {
  return render(
    createElement(AgentChatView, {
      agent: GA_FIXTURE,
      conversation: GA_CONVERSATION,
      thread: buildThread(GA_CONVERSATION.conversation_id),
      ...props,
    }),
  );
}

describe("chat header identity (§S3)", () => {
  it("runtime mode renders the presence PLACEHOLDER — session states arrive in S12", () => {
    // G4: real sessions report no presence in this slice, and the fixture
    // demo's derived presence must never leak onto real rows — the runtime
    // header shows an explicit placeholder instead of nothing or a guess.
    const html = renderChatView({ mode: "runtime" });
    expect(html).toContain("Presence arrives in S12");
    expect(html).toContain("placeholder");
  });

  it("runtime header links to the Agent settings surface (§S3 overflow affordance)", () => {
    const html = renderChatView({ mode: "runtime" });
    const slug = entitySlug(GA_FIXTURE.agent_id);
    expect(html).toContain(`href="${routes.settings(`agents/${slug}`)}"`);
    expect(html).toContain(`aria-label="Open ${GA_FIXTURE.display_name} settings"`);
  });

  it("demo mode keeps the D32 derived presence pill (unchanged demo behavior)", () => {
    const html = renderChatView({ mode: "demo" });
    expect(html).toContain("session active");
    expect(html).not.toContain("Presence arrives in S12");
  });

  it("renders the header identity from the Agent's pack data in runtime mode", () => {
    const html = renderChatView({ mode: "runtime" });
    expect(html).toContain("General Assistant");
    expect(html).toContain("Default coordinator of every Operation");
    // The authored hue rides along on the runtime rows too (D39: one identity
    // everywhere — sidebar, header, bubbles).
    expect(html).toContain("--agent-hue:217");
  });
});

// ---------------------------------------------------------------------------
// 3. Agent settings view (§S9 + D16)
// ---------------------------------------------------------------------------

function renderSettings(props: Record<string, unknown> = {}): string {
  return render(
    createElement(AgentSettingsView, {
      agentName: "General Assistant",
      snapshot: SNAPSHOT,
      surfaceState: "ready",
      pendingResetKey: null,
      commandPending: false,
      defaultAdvancedOpen: false,
      onUpdateInstructions: () => undefined,
      onUpdateDefaultProvider: () => undefined,
      onUpdateToolDefaults: () => undefined,
      onResetClick: () => undefined,
      onResetConfirm: () => undefined,
      onResetCancel: () => undefined,
      ...props,
    }),
  );
}

describe("agent settings view (§S9 + D16)", () => {
  it("renders the snapshot entries with their display labels and why-it-matters copy", () => {
    const html = renderSettings();
    const labels = [
      "Role",
      "Your instructions",
      "Memory",
      "Default provider and model",
      "Capabilities",
      "Appearance",
    ];
    let cursor = 0;
    for (const label of labels) {
      const at = html.indexOf(label, cursor);
      expect(at, `${label} missing or out of snapshot order`).toBeGreaterThan(-1);
      cursor = at;
    }
    // The why-it-matters description renders (D16), verbatim from the fixture.
    expect(html).toContain(
      "The fixed role the pack declared for this Agent; user instructions layer above it.",
    );
  });

  it("progressively discloses the advanced tool-defaults entry (D16)", () => {
    const closed = renderSettings();
    expect(closed).toContain("Show advanced settings");
    expect(closed).not.toContain("Tool defaults");

    const open = renderSettings({ defaultAdvancedOpen: true });
    expect(open).toContain("Hide advanced settings");
    expect(open).toContain("Tool defaults");
    // The placeholder honesty note rides with the entry (S21+ owns real config).
    expect(open).toContain("the tool slices");
  });

  it("read-only pack-owned entries render no controls and no reset (D16)", () => {
    const html = renderSettings({ defaultAdvancedOpen: true });
    for (const key of ["role", "memory_link", "capabilities", "ui_identity"]) {
      const card = cardFor(html, key);
      expect(card, `${key} read-only badge`).toContain("Read-only");
      expect(card, `${key} must have no editable control`).not.toMatch(
        /<(textarea|input|button)\b/,
      );
    }
  });

  it("editable user_instructions entry renders its editor with Save and Clear", () => {
    const html = renderSettings();
    const card = cardFor(html, "user_instructions");
    expect(card).toContain("<textarea");
    expect(card).toContain("Always answer in Bangla.");
    expect(card).toContain("Save");
    expect(card).toContain("Clear");
  });

  it("default_provider entry shows current value, recommended default, and risk note", () => {
    const html = renderSettings();
    const card = cardFor(html, "default_provider");
    expect(card).toContain("provider_local");
    expect(card).toContain("qwen3-8b");
    expect(card).toContain("Recommended default");
    expect(card).toContain("provider_platform");
    expect(card).toContain("platform-default");
    expect(card).toContain(
      "Providers differ in privacy and cost behavior", // risk note (D16), fixture-verbatim
    );
    expect(card).toContain("recommendation avoids surprises");
  });

  it("resettable entries arm a confirm before any reset fires (D16)", () => {
    const idle = renderSettings();
    const idleCard = cardFor(idle, "user_instructions");
    expect(idleCard).toContain("Reset to default");
    expect(idleCard).not.toContain("Confirm reset");

    const armed = renderSettings({ pendingResetKey: "user_instructions" });
    const armedCard = cardFor(armed, "user_instructions");
    expect(armedCard).toContain("Confirm reset");
    expect(armedCard).toContain("Cancel");
  });

  it("loading and error states follow the §2.4 language", () => {
    const loading = renderSettings({ surfaceState: "loading" });
    expect(loading).toContain("animate-pulse");
    expect(loading).not.toContain("Your instructions");

    const error = renderSettings({
      surfaceState: "error",
      safeErrorMessage: "The Agent settings could not be loaded.",
      onRetry: () => undefined,
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("The Agent settings could not be loaded.");
    expect(error).toContain("Retry");
  });

  it("reports a failed settings command through the redacted message only", () => {
    const html = renderSettings({
      commandError: "The settings command was not accepted.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The settings command was not accepted.");
  });

  it("shows the command-in-flight state while a mutation is pending", () => {
    const html = renderSettings({ commandPending: true });
    expect(html).toContain("Saving");
  });
});

// ---------------------------------------------------------------------------
// 4. The D16 command builder — the ONE mutation surface (D16, D26)
// ---------------------------------------------------------------------------

describe("agent settings command builder (D16 envelope)", () => {
  const ENVELOPE = {
    command_id: "cmd_test_001",
    idempotency_key: "idem_test_0001",
    workspace_id: "ws_default_01",
    agent_id: "agent_general_assistant",
    issued_at: "2026-10-07T10:00:00.000Z",
  } as const;

  it("builds a contracts-valid update_instructions command with the user actor", () => {
    const command = buildAgentSettingsCommand(
      { type: "agent_settings.update_instructions", user_instructions: "Always answer in Bangla." },
      ENVELOPE,
    );
    // Validated through the SAME contracts union the runtime parses (S30 will
    // reuse it verbatim) — a malformed command never leaves the client.
    expect(AgentSettingsCommand.parse(command)).toEqual(command);
    expect(command).toMatchObject({
      type: "agent_settings.update_instructions",
      user_instructions: "Always answer in Bangla.",
      ...ENVELOPE,
      actor: { type: "user", id: "user_emon" },
    });
  });

  it("builds a contracts-valid reset_setting command for an editable key only", () => {
    const command = buildAgentSettingsCommand(
      { type: "agent_settings.reset_setting", setting_key: "user_instructions" },
      ENVELOPE,
    );
    expect(AgentSettingsCommand.parse(command)).toEqual(command);
    // A pack-owned key is not a command target (D16) — the builder rejects it
    // instead of shipping a command the runtime would 400.
    expect(() =>
      buildAgentSettingsCommand(
        // @ts-expect-error — deliberately invalid: pack-owned key
        { type: "agent_settings.reset_setting", setting_key: "role" },
        ENVELOPE,
      ),
    ).toThrow();
  });

  it("builds reset_all with no payload fields", () => {
    const command = buildAgentSettingsCommand({ type: "agent_settings.reset_all" }, ENVELOPE);
    expect(AgentSettingsCommand.parse(command)).toEqual(command);
    expect(command).toMatchObject({ type: "agent_settings.reset_all", ...ENVELOPE });
  });

  it("mints fresh envelope ids: command_id, ≥1-char idempotency key, ISO issued_at", () => {
    const ids = newAgentSettingsCommandIds();
    expect(ids.command_id.length).toBeGreaterThanOrEqual(1);
    expect(ids.idempotency_key.length).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(ids.issued_at))).toBe(false);
    // Two calls never share an idempotency key — each submit is its own unit.
    expect(newAgentSettingsCommandIds().idempotency_key).not.toBe(ids.idempotency_key);
  });
});

// ---------------------------------------------------------------------------
// 5. The typed settings client through the same-origin proxy
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent settings client (proxy paths)", () => {
  it("fetchAgentRoster GETs the workspace roster and parses the summaries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents: ROSTER }));
    vi.stubGlobal("fetch", fetchMock);

    const agents = await fetchAgentRoster("ws_account-1");
    expect(agents).toHaveLength(6);
    expect(agents[0]).toMatchObject({ agent_id: "agent_general_assistant", avatar_hue: 217 });

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/runtime/v1/agents?workspace_id=ws_account-1");
  });

  it("fetchAgentSettings GETs the workspace-scoped snapshot and parses it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchAgentSettings("ws_account-1", "agent_general_assistant");
    expect(snapshot.entries).toHaveLength(7);

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(
      "/api/runtime/v1/agents/agent_general_assistant/settings?workspace_id=ws_account-1",
    );
  });

  it("submitAgentSettingsCommand POSTs the command and parses the read-after-write snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);

    const command = buildAgentSettingsCommand(
      { type: "agent_settings.update_instructions", user_instructions: null },
      {
        command_id: "cmd_route",
        idempotency_key: "idem_route",
        workspace_id: "ws_account-1",
        agent_id: "agent_general_assistant",
        issued_at: "2026-10-07T10:00:00.000Z",
      },
    );
    const snapshot = await submitAgentSettingsCommand(
      "ws_account-1",
      "agent_general_assistant",
      command,
    );
    expect(snapshot.entries).toHaveLength(7);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/agents/agent_general_assistant/settings/commands");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(command);
  });

  it("raises the typed failure from the local API's SheraError bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          code: "AGENT_NOT_FOUND",
          category: "resource",
          safe_message: "The requested Agent does not exist in this workspace.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "33333333-3333-4333-8333-333333333333",
        }),
      ),
    );
    await expect(fetchAgentSettings("ws_account-1", "agent_unknown")).rejects.toMatchObject({
      sheraError: { code: "AGENT_NOT_FOUND" },
    });
  });
});
