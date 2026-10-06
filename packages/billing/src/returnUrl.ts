/**
 * Security-review fix round 2 (PR #53, finding #3): every Stripe redirect
 * target this package builds -- the billing-portal `return_url`, and the
 * Checkout Session's `success_url`/`cancel_url` -- is built from a
 * server-configured app origin plus a caller-supplied PATH, never from a
 * caller-supplied URL. Stripe redirects the customer's browser here when
 * they leave the portal or complete/cancel checkout, so accepting an
 * arbitrary caller URL is an open redirect (CWE-601).
 *
 * `path` must be a bare absolute path: it must start with exactly one
 * `/` (not `//`, which a browser resolves as scheme-relative to a
 * different host) and must carry no scheme of its own. That rules out
 * `https://evil.example/phish` (doesn't start with `/`), `javascript:...`
 * (doesn't start with `/`) and `//evil.example` (starts with `//`)
 * without needing to reason about how any particular URL parser resolves
 * them -- the accepted shape is narrow enough that "parse it and compare
 * origins" is a second, belt-and-suspenders check rather than the only
 * one.
 *
 * Returns the full validated URL string, or `null` if `path` (or the
 * configured `appOrigin` itself) fails validation. `appOrigin` is a
 * deploy-time config value (see src/env.ts's `appOriginFromEnv`), not
 * user input -- an invalid `appOrigin` is a configuration bug, and this
 * function refuses rather than silently degrading.
 */
export function buildValidatedReturnUrl(path: string, appOrigin: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('\\')) return null; // some URL parsers treat backslash as a path/host separator
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null; // defense in depth: a scheme before the first '/' would be impossible here anyway
  // The URL parser deletes tab/LF/CR anywhere and trims C0 controls and
  // spaces at the ends, so '/x/..\t/y' would normalise like '/x/../y'.
  // Refuse every control character, space and DEL up front, and encoded
  // slashes/backslashes (defence in depth), before any segment check.
  if (/[\u0000- \u007f]/.test(path)) return null;
  if (/%2f|%5c/i.test(path)) return null;
  // Refuse a dot-segment BEFORE `new URL` gets to normalise it: '/a/../b'
  // and '/x/%2e%2e/y' would otherwise resolve to a different path than the
  // caller wrote. Percent-encoded dots (any case, mixed) count as dots,
  // because the WHATWG parser treats '%2e' as '.' when it resolves segments.
  const pathOnly = path.split(/[?#]/, 1)[0]!.replace(/%2e/gi, '.');
  if (pathOnly.split('/').some((segment) => segment === '.' || segment === '..')) return null;

  let base: URL;
  try {
    base = new URL(appOrigin);
  } catch {
    // fx-swallow-ok: an unparsable base URL is a refusal (null), not a failure
    return null;
  }
  if (base.protocol !== 'https:') return null;

  let resolved: URL;
  try {
    resolved = new URL(path, base);
  } catch {
    // fx-swallow-ok: an unparsable return URL is a refusal (null), not a failure
    return null;
  }
  if (resolved.protocol !== 'https:' || resolved.origin !== base.origin) return null;
  // Security review informational note (PR #53): `/..//evil.example` and
  // similar dot-segment paths can resolve to `https://<app>//evil.example`
  // -- still on OUR origin (the check above already holds), so this is not
  // itself an open redirect. Refused anyway as cheap insurance against a
  // future consumer reusing the resolved pathname as its own relative
  // redirect target, where a leading `//` would be scheme-relative again.
  if (resolved.pathname.startsWith('//')) return null;
  return resolved.toString();
}
