import type { Pool } from 'pg';
import { digestLookbackHours, type ErrorEventRow } from '@fx/telemetry';

/**
 * The database side of the operator's error digest (D#454 H1f). Both functions run as `platform_ops`:
 *   - `error_events` is platform-wide and only platform_ops (and the definer role) may read it (0702, 0703);
 *   - `rate_limit_windows` has no app_user grant at all, and platform_ops has SELECT, INSERT and UPDATE on it (0622).
 * Nothing here touches a tenant row.
 */

/** The digest's own budget: authenticated calls only, counted over a fixed hour. */
export const DIGEST_CALLS_PER_HOUR = 60;
/** One bucket for the whole platform (there is one operator). The shape is not one rate_limit_check accepts, so no caller can reach it through that function. */
export const DIGEST_BUCKET_KEY = 'ops-digest:w3600';

const WINDOW_SECONDS = 3600;

export interface ErrorEventsRead {
  /** The database's clock, in ms; the digest is judged against this, never against the web instance's. */
  now: number;
  rows: ErrorEventRow[];
}

/** Every stored class-hour from `lookbackHours(windowHours)` before now. One statement, so the clock and the rows agree. */
export async function readErrorEvents(pool: Pick<Pool, 'query'>, windowHours: number): Promise<ErrorEventsRead> {
  const { rows } = await pool.query<{
    at: Date;
    bucket: Date | null;
    service: string | null;
    route: string | null;
    stage: string | null;
    code: string | null;
    count: string | null;
    first_seen_at: Date | null;
    last_seen_at: Date | null;
  }>(
    // The LEFT JOIN keeps the clock when the table is empty. count is bigint, so it arrives as text.
    `WITH t AS (SELECT now() AS at)
     SELECT t.at, e.bucket, e.service, e.route, e.stage, e.code, e.count::text AS count, e.first_seen_at, e.last_seen_at
       FROM t LEFT JOIN error_events e ON e.bucket >= t.at - make_interval(hours => $1::integer)
      ORDER BY e.bucket, e.service, e.route, e.stage, e.code`,
    [digestLookbackHours(windowHours)],
  );
  const now = rows[0]?.at.getTime();
  if (now === undefined) throw new Error('error digest: the clock query returned no row');
  const events: ErrorEventRow[] = [];
  for (const r of rows) {
    if (r.bucket === null) continue;
    events.push({
      bucket: r.bucket,
      service: r.service!,
      route: r.route!,
      stage: r.stage!,
      code: r.code!,
      count: Number(r.count),
      firstSeenAt: r.first_seen_at!,
      lastSeenAt: r.last_seen_at!,
    });
  }
  return { now, rows: events };
}

export interface DigestSlot {
  allowed: boolean;
  /** Seconds until the hour rolls over; at least 1. */
  retryAfterSeconds: number;
}

/**
 * Counts one authenticated digest call and says whether it is within `limit` for the current hour. One atomic upsert: the
 * first call of a window opens it, a later one bumps it, and a window older than an hour restarts at 1. A database failure
 * rejects, and the route turns that into a refusal: it never serves the digest unlimited.
 */
export async function takeDigestSlot(pool: Pick<Pool, 'query'>, limit: number = DIGEST_CALLS_PER_HOUR): Promise<DigestSlot> {
  const { rows } = await pool.query<{ request_count: number; retry_after: number }>(
    `INSERT INTO rate_limit_windows AS w (bucket_key, window_start, request_count)
     VALUES ($1, clock_timestamp(), 1)
     ON CONFLICT (bucket_key) DO UPDATE
       SET window_start  = CASE WHEN w.window_start <= clock_timestamp() - make_interval(secs => $2::integer) THEN clock_timestamp() ELSE w.window_start END,
           request_count = CASE WHEN w.window_start <= clock_timestamp() - make_interval(secs => $2::integer) THEN 1 ELSE w.request_count + 1 END
     RETURNING w.request_count,
               GREATEST(1, CEIL(EXTRACT(EPOCH FROM (w.window_start + make_interval(secs => $2::integer) - clock_timestamp()))))::integer AS retry_after`,
    [DIGEST_BUCKET_KEY, WINDOW_SECONDS],
  );
  const row = rows[0];
  if (!row) throw new Error('error digest: the rate-limit upsert returned no row');
  return { allowed: row.request_count <= limit, retryAfterSeconds: row.retry_after };
}
