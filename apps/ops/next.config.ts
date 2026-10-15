import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The monorepo root, as apps/web pins it: `next` lives in the root pnpm store.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // Workspace packages write relative imports with an explicit ".js" for a ".ts" file on disk; webpack needs the same
  // mapping Node's loader and TypeScript apply (see apps/web/next.config.mjs).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
