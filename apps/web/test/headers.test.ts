import { describe, expect, it } from "vitest";
import { SHELL_SECURITY_HEADERS, SHELL_STATIC_ASSET_HEADERS } from "../lib/shell/headers";
import nextConfig from "../next.config.mjs";

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
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'; form-action 'self' https://github.com; upgrade-insecure-requests; report-to csp",
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
      { source: "/api/:path*", headers: EXPECTED_HEADERS },
    ]);
  });
});
