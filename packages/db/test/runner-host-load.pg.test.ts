import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const LOAD = 'runner_host_load_record(integer,integer,integer)';
const HELLO = 'runner_hello_record(integer,text,text,boolean)';
const COLS = ['host_mem_avail_mb', 'host_disk_free_mb', 'host_setups_running', 'host_load_at'];

/** D#845 ON-1b (migration 1045): the machine's reported load, the hello's model-auth flag, and the two definers that write them. */
describe('migration 1045: runner host load and model_auth_present', () => {
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

  async function runner(who: SeedRefs, protocol: number | null, facts = true): Promise<string> {
    const id = await insertRunner(admin, who.accountId, who.userId);
    if (protocol !== null) await admin.query('UPDATE runners SET protocol_version = $2 WHERE id = $1', [id, protocol]);
    if (facts) await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm')`, [id, who.accountId]);
    return id;
  }
  const load = (args: unknown[], o: { runnerId?: string | null; accountId?: string } = {}): Promise<boolean> =>
    withTenant(appPool, o.accountId ?? a.accountId, async (c) => {
      if (o.runnerId !== null) await c.query(`SELECT set_config('app.runner_id', $1, true)`, [o.runnerId]);
      return (await c.query<{ ok: boolean }>('SELECT runner_host_load_record($1::int, $2::int, $3::int) AS ok', args)).rows[0]!.ok;
    });
  const hello = (runnerId: string, args: unknown[], accountId = a.accountId): Promise<boolean> =>
    withTenant(appPool, accountId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerId]);
      return (await c.query<{ ok: boolean }>('SELECT runner_hello_record($1::int, $2, $3, $4::boolean) AS ok', args)).rows[0]!.ok;
    });
  const stored = async (id: string) => (await admin.query(`SELECT ${COLS.join(', ')} FROM runner_facts WHERE runner_id = $1`, [id])).rows[0];
  const modelAuth = async (id: string) => (await admin.query<{ m: boolean | null }>('SELECT model_auth_present AS m FROM runners WHERE id = $1', [id])).rows[0]!.m;

  describe('host load', () => {
    it('stores the three numbers and a time for the runner the session names, and touches no other runner', async () => {
      const r = await runner(a, 22);
      const other = await runner(a, 22);
      expect(await stored(r)).toEqual({ host_mem_avail_mb: null, host_disk_free_mb: null, host_setups_running: null, host_load_at: null });
      expect(await load([9100, 250000, 2], { runnerId: r })).toBe(true);
      const row = await stored(r);
      expect(row).toMatchObject({ host_mem_avail_mb: 9100, host_disk_free_mb: 250000, host_setups_running: 2 });
      expect(row.host_load_at).toBeInstanceOf(Date);
      expect(await stored(other)).toEqual({ host_mem_avail_mb: null, host_disk_free_mb: null, host_setups_running: null, host_load_at: null });
      expect(await load([1, 2, 0], { runnerId: r })).toBe(true);
      expect(await stored(r)).toMatchObject({ host_mem_avail_mb: 1, host_disk_free_mb: 2, host_setups_running: 0 });
    });

    it('refuses a runner that declared a protocol below 22 (or none) and writes nothing', async () => {
      for (const protocol of [21, null]) {
        const r = await runner(a, protocol);
        await expect(load([1, 1, 1], { runnerId: r }), String(protocol)).rejects.toMatchObject({ code: '22023' });
        expect((await stored(r)).host_mem_avail_mb).toBeNull();
      }
    });

    it('refuses a value out of range or null, and keeps the old reading', async () => {
      const r = await runner(a, 22);
      expect(await load([5, 6, 7], { runnerId: r })).toBe(true);
      for (const args of [[-1, 1, 1], [1, -1, 1], [1, 1, -1], [100000001, 1, 1], [1, 100000001, 1], [1, 1, 1001], [null, 1, 1], [1, null, 1], [1, 1, null]]) {
        await expect(load(args, { runnerId: r }), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
      }
      expect(await stored(r)).toMatchObject({ host_mem_avail_mb: 5, host_disk_free_mb: 6, host_setups_running: 7 });
    });

    it('answers false and stores nothing for a runner with no facts row', async () => {
      const r = await runner(a, 22, false);
      expect(await load([1, 1, 1], { runnerId: r })).toBe(false);
      expect((await admin.query('SELECT 1 FROM runner_facts WHERE runner_id = $1', [r])).rowCount).toBe(0);
    });

    it("is refused with no runner in the session, for a revoked runner and for another account's runner", async () => {
      const mine = await runner(a, 22);
      const foreign = await runner(b, 22);
      await expect(load([1, 1, 1], { runnerId: null })).rejects.toMatchObject({ code: '42501' });
      await expect(load([1, 1, 1], { runnerId: foreign })).rejects.toMatchObject({ code: '42501' });
      expect((await stored(foreign)).host_mem_avail_mb).toBeNull();
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [mine]);
      await expect(load([1, 1, 1], { runnerId: mine })).rejects.toMatchObject({ code: '42501' });
      expect((await stored(mine)).host_mem_avail_mb).toBeNull();
    });

    it('the four columns are all set or all null (a table check), and only the definer may write them', async () => {
      const r = await runner(a, 22);
      await expect(admin.query('UPDATE runner_facts SET host_mem_avail_mb = 1 WHERE runner_id = $1', [r])).rejects.toMatchObject({ code: '23514' });
      for (const who of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer']) {
        expect((await admin.query(`SELECT has_column_privilege($1, 'runner_facts', c, 'UPDATE') AS ok FROM unnest($2::text[]) c`, [who, COLS])).rows.every((x) => x.ok === false), who).toBe(true);
      }
      expect((await admin.query(`SELECT has_column_privilege('runner_facts_definer', 'runner_facts', c, 'UPDATE') AS ok FROM unnest($1::text[]) c`, [COLS])).rows.every((x) => x.ok === true)).toBe(true);
      expect((await admin.query(`SELECT has_column_privilege('app_user', 'runner_facts', c, 'SELECT') AS ok FROM unnest($1::text[]) c`, [COLS])).rows.every((x) => x.ok === true)).toBe(true);
    });

    it('is a SECURITY DEFINER with a pinned search_path, owned by the facts role, executable by app_user alone', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [LOAD],
      );
      expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'runner_facts_definer', grantees: ['app_user'] });
      expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [LOAD])).rows[0].ok).toBe(false);
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        await expect(ops.query('SELECT runner_host_load_record(1, 1, 1)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ops.end();
      }
    });
  });

  describe('model_auth_present on the hello', () => {
    it('is NULL until a hello says, stored as sent on every hello, and the next hello moves it', async () => {
      const r = await runner(a, null, false);
      expect(await modelAuth(r)).toBeNull();
      expect(await hello(r, [3, '1.2.3', 'microvm', true])).toBe(true);
      expect(await modelAuth(r)).toBe(true);
      expect(await hello(r, [3, '1.2.3', 'microvm', false])).toBe(true);
      expect(await modelAuth(r)).toBe(false);
      expect(await admin.query('SELECT protocol_version, binary_version, isolation FROM runners WHERE id = $1', [r]).then((x) => x.rows[0])).toEqual({ protocol_version: 3, binary_version: '1.2.3', isolation: 'microvm' });
    });

    it('stays NULL for a caller that sends no value (the three-argument call), and a later hello without it clears an old value', async () => {
      const r = await runner(a, null, false);
      expect(await withTenant(appPool, a.accountId, async (c) => {
        await c.query(`SELECT set_config('app.runner_id', $1, true)`, [r]);
        return (await c.query<{ ok: boolean }>(`SELECT runner_hello_record(3, '1.2.3', 'container') AS ok`)).rows[0]!.ok;
      })).toBe(true);
      expect(await modelAuth(r)).toBeNull();
      expect(await hello(r, [3, '1.2.3', 'container', true])).toBe(true);
      expect(await hello(r, [3, '1.2.3', 'container', null])).toBe(true);
      expect(await modelAuth(r)).toBeNull();
    });

    it("writes only the named runner's row, and nothing for a revoked runner or another account's runner", async () => {
      const mine = await runner(a, null, false);
      const sibling = await runner(a, null, false);
      const foreign = await runner(b, null, false);
      expect(await hello(mine, [3, '1', 'container', true])).toBe(true);
      expect(await modelAuth(sibling)).toBeNull();
      expect(await hello(foreign, [3, '1', 'container', true])).toBe(false);
      expect(await modelAuth(foreign)).toBeNull();
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [sibling]);
      expect(await hello(sibling, [3, '1', 'container', true])).toBe(false);
      expect(await modelAuth(sibling)).toBeNull();
    });

    it('keeps 0724\'s refusals: a malformed argument is 22023, a missing runner is 42501', async () => {
      const r = await runner(a, null, false);
      for (const args of [[0, '1', 'container', true], [1, 'a b', 'container', true], [1, '1', 'none', true]]) {
        await expect(hello(r, args), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
      }
      await expect(withTenant(appPool, a.accountId, async (c) => c.query(`SELECT runner_hello_record(1, '1', 'container', true)`))).rejects.toMatchObject({ code: '42501' });
      expect(await modelAuth(r)).toBeNull();
    });

    it("the definer's owner, grants and search_path are 0724's: one function, owned by platform_ops, executable by app_user alone, never by PUBLIC", async () => {
      const all = await admin.query(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'runner_hello_record'`);
      expect(all.rows.map((x) => x.sig)).toEqual([HELLO]);
      const { rows } = await admin.query(
        `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [HELLO],
      );
      expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'platform_ops', grantees: ['app_user'] });
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        await expect(ops.query(`SELECT runner_hello_record(1, '1', 'container', true)`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ops.end();
      }
    });

    it('the migration left no role with CREATE on the public schema and no stray membership', async () => {
      for (const role of ['runner_facts_definer', 'platform_ops']) {
        expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [role])).rows[0].ok, role).toBe(false);
      }
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'runner_facts_definer'::regrole OR member = 'runner_facts_definer'::regrole`)).rowCount).toBe(0);
    });
  });
});
