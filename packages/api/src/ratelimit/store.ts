import type { Pool, PoolClient } from "pg";

/** The result of one atomic "increment and check" against a rate-limit bucket. */
export interface RateLimitDecision {
  /** True when the caller is still within the limit AFTER this request counted. */
  allowed: boolean;
  /** Seconds until the current window rolls over -- always >= 1, used for the `Retry-After` header on a 429. */
  retryAfterSeconds: number;
}

/**
 * A pooled connection or a single checked-out client -- whichever
 * `checkAndIncrement`'s caller happens to be holding. Fix round 1 (M2):
 * `enforceTokenRateLimits` (limits.ts) now runs the token/tenant checks
 * inside a `withTenant` transaction, so it must be able to pass that
 * transaction's own `PoolClient` through, rather than always reaching
 * for a fresh connection off the pool (which would carry no
 * `app.account_id` for `rate_limit_check`'s tenant-binding checks to
 * read).
 */
type Queryable = Pool | PoolClient;

/**
 * "Rate-limit state: Postgres for v1, behind a RateLimitStore interface"
 * (cost-analyst, D#31 resolved disagreement 15) -- "Move to KV above
 * ~500 writes/s or a limiter p95 over 5 ms." Every caller in this
 * package (handler.ts, tokens/resolve.ts) depends on this interface,
 * never on `PgRateLimitStore` directly, so that move is a single
 * implementation swap later.
 */
export interface RateLimitStore {
  /**
   * Atomically bumps the counter for `bucketKey` and reports whether the
   * caller is still within `limit` requests in the current (server-fixed,
   * fix round 1 M1) window. Callers must NEVER catch and swallow a
   * rejection from this method -- C13c criterion 6 ("fail-closed... never
   * served unlimited") depends on an unavailable store aborting the
   * request (mapped to a 5xx by errors.ts's generic branch) rather than
   * being treated as "allowed".
   *
   * `client` (fix round 1, M2): when the caller already holds a
   * tenant-scoped transaction (via `withTenant`), it passes that
   * transaction's client here so `rate_limit_check`'s tenant-binding
   * checks see the same `app.account_id` the rest of the transaction
   * does. Defaults to a fresh connection off the store's own pool for
   * the pre-tenant-context failed-auth bucket, which must run with NO
   * tenant context set (see the migration's own comment on why).
   */
  checkAndIncrement(bucketKey: string, limit: number, client?: Queryable, windowSeconds?: SessionWindowSeconds): Promise<RateLimitDecision>;
}

/** The windows a session bucket may use. The database function accepts exactly these and nothing else. */
export type SessionWindowSeconds = 10 | 60 | 3600;

/** The v1 (and, per the cost-analyst's own note, likely long-term) backend: `rate_limit_check` (packages/db/migrations/0622_rate_limits.sql), a SECURITY DEFINER function callable straight off the app_user pool. */
export class PgRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: Pool) {}

  async checkAndIncrement(
    bucketKey: string,
    limit: number,
    client: Queryable = this.pool,
    windowSeconds?: SessionWindowSeconds,
  ): Promise<RateLimitDecision> {
    // A window is only ever passed for a session bucket (session_rate_limit_check, 0700); every
    // other key keeps the fixed 60 second window of rate_limit_check.
    const { rows } =
      windowSeconds === undefined
        ? await client.query<{ allowed: boolean; retry_after_seconds: number }>(
            "SELECT allowed, retry_after_seconds FROM rate_limit_check($1, $2)",
            [bucketKey, limit],
          )
        : await client.query<{ allowed: boolean; retry_after_seconds: number }>(
            "SELECT allowed, retry_after_seconds FROM session_rate_limit_check($1, $2, $3)",
            [bucketKey, limit, windowSeconds],
          );
    const row = rows[0];
    if (!row) {
      // Defensive: rate_limit_check is declared RETURNS TABLE and always
      // returns exactly one row for valid, tenant-bound input. A missing
      // row means either a NULL argument (STRICT -- fix round 1 M1) or
      // something badly wrong with the function itself -- fail closed
      // (throw) either way, never treat "no row" as "allowed".
      throw new Error(`rate_limit_check returned no row for bucket ${bucketKey}`);
    }
    return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds };
  }
}
