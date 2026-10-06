import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { MembershipRole } from "../registry.js";
import { SCOPES, type Scope } from "../registry.js";
import { InvalidTokenError } from "../errors.js";
import type { Principal } from "../principal.js";
import { enforceFailedAuthRateLimit } from "../ratelimit/limits.js";
import type { RateLimitStore } from "../ratelimit/store.js";
import { verifyChecksum } from "./format.js";

/** `sha256(secret)` -- the only form ever written to `api_tokens.token_hash` (security-expert: "stored as SHA-256(secret)"). */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

interface ResolvedTokenRow {
  id: string;
  account_id: string;
  created_by: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  token_hash: string;
  creator_role: string | null;
}

/** The token text of an `Authorization` header: the one place the `Bearer ` prefix is stripped (the stream re-check reuses it, so it hashes exactly what the first request did). */
export function bearerFromAuthorization(authorizationHeader: string): string {
  return authorizationHeader.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Fills in the principal.ts stub. `pool` is the app_user pool --
 * resolve_api_token (migrations/0616_api_tokens.sql) and
 * touch_api_token_last_used (migrations/0621_api_tokens_hardening.sql)
 * are both SECURITY DEFINER, so no platform_ops connection is needed
 * here.
 *
 * D#31 API-3d (C13c criterion 5): every rejection path below routes
 * through `failAuth`, which counts the failure against `clientIp`'s
 * per-minute bucket before throwing `InvalidTokenError` -- "Failures
 * counted: unknown, expired, revoked and bad checksum. A bad checksum
 * still causes no api_tokens lookup, and the counter write is allowed."
 * Once that bucket is over its cap, `failAuth` throws `RateLimitedError`
 * (429) instead of the usual 401, on the request that pushes it over.
 */
export async function resolveApiToken(
  pool: Pool,
  authorizationHeader: string,
  clientIp: string,
  rateLimitStore: RateLimitStore,
): Promise<Principal> {
  async function failAuth(): Promise<never> {
    await enforceFailedAuthRateLimit(rateLimitStore, clientIp);
    throw new InvalidTokenError();
  }

  // csrfStep already confirmed Bearer scheme; stripped defensively since
  // tests call this directly, bypassing that middleware step.
  const candidate = bearerFromAuthorization(authorizationHeader);

  if (!verifyChecksum(candidate)) {
    // Criterion 7: "A bad checksum is rejected without a DB lookup" --
    // still true; failAuth's counter write is a rate-limit bucket, never
    // an api_tokens lookup.
    return failAuth();
  }

  const hash = hashToken(candidate);
  const { rows } = await pool.query<ResolvedTokenRow>("SELECT * FROM resolve_api_token($1)", [hash]);
  const row = rows[0];
  if (!row) {
    return failAuth();
  }

  // Defense-in-depth constant-time compare of the hash: resolve_api_token
  // already matched it by SQL equality against a unique index (an
  // unpredictable 256-bit value, not a timing-sensitive plaintext
  // comparison), but this makes the comparison explicit in app code too.
  const hashBuf = Buffer.from(hash, "utf8");
  const storedBuf = Buffer.from(row.token_hash, "utf8");
  if (hashBuf.length !== storedBuf.length || !timingSafeEqual(hashBuf, storedBuf)) {
    return failAuth();
  }

  if (row.revoked_at !== null || new Date(row.expires_at).getTime() <= Date.now()) {
    return failAuth();
  }
  if (row.creator_role === null) {
    // The creator is no longer a member of the account at all.
    return failAuth();
  }

  // Criterion 10's "100 reads produce at most one last_used_at UPDATE" is
  // enforced by the function's own WHERE clause (a no-op update when the
  // last touch was under 60s ago). API-3f/S7: keyed on the hash, not on
  // row.id/row.account_id -- a SECURITY DEFINER function granted to
  // app_user at large must not trust two caller-supplied identifiers to
  // agree; only a holder of the secret that hashes to this value can
  // touch this row. Same hash already resolved just above.
  await pool.query("SELECT touch_api_token_last_used($1)", [hash]);

  const scopeSet = new Set<string>(SCOPES);
  const scopes = row.scopes.filter((s): s is Scope => scopeSet.has(s));

  return {
    kind: "token",
    accountId: row.account_id,
    userId: row.created_by,
    // "For a token, the effective permission is its scopes intersected
    // with the creator's current role" -- role is read LIVE from the
    // join every request, never stored on the token itself, so a
    // creator's role change is reflected immediately even on a request
    // that races ahead of membership.ts's own revocation.
    role: row.creator_role as MembershipRole,
    scopes,
    tokenId: row.id,
  };
}
