import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar reads the active path for the nav highlight; the notification
// bell's Settings jump soft-navigates through the router.
vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

import { SidebarContent, mergeChatsByRecency } from "../components/shell/sidebar-content";
import {
  ADVANCED_SETTINGS_CATEGORIES,
  CORE_SETTINGS_CATEGORIES,
  SETTINGS_CATEGORIES,
} from "../lib/settings-categories";
import {
  readAdvancedMode,
  resetSessionChoice,
  setAdvancedMode,
  subscribe,
} from "../lib/interface-mode";

const render = (element: React.ReactElement): string =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, element));

describe("interface mode (owner direction, 2026-11-20)", () => {
  beforeEach(() => {
    setAdvancedMode(false);
  });
  afterEach(() => {
    setAdvancedMode(false);
  });

  it("defaults to simple — the first paint is the minimal UI", () => {
    expect(readAdvancedMode()).toBe(false);
  });

  it("setAdvancedMode toggles the read value both ways", () => {
    setAdvancedMode(true);
    expect(readAdvancedMode()).toBe(true);
    setAdvancedMode(false);
    expect(readAdvancedMode()).toBe(false);
  });

  it("a truly fresh document (no session choice, no storage) reads simple", () => {
    resetSessionChoice();
    expect(readAdvancedMode()).toBe(false);
  });

  it("the localStorage layer parses '1'/'0' and falls back to simple otherwise", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage;
    try {
      resetSessionChoice();
      store.set("shera-advanced-mode", "1");
      expect(readAdvancedMode()).toBe(true);
      store.set("shera-advanced-mode", "0");
      expect(readAdvancedMode()).toBe(false);
      store.set("shera-advanced-mode", "garbage");
      expect(readAdvancedMode()).toBe(false);
      // Writes persist through the same key.
      setAdvancedMode(true);
      expect(store.get("shera-advanced-mode")).toBe("1");
      setAdvancedMode(false);
      expect(store.get("shera-advanced-mode")).toBe("0");
    } finally {
      globalThis.localStorage = original;
      resetSessionChoice();
    }
  });

  it("subscribe/unsubscribe/subscribe keeps notifying — one listener for the module lifetime", () => {
    const seen: boolean[] = [];
    const observer = () => seen.push(readAdvancedMode());
    const unsubscribe = subscribe(observer);
    setAdvancedMode(true);
    unsubscribe();
    setAdvancedMode(false);
    expect(seen).toEqual([true]);
    const resubscribe = subscribe(observer);
    setAdvancedMode(true);
    resubscribe();
    expect(seen).toEqual([true, true]);
    setAdvancedMode(false);
  });

  it("the simple sidebar renders one merged chat list — direct chats and Operation chats together", () => {
    const html = render(createElement(SidebarContent));
    // One list, both kinds of conversation (fixture demo model).
    expect(html).toContain("General Assistant");
    expect(html).toContain("Research Paper");
    // No template gallery, no role descriptions, no duplicated groups.
    expect(html).not.toContain("Exam Preparation"); // a template title, not a chat
    expect(html).not.toContain("Finds, reads, and synthesizes"); // a role description
    expect(html).not.toContain("Active chats");
    // The primary action and the mode toggle are present.
    expect(html).toContain("New Operation");
    expect(html).toContain("Advanced");
  });

  it("the advanced sidebar restores the documented structure (§3.2)", () => {
    setAdvancedMode(true);
    const html = render(createElement(SidebarContent));
    expect(html).toContain("Agents");
    expect(html).toContain("Operations");
    expect(html).toContain("Active chats");
    expect(html).toContain("Exam Preparation"); // the template gallery is back
    expect(html).toContain("student pack v1");
  });
});

describe("merged Chats recency order (D52, spec-review fix)", () => {
  it("agent and Operation rows interleave by their recorded timestamps, newest first, agents winning ties", () => {
    const agentRows = [
      { kind: "agent" as const, key: "a-old", at: 100 },
      { kind: "agent" as const, key: "a-new", at: 300 },
    ];
    const operationRows = [
      { kind: "operation" as const, key: "op-mid", at: 200 },
      { kind: "operation" as const, key: "op-tie", at: 300 },
    ];
    const merged = mergeChatsByRecency(agentRows, operationRows);
    expect(merged.map((row) => `${row.kind}:${row.key}`)).toEqual([
      "agent:a-new", // 300, agent rows win the tie with stable insertion order
      "operation:op-tie", // 300
      "operation:op-mid", // 200
      "agent:a-old", // 100
    ]);
  });
});

describe("settings register grouping (owner direction, 2026-11-20)", () => {
  it("core leads, the rest stays in the advanced group — the D16 register is untouched", () => {
    expect(CORE_SETTINGS_CATEGORIES.length + ADVANCED_SETTINGS_CATEGORIES.length).toBe(
      SETTINGS_CATEGORIES.length,
    );
    const coreSlugs = CORE_SETTINGS_CATEGORIES.map((c) => c.slug);
    // D16's recorded order is preserved within each group.
    expect(coreSlugs).toEqual([
      "account",
      "agents",
      "providers",
      "credits",
      "memory",
      "notifications",
    ]);
    const advancedSlugs = ADVANCED_SETTINGS_CATEGORIES.map((c) => c.slug);
    expect(advancedSlugs).toEqual([
      "tools",
      "permissions",
      "workspace",
      "files",
      "schedules",
      "privacy",
      "runtime",
      "git",
      "backups",
    ]);
    expect(advancedSlugs.length).toBe(SETTINGS_CATEGORIES.length - coreSlugs.length);
  });
});
