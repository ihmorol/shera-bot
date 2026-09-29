import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D44 vocabulary guard (UI_DESIGN §1 rule 1): the product vocabulary is
 * Pack → Operations → Agents. "Expert" and "Scene" are retired aliases and
 * must never appear in UI source (which is where all rendered copy lives).
 * "Subagent" (D46) is allowed — it is a current term for a subordinate agent
 * execution inside an Operation, not a retired alias.
 */
const APP_DIR = join(import.meta.dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"].map((dir) => join(APP_DIR, dir));
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo"]);

const BANNED_TERMS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bExperts?\b/, reason: '"Expert" is retired — use "Agent" (D44)' },
  { pattern: /\bScenes?\b/, reason: '"Scene" is retired — use "Operation" (D29, D44)' },
  { pattern: /\bgroup chats?\b/i, reason: '"group chat" is retired — use "Operation"' },
  { pattern: /\btask chats?\b/i, reason: '"task chat" is retired (D41) — use "Operation"' },
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

describe("canonical vocabulary (D44)", () => {
  it("uses Agent/Operation everywhere — no retired aliases in UI source", () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listSourceFiles(dir)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          for (const { pattern, reason } of BANNED_TERMS) {
            if (pattern.test(line)) {
              violations.push(`${file}:${index + 1} — ${reason}: ${line.trim()}`);
            }
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
