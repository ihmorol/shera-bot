import { defineConfig } from "vitest/config";

/**
 * Test tiers follow E8 (unit / contract / integration / e2e / recovery / security /
 * benchmark). Test files live under tests/<tier>/; S01 adds the first contract-tier
 * smoke test, later slices fill the remaining tiers. Live-provider tests are opt-in
 * and never part of the default run (G7).
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
