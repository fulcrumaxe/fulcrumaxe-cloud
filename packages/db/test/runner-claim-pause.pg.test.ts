import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'runner_capacity_definer';
const PAUSE_FN = 'runner_claim_pause_record(timestamp with time zone)';
const TABLE = 'runner_capacity';

/** 0779 (D#6 C43-6): the pause a usage limit puts on a runner's claims, kept as a time on the capacity row. */
describe('migration 0779: runner_claim_pause_record and claim_paused_until', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  /** Calls the definer as the web tier's login, in the runner's session context (what the runner middleware sets). */
  const pause = (id: string, until: Date | null, accountId = refs.accountId): Promise<unknown> =>
    withTenant(appPool, accountId, async (client) => {
      await client.query(`SELECT set_config('app.runner_id', $1, true)`, [id]);
      await client.query('SELECT runner_claim_pause_record($1::timestamptz)', [until]);
    });
  const record = (id: string, light: number, heavy: number, limitedBy: string | null): Promise<unknown> =>
    withTenant(appPool, refs.accountId, async (client) => {
      await client.query(`SELECT set_config('app.runner_id', $1, true)`, [id]);
      await client.query('SELECT runner_capacity_record($1::int, $2::int, $3::text)', [light, heavy, limitedBy]);
    });
  /** Seconds from now to the stored end time (null: no pause stored), measured by the database clock. */
  const left = async (id: string): Promise<number | null> => {
    const { rows } = await admin.query<{ s: number | null }>(`SELECT EXTRACT(EPOCH FROM (claim_paused_until - now()))::float8 AS s FROM ${TABLE} WHERE runner_id = $1`, [id]);
    return rows[0]?.s ?? null;
  };
  const inSeconds = (s: number): Date => new Date(Date.now() + s * 1000);
  const near = (actual: number | null, expected: number): void => {
    expect(actual).not.toBeNull();
    expect(Math.abs(actual! - expected)).toBeLessThan(30);
  };

  it('stores the reported reset for a subscription runner that has no capacity row yet, which then reads as declared nothing', async () => {
    const id = await insertRunner(admin, refs.accountId, refs.userId);
    await pause(id, inSeconds(600));
    near(await left(id), 600);
    expect((await admin.query(`SELECT declared, light_limit, heavy_limit FROM ${TABLE} WHERE runner_id = $1`, [id])).rows[0]).toEqual({ declared: false, light_limit: null, heavy_limit: null });
  });

  it("keeps the runner's declared capacity when it pauses, and a later capacity record leaves the pause alone", async () => {
    const id = await insertRunner(admin, refs.accountId, refs.userId);
    await record(id, 3, 1, null);
    await pause(id, inSeconds(900));
    expect((await admin.query(`SELECT declared, light_limit, heavy_limit FROM ${TABLE} WHERE runner_id = $1`, [id])).rows[0]).toEqual({ declared: true, light_limit: 3, heavy_limit: 1 });
    await record(id, 0, 0, 'usage_limit');
    near(await left(id), 900);
    expect((await admin.query(`SELECT limited_by FROM ${TABLE} WHERE runner_id = $1`, [id])).rows[0].limited_by).toBe('usage_limit');
  });

  it('a null time means an hour, a time past a day is cut to a day, and a later report overwrites an earlier one, earlier or later', async () => {
    const id = await insertRunner(admin, refs.accountId, refs.userId);
    await pause(id, null);
    near(await left(id), 3600);
    await pause(id, inSeconds(5 * 86400));
    near(await left(id), 86400);
    await pause(id, inSeconds(120));
    near(await left(id), 120);
  });

  it('a time already past is ignored: nothing is stored, and a pause an earlier report set is not cleared', async () => {
    const id = await insertRunner(admin, refs.accountId, refs.userId);
    await pause(id, inSeconds(-60));
    expect(await left(id)).toBeNull();
    await pause(id, inSeconds(600));
    await pause(id, inSeconds(-60));
    near(await left(id), 600);
  });

  it('an api_key runner is never paused, and neither is a revoked one or one of another account', async () => {
    const apiKey = await insertRunner(admin, refs.accountId, refs.userId, { credentialMode: 'api_key' });
    await pause(apiKey, inSeconds(600));
    expect(await left(apiKey)).toBeNull();
    const revoked = await insertRunner(admin, refs.accountId, refs.userId);
    await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [revoked]);
    await pause(revoked, inSeconds(600));
    expect(await left(revoked)).toBeNull();
    const stranger = await seedAccount(admin, randomUUID());
    const theirs = await insertRunner(admin, stranger.accountId, stranger.userId);
    await pause(theirs, inSeconds(600));
    expect(await left(theirs)).toBeNull();
  });

  it('the function is the only way to write the pause: app_user cannot update the column, and a session without a runner is refused (42501)', async () => {
    const id = await insertRunner(admin, refs.accountId, refs.userId);
    await pause(id, inSeconds(600));
    await expect(withTenant(appPool, refs.accountId, (c) => c.query(`UPDATE ${TABLE} SET claim_paused_until = NULL WHERE runner_id = $1`, [id]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appPool, refs.accountId, (c) => c.query('SELECT runner_claim_pause_record($1::timestamptz)', [inSeconds(60)]))).rejects.toMatchObject({ code: '42501' });
    near(await left(id), 600);
    // The tenant reads the time (the claim route needs it) and no other tenant does.
    const seen = await withTenant(appPool, refs.accountId, (c) => c.query(`SELECT claim_paused_until FROM ${TABLE} WHERE runner_id = $1`, [id]));
    expect(seen.rowCount).toBe(1);
    const stranger = await seedAccount(admin, randomUUID());
    expect((await withTenant(appPool, stranger.accountId, (c) => c.query(`SELECT 1 FROM ${TABLE} WHERE runner_id = $1`, [id]))).rowCount).toBe(0);
  });

  it('the function is SECURITY DEFINER, pinned, owned by the role, and runnable by app_user alone (not platform_ops)', async () => {
    const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[]; owner: string; grantees: string[] }>(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner)::text AS owner,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [PAUSE_FN],
    );
    expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: ['app_user'] });
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query(`SELECT runner_claim_pause_record(now() + interval '1 hour')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });

  it('the limited_by check takes usage_limit and still refuses a value outside the set', async () => {
    const id = await insertRunner(admin, refs.accountId, refs.userId);
    await admin.query(`INSERT INTO ${TABLE} (runner_id, account_id, declared, light_limit, heavy_limit, limited_by) VALUES ($1, $2, true, 0, 0, 'usage_limit')`, [id, refs.accountId]);
    await expect(admin.query(`UPDATE ${TABLE} SET limited_by = 'gpu' WHERE runner_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });
});
