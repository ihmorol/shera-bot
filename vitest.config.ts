import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Test tiers follow E8 (unit / contract / integration / e2e / recovery / security /
 * benchmark). Test files live under tests/<tier>/; S01 adds the first contract-tier
 * smoke test, later slices fill the remaining tiers. Live-provider tests are opt-in
 * and never part of the default run (G7).
 */
export default defineConfig({
  // apps/web source uses the Next-style "@/..." alias for its own modules.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/", import.meta.url)),
    },
  },
  // S08: component tests render apps/web .tsx components in the node
  // environment. apps/web's tsconfig keeps Next's `jsx: "preserve"` (which
  // the transform would copy verbatim, leaving unparseable JSX), so the
  // transform pins the automatic JSX runtime here — .ts suites are unaffected.
  oxc: {
    jsx: { runtime: "automatic", importSource: "react" },
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
    // Integration suites (S05: real PostgreSQL cluster + OAuth flow) exceed
    // the unit default; unit tests still finish in milliseconds.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    environment: "node",
    passWithNoTests: false,
  },
});
