import type { NextConfig } from "next";

/**
 * Workspace packages are consumed as TypeScript source (each package exports
 * ./src/index.ts), so every workspace package the client imports must be
 * listed in `transpilePackages`. S08 chunk 2 imports @shera-bot/contracts for
 * the typed mock fixtures (UI_DESIGN §9).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@shera-bot/contracts"],
  async rewrites() {
    const base = process.env["CONTROL_PLANE_URL"]?.replace(/\/$/, "");
    return {
      beforeFiles: base
        ? [{ source: "/api/runtime/live", destination: `${base}/api/runtime/live` }]
        : [],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
