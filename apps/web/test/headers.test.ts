import { describe, expect, it } from "vitest";
import { SHELL_SECURITY_HEADERS, SHELL_STATIC_ASSET_HEADERS } from "../lib/shell/headers";
import nextConfig from "../next.config.mjs";
import { middleware } from "../middleware";
import { NextRequest } from "next/server";
// Next's own header-source matcher, the one the router uses.
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

/**
 * Security fix round item 2 (CWE-693, Protection Mechanism Failure):
 * pins both criterion-13 header copies (lib/shell/headers.ts's TS copy
 * and next.config.mjs's plain-JS copy) to their exact expected literal
 * values, so the two of them silently drifting apart -- or either one
 * weakening -- fails a unit test instead of passing the whole suite.
 * Written by hand here, deliberately NOT imported from either source
 * file, so a mutation to either copy's CSP/header values has something
 * independent to disagree with.
 *
 * D#37 Correction C16c / WS-C4: require-trusted-types-for 'script' (plus
 * trusted-types 'none', C16c criterion 3) moved into the enforced
 * Content-Security-Policy value, and the Content-Security-Policy-Report-Only
 * header is gone entirely -- both copies.
 */
const EXPECTED_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'; form-action 'self' https://github.com; upgrade-insecure-requests; report-to csp",
  },
  { key: "Reporting-Endpoints", value: 'csp="/api/csp-report"' },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// D#37 WS-D criterion 3: "/s/**" is served public, max-age=31536000,
// immutable, on top of the same criterion-13 headers.
const EXPECTED_STATIC_ASSET_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  ...EXPECTED_HEADERS,
  { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
];

describe("D#37 WS-C criterion 13: lib/shell/headers.ts pinned to exact literal values", () => {
  it("SHELL_SECURITY_HEADERS matches the expected keys/values, in order", () => {
    expect(SHELL_SECURITY_HEADERS).toEqual(EXPECTED_HEADERS);
  });

  it("carries no Access-Control-* header (C1: no route sends one)", () => {
    expect(SHELL_SECURITY_HEADERS.some((h) => h.key.toLowerCase().startsWith("access-control"))).toBe(false);
  });

  it("D#37 WS-D criterion 3: SHELL_STATIC_ASSET_HEADERS is the same list plus one immutable Cache-Control", () => {
    expect(SHELL_STATIC_ASSET_HEADERS).toEqual(EXPECTED_STATIC_ASSET_HEADERS);
  });
});

describe("D#37 WS-C criterion 13: next.config.mjs's plain-JS copy agrees exactly", () => {
  it("headers() returns the exact same values for /, /s/:path* and /api/:path*", async () => {
    const entries = await nextConfig.headers!();
    expect(entries).toEqual([
      { source: "/", headers: EXPECTED_HEADERS },
      { source: "/s/:path*", headers: EXPECTED_STATIC_ASSET_HEADERS },
      // D#3 K10: every /api/* answer except a site's preview render keeps the shell policy; the render has its own (set by its route).
      { source: "/api", headers: EXPECTED_HEADERS },
      { source: "/api/:path((?!v1/sites/[^/]+/preview/render$).*)", headers: EXPECTED_HEADERS },
      { source: "/api/v1/sites/:id/preview/render", headers: EXPECTED_HEADERS.filter((entry) => entry.key !== "Content-Security-Policy") },
    ]);
  });
});

/**
 * The same matcher Next runs on header sources (strict, case-insensitive by default), applied to the real sources, so the test
 * exercises what a request path actually gets and not the config text.
 */
async function configCsp(pathname: string): Promise<string | null> {
  const entries = await nextConfig.headers!();
  let csp: string | null = null;
  for (const entry of entries) {
    if (!getPathMatch(entry.source, { removeUnnamedParams: true, strict: true })(pathname)) continue;
    for (const header of entry.headers) if (header.key === "Content-Security-Policy") csp = header.value;
  }
  return csp;
}

const SHELL_CSP = EXPECTED_HEADERS[0]!.value;

describe("D#3 K10: which paths lose the shell policy", () => {
  it.each([
    "/api",
    "/api/",
    "/api/x",
    "/api/v1/sites/x/preview",
    "/api/v1/sites/x/preview/render/",
    "/api/v1/sites/x/preview/render/x",
    "/api/v1/sites/x/preview/render%2Fx",
    "/api/v1/sites/x/preview/render%2F",
    "/api/v1/sites/x/preview/render;x",
    "/api/v1/sites/x/preview/rend%65r",
    "/api/v1/sites//preview/render",
    "/api/v1/sites/x/y/preview/render",
    "/api/api/v1/sites/x/preview/render",
    "/api/v1/sites/preview/render",
  ])("%s keeps the shell policy", async (pathname) => {
    expect(await configCsp(pathname)).toBe(SHELL_CSP);
  });

  it.each(["/api/v1/sites/x/preview/render", "/api/v1/sites/0b6a1c5e-1111-4222-8333-444455556666/preview/render"])(
    "%s is the one path without it",
    async (pathname) => {
      expect(await configCsp(pathname)).toBeNull();
    },
  );

  // Next cannot match a header source case-sensitively, so the config exempts these too; middleware answers them with the shell policy.
  it.each(["/api/V1/sites/x/preview/render", "/api/v1/sites/x/preview/RENDER", "/API/v1/sites/x/Preview/render"])(
    "%s: exempt in the config, so middleware answers it with a 404 that carries the shell policy",
    async (pathname) => {
      const res = await middleware(new NextRequest(`https://example.test${pathname}`));
      expect(res.status).toBe(404);
      for (const { key, value } of EXPECTED_HEADERS) expect(res.headers.get(key)).toBe(value);
    },
  );

  it("middleware leaves the exact lowercase render path to the route", async () => {
    const res = await middleware(new NextRequest("https://example.test/api/v1/sites/x/preview/render"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
