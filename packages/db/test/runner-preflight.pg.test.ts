import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const FN = 'runner_preflight_record(text[])';

/** D#845 ON-21b (migration 1051): the machine's preflight codes, written by the new definer on every hello of a database that has the column. */
describe('migration 1051: runners.preflight through runner_preflight_record', () => {
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

  const say = (runnerId: string, codes: string[] | null, accountId = a.accountId): Promise<boolean> =>
    withTenant(appPool, accountId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerId]);
      return (await c.query<{ ok: boolean }>('SELECT runner_preflight_record($1::text[]) AS ok', [codes])).rows[0]!.ok;
    });
  const stored = async (id: string) => (await admin.query<{ p: string[] | null }>('SELECT preflight AS p FROM runners WHERE id = $1', [id])).rows[0]!.p;

  it('a new runner row reads unknown (NULL), which is not the same as an empty list', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    expect(await stored(r)).toBeNull();
    expect(await say(r, [])).toBe(true);
    expect(await stored(r)).toEqual([]);
  });

  it('stores the codes, replaces the old list on the next hello, and a hello that says nothing (NULL) clears it', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    expect(await say(r, ['kvm_absent', 'net_blocked:github', 'unchecked:disk'])).toBe(true);
    expect(await stored(r)).toEqual(['kvm_absent', 'net_blocked:github', 'unchecked:disk']);
    expect(await say(r, ['dns_failed'])).toBe(true);
    expect(await stored(r)).toEqual(['dns_failed']);
    expect(await say(r, null)).toBe(true);
    expect(await stored(r)).toBeNull();
  });

  it('refuses anything outside the closed set, a repeat, a NULL member, a nested list and an oversized list (22023), and keeps the old list', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    expect(await say(r, ['clock_skew'])).toBe(true);
    const many = Array.from({ length: 33 }, () => 'kvm_absent');
    for (const bad of [['KVM_ABSENT'], ['kvm_absent', 'kvm_absent'], ['net_blocked:evil.example'], ['fictional-dir/secret'], [''], ['unchecked:'], many, ['kvm_absent', null as unknown as string]]) {
      await expect(say(r, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    await expect(withTenant(appPool, a.accountId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [r]);
      await c.query(`SELECT runner_preflight_record('{{kvm_absent},{dns_failed}}'::text[])`);
    })).rejects.toMatchObject({ code: '22023' });
    expect(await stored(r)).toEqual(['clock_skew']);
  });

  it("the column's CHECK refuses what the definer would, even for a direct write (23514)", async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    for (const bad of [`'{host.example}'`, `'{kvm_absent,/etc}'`, `'{{kvm_absent},{dns_failed}}'`]) {
      await expect(admin.query(`UPDATE runners SET preflight = ${bad}::text[] WHERE id = $1`, [r]), bad).rejects.toMatchObject({ code: '23514' });
    }
    await admin.query(`UPDATE runners SET preflight = '{}' WHERE id = $1`, [r]);
    expect(await stored(r)).toEqual([]);
  });

  it("writes only the named runner's row; a revoked runner and another account's runner are not written", async () => {
    const mine = await insertRunner(admin, a.accountId, a.userId);
    const sibling = await insertRunner(admin, a.accountId, a.userId);
    const foreign = await insertRunner(admin, b.accountId, b.userId);
    expect(await say(mine, ['kvm_absent'])).toBe(true);
    expect(await stored(sibling)).toBeNull();
    // Another account's runner named from this account's session: no row matches, nothing is written.
    expect(await say(foreign, ['kvm_absent'])).toBe(false);
    expect(await stored(foreign)).toBeNull();
    await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [sibling]);
    expect(await say(sibling, ['kvm_absent'])).toBe(false);
    expect(await stored(sibling)).toBeNull();
  });

  it('refuses a session that is not a live runner of an active account: no runner is 42501, and a platform_ops login is refused', async () => {
    await expect(withTenant(appPool, a.accountId, async (c) => c.query(`SELECT runner_preflight_record('{kvm_absent}')`))).rejects.toMatchObject({ code: '42501' });
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query(`SELECT runner_preflight_record('{kvm_absent}')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });

  it('is one function: platform_ops owns it, app_user alone may execute it, PUBLIC may not, and its search_path is pinned', async () => {
    const all = await admin.query(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'runner_preflight_record'`);
    expect(all.rows.map((x) => x.sig)).toEqual([FN]);
    const { rows } = await admin.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'platform_ops', grantees: ['app_user'] });
  });

  it('the capability list stores preflight_v1 (and still kvm_fact_v1), and refuses an unknown one', async () => {
    const r = await insertRunner(admin, a.accountId, a.userId);
    const record = (caps: string[]) =>
      withTenant(appPool, a.accountId, async (c) => {
        await c.query(`SELECT set_config('app.runner_id', $1, true)`, [r]);
        await c.query('SELECT runner_capabilities_record($1::text[])', [caps]);
      });
    await record(['kvm_fact_v1', 'preflight_v1']);
    expect((await admin.query<{ c: string[] }>('SELECT capabilities AS c FROM runner_capabilities WHERE runner_id = $1', [r])).rows[0]!.c).toEqual(['kvm_fact_v1', 'preflight_v1']);
    await expect(record(['preflight_v2'])).rejects.toMatchObject({ code: '22023' });
  });
});
