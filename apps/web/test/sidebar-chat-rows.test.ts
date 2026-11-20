import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatPreviewFromMessages,
  chatRowMenuItems,
  clampMenuPosition,
  type ChatRowMenuEntry,
  ChatRowMenuSheet,
  nextMenuFocusIndex,
  orderChatsPinFirst,
  SimpleChatRows,
  type SimpleChatRow,
} from "../components/shell/sidebar-content";
import { formatChatTimestamp } from "../lib/relative-time";
import { agentById, messagesForConversation } from "../lib/fixtures";
import { routes } from "../lib/routes";
import {
  resetChatViewPrefsForTests,
  setChatUnreadMark,
  toggleChatPin,
} from "../lib/chat-view-prefs";

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

const renderRows = (rows: SimpleChatRow[]): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SimpleChatRows, { rows, pathname: "/app", now: NOW }),
    ),
  );

afterEach(() => {
  resetChatViewPrefsForTests();
});

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
    toggleChatPin(baseRow.conversationId);
    const pinned = renderRows([baseRow]);
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
    toggleChatPin(baseRow.conversationId);
    const html = renderRows([newer, baseRow]);
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

// ---------------------------------------------------------------------------
// 6. Wave A chunk A2 — the row context menu: item contract (pure)
// ---------------------------------------------------------------------------

describe("row menu items (order, labels, reasons)", () => {
  const noops = {
    onTogglePin: () => undefined,
    onSetMark: () => undefined,
    onCopy: () => undefined,
  };
  const labelsOf = (entries: ChatRowMenuEntry[]): string[] =>
    entries.map((entry) => (entry.kind === "item" ? entry.label : "---"));

  it("agent rows: Pin → read-state → — → Copy conversation ID → — → Agent settings", () => {
    const entries = chatRowMenuItems({
      kind: "agent",
      conversationId: "conversation_agent_general_assistant",
      pinned: false,
      mark: undefined,
      runtimeUnread: false,
      containerReady: true,
      agentSlug: "general-assistant",
      ...noops,
    });
    expect(labelsOf(entries)).toEqual([
      "Pin",
      "Mark as unread",
      "---",
      "Copy conversation ID",
      "---",
      "Agent settings",
    ]);
    const settings = entries.at(-1);
    expect(settings?.kind).toBe("item");
    if (settings?.kind === "item") {
      expect(settings.href).toBe(routes.settings("agents/general-assistant"));
      expect(settings.disabled).toBe(false);
    }
  });

  it("operation rows end with Open roster pointing at the operation chat", () => {
    const entries = chatRowMenuItems({
      kind: "operation",
      conversationId: "conversation_op_research_paper",
      pinned: false,
      mark: undefined,
      runtimeUnread: false,
      containerReady: true,
      operationHref: routes.operation("chat-research-paper"),
      ...noops,
    });
    expect(labelsOf(entries)).toEqual([
      "Pin",
      "Mark as unread",
      "---",
      "Copy conversation ID",
      "---",
      "Open roster",
    ]);
    const roster = entries.at(-1);
    if (roster?.kind === "item") {
      expect(roster.href).toBe("/app/operation/chat-research-paper");
    }
  });

  it("a pinned row offers Unpin; a runtime-unread row offers Mark as read", () => {
    const pinned = labelsOf(
      chatRowMenuItems({
        kind: "agent",
        conversationId: "conv",
        pinned: true,
        mark: undefined,
        runtimeUnread: false,
        containerReady: true,
        agentSlug: "researcher",
        ...noops,
      }),
    );
    expect(pinned[0]).toBe("Unpin");
    expect(pinned[1]).toBe("Mark as unread");

    const unread = labelsOf(
      chatRowMenuItems({
        kind: "agent",
        conversationId: "conv",
        pinned: false,
        mark: undefined,
        runtimeUnread: true,
        containerReady: true,
        agentSlug: "researcher",
        ...noops,
      }),
    );
    expect(unread[0]).toBe("Pin");
    expect(unread[1]).toBe("Mark as read");
  });

  it("the overlay wins over runtime state for the read-state item", () => {
    const overlayUnread = chatRowMenuItems({
      kind: "agent",
      conversationId: "conv",
      pinned: false,
      mark: "unread",
      runtimeUnread: false,
      containerReady: true,
      agentSlug: "researcher",
      ...noops,
    });
    const unreadItem = overlayUnread.find((e) => e.kind === "item" && e.key === "mark");
    expect(unreadItem?.kind === "item" && unreadItem.label).toBe("Mark as read");

    const overlayRead = chatRowMenuItems({
      kind: "agent",
      conversationId: "conv",
      pinned: false,
      mark: "read",
      runtimeUnread: true,
      containerReady: true,
      agentSlug: "researcher",
      ...noops,
    });
    const markItem = overlayRead.find((e) => e.kind === "item" && e.key === "mark");
    expect(markItem?.kind === "item" && markItem.label).toBe("Mark as unread");
    // The overlay is browser-local — the title says so.
    expect(markItem?.kind === "item" && markItem.title).toBe("Marked unread here only");
  });

  it("Agent settings is disabled with its reason when the container is not ready; Open roster never is", () => {
    const agentEntries = chatRowMenuItems({
      kind: "agent",
      conversationId: "conv",
      pinned: false,
      mark: undefined,
      runtimeUnread: false,
      containerReady: false,
      agentSlug: "researcher",
      ...noops,
    });
    const settings = agentEntries.at(-1);
    expect(settings?.kind === "item" && settings.disabled).toBe(true);
    expect(settings?.kind === "item" && settings.disabledReason).toBe(
      "Settings need the workspace ready",
    );

    const operationEntries = chatRowMenuItems({
      kind: "operation",
      conversationId: "conv",
      pinned: false,
      mark: undefined,
      runtimeUnread: false,
      containerReady: false,
      operationHref: "/app/operation/op",
      ...noops,
    });
    const roster = operationEntries.at(-1);
    expect(roster?.kind === "item" && roster.disabled).toBe(false);
  });

  it("no delete/archive/rename exists in v1 — persistent chats, and the runtime has no such commands (G2)", () => {
    const entries = chatRowMenuItems({
      kind: "agent",
      conversationId: "conv",
      pinned: false,
      mark: undefined,
      runtimeUnread: false,
      containerReady: true,
      agentSlug: "researcher",
      ...noops,
    });
    expect(labelsOf(entries).join(" | ").toLowerCase()).not.toMatch(/delete|archive|rename/);
  });
});

// ---------------------------------------------------------------------------
// 7. Wave A chunk A2 — menu geometry + roving focus (pure)
// ---------------------------------------------------------------------------

describe("menu geometry + roving focus", () => {
  it("clampMenuPosition keeps the sheet inside the viewport with an 8px margin", () => {
    // A pointer click near the right/bottom edge pulls the sheet back in.
    expect(clampMenuPosition(1200, 800, 224, 168, 1280, 900)).toEqual({ x: 1048, y: 724 });
    // An in-bounds position passes through.
    expect(clampMenuPosition(40, 40, 224, 168, 1280, 900)).toEqual({ x: 40, y: 40 });
    // Tiny viewports never go negative — the 8px floor wins.
    expect(clampMenuPosition(0, 0, 224, 168, 200, 120)).toEqual({ x: 8, y: 8 });
  });

  it("nextMenuFocusIndex roves the enabled items and wraps", () => {
    expect(nextMenuFocusIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextMenuFocusIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextMenuFocusIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextMenuFocusIndex(-1, "ArrowUp", 3)).toBe(2);
    expect(nextMenuFocusIndex(1, "Home", 3)).toBe(0);
    expect(nextMenuFocusIndex(1, "End", 3)).toBe(2);
    expect(nextMenuFocusIndex(1, "ArrowRight", 3)).toBeNull();
    expect(nextMenuFocusIndex(1, "Escape", 3)).toBeNull();
    expect(nextMenuFocusIndex(0, "ArrowDown", 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Wave A chunk A2 — the menu sheet markup (a11y contract)
// ---------------------------------------------------------------------------

describe("the chat row menu sheet (a11y)", () => {
  const entries = chatRowMenuItems({
    kind: "agent",
    conversationId: "conversation_agent_general_assistant",
    pinned: true,
    mark: undefined,
    runtimeUnread: true,
    containerReady: false,
    agentSlug: "general-assistant",
    onTogglePin: () => undefined,
    onSetMark: () => undefined,
    onCopy: () => undefined,
  });

  const renderSheet = (): string =>
    renderToStaticMarkup(createElement(ChatRowMenuSheet, { entries, onDismiss: () => undefined }));

  it("renders role=menu with role=menuitem rows, hairline separators, and the 30px/14px recipe", () => {
    const html = renderSheet();
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)?.length).toBe(4);
    expect(html.match(/role="separator"/g)?.length).toBe(2);
    expect(html).toMatch(/min-h-\[30px\]/);
    expect(html).toMatch(/text-sm/); // 14px
    expect(html).toMatch(/h-px/); // hairline
  });

  it("the disabled item carries opacity + the reason in its title", () => {
    const html = renderSheet();
    expect(html).toMatch(/opacity-40/);
    expect(html).toContain("Settings need the workspace ready");
  });

  it("labels render as the short declaratives — no exclamation marks", () => {
    const html = renderSheet();
    expect(html).toContain("Unpin"); // pinned fixture
    expect(html).toContain("Mark as read");
    expect(html).toContain("Copy conversation ID");
    expect(html).not.toMatch(/!+/);
  });
});

// ---------------------------------------------------------------------------
// 9. Wave A chunk A2 — the row menu trigger + overlay wiring
// ---------------------------------------------------------------------------

describe("the row menu trigger (a11y)", () => {
  it("every row carries a hover/keyboard-reachable trigger with menu semantics", () => {
    const html = renderRows([baseRow]);
    expect(html).toContain('aria-label="Chat options for General Assistant"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // Keyboard-reachable: in the DOM always, revealed on hover or focus.
    expect(html).toMatch(/opacity-0[^"]*group-hover:opacity-100/);
  });
});

describe("pins and overlays through the real store wiring", () => {
  it("the overlay read mark suppresses the runtime unread pill for that row", () => {
    expect(renderRows([baseRow])).toContain(">2</span>"); // runtime pill
    setChatUnreadMark(baseRow.conversationId, "read");
    expect(renderRows([baseRow])).not.toContain(">2</span>");
  });

  it("the overlay unread mark renders a dot, never a fake count", () => {
    const quiet: SimpleChatRow = { ...baseRow, state: "quiet", unreadCount: 0 };
    const html = renderRows([quiet]);
    expect(html).not.toContain("chat-unread-dot");
    setChatUnreadMark(quiet.conversationId, "unread");
    const marked = renderRows([quiet]);
    expect(marked).toContain('data-testid="chat-unread-dot"');
    expect(marked).toContain("Marked unread here only");
    expect(marked).not.toContain('class="inline-flex min-w-5'); // no count pill
  });
});
