import path from "node:path";
import { fileURLToPath } from "node:url";
import { withWorkflow } from "workflow/next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// D#37 WS-C criterion 13: the exact CSP and headers on `/`, the static
// shell prefix (`/s/:path*`, WS-D) and `/api/*`. This is a plain-JS copy
// of apps/web/lib/shell/headers.ts's SHELL_SECURITY_HEADERS -- next.config.mjs
// is loaded by plain Node before Next's own TypeScript pipeline exists,
// so it cannot `import` a `.ts` file directly (see that file's own
// header comment for the full reasoning). Every dynamic route handler
// also applies these directly via that module, so this array is really
// a safety net for `/` and the future static shell prefix, which have
// no dynamic handler to call it from yet.
//
// Kept in the exact order criterion 13 lists them; if you change one
// copy, change the other -- apps/web/test/headers.test.ts imports this
// file's own `headers()` and pins its output, alongside
// lib/shell/headers.ts's SHELL_SECURITY_HEADERS, to exact literal
// values, so the two copies drifting apart fails a unit test (security
// fix round item 2). The PR description's `next start` curl transcript
// is a live, one-time wire check on top of that, not a substitute.
// D#37 Correction C16c / WS-C4: require-trusted-types-for 'script' moved
// here from the (now removed) Report-Only header, alongside trusted-types
// 'none' (C16c criterion 3 -- the shell needs no policy, so none is
// allowed to be created). See lib/shell/headers.ts's own copy for the
// full reasoning.
const WORKSPACE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'; form-action 'self' https://github.com; upgrade-insecure-requests; report-to csp";

const SHELL_SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: WORKSPACE_CSP },
  { key: "Reporting-Endpoints", value: 'csp="/api/csp-report"' },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// D#37 WS-D criterion 3: "/s/**" (the content-hashed static prefix) is
// served public, max-age=31536000, immutable, on top of the same
// criterion-13 headers -- see lib/shell/headers.ts's own copy
// (SHELL_STATIC_ASSET_HEADERS) for the full reasoning. Kept as its own
// list, not folded into SHELL_SECURITY_HEADERS, so "/" and "/api/*" never
// inherit a cache header meant only for the hashed prefix.
const SHELL_STATIC_ASSET_HEADERS = [
  ...SHELL_SECURITY_HEADERS,
  { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the tracing root to the monorepo root. Next inferred the wrong
  // workspace root when a worktree and the main checkout both have a
  // pnpm-lock.yaml ("Detected additional lockfiles"), which broke the
  // middleware `NextResponse.rewrite()` under a real `next start`; pinning
  // fixed that. It must be the MONOREPO root, not this app's directory:
  // `next` itself lives in the root node_modules/.pnpm store, and with the
  // root at apps/web the file traces dropped files next-server requires
  // lazily (e.g. next/dist/compiled/source-map), so every Vercel function
  // crashed on its first request. scripts/check-next-trace.mjs (run by
  // scripts/check.sh after the build) fails if that happens again.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Root-level ESLint (flat config) is the lint pass/fail check; keep the
  // Next.js build focused on building.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // @fx/design ships TS/TSX source (no separate build step, like every
  // other workspace package) — Next needs to transpile it itself.
  transpilePackages: ["@fx/design"],
  async headers() {
    return [
      { source: "/", headers: SHELL_SECURITY_HEADERS },
      { source: "/s/:path*", headers: SHELL_STATIC_ASSET_HEADERS },
      { source: "/api/:path*", headers: SHELL_SECURITY_HEADERS },
    ];
  },
  // D#37 WS-C criterion 5's "reached through rewrites" is implemented in
  // apps/web/middleware.ts (a `NextResponse.rewrite()` step,
  // shellSessionRewriteStep in lib/shell/shell-paths.ts), not here. A
  // `next.config.mjs`-level `rewrites()` rule's `destination` query
  // string does not propagate to `req.nextUrl.searchParams` inside the
  // destination App Router route handler -- confirmed empirically
  // against a real `next start` during this PR's Gate 2 verification
  // (see the PR description): the handler saw an empty search string
  // even though Next correctly dispatched to the right file. Middleware
  // carries the original path in a request HEADER instead (see
  // shell-paths.ts's SHELL_PATH_HEADER comment for the full story,
  // including why a header -- not just "middleware instead of config" --
  // was also necessary).
  webpack: (config) => {
    // Workspace packages write relative imports with an explicit ".js"
    // extension for a ".ts"/".tsx" source file on disk. Two independent
    // cases now rely on this working under webpack:
    //  - @fx/core and @fx/db use NodeNext moduleResolution, where this is
    //    correct by rule (tsc and vitest/esbuild both already resolve it
    //    that way). H06 was the first cross-package import of these into
    //    apps/web, so nothing exercised the gap before now.
    //  - @fx/design uses the same ".js"-for-".ts"/".tsx" convention as
    //    other Bundler-resolution workspace packages (e.g.
    //    packages/sitekit-template); vitest/esbuild already resolve it.
    // Webpack's default resolver has no such rule and fails "Module not
    // found" on any of them, so it needs the same extensionAlias mapping
    // Node's ESM loader and TypeScript already apply.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

// D#2 H14c-3b: the Workflow SDK's builder compiles the `"use workflow"` / `"use step"`
// directives in apps/web/workflows. `withWorkflow` returns an async (phase, ctx) function,
// which would hide `headers` from apps/web/test/headers.test.ts, so `headers` is re-attached
// to the exported function and the wrap leaves headers() itself untouched.
export default Object.assign((phase, ctx) => withWorkflow(nextConfig)(phase, ctx), { headers: nextConfig.headers });
