import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The G7 pin (issue #24 AC9): the live-provider suite is opt-in ONLY — it is
 * documented, runnable manually with the owner's key, and structurally
 * EXCLUDED from the default test run. Exclusion is by location: the vitest
 * include patterns cover tests/ and the apps source/test trees, so the live
 * suite lives under apps/user-runtime/live/ and can never be picked up by
 * `pnpm test` (no allowlist edit can silently add it, and no CI default run
 * executes it).
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const LIVE_DIR = join(ROOT, "apps", "user-runtime", "live");
const LIVE_SUITE = join(LIVE_DIR, "providers-live.test.ts");

describe("the G7 live-provider posture (issue #24 AC9)", () => {
  it("the documented live suite exists beside the runtime (not in a tested tree)", () => {
    expect(existsSync(LIVE_SUITE)).toBe(true);
    expect(existsSync(join(LIVE_DIR, "README.md"))).toBe(true);
  });

  it("no default vitest include pattern can match the live directory", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    // The literal include list, parsed loosely from the config source — the
    // same list `pnpm test` runs. None of the globs may reach apps/*/live/.
    const includeMatch = config.match(/include:\s*\[([^\]]+)\]/s);
    expect(includeMatch).not.toBeNull();
    const patterns = (includeMatch![1] ?? "")
      .split(",")
      .map((line) => line.trim().replace(/^["']|["']$/g, ""))
      .filter((line) => line.length > 0);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern, `include pattern ${pattern} must not reach the live dir`).not.toContain(
        "live",
      );
    }
    // And the live dir is genuinely outside every pattern's tree.
    for (const pattern of patterns) {
      const base = pattern.split("/")[0]!;
      expect(base === "apps" ? pattern : base).not.toMatch(/^apps\/\*\/live/);
    }
  });

  it("the live suite refuses to run without explicit owner configuration", () => {
    const source = readFileSync(LIVE_SUITE, "utf8");
    // The suite guards itself on the env contract — no env, no run, no
    // accidental live call (G7: opt-in means the OWNER's explicit act).
    expect(source).toContain("SHERA_LIVE_PROVIDER_PROTOCOL");
    expect(source).toContain("describe.skipIf");
  });
});
