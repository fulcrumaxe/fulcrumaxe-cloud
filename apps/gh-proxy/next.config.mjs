import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The proxy-only deployable. Nothing here may add a page, a redirect, a
 * rewrite, a header rule or an image optimizer: the gate in middleware.ts and
 * the one route are the whole surface (test/strippedBuild.test.ts runs
 * `next build` and lists what it produced).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // The route and its handler are the same source files apps/web ships, so the
  // audited code is the code that runs; externalDir lets this app compile them.
  experimental: { externalDir: true },
  // Repo root, so the traced output includes the workspace packages.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // A 308 to or from a trailing slash is a redirect the sandbox forwarder could follow.
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // Workspace packages import ".ts" source through ".js" specifiers.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
