import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";
import { resolve, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const WEB = resolve(HERE, "..");

/**
 * The S34 browser-matrix harness (the recorded S24-harness pattern): the REAL
 * shipped web components, fed with frozen fixture state (E43 tier-1/tier-2
 * posture — hermetic, deterministic, scorers over frozen snapshots). It is
 * surface QA: it proves what the shipped components render and how they
 * behave in real browsers — it never vouches for live runtime behavior, which
 * stays with the vitest legs (the ledger separates the two on purpose).
 */
export default defineConfig({
  root: HERE,
  // The web app's tsconfig sets jsx: preserve (Next) — the harness compiles
  // with esbuild's automatic runtime instead.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  resolve: {
    alias: {
      "@": WEB,
      "next/link": resolve(HERE, "link-stub.tsx"),
      "next/navigation": resolve(HERE, "navigation-stub.ts"),
    },
  },
  // The harness mounts fixture data only — no HMR overlays over assertions.
  server: { port: 4621, strictPort: true, host: "127.0.0.1", hmr: false },
});
