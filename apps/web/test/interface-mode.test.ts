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

import { SidebarContent } from "../components/shell/sidebar-content";
import {
  ADVANCED_SETTINGS_CATEGORIES,
  CORE_SETTINGS_CATEGORIES,
  SETTINGS_CATEGORIES,
} from "../lib/settings-categories";
import { readAdvancedMode, setAdvancedMode } from "../lib/interface-mode";

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
