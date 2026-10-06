import type { NextResponse } from "next/server";

/**
 * D#37 WS-C criterion 13: the exact CSP and headers on `/`, the static
 * shell prefix and `/api/*`. This is the security panel's policy (D#37
 * discussion body, technical panel comments) with `base-uri 'self'` in
 * place of `'none'` per the Spec's own Resolved disagreement 9: a
 * `'none'` base-uri would block the `<base href="/s/<hash>/">` element
 * WS-D's performance plan relies on; `'self'` still stops an injected
 * `<base>` pointing at another origin, which is the threat `base-uri`
 * actually covers.
 *
 * `next.config.mjs` cannot `import` this file directly -- it is loaded
 * by plain Node before Next's own TypeScript/SWC pipeline is available,
 * so a `.ts` specifier there would fail under plain ESM resolution
 * regardless of this file's content. next.config.mjs therefore carries
 * its own plain-JS copy of the same header list (its own comment points
 * back here), and this module is the one every dynamic route handler
 * below imports directly -- both so those responses carry the headers
 * even if a future change ever bypassed next.config.mjs's `headers()`
 * matching (e.g. a middleware short-circuit), and so this is unit
 * testable without a real server.
 *
 * Security fix round item 2 (CWE-693, Protection Mechanism Failure):
 * this comment previously claimed `apps/web/test/shell-routes.test.ts`
 * curls a real `next start` and asserts the two copies agree -- that
 * test never existed, and nothing pinned either copy to its exact
 * literal values (a mutant adding `'unsafe-inline' 'unsafe-eval'` to
 * `script-src` here, or changing `frame-ancestors 'none'` to
 * `frame-ancestors *` in next.config.mjs, passed the whole suite).
 * `apps/web/test/headers.test.ts` now pins `SHELL_SECURITY_HEADERS`
 * here AND `next.config.mjs`'s `headers()` output to the exact expected
 * strings, so the two copies drifting apart fails a unit test with no
 * server required. The PR description's `next start` curl transcript is
 * a live, one-time wire check on top of that -- not a substitute for it.
 *
 * D#37 Correction C16c / WS-C4: `require-trusted-types-for 'script'`
 * moves here from the (now removed) Report-Only header -- WS-C5 (#153)
 * removed every Trusted Types sink the shipped shell had, and the
 * WS-C5-then-WS-C4 Report-Only walk (this same live walk, re-run
 * unchanged per C18d) recorded zero violations first. `trusted-types
 * 'none'` sits alongside it per C16c criterion 3: the shell needs no
 * policy (nothing calls `trustedTypes.createPolicy`, confirmed by the
 * WS-C5 sweep and its security review), so no policy name is allowed to
 * be created at all -- there is no pass-through default policy to
 * quietly widen this later.
 */
export const WORKSPACE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'; form-action 'self' https://github.com; upgrade-insecure-requests; report-to csp";

export const WORKSPACE_REPORTING_ENDPOINTS = 'csp="/api/csp-report"';

/** In the order criterion 13 lists them. */
export const SHELL_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Content-Security-Policy", value: WORKSPACE_CSP },
  { key: "Reporting-Endpoints", value: WORKSPACE_REPORTING_ENDPOINTS },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** Applies every criterion-13 header to `res`. Mutates and returns it, matching this file's other `apply*` helpers and `withSessionCookie`'s own style. */
export function applySecurityHeaders(res: NextResponse): NextResponse {
  for (const { key, value } of SHELL_SECURITY_HEADERS) {
    res.headers.set(key, value);
  }
  return res;
}

/**
 * D#37 WS-D criterion 3: "`/s/**` is served public, max-age=31536000,
 * immutable". Every file under that content-hashed prefix is named by a
 * hash of its own build (build.mjs's computeAssetHash) -- a changed byte
 * anywhere in the shipped set produces a new hash and therefore a new
 * path, so caching the OLD path forever is safe by construction. This is
 * the criterion-13 header set plus that one addition, kept as its own
 * named export (not folded into SHELL_SECURITY_HEADERS) so `/` and
 * `/api/*` never accidentally inherit a long-lived cache header meant only
 * for the hashed static prefix. next.config.mjs carries the same plain-JS
 * copy for the same reason SHELL_SECURITY_HEADERS does (see that file's
 * own comment); apps/web/test/headers.test.ts pins both to the same
 * expected literal values.
 */
export const SHELL_STATIC_ASSET_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  ...SHELL_SECURITY_HEADERS,
  { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
];

/** D#37 WS-C criterion 5: "Every authenticated shell route sends `Cache-Control: private, no-store`." */
export function applyNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
