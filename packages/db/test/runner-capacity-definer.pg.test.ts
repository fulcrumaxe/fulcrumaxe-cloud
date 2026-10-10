import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'runner_capacity_definer';
const FN = 'runner_capacity_record(integer,integer,text)';
const TABLE = 'runner_capacity';

/** 0777 (D#6 C43-2b): the side table of declared capacity, and the definer that sets it for the runner named by the session. */
describe('migration 0777: runner_capacity and runner_capacity_record', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  let runner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, refs.accountId, refs.userId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const stored = async (id = runner) => (await admin.query(`SELECT declared, light_limit, heavy_limit, limited_by FROM ${TABLE} WHERE runner_id = $1`, [id])).rows[0] ?? null;
  /** Calls the definer as the web tier's login, in the runner's session context (what the runner middleware sets). */
  const record = (light: number | null, heavy: number | null, id = runner, accountId = refs.accountId, limitedBy: string | null = null): Promise<unknown> =>
    withTenant(appPool, accountId, async (client) => {
      await client.query(`SELECT set_config('app.runner_id', $1, true)`, [id]);
      await client.query('SELECT runner_capacity_record($1::int, $2::int, $3::text)', [light, heavy, limitedBy]);
    });

  it('the role is NOLOGIN and unprivileged, has no member, is a member of nothing, and owns exactly this function', async () => {
    const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
    const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
    expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
    expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
  });

  it('the role holds exactly the grants its body needs, and app_user may read the limits and nothing more', async () => {
    const held = (who: string) =>
      admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace AND c.relname = $2
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace AND c.relname IN ($2, 'runners', 'accounts')
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [who, TABLE],
      );
    const col = (c: string, p: string) => `column ${TABLE}.${c} ${p}`;
    expect((await held(ROLE)).rows.map((r) => r.x).sort()).toEqual(
      [
        ...['runner_id', 'account_id', 'declared', 'light_limit', 'heavy_limit', 'limited_by'].map((c) => col(c, 'SELECT')),
        ...['runner_id', 'account_id', 'declared', 'light_limit', 'heavy_limit', 'limited_by', 'updated_at'].map((c) => col(c, 'INSERT')),
        ...['declared', 'light_limit', 'heavy_limit', 'limited_by', 'updated_at'].map((c) => col(c, 'UPDATE')),
        'column runners.id SELECT',
        'column runners.account_id SELECT',
        'column runners.revoked_at SELECT',
        'column accounts.id SELECT',
        'column accounts.deleted_at SELECT',
        'schema public USAGE',
      ].sort(),
    );
    expect((await held('app_user')).rows.map((r) => r.x).filter((x) => x.includes(TABLE)).sort()).toEqual(['runner_id', 'account_id', 'declared', 'light_limit', 'heavy_limit', 'limited_by'].map((c) => col(c, 'SELECT')).sort());
  });

  it('the table is row-secured and forced, with a policy per write command for the definer and a tenant read for app_user', async () => {
    expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [TABLE])).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const { rows } = await admin.query<{ roles: string[]; cmd: string }>(`SELECT roles::text[] AS roles, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [TABLE]);
    expect(rows.map((r) => `${r.cmd} ${r.roles.join(',')}`).sort()).toEqual(['INSERT ' + ROLE, 'SELECT ' + ROLE, 'SELECT app_user', 'UPDATE ' + ROLE].sort());
  });

  it('platform_ops holds NO privilege on the table, any column of it, or the function, and no other web-tier login can write it', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect((await admin.query(`SELECT has_table_privilege('platform_ops', $1, $2) AS ok`, [TABLE, privilege])).rows[0].ok, privilege).toBe(false);
    }
    expect((await admin.query(`SELECT has_any_column_privilege('platform_ops', $1, 'SELECT, INSERT, UPDATE, REFERENCES') AS ok`, [TABLE])).rows[0].ok).toBe(false);
    expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [FN])).rows[0].ok).toBe(false);
    // runners itself is unchanged: no new column for the table-wide grant to reach.
    expect((await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'runners' AND column_name IN ('light_limit', 'heavy_limit', 'capacity')`)).rowCount).toBe(0);
    for (const who of ['app_user', 'partner_user', 'agent_run_writer']) {
      expect((await admin.query(`SELECT has_any_column_privilege($1, $2, 'INSERT, UPDATE') AS ok`, [who, TABLE])).rows[0].ok, who).toBe(false);
      expect((await admin.query(`SELECT has_table_privilege($1, $2, 'DELETE') AS ok`, [who, TABLE])).rows[0].ok, who).toBe(false);
    }
  });

  it('the function is SECURITY DEFINER with a pinned search_path, and EXECUTE for app_user alone', async () => {
    const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[]; grantees: string[]; grantable: boolean }>(
      `SELECT p.prosecdef, p.proconfig,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
              coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'], grantable: false });
  });

  it('stores the two limits, and null for both means declared nothing', async () => {
    await record(3, 1);
    expect(await stored()).toEqual({ declared: true, light_limit: 3, heavy_limit: 1, limited_by: null });
    await record(null, null);
    expect(await stored()).toEqual({ declared: false, light_limit: null, heavy_limit: null, limited_by: null });
    await record(8, 4);
    expect(await stored()).toEqual({ declared: true, light_limit: 8, heavy_limit: 4, limited_by: null });
    await record(0, 0);
    expect(await stored()).toEqual({ declared: true, light_limit: 0, heavy_limit: 0, limited_by: null });
  });

  it('stores the cause of a low limit, changes it, clears it, and refuses one outside the set or without limits (22023)', async () => {
    for (const cause of ['memory', 'cpu', 'disk', 'paused', 'ceiling']) {
      await record(2, 1, runner, refs.accountId, cause);
      expect((await stored())!.limited_by, cause).toBe(cause);
    }
    await record(2, 1);
    expect((await stored())!.limited_by).toBeNull();
    await record(2, 1, runner, refs.accountId, 'memory');
    await expect(record(2, 1, runner, refs.accountId, 'gpu')).rejects.toMatchObject({ code: '22023' });
    await expect(record(null, null, runner, refs.accountId, 'memory')).rejects.toMatchObject({ code: '22023' });
    expect((await stored())!.limited_by).toBe('memory');
    await expect(admin.query(`UPDATE ${TABLE} SET limited_by = 'gpu' WHERE runner_id = $1`, [runner])).rejects.toMatchObject({ code: '23514' });
    await record(2, 1);
  });

  it('writes nothing when the figure is unchanged', async () => {
    await record(2, 1);
    const xmin = async () => (await admin.query<{ x: string }>(`SELECT xmin::text AS x FROM ${TABLE} WHERE runner_id = $1`, [runner])).rows[0]!.x;
    const before = await xmin();
    await record(2, 1);
    expect(await xmin()).toBe(before);
    await record(2, 2);
    expect(await xmin()).not.toBe(before);
  });

  it('refuses a figure above the ceilings, below zero, or half given (22023), and the table constraint holds for a direct write', async () => {
    await record(1, 1);
    for (const [l, h] of [[9, 1], [1, 5], [-1, 1], [1, -1], [3, null], [null, 1]] as Array<[number | null, number | null]>) {
      await expect(record(l, h), `${l},${h}`).rejects.toMatchObject({ code: '22023' });
    }
    expect(await stored()).toEqual({ declared: true, light_limit: 1, heavy_limit: 1, limited_by: null });
    await expect(admin.query(`INSERT INTO ${TABLE} (runner_id, account_id, declared, light_limit, heavy_limit) VALUES ($1, $2, true, 9, 1)`, [await insertRunner(admin, refs.accountId, refs.userId), refs.accountId])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE ${TABLE} SET declared = false WHERE runner_id = $1`, [runner])).rejects.toMatchObject({ code: '23514' });
  });

  it('touches only the runner the session names, in the session account, and never a revoked one', async () => {
    const other = await insertRunner(admin, refs.accountId, refs.userId);
    await admin.query(`DELETE FROM ${TABLE} WHERE runner_id = $1`, [runner]);
    await record(2, 1);
    expect(await stored(other)).toBeNull();
    const stranger = await seedAccount(admin, randomUUID());
    await record(5, 3, runner, stranger.accountId);
    expect(await stored()).toEqual({ declared: true, light_limit: 2, heavy_limit: 1, limited_by: null });
    await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [runner]);
    await record(4, 2);
    expect(await stored()).toEqual({ declared: true, light_limit: 2, heavy_limit: 1, limited_by: null });
    await admin.query('UPDATE runners SET revoked_at = NULL WHERE id = $1', [runner]);
  });

  it("a tenant reads its own runners' limits and never another account's; the row follows its runner when that is deleted", async () => {
    const mine = await insertRunner(admin, refs.accountId, refs.userId);
    const stranger = await seedAccount(admin, randomUUID());
    const theirs = await insertRunner(admin, stranger.accountId, stranger.userId);
    await admin.query(`INSERT INTO ${TABLE} (runner_id, account_id, declared, light_limit, heavy_limit) VALUES ($1, $2, true, 2, 1), ($3, $4, true, 3, 3)`, [mine, refs.accountId, theirs, stranger.accountId]);
    const seen = await withTenant(appPool, refs.accountId, (c) => c.query<{ runner_id: string }>(`SELECT runner_id FROM ${TABLE}`));
    expect(seen.rows.map((r) => r.runner_id)).not.toContain(theirs);
    expect(seen.rows.map((r) => r.runner_id)).toContain(mine);
    await expect(withTenant(appPool, refs.accountId, (c) => c.query(`INSERT INTO ${TABLE} (runner_id, account_id, declared) VALUES ($1, $2, false)`, [runner, refs.accountId]))).rejects.toMatchObject({ code: '42501' });
    await admin.query('DELETE FROM runners WHERE id = $1', [mine]);
    expect((await admin.query(`SELECT 1 FROM ${TABLE} WHERE runner_id = $1`, [mine])).rowCount).toBe(0);
  });

  it('refuses a session with no runner (42501) and a direct platform_ops login', async () => {
    await expect(withTenant(appPool, refs.accountId, async (client) => client.query('SELECT runner_capacity_record($1::int, $2::int, $3::text)', [1, 1, null]))).rejects.toMatchObject({ code: '42501' });
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query(`SELECT 1 FROM ${TABLE}`)).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query('SELECT runner_capacity_record(1, 1, NULL)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });
});
