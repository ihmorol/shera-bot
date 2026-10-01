import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * G1 vocabulary guard, scoped to @shera-bot/agent-pack-sdk (S10 chunk 1):
 * the product vocabulary is Pack → Operations → Agents. "Expert" and "Scene"
 * are retired aliases (D29, D44) and must not appear anywhere in this package —
 * code, schemas, fixtures, or comments. "Subagent" (D46) is allowed: it names a
 * subordinate agent execution within an Operation, not a separate object type.
 *
 * This file is the only file exempt from its own scan — it must quote the
 * banned terms to ban them (same pattern as apps/web/test/vocabulary.test.ts).
 */
const PACKAGE_ROOT = join(import.meta.dirname, "..");
const SELF_PATH = join(import.meta.dirname, "vocabulary.test.ts");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo"]);
const SCAN_EXTENSIONS = [".ts", ".json", ".md"];

const BANNED_TERMS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bexperts?\b/i, reason: '"Expert" is retired — use "Agent" (D44)' },
  { pattern: /\bscenes?\b/i, reason: '"Scene" is retired — use "Operation" (D29, D44)' },
];

function listFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) files.push(...listFiles(full));
    } else if (SCAN_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

describe("canonical vocabulary (D44) in @shera-bot/agent-pack-sdk", () => {
  it("never uses the retired aliases Expert or Scene", () => {
    const violations: string[] = [];
    for (const file of listFiles(PACKAGE_ROOT)) {
      if (file === SELF_PATH) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { pattern, reason } of BANNED_TERMS) {
          if (pattern.test(line)) {
            violations.push(`${file}:${index + 1} — ${reason}: ${line.trim()}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
