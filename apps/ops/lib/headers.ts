/** Headers every apps/ops response carries, and the inbound staff headers that must never be trusted. */

export const STAFF_HEADER_PREFIX = "x-fx-staff-";
/** Set only by middleware, from a verified session. Downstream code treats it as a claim and re-checks the staff row. */
export const STAFF_ID_HEADER = "x-fx-staff-id";
/** The verified session's id, set by middleware beside the staff id; requireStaff checks it against the sign-out deny-list. */
export const STAFF_SID_HEADER = "x-fx-staff-sid";

/** Deletes every inbound x-fx-staff-* header (run before any other step). */
export function stripStaffHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(STAFF_HEADER_PREFIX)) headers.delete(name);
  }
}

/**
 * Script execution is limited to this origin and to scripts carrying the per-request nonce (Next copies the nonce onto its own
 * scripts); there is no 'unsafe-inline' for scripts. Development adds 'unsafe-eval', which React's dev tools need.
 */
export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function securityHeaders(csp: string): [string, string][] {
  return [
    ["Content-Security-Policy", csp],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
  ];
}

/** Sets the security headers on a response and removes any Access-Control-* header: the console allows no cross-origin reader. */
export function applySecurityHeaders(res: Response, csp: string): void {
  for (const [k, v] of securityHeaders(csp)) res.headers.set(k, v);
  for (const name of [...res.headers.keys()]) {
    if (name.toLowerCase().startsWith("access-control-")) res.headers.delete(name);
  }
}
