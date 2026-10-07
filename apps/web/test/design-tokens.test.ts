import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UI_DESIGN §2.1 token-only architecture: every color in component source is a
 * Tailwind/theme token resolved from the token layer in globals.css. Raw color
 * literals (hex, rgb(), rgba(), hsl()) are allowed ONLY in the token definition
 * file itself, so a future light theme (PRD §21.19 register item) stays cheap.
 */
const APP_DIR = join(import.meta.dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"].map((dir) => join(APP_DIR, dir));
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo"]);

const RAW_COLOR_PATTERNS: Array<[RegExp, string]> = [
  [/#[0-9a-fA-F]{3,8}\b/, "hex literal"],
  [/\brgba?\(/, "rgb()/rgba() literal"],
  [/\bhsla?\(/, "hsl()/hsla() literal"],
  [/\boklch\(/, "oklch() literal"],
];

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

/** The single file allowed to carry raw color values (UI_DESIGN §2.1 table). */
const TOKEN_FILE = join(APP_DIR, "app", "globals.css");

describe("design tokens (UI_DESIGN §2.1)", () => {
  it("token layer defines every §2.1 color token", () => {
    const css = readFileSync(TOKEN_FILE, "utf8");
    const required = [
      "--color-canvas",
      "--color-surface",
      "--color-surface-elevated",
      "--color-brand",
      "--color-brand-deep",
      "--color-sky",
      "--color-cool-highlight",
      "--color-text",
      "--color-muted",
      "--color-live",
      "--color-line",
      "--color-line-accent",
      "--color-approval",
      "--color-failed",
    ];
    const missing = required.filter((token) => !css.includes(token));
    expect(missing, `missing tokens in globals.css: ${missing.join(", ")}`).toEqual([]);
  });

  it("component source carries no raw color literals", () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listSourceFiles(dir)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          for (const [pattern, label] of RAW_COLOR_PATTERNS) {
            if (pattern.test(line)) {
              violations.push(`${file}:${index + 1} ${label}: ${line.trim()}`);
            }
          }
        });
      }
    }
    expect(violations, "raw colors must live only in the token layer").toEqual([]);
  });

  it("glow token exists as the §2.1 emphasis shadow", () => {
    const css = readFileSync(TOKEN_FILE, "utf8");
    expect(css).toMatch(/--shadow-glow/);
  });
});
