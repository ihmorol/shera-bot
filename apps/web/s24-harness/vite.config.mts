import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";
import { resolve, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const WEB = resolve(HERE, "..");

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
    },
  },
  server: { port: 4620, strictPort: true, host: "127.0.0.1" },
});
