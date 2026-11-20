import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  chatPreviewFromMessages,
  orderChatsPinFirst,
  SimpleChatRows,
  type SimpleChatRow,
} from "../components/shell/sidebar-content";
import { formatChatTimestamp } from "../lib/relative-time";
import { agentById, messagesForConversation } from "../lib/fixtures";

/**
 * Wave A chunk A1 (D52; E43 §5 patterns-not-pixels) — the SIMPLE merged Chats
 * rows: two-line anatomy (name + relative timestamp / activity preview line),
 * pin-first ordering over the recency merge, and the honest preview sources
 * (G4): live Agent rows render only the runtime-derived `last_activity.preview`,
 * live Operation rows render none (the runtime has no such field), demo rows
 * derive from the newest fixture message with the "You: " convention.
 *
 * The pure pieces (formatter, ordering, preview derivation) are tested
 * directly; the row anatomy renders through the shared presentational
 * `SimpleChatRows` in the node environment like the other component suites.
 */

const NOW = Date.parse("2026-09-20T16:10:00Z");

// ---------------------------------------------------------------------------
// 1. The relative timestamp formatter (pure, <7 days relative, else a date)
// ---------------------------------------------------------------------------

describe("chat timestamp formatter", () => {
  it("says just now under 45 seconds", () => {
    expect(formatChatTimestamp(NOW - 30_000, NOW)).toBe("just now");
    expect(formatChatTimestamp(NOW - 44_999, NOW)).toBe("just now");
  });

  it("counts whole minutes under an hour", () => {
    expect(formatChatTimestamp(NOW - 45_000, NOW)).toBe("1 min ago");
    expect(formatChatTimestamp(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(formatChatTimestamp(NOW - 59 * 60_000, NOW)).toBe("59 min ago");
  });

  it("counts hours before a day", () => {
    expect(formatChatTimestamp(NOW - 60 * 60_000, NOW)).toBe("1 h ago");
    expect(formatChatTimestamp(NOW - 5 * 3600_000 - 1, NOW)).toBe("5 h ago");
    expect(formatChatTimestamp(NOW - 23 * 3600_000, NOW)).toBe("23 h ago");
  });

  it("says yesterday inside two days", () => {
    expect(formatChatTimestamp(NOW - 24 * 3600_000, NOW)).toBe("yesterday");
    expect(formatChatTimestamp(NOW - 47 * 3600_000, NOW)).toBe("yesterday");
  });

  it("counts days under a week", () => {
    expect(formatChatTimestamp(NOW - 49 * 3600_000, NOW)).toBe("2 d ago");
    expect(formatChatTimestamp(NOW - 6 * 24 * 3600_000, NOW)).toBe("6 d ago");
  });

  it("falls back to a short date at seven days — relative only while <7 days old", () => {
    const label = formatChatTimestamp(NOW - 7 * 24 * 3600_000, NOW);
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(label).not.toMatch(/ago|yesterday|just now/);
  });

  it("never claims precision the record lacks — invalid or zeroed stamps render nothing", () => {
    expect(formatChatTimestamp(0, NOW)).toBeNull();
    expect(formatChatTimestamp(-5, NOW)).toBeNull();
    expect(formatChatTimestamp(Number.NaN, NOW)).toBeNull();
    expect(formatChatTimestamp(NOW, 0)).toBeNull(); // the pre-mount clock
  });
});

// ---------------------------------------------------------------------------
// 2. Pin-first ordering over the recency merge (behavior change — D52 §3.4)
// ---------------------------------------------------------------------------

describe("pin-first ordering", () => {
  const row = (key: string, at: number) => ({ key, at, conversationId: key });

  it("pinned rows lead; recency order survives within the pinned group and the rest", () => {
    const recency = [row("b", 400), row("c", 300), row("d", 200), row("a", 100)];
    expect(orderChatsPinFirst(recency, ["a", "c"]).map((r) => r.key)).toEqual([
      "c", // pinned, newer
      "a", // pinned, older
      "b", // rest in recency order
      "d",
    ]);
  });

  it("is a no-op when nothing is pinned — the D52 recency-sorted claim stands", () => {
    const recency = [row("b", 400), row("a", 100)];
    expect(orderChatsPinFirst(recency, []).map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("ignores pin ids that match no row", () => {
    const recency = [row("b", 400), row("a", 100)];
    expect(orderChatsPinFirst(recency, ["missing"]).map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("does not mutate the input list", () => {
    const recency = [row("b", 400), row("a", 100)];
    orderChatsPinFirst(recency, ["a"]);
    expect(recency.map((r) => r.key)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The demo preview derivation (G4: newest fixture message, "You: " convention)
// ---------------------------------------------------------------------------

describe("demo chat preview derivation", () => {
  it("prefixes the user's own newest line with You", () => {
    expect(
      chatPreviewFromMessages(
        messagesForConversation("conversation_agent_general_assistant"),
        "agent_direct",
      ),
    ).toBe("You: Go ahead — focus on 2024 or later.");
  });

  it("quotes the newest Agent line unprefixed in a direct chat", () => {
    expect(
      chatPreviewFromMessages(
        messagesForConversation("conversation_agent_researcher"),
        "agent_direct",
      ),
    ).toMatch(/^Done — the digest/);
  });

  it("keeps the system line as recorded (a recovery notice previews as itself)", () => {
    expect(
      chatPreviewFromMessages(
        messagesForConversation("conversation_agent_developer"),
        "agent_direct",
      ),
    ).toMatch(/^A run in this conversation needs recovery/);
  });

  it("attributes Agent lines by name inside an Operation chat", () => {
    const messages = messagesForConversation("conversation_agent_researcher").slice(-1);
    expect(chatPreviewFromMessages(messages, "operation")).toBe(
      "Researcher: Done — the digest is published to the workspace as sources-digest.md. Each claim links back to its source paragraph.",
    );
  });

  it("returns null for a conversation with no messages — the row stays quiet (G4)", () => {
    expect(
      chatPreviewFromMessages(
        messagesForConversation("conversation_op_research_paper"),
        "operation",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The shared two-line row anatomy (SIMPLE list, demo and live shapes)
// ---------------------------------------------------------------------------

const baseRow: SimpleChatRow = {
  kind: "agent",
  key: "agent_general_assistant",
  conversationId: "conversation_agent_general_assistant",
  href: "/app/agent/general-assistant",
  title: "General Assistant",
  agent: agentById("agent_general_assistant") ?? null,
  at: Date.parse("2026-09-20T10:16:00Z"),
  preview: "You: Go ahead — focus on 2024 or later.",
  state: "unread",
  unreadCount: 2,
  approvalCount: 0,
  attention: undefined,
};

const renderRows = (rows: SimpleChatRow[], pinnedIds: string[] = []): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SimpleChatRows, { rows, pinnedIds, pathname: "/app", now: NOW }),
    ),
  );

describe("simple chat row anatomy", () => {
  it("renders two lines: name + right-aligned timestamp, then the preview line", () => {
    const html = renderRows([baseRow]);
    expect(html).toContain('data-testid="chat-timestamp"');
    expect(html).toContain("5 h ago"); // 10:16 against the pinned 16:10 clock
    expect(html).toContain('data-testid="chat-preview-line"');
    expect(html).toContain("You: Go ahead — focus on 2024 or later.");
    // The timestamp span trails the name on line one (ml-auto right-align).
    expect(html).toMatch(/ml-auto[^"]*"[^>]*>/);
  });

  it("renders a short date for stamps older than the relative window", () => {
    const html = renderRows([{ ...baseRow, at: NOW - 8 * 24 * 3600_000 }]);
    expect(html).toMatch(/data-testid="chat-timestamp"[^>]*>Sep 12</);
  });

  it("renders the tabular-num timestamp class (relative, 12px, mono meta)", () => {
    const html = renderRows([baseRow]);
    expect(html).toMatch(/tabular-nums/);
  });

  it("stays quiet single-line when there is no preview (G4)", () => {
    const html = renderRows([{ ...baseRow, preview: null }]);
    expect(html).not.toContain('data-testid="chat-preview-line"');
    expect(html).toContain('data-testid="chat-timestamp"');
  });

  it("renders no timestamp when the record lacks a usable stamp (live quiet rows)", () => {
    const html = renderRows([{ ...baseRow, preview: null, at: 0 }]);
    expect(html).not.toContain('data-testid="chat-timestamp"');
    expect(html).not.toContain('data-testid="chat-preview-line"');
  });

  it("keeps the state machinery — the unread pill renders on the demo row", () => {
    const html = renderRows([baseRow]);
    expect(html).toContain(">2</span>"); // the UnreadPill count
  });

  it("renders the pin glyph only on pinned rows", () => {
    const unpinned = renderRows([baseRow]);
    expect(unpinned).not.toContain('data-testid="chat-pin-glyph"');
    const pinned = renderRows([baseRow], [baseRow.conversationId]);
    expect(pinned).toContain('data-testid="chat-pin-glyph"');
  });

  it("pinned rows lead the rendered list; the rest keeps recency order", () => {
    const newer: SimpleChatRow = {
      ...baseRow,
      key: "op_newer",
      conversationId: "conv_newer",
      href: "/app/operation/op_newer",
      title: "Newer Operation",
      agent: null,
      kind: "operation",
      at: Date.parse("2026-09-20T16:05:00Z"),
      preview: null,
      state: "quiet",
      unreadCount: 0,
    };
    const html = renderRows([newer, baseRow], [baseRow.conversationId]);
    expect(html.indexOf("/app/agent/general-assistant")).toBeLessThan(
      html.indexOf("/app/operation/op_newer"),
    );
  });

  it("renders live-shaped Agent rows (identity only, runtime preview or none)", () => {
    const live: SimpleChatRow = {
      ...baseRow,
      key: "agent_live",
      conversationId: "agent_live",
      href: "/app/agent/live",
      title: "Live Agent",
      agent: null,
      hue: 200,
      glyph: "L",
      state: undefined, // live rows fabricate no state (G4)
      preview: null,
    };
    const html = renderRows([live]);
    expect(html).toContain("Live Agent");
    expect(html).not.toContain('data-testid="chat-preview-line"');
    expect(html).not.toContain("unread messages"); // no fabricated StateTrail label
  });
});

// ---------------------------------------------------------------------------
// 5. The real SIMPLE sidebar list (demo fixture model through SidebarContent)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

// Rendered lazily so the mock above is registered before the component module
// pulls the hook in.
const renderSidebar = async (): Promise<string> => {
  const { SidebarContent } = await import("../components/shell/sidebar-content");
  const { setAdvancedMode } = await import("../lib/interface-mode");
  setAdvancedMode(false);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SidebarContent),
    ),
  );
};

describe("the merged Chats list (demo model, simple mode)", () => {
  it("previews render only where the fixture model has messages — no invented lines", async () => {
    const html = await renderSidebar();
    // The two fixture Operation chats have NO recorded messages — no invented
    // preview lines; the six agent chats preview their newest fixture line.
    expect(html.match(/data-testid="chat-preview-line"/g)?.length).toBe(6);
    expect(html).toContain("You: Go ahead — focus on 2024 or later.");
  });

  it("a static render claims no clock precision — timestamps mount with the render clock", async () => {
    const html = await renderSidebar();
    // The render clock is mount-gated (lib/relative-time.ts): server and
    // first client renders agree on "no timestamp yet" instead of a label
    // that would drift between them (hydration honesty, G4).
    expect(html).not.toContain('data-testid="chat-timestamp"');
  });
});
