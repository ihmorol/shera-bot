import type { NextConfig } from "next";

/**
 * S01 placeholder configuration. Workspace packages are consumed as TypeScript
 * source (each package exports ./src/index.ts), so the client that imports them
 * in S08 adds `transpilePackages` here — not before.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
