import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentChatView, FirstTimeSessionNote } from "../components/chat/agent-chat-view";
import { fetchAgentDetail, fetchAgentRoster } from "../lib/agent-api";
import { agentById, conversationForAgent } from "../lib/fixtures";
import {
  PRESENCE_POLL_MS,
  SESSION_NOTE_AUTO_DISMISS_MS,
  SESSION_NOTE_TEXT,
  hasSeenSessionNote,
  markSessionNoteSeen,
  presenceRefetchInterval,
  shouldShowFirstTimeNote,
  type AgentSessionPresence,
} from "../lib/session-presence";

/**
 * S12 chunk 4 — the chat header's honest session presence (D32 layer 3):
 * the runtime agent API reports `session.presence` on the roster and detail
 * rows (S12 chunks 1–3), and the header renders it as a small presence chip
 * plus the first-time explainer note. Like the other component suites this
 * renders to static markup (node environment, no DOM): fetch is stubbed at
 * the same-origin proxy boundary, polling decisions are pure functions, and
 * the real round trip is proven in apps/user-runtime plus the browser
 * captures under apps/web/.impeccable/review/s12/.
 *
 * Honesty rules pinned here (G4):
 *  - presence "none" renders NO chip — a supervised-off runtime is not
 *    decorated with a fake session state;
 *  - a presence FETCH failure renders NOTHING scary — a presence chip never
 *    becomes an error surface;
 *  - the demo's derived presence pill is unchanged, and real presence never
 *    leaks onto demo rows;
 *  - the S11 placeholder is gone — session states arrive in S12, for real.
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

const GA_FIXTURE = agentById("agent_general_assistant")!;
const GA_CONVERSATION = conversationForAgent("agent_general_assistant")!;

function renderRuntimeChat(props: Record<string, unknown> = {}): string {
  return render(
    createElement(AgentChatView, {
      agent: GA_FIXTURE,
      conversation: GA_CONVERSATION,
      thread: [],
      mode: "runtime",
      ...props,
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. The presence chip renders every reported state honestly
// ---------------------------------------------------------------------------

describe("session presence chip (§S3, D32)", () => {
  it.each<[AgentSessionPresence, string]>([
    ["active", "Session active"],
    ["hibernating", "Hibernating"],
    ["starting", "Starting"],
    ["restarting", "Reconnecting"],
    ["failed", "Session failed"],
  ])("presence %s renders its labeled chip", (presence, label) => {
    const html = renderRuntimeChat({ sessionPresence: presence });
    expect(html).toContain(`data-session-presence="${presence}"`);
    expect(html).toContain(label);
  });

  it("the active chip keeps the demo pill's live-dot tone", () => {
    const html = renderRuntimeChat({ sessionPresence: "active" });
    expect(html).toContain("bg-live");
  });

  it("presence none renders NO chip — no fabricated session state (G4)", () => {
    const html = renderRuntimeChat({ sessionPresence: "none" });
    expect(html).not.toContain("data-session-presence");
    expect(html).not.toContain("Session active");
    expect(html).not.toContain("Hibernating");
  });

  it("the loading state is styled quiet — a pulse, never a claimed state", () => {
    const html = renderRuntimeChat({ sessionPresence: "loading" });
    expect(html).toContain('data-session-presence="loading"');
    expect(html).toContain("animate-pulse");
    // It must not claim any concrete state before the runtime reported one.
    expect(html).not.toContain("Session active");
    expect(html).not.toContain("Hibernating");
    expect(html).not.toContain("Session failed");
  });

  it("a presence fetch failure renders NOTHING scary — no chip, no alert", () => {
    const html = renderRuntimeChat({ sessionPresence: "error" });
    expect(html).not.toContain("data-session-presence");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("error");
  });

  it("the S11 placeholder is gone — runtime presence is real now", () => {
    const html = renderRuntimeChat({ sessionPresence: "none" });
    expect(html).not.toContain("Presence arrives in S12");
  });

  it("real presence never leaks onto demo rows — the demo pill is unchanged", () => {
    const html = render(
      createElement(AgentChatView, {
        agent: GA_FIXTURE,
        conversation: GA_CONVERSATION,
        thread: [],
        mode: "demo",
        sessionPresence: "active",
      }),
    );
    // The demo derives its own presence from run fixtures (D32 demo pill);
    // the runtime chip's data attribute must not appear in demo mode.
    expect(html).not.toContain("data-session-presence");
    expect(html).toContain("session active");
  });

  it("the header identity survives the chip — name, role, settings link", () => {
    const html = renderRuntimeChat({ sessionPresence: "active" });
    expect(html).toContain("General Assistant");
    expect(html).toContain("Default coordinator of every Operation");
    expect(html).toContain('aria-label="Open General Assistant settings"');
  });
});

// ---------------------------------------------------------------------------
// 2. The first-time session note (issue requirement: shown once per browser
//    session, self-dismissing, aria-live polite)
// ---------------------------------------------------------------------------

/** Minimal in-memory Storage for the note bookkeeping. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => map.delete(key),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  } as Storage;
}

describe("first-time session note", () => {
  it("shows the first time a session is starting or active — and only once", () => {
    const storage = fakeStorage();
    expect(hasSeenSessionNote(storage)).toBe(false);
    expect(shouldShowFirstTimeNote("starting", storage)).toBe(true);
    expect(shouldShowFirstTimeNote("active", storage)).toBe(true);

    markSessionNoteSeen(storage);
    expect(hasSeenSessionNote(storage)).toBe(true);
    expect(shouldShowFirstTimeNote("active", storage)).toBe(false);
    expect(shouldShowFirstTimeNote("starting", storage)).toBe(false);
  });

  it("only a live session triggers the note — none/restarting/failed never do", () => {
    const storage = fakeStorage();
    expect(shouldShowFirstTimeNote("none", storage)).toBe(false);
    expect(shouldShowFirstTimeNote("restarting", storage)).toBe(false);
    expect(shouldShowFirstTimeNote("failed", storage)).toBe(false);
    expect(shouldShowFirstTimeNote("loading", storage)).toBe(false);
    expect(shouldShowFirstTimeNote("error", storage)).toBe(false);
  });

  it("missing storage (SSR, privacy mode) shows nothing and never throws", () => {
    expect(() => hasSeenSessionNote(undefined)).not.toThrow();
    expect(() => markSessionNoteSeen(undefined)).not.toThrow();
    expect(shouldShowFirstTimeNote("active", undefined)).toBe(false);
  });

  it("the visible note renders the product copy once, aria-live polite", () => {
    const html = render(createElement(FirstTimeSessionNote, { visible: true }));
    expect(html).toContain(SESSION_NOTE_TEXT);
    expect(html).toContain('aria-live="polite"');
  });

  it("the dismissed note leaves no copy behind (the polite region stays quiet)", () => {
    const html = render(createElement(FirstTimeSessionNote, { visible: false }));
    expect(html).not.toContain(SESSION_NOTE_TEXT);
  });

  it("auto-dismiss lands in 'a few seconds' — pinned, not a forever note", () => {
    expect(SESSION_NOTE_AUTO_DISMISS_MS).toBeGreaterThanOrEqual(3000);
    expect(SESSION_NOTE_AUTO_DISMISS_MS).toBeLessThanOrEqual(15000);
  });
});

// ---------------------------------------------------------------------------
// 3. Polling respects the hidden tab (no background refetch churn)
// ---------------------------------------------------------------------------

describe("presence polling interval", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls every 5s while the tab is visible", () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(presenceRefetchInterval()).toBe(PRESENCE_POLL_MS);
    expect(PRESENCE_POLL_MS).toBe(5000);
  });

  it("pauses when the document is hidden (mocked visibilityState)", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(presenceRefetchInterval()).toBe(false);
  });

  it("never throws without a document (SSR-safe) and keeps the default cadence", () => {
    expect(() => presenceRefetchInterval()).not.toThrow();
    expect(presenceRefetchInterval()).toBe(PRESENCE_POLL_MS);
  });
});

// ---------------------------------------------------------------------------
// 4. The typed client parses the S12 session-presence read (chunks 1–3 wire)
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rosterRow(presence: AgentSessionPresence): Record<string, unknown> {
  return {
    agent_id: "agent_general_assistant",
    display_name: "General Assistant",
    role_description: "Default coordinator of every Operation",
    avatar_hue: 217,
    initial_glyph: "G",
    has_user_instructions: false,
    session: { presence },
  };
}

function detailBody(presence: AgentSessionPresence): Record<string, unknown> {
  return {
    ...rosterRow(presence),
    user_instructions: null,
    default_provider: { provider_id: "provider_local", model: "qwen3-8b" },
    direct_chat_id: "conv_direct_01",
  };
}

describe("agent client session-presence parsing", () => {
  it("fetchAgentDetail carries the reported session presence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, detailBody("hibernating")));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchAgentDetail("ws_account-1", "agent_general_assistant");
    expect(detail.session.presence).toBe("hibernating");

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/runtime/v1/agents/agent_general_assistant?workspace_id=ws_account-1");
  });

  it("fetchAgentRoster rows carry their per-Agent session presence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          agents: [rosterRow("none"), rosterRow("starting"), rosterRow("failed")],
        }),
      ),
    );

    const agents = await fetchAgentRoster("ws_account-1");
    expect(agents.map((agent) => agent.session.presence)).toEqual([
      "none",
      "starting",
      "failed",
    ]);
  });
});
