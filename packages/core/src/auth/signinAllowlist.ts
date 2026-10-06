/**
 * Staging lock: an optional allowlist of GitHub logins. `FX_SIGNIN_ALLOWLIST`
 * is a comma-separated list, compared case-insensitively (GitHub logins are).
 *
 * Unset, empty, or nothing but blank entries means no restriction -- today's
 * behaviour. Once at least one login is listed, only those logins may sign in,
 * and a login that has since been removed from the list loses its existing
 * sessions on their next request (see getSessionEpochAndRevocation in
 * identity.ts, the one check every session-honouring handler already goes
 * through).
 *
 * Pure, with no logging: callers log a fixed code, never a login.
 */

/** The fixed code a refusal logs. Never the login. */
export const SIGNIN_REFUSED_CODE = 'FX_SIGNIN_REFUSED_NOT_ALLOWLISTED';

/** The lowercased allowlist, or null when the lock is off. */
export function signinAllowlist(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const raw = env.FX_SIGNIN_ALLOWLIST;
  if (raw === undefined) return null;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? new Set(entries) : null;
}

/** True when the lock is off, or `login` is on the list. A missing login is refused while the lock is on. */
export function isSigninAllowed(
  login: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const list = signinAllowlist(env);
  if (list === null) return true;
  return typeof login === 'string' && list.has(login.trim().toLowerCase());
}
