import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const HELLO = 'runner_hello_record(integer,text,text,boolean,text)';

/** D#845 ON-6c (migration 1047): the machine's KVM fact, written by the hello definer on every hello. */
describe('migration 1047: runners.kvm through runner_hello_record', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const hello = (runnerId: string, sql: string, args: unknown[], accountId = a.accountId): Promise<boolean> =>
    withTenant(appPool, accountId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerId]);
      return (await c.query<{ ok: boolean }>(sql, args)).rows[0]!.ok;
    });
  const sayKvm = (id: string, kvm: string | null, accountId = a.accountId) => hello(id, 'SELECT runner_hello_record(3, $1, $2, $3::boolean, $4::text) AS ok', ['1.2.3', 'container', true, kvm], accountId);
  const kvmOf = async (id: string) => (await admin.query<{ k: string | null }>('SELECT kvm AS k FROM runners WHERE id = $1', [id])).rows[0]!.k;

  it('a new runner row reads unknown (NULL)', async () => {
    expect(await kvmOf(await insertRunner(admin, a.accountId, a.userId))).toBeNull();
  });

  it('stores present and absent, and replaces the old answer on the next hello', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    expect(await sayKvm(r, 'present')).toBe(true);
    expect(await kvmOf(r)).toBe('present');
    expect(await sayKvm(r, 'absent')).toBe(true);
    expect(await kvmOf(r)).toBe('absent');
  });

  it('an old runner (the three- and four-argument call) reads as unknown, and a hello that says nothing clears an earlier answer', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    expect(await sayKvm(r, 'present')).toBe(true);
    expect(await hello(r, `SELECT runner_hello_record(3, '1.2.3', 'container', true) AS ok`, [])).toBe(true);
    expect(await kvmOf(r)).toBeNull();
    expect(await sayKvm(r, 'absent')).toBe(true);
    expect(await hello(r, `SELECT runner_hello_record(3, '1.2.3', 'container') AS ok`, [])).toBe(true);
    expect(await kvmOf(r)).toBeNull();
  });

  it('refuses any other value (22023) and keeps the old answer', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    expect(await sayKvm(r, 'present')).toBe(true);
    for (const bad of ['', 'yes', 'PRESENT', 'unreadable']) {
      await expect(sayKvm(r, bad), bad).rejects.toMatchObject({ code: '22023' });
    }
    expect(await kvmOf(r)).toBe('present');
    await expect(admin.query(`UPDATE runners SET kvm = 'maybe' WHERE id = $1`, [r])).rejects.toMatchObject({ code: '23514' });
  });

  it("writes only the named runner's row; a revoked runner and another account's runner are not written", async () => {
    const mine = await insertRunner(admin, a.accountId, a.userId);
    const sibling = await insertRunner(admin, a.accountId, a.userId);
    const foreign = await insertRunner(admin, b.accountId, b.userId);
    expect(await sayKvm(mine, 'present')).toBe(true);
    expect(await kvmOf(sibling)).toBeNull();
    expect(await sayKvm(foreign, 'present')).toBe(false);
    expect(await kvmOf(foreign)).toBeNull();
    await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [sibling]);
    expect(await sayKvm(sibling, 'absent')).toBe(false);
    expect(await kvmOf(sibling)).toBeNull();
  });

  it("keeps the earlier definer's refusals: no runner in the session is 42501, a platform_ops login is refused", async () => {
    await expect(withTenant(appPool, a.accountId, async (c) => c.query(`SELECT runner_hello_record(1, '1', 'container', true, 'present')`))).rejects.toMatchObject({ code: '42501' });
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query(`SELECT runner_hello_record(1, '1', 'container', true, 'present')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });

  it('is one function: platform_ops owns it, app_user alone may execute it, PUBLIC may not, and its search_path is pinned', async () => {
    const all = await admin.query(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'runner_hello_record'`);
    expect(all.rows.map((x) => x.sig)).toEqual([HELLO]);
    const { rows } = await admin.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [HELLO],
    );
    expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'platform_ops', grantees: ['app_user'] });
  });
});
