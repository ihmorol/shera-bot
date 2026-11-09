import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

/**
 * The S34 browser-matrix config (PRD §18 browsers via the E15 embed:
 * Playwright Test). Projects map the §18 browser families honestly:
 *
 *   chromium — Playwright's bundled Chromium build (the Chrome/Edge rendering
 *              engine family)
 *   chrome   — the system Google Chrome binary via the channel seam
 *   firefox  — Playwright's bundled Firefox build (obtained via the official
 *              installer into the worktree-local .browsers-cache when needed)
 *   webkit   — Playwright's bundled WebKit build (the Safari rendering engine
 *              family; NOT macOS Safari itself)
 *
 * Microsoft Edge as a distinct binary is NOT-VERIFIED in this environment
 * (not installed; recorded in the ledger row, never faked). The runner probes
 * every project and passes --project only for obtainable binaries.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: "test-results",
  reporter: process.env["SHERA_PW_JSON_OUT"]
    ? [["line"], ["json", { outputFile: process.env["SHERA_PW_JSON_OUT"] }]]
    : [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4621",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "node_modules/.bin/vite --config apps/web/s34-harness-matrix/vite.config.mts",
    url: "http://127.0.0.1:4621",
    cwd: resolve(import.meta.dirname, "..", "..", ".."),
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
