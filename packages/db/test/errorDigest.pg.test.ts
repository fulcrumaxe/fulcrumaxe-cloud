import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { digestLookbackHours } from '@fx/telemetry';
import { createPool } from '../src/pool.js';
import { DIGEST_BUCKET_KEY, DIGEST_CALLS_PER_HOUR, readErrorEvents, takeDigestSlot } from '../src/errorDigest.js';

/**
 * The digest's two database calls against the real local Postgres, as `platform_ops` (the login the route uses).
 * What it cannot fake: Neon's pooler. Both calls are single statements, so PgBouncer's transaction mode changes nothing for them.
 */
let admin: Pool;
let ops: Pool;
let app: Pool;

const insertRow = (hoursAgo: number, code: string, count: string | number = 1): Promise<unknown> =>
  admin.query(
    `INSERT INTO error_events (bucket, service, route, stage, code, count, first_seen_at, last_seen_at)
     VALUES (date_trunc('hour', now()) - make_interval(hours => $1::integer), 'web', '/api/x', 'sync', $2, $3::bigint, now(), now())`,
    [hoursAgo, code, count],
  );

beforeAll(() => {
  admin = createPool(process.env.DATABASE_URL!);
  ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  app = createPool(process.env.DATABASE_URL_APP_USER!);
});
afterAll(async () => {
  await Promise.all([admin.end(), ops.end(), app.end()]);
});
beforeEach(async () => {
  await admin.query('TRUNCATE error_events');
  await admin.query('DELETE FROM rate_limit_windows WHERE bucket_key = $1', [DIGEST_BUCKET_KEY]);
});

describe('readErrorEvents (error_events, as platform_ops)', () => {
  it('returns the database clock and no rows from an empty table', async () => {
    const got = await readErrorEvents(ops, 24);
    expect(got.rows).toEqual([]);
    const { rows } = await admin.query<{ ms: string }>('SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint::text AS ms');
    expect(Math.abs(got.now - Number(rows[0]!.ms))).toBeLessThan(5000);
  });

  it('reads the window plus the look-back, and not an hour more', async () => {
    const lookback = digestLookbackHours(24);
    await insertRow(0, 'now_hour');
    await insertRow(lookback - 1, 'inside_lookback');
    await insertRow(lookback + 1, 'beyond_lookback');
    const got = await readErrorEvents(ops, 24);
    expect(got.rows.map((r) => r.code).sort()).toEqual(['inside_lookback', 'now_hour']);
  });

  it('reads a bigint count as a number, with the buckets and times as dates', async () => {
    await insertRow(1, 'big', '5000000000');
    const [row] = (await readErrorEvents(ops, 24)).rows;
    expect(row).toMatchObject({ service: 'web', route: '/api/x', stage: 'sync', code: 'big', count: 5_000_000_000 });
    expect(row!.bucket).toBeInstanceOf(Date);
    expect(row!.firstSeenAt).toBeInstanceOf(Date);
  });

  it('is a read the application login cannot make: error_events has no app_user grant', async () => {
    await expect(readErrorEvents(app, 24)).rejects.toThrow(/permission denied/);
  });
});

describe('takeDigestSlot (rate_limit_windows, as platform_ops)', () => {
  it('allows 60 calls in the hour and refuses the 61st with a Retry-After inside the hour', async () => {
    for (let i = 1; i <= DIGEST_CALLS_PER_HOUR; i++) expect((await takeDigestSlot(ops)).allowed, `call ${i}`).toBe(true);
    const over = await takeDigestSlot(ops);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(3600);
    const { rows } = await admin.query<{ request_count: number }>('SELECT request_count FROM rate_limit_windows WHERE bucket_key = $1', [DIGEST_BUCKET_KEY]);
    expect(rows[0]!.request_count).toBe(DIGEST_CALLS_PER_HOUR + 1);
  });

  it('starts a fresh hour once the window has ended', async () => {
    for (let i = 0; i < DIGEST_CALLS_PER_HOUR + 1; i++) await takeDigestSlot(ops);
    await admin.query(`UPDATE rate_limit_windows SET window_start = now() - interval '61 minutes' WHERE bucket_key = $1`, [DIGEST_BUCKET_KEY]);
    expect((await takeDigestSlot(ops)).allowed).toBe(true);
    const { rows } = await admin.query<{ request_count: number; fresh: boolean }>(
      `SELECT request_count, window_start > now() - interval '1 minute' AS fresh FROM rate_limit_windows WHERE bucket_key = $1`,
      [DIGEST_BUCKET_KEY],
    );
    expect(rows[0]).toEqual({ request_count: 1, fresh: true });
    // The new hour counts on: 60 in all are allowed, the 61st is not.
    for (let i = 2; i <= DIGEST_CALLS_PER_HOUR; i++) expect((await takeDigestSlot(ops)).allowed).toBe(true);
    expect((await takeDigestSlot(ops)).allowed).toBe(false);
  });

  it('counts concurrent calls exactly: 100 at once let 60 through', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => takeDigestSlot(ops)));
    expect(results.filter((r) => r.allowed)).toHaveLength(DIGEST_CALLS_PER_HOUR);
  });

  it('honours a smaller limit', async () => {
    expect((await takeDigestSlot(ops, 1)).allowed).toBe(true);
    expect((await takeDigestSlot(ops, 1)).allowed).toBe(false);
  });

  it('is not a bucket the application login can reach through the shared limiter', async () => {
    await expect(app.query('SELECT * FROM rate_limit_check($1, 1)', [DIGEST_BUCKET_KEY])).rejects.toThrow();
    await expect(app.query('SELECT * FROM session_rate_limit_check($1, 1, 3600)', [DIGEST_BUCKET_KEY])).rejects.toThrow();
  });
});
