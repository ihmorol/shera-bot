import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageList } from "../components/chat/message-list";
import { ArtifactCard, ToolCallCard } from "../components/chat/cards";
import { Composer } from "../components/chat/composer";
import { StreamingMessage } from "../components/chat/streaming-message";
import {
  EVENT_GA_WEB_SEARCH,
  EVENT_TUTOR_APPROVAL,
  FIXTURE_ARTIFACTS,
  buildThread,
} from "../lib/fixtures";
import { insertDaySeparators } from "../lib/thread-layout";

/**
 * §2.3 accessibility baseline — axe-style static checks plus the documented
 * manual pass list. Everything interactive is a native link/button/textarea
 * (natively tabbable, Enter/Space activated); focus styling comes from the
 * global :focus-visible rule; no positive tabindex exists anywhere.
 *
 * MANUAL PASS LIST (§2.3 "documented tab order per screen" — S3, to run in a
 * real browser; static checks below cover what markup can prove):
 *   1. Tab order for S3: skip link ("Skip to conversation") → sidebar
 *      settings gear → six Agent links → three template links → "+ New" →
 *      two active-chat links → [jump-to-unread pill when unread] →
 *      [Stop streaming while a demo stream runs] → [artifact Download,
 *      aria-disabled but focusable] → composer textarea → send button.
 *   2. Every stop shows a visible 2px --sky outline with 2px offset (global
 *      :focus-visible rule) — spot-check sidebar, thread pill, composer.
 *   3. Screen reader: Agent messages announce "«name» said:"; streaming text
 *      announces politely (throttled); tool/approval cards announce
 *      assertively on insertion; the disconnected banner announces via
 *      role="alert"; reconnecting via polite status.
 *   4. Color independence: state dots pair with counts/spinners/sr-only
 *      labels; banners pair icon + text; risk badges are text.
 *   5. prefers-reduced-motion: cursor blink, running spinner, and sheet
 *      entrance animations are stilled (globals.css global rule).
 *   6. Keyboard-only run of the full path: sidebar → open chat → composer →
 *      a card (artifact Download) → settings gear; no keyboard trap.
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

const APP_DIR = join(import.meta.dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"].map((dir) => join(APP_DIR, dir));
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo"]);

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) files.push(...listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

const GA_TIMELINE = insertDaySeparators(buildThread("conversation_agent_general_assistant"));

describe("focus visibility (§2.3)", () => {
  it("keeps the global focus-visible ring and never removes outlines", () => {
    const css = readFileSync(join(APP_DIR, "app", "globals.css"), "utf8");
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/outline:\s*2px solid var\(--color-sky\)/);
    for (const dir of SCAN_DIRS) {
      for (const file of listSourceFiles(dir)) {
        expect(readFileSync(file, "utf8"), `${file} removes outlines`).not.toMatch(
          /outline:\s*(none|0)/,
        );
      }
    }
  });

  it("keeps the global :focus-visible rule the SINGLE focus treatment", () => {
    // The per-field focus utilities once shadowed the token rule (and the
    // utilities layer always loses to the unlayered global rule, so they were
    // dead code); components must never redeclare the ring.
    for (const dir of SCAN_DIRS) {
      for (const file of listSourceFiles(dir)) {
        expect(readFileSync(file, "utf8"), `${file} redeclares the focus ring`).not.toMatch(
          /focus-visible:outline|focus:outline-none/,
        );
      }
    }
    // The button transition must not animate outline-color — the ring has to
    // land at full strength (no fade-in from the resting currentcolor).
    const button = readFileSync(join(APP_DIR, "components", "ui", "button.tsx"), "utf8");
    expect(button).not.toMatch(/\btransition-colors\b/);
    expect(button).toMatch(/transition-\[[^\]]*border-color[^\]]*\]/);
    expect(button).not.toMatch(/transition-\[[^\]]*outline-color/);
  });

  it("uses no positive tabindex anywhere (native tab order only)", () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listSourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        if (/tab[Ii]ndex\s*=\s*["'{]?[1-9]/.test(source)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("accessible names on icon-only controls (§2.3)", () => {
  it("names every shipped icon-only button", () => {
    // Composer send button.
    const composer = render(
      createElement(Composer, { agentName: "Researcher", onSend: () => undefined }),
    );
    expect(composer).toContain('aria-label="Send message"');
    // Streaming stop button.
    const streaming = render(
      createElement(StreamingMessage, {
        agentId: "agent_general_assistant",
        visibleText: "partial",
        announcementText: "partial",
        done: false,
        stopped: false,
        onStop: () => undefined,
      }),
    );
    expect(streaming).toContain('aria-label="Stop streaming"');
    // Sidebar chrome: settings gear + mobile menu (source-level audit).
    const sidebar = readFileSync(
      join(APP_DIR, "components", "shell", "sidebar-content.tsx"),
      "utf8",
    );
    expect(sidebar).toContain('aria-label="Open settings"');
    const shell = readFileSync(join(APP_DIR, "components", "shell", "app-shell.tsx"), "utf8");
    expect(shell).toContain('aria-label="Open navigation"');
    // Radix sheet close button.
    const sheet = readFileSync(join(APP_DIR, "components", "ui", "sheet.tsx"), "utf8");
    expect(sheet).toContain('aria-label="Close"');
  });

  it("labels the composer input itself, not just the send button", () => {
    const composer = render(
      createElement(Composer, { agentName: "Researcher", onSend: () => undefined }),
    );
    expect(composer).toContain('aria-label="Message Researcher"');
  });
});

describe("sender + event announcements (§2.3)", () => {
  it("Agent messages announce the sender («name» said:)", () => {
    const ga = render(
      createElement(MessageList, { items: GA_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(ga).toContain("General Assistant said:");
    const researcher = render(
      createElement(MessageList, {
        items: insertDaySeparators(buildThread("conversation_agent_researcher")),
        jumpTargetId: null,
        unreadCount: 0,
      }),
    );
    expect(researcher).toContain("Researcher said:");
  });

  it("tool and approval cards are assertive live regions", () => {
    const proposed = render(createElement(ToolCallCard, { event: EVENT_GA_WEB_SEARCH }));
    expect(proposed).toContain('aria-live="assertive"');
    const approval = render(createElement(ToolCallCard, { event: EVENT_TUTOR_APPROVAL }));
    expect(approval).toContain('aria-live="assertive"');
    expect(approval).toContain("aria-atomic");
  });

  it("non-event cards carry no live region (no announcement noise)", () => {
    const artifact = render(createElement(ArtifactCard, { artifact: FIXTURE_ARTIFACTS[0]! }));
    expect(artifact).not.toContain("aria-live");
  });
});

describe("color never the only signal (§2.3)", () => {
  it("sidebar state dots pair with counts/spinners/sr-only labels", () => {
    const sidebar = readFileSync(
      join(APP_DIR, "components", "shell", "sidebar-content.tsx"),
      "utf8",
    );
    expect(sidebar).toContain("STATE_LABELS");
    expect(sidebar).toContain('"waiting for your approval"');
    expect(sidebar).toContain("animate-spin");
    expect(sidebar).toContain("sr-only");
  });

  it("banners and status footers pair icons or text with color", () => {
    // Icon + text on cards (asserted via markup), spinner + text on banners
    // (connection.test.ts), ticks carry icons + words in the message list.
    const timeline = insertDaySeparators(buildThread("conversation_agent_programming_tutor"));
    const html = render(
      createElement(MessageList, { items: timeline, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(html).toContain("Pausing for your approval");
    expect(html).toContain("EXTERNAL_WRITE");
  });
});

describe("keyboard reachability hooks (§2.3)", () => {
  it("the artifact Download stays keyboard-reachable via aria-disabled", () => {
    const html = render(createElement(ArtifactCard, { artifact: FIXTURE_ARTIFACTS[0]! }));
    // Focusable (no disabled attribute) and announced as dimmed.
    expect(html).toContain('type="button"');
    expect(html).not.toContain(" disabled");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Demo data — file serving arrives with the runtime");
  });
});
