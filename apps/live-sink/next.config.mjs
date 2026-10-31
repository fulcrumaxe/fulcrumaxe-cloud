import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained output: test/built.test.ts moves it to another directory and runs it there.
  output: "standalone",
  // Repo root, as apps/web pins it: `next` lives in the root pnpm store, and a lower root drops files from the trace.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
