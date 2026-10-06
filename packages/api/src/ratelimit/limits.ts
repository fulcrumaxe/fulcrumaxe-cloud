import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { apiLimitsFor, isPlanId, type PlanId } from "@fx/spend";
import { RateLimitedError } from "../errors.js";
import type { RateLimitStore } from "./store.js";

/**
 * The rateClass vocabulary `limits.ts` knows about (C13c criterion 7:
 * "every entry whose principals include token declares a rateClass that
 * limits.ts knows"). Every route's numeric cap is class-agnostic today
 * (criteria 1-4 describe one per-token and one per-tenant cap, with no
 * per-class split) -- `rateClass` exists so a later task can widen this
 * set and give one class its own cap (the cost-analyst panel's separate
 * "other writes: 30/min" and "JSON polling: 6/min" figures, not part of
 * this task's pass/fail list) without touching every route module again.
 */
export const RATE_CLASSES = ["read", "write"] as const;
export type RateClass = (typeof RATE_CLASSES)[number];

/** Old criterion 7 bullet 3, now C13c criterion 5: "the 21st failed token authentication from one IP within a minute -> 429." Fixed, not plan data -- a failed Bearer credential carries no resolved account yet. */
export const FAILED_AUTH_LIMIT_PER_IP_PER_MINUTE = 20;

/**
 * The caller's IP for rate-limiting purposes.
 *
 * Fix round 1 (PR #159 review, "Ruling: which header to trust for the
 * client IP", informational): the deployment is Vercel, which overwrites
 * `X-Forwarded-For` with the real client IP and never forwards a
 * client-supplied value -- on Vercel the leftmost XFF entry is the
 * client and cannot be spoofed, so trusting it (the original behavior,
 * still the fallback below) was never wrong on its own. `x-real-ip`
 * (Vercel: a single IP, no list to parse) and `x-vercel-forwarded-for`
 * (Vercel's own XFF, distinct from the standard header a future proxy in
 * front of Vercel could rewrite) are preferred per the review's
 * suggestion, because they stay correct even if a proxy is ever placed
 * in front of Vercel -- a scenario where the plain `X-Forwarded-For`
 * header's leftmost entry could become either spoofable or just the
 * proxy's own address. `X-Forwarded-For` remains the fallback for
 * `next start` (no Vercel edge) and every existing test, none of which
 * set the Vercel-specific headers.
 *
 * Falls back to a fixed sentinel bucket when no header is present at all
 * (never reachable in a real Vercel deployment) rather than skipping the
 * check -- a request the platform cannot tell apart from any other
 * unidentified caller is still charged against a shared conservative
 * bucket, never left unlimited.
 */
export function clientIpFromRequest(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  const vercelForwardedFor = req.headers.get("x-vercel-forwarded-for");
  if (vercelForwardedFor) {
    const first = vercelForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Fix round 1, S2 (should-fix): an IPv6 client that holds a /64 -- the
 * smallest block residential/mobile ISPs typically hand out (RFC 6177)
 * -- can rotate its address within that block to dodge the per-IP
 * failed-auth cap, with each rotation opening a fresh
 * `rate_limit_windows` row besides. Keys an IPv6 address on its /64
 * prefix (the first 4 of its 8 hextets) instead of the full /128
 * address; an IPv4 address, or anything that doesn't parse as IPv6, is
 * returned unchanged (one bucket per literal address, today's
 * behavior -- IPv4 has no equivalent easy-rotation concern at v1's
 * scale, and an unparseable value is safer bucketed narrowly than
 * dropped).
 */
export function bucketKeyForFailedAuthIp(ip: string): string {
  const prefix = ipv6Slash64Prefix(ip);
  return `failed-auth:${prefix ?? ip}`;
}

/**
 * D#37 WS-D fix round 1, MUST 1 (PR #172 review): a bucket-key builder
 * for a coarse per-IP abuse bound on an unauthenticated, pre-tenant
 * route that is NOT a failed-auth attempt -- `POST /api/rum` (apps/web)
 * is the first caller. Reuses the exact same `rate_limit_check`
 * function and the same /64 collapsing `bucketKeyForFailedAuthIp` above
 * uses (fix round 1, S2), via a new `anon:` bucket-key shape
 * (0626_rate_limit_anon_ip.sql) -- "reuse the existing mechanism if one
 * fits, do not invent a second limiter" (the review's own words).
 *
 * Deliberately a SEPARATE namespace from `failed-auth:`, not the same
 * bucket: sharing one budget between real failed sign-ins and, say, a
 * telemetry-beacon flood from the same address would let either kind of
 * traffic exhaust the other's cap, and would make `failed-auth:<ip>`'s
 * count misleading as a signal of sign-in abuse. `routeName` further
 * namespaces the bucket per caller (e.g. "rum") so two different
 * anonymous routes added later never share one counter either.
 */
export function bucketKeyForAnonIp(routeName: string, ip: string): string {
  const prefix = ipv6Slash64Prefix(ip);
  return `anon:${routeName}:${prefix ?? ip}`;
}

/**
 * Expands `addr` to its 8 canonical lowercase hextets and returns the
 * first 4 (the /64 prefix) joined as `xxxx:xxxx:xxxx:xxxx::/64`, or
 * `null` if `addr` isn't a plausible IPv6 literal (including a bare
 * IPv4 address, which contains no `:` at all). Handles `::` compression
 * (at most one occurrence, per RFC 4291) by padding the elided run with
 * zero groups; rejects anything else that doesn't resolve to exactly 8
 * groups of 1-4 hex digits each. Best-effort only -- this drives a
 * rate-limit bucket key, not a security boundary in itself (the caller
 * falls back to the raw string on a `null`), so a malformed or exotic
 * input (a zone id, an IPv4-mapped address) safely falls back to
 * per-literal-string bucketing rather than being rejected outright.
 */
function ipv6Slash64Prefix(addr: string): string | null {
  if (!addr.includes(":")) return null;
  const withoutZone = addr.split("%")[0]!;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null; // more than one "::" -- malformed.

  let groups: string[];
  if (halves.length === 1) {
    groups = withoutZone.split(":");
    if (groups.length !== 8) return null;
  } else {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }

  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase()).join(":")}::/64`;
}

/**
 * `accounts.plan` for the token/tenant caps below, read on the SAME
 * tenant-scoped `client` `enforceTokenRateLimits` already has open (fix
 * round 1, M2 -- previously its own separate `withTenant` round trip;
 * folding it into the caller's own transaction is what the review's M2
 * fix asks for: "run the token and tenant checks inside the tenant
 * transaction `getAccountPlanId` already opens -- that also saves a
 * round trip"). `client` must already have `app.account_id` set (via
 * `withTenant`'s `SET LOCAL`) the same way `routes/account.ts`'s
 * `GET /api/v1/account` handler needs it -- see `accounts`' own
 * `tenant_isolation` policy, 0001_core.sql. A separate query from
 * `resolve_api_token` deliberately: C13c's migration note rules out
 * changing that function's signature here ("it does not edit 0616
 * itself, because #152 merges first" -- the sibling constraint API-3f's
 * own brief states for its migration applies just as much to this one).
 */
async function getAccountPlanId(client: PoolClient, accountId: string): Promise<PlanId> {
  const { rows } = await client.query<{ plan: string }>("SELECT plan FROM accounts WHERE id = $1", [accountId]);
  const plan = rows[0]?.plan;
  if (plan === undefined || !isPlanId(plan)) {
    throw new Error(`ratelimit: account ${accountId} has no resolvable plan`);
  }
  return plan as PlanId;
}

/** What handler.ts hands in for a resolved TOKEN principal -- never a session principal (criterion 3: session traffic never touches these buckets). `tokenBucketKey` is `principalIdOf(principal)` ("token:<id>"), computed by the caller so this module never needs to import principal.ts (and risk a circular import back through resolveApiToken's own use of this module). */
export interface TokenRateLimitSubject {
  accountId: string;
  tokenBucketKey: string;
}

/**
 * C13c criteria 1-4 and 6. Increments BOTH the per-token and the
 * per-tenant bucket on every request (never short-circuits after the
 * first denial) so the tenant bucket's count is always accurate
 * regardless of how a burst is split across a tenant's tokens (criterion
 * 2's "combined" wording). Throws `RateLimitedError` if either bucket is
 * now over its cap; the `Retry-After` value is the more restrictive of
 * the two. Never catches a `RateLimitStore` failure -- an error from
 * `checkAndIncrement` or `getAccountPlanId` propagates straight up
 * through `handler.ts`'s try/catch to `errors.ts`'s generic 500 branch
 * (criterion 6: fail-closed, never served unlimited).
 *
 * Fix round 1, M2 (must-fix): the plan lookup and both
 * `checkAndIncrement` calls now run inside ONE `withTenant(pool,
 * subject.accountId, ...)` transaction, so `rate_limit_check`'s own
 * tenant-binding checks (0622_rate_limits.sql) see the caller's real
 * `app.account_id` via `SET LOCAL` -- without this, the definer had no
 * way to tell the caller's tenant apart from any other, and any
 * app_user context could drain or reset another tenant's buckets
 * (reproduced live in the review: 130 calls from tenant A's context
 * against `tenant:<B>` pushed tenant B over its cap). A tenant/token
 * mismatch inside the definer now RAISEs, which propagates straight
 * through this transaction (ROLLBACK, rethrow) to the same fail-closed
 * 500 path a `RateLimitStore` failure already takes -- there is no
 * legitimate call site where that mismatch should ever occur, since
 * `subject` is always built from the caller's OWN resolved principal.
 */
export async function enforceTokenRateLimits(
  store: RateLimitStore,
  pool: Pool,
  subject: TokenRateLimitSubject,
): Promise<void> {
  const { tokenDecision, tenantDecision } = await withTenant(pool, subject.accountId, async (client) => {
    const plan = await getAccountPlanId(client, subject.accountId);
    const limits = apiLimitsFor(plan);

    const tokenDecision = await store.checkAndIncrement(subject.tokenBucketKey, limits.perTokenPerMinute, client);
    const tenantDecision = await store.checkAndIncrement(
      `tenant:${subject.accountId}`,
      limits.perTenantPerMinute,
      client,
    );
    return { tokenDecision, tenantDecision };
  });

  if (!tokenDecision.allowed || !tenantDecision.allowed) {
    const retryAfterSeconds = Math.max(
      tokenDecision.allowed ? 0 : tokenDecision.retryAfterSeconds,
      tenantDecision.allowed ? 0 : tenantDecision.retryAfterSeconds,
    );
    throw new RateLimitedError(retryAfterSeconds);
  }
}

/**
 * C13c criterion 5. Called from `tokens/resolve.ts` on every rejected
 * Bearer credential (unknown, expired, revoked, bad checksum -- "the
 * counter write is allowed" even when checksum verification itself
 * skipped the DB). Throws `RateLimitedError` in place of the caller's own
 * `InvalidTokenError` once the 21st failure in a window lands; the first
 * 20 still 401 as before.
 *
 * Deliberately calls `store.checkAndIncrement` with NO `client` argument
 * (a fresh connection off the store's own pool, no open transaction) --
 * this bucket runs pre-auth, pre-tenant-context, by design, and
 * `rate_limit_check`'s M2 fix (0622_rate_limits.sql) only accepts a
 * `failed-auth:` key when the CALLER sets no `app.account_id` at all.
 * `bucketKeyForFailedAuthIp` (fix round 1, S2) keys an IPv6 address on
 * its /64 rather than its full address, so rotating within one /64
 * block can't be used to dodge this cap.
 */
export async function enforceFailedAuthRateLimit(store: RateLimitStore, clientIp: string): Promise<void> {
  const decision = await store.checkAndIncrement(bucketKeyForFailedAuthIp(clientIp), FAILED_AUTH_LIMIT_PER_IP_PER_MINUTE);
  if (!decision.allowed) {
    throw new RateLimitedError(decision.retryAfterSeconds);
  }
}
