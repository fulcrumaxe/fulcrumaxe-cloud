import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'runner_sandbox_status_definer';
const FN = 'runner_sandbox_status_record(text)';
const TABLE = 'runner_sandbox_status';
const REASONS = ['bwrap_missing', 'socat_missing', 'userns_disabled', 'apparmor_userns_restricted', 'probe_failed_other'];

/** 0763 (D#6 R4a-6, C16 section 1.3): the side table, its closed set, and the definer that sets it for the runner named by the session. */
describe('migration 0763: runner_sandbox_status and runner_sandbox_status_record', () => {
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

  const stored = async (id = runner): Promise<string | null> => (await admin.query<{ s: string }>(`SELECT reason AS s FROM ${TABLE} WHERE runner_id = $1`, [id])).rows[0]?.s ?? null;
  /** Calls the definer as the web tier's login, in the runner's session context (what the runner middleware sets). */
  const record = (reason: string | null, id = runner, accountId = refs.accountId): Promise<unknown> =>
    withTenant(appPool, accountId, async (client) => {
      await client.query(`SELECT set_config('app.runner_id', $1, true)`, [id]);
      await client.query('SELECT runner_sandbox_status_record($1)', [reason]);
    });

  it('the role is NOLOGIN and unprivileged, has no member, is a member of nothing, and owns exactly this function', async () => {
    const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
    const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
    expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
    expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
  });

  it('the role holds exactly the grants its body needs, and app_user may read the reason and nothing more', async () => {
    const held = (who: string) =>
      admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace AND c.relname = $2
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace AND c.relname IN ($2, 'runners', 'accounts')
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [who, TABLE],
      );
    expect((await held(ROLE)).rows.map((r) => r.x).sort()).toEqual(
      [
        `table ${TABLE} DELETE`,
        `column ${TABLE}.runner_id SELECT`,
        `column ${TABLE}.account_id SELECT`,
        `column ${TABLE}.reason SELECT`,
        `column ${TABLE}.runner_id INSERT`,
        `column ${TABLE}.account_id INSERT`,
        `column ${TABLE}.reason INSERT`,
        `column ${TABLE}.updated_at INSERT`,
        `column ${TABLE}.reason UPDATE`,
        `column ${TABLE}.updated_at UPDATE`,
        'column runners.id SELECT',
        'column runners.account_id SELECT',
        'column runners.revoked_at SELECT',
        'column accounts.id SELECT',
        'column accounts.deleted_at SELECT',
        'schema public USAGE',
      ].sort(),
    );
    expect((await held('app_user')).rows.map((r) => r.x).filter((x) => x.includes(TABLE)).sort()).toEqual(
      [`column ${TABLE}.runner_id SELECT`, `column ${TABLE}.account_id SELECT`, `column ${TABLE}.reason SELECT`].sort(),
    );
  });

  it('the table is row-secured and forced, with a policy per command for the definer and a tenant read for app_user', async () => {
    expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [TABLE])).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const { rows } = await admin.query<{ roles: string[]; cmd: string }>(`SELECT roles::text[] AS roles, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY cmd, 1`, [TABLE]);
    expect(rows.map((r) => `${r.cmd} ${r.roles.join(',')}`).sort()).toEqual(['DELETE ' + ROLE, 'INSERT ' + ROLE, 'SELECT ' + ROLE, 'SELECT app_user', 'UPDATE ' + ROLE].sort());
    const own = await admin.query<{ roles: string[] }>(`SELECT roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'runner_sandbox_status_definer%'`);
    expect(own.rowCount).toBe(6);
    for (const p of own.rows) expect(p.roles).toEqual([ROLE]);
  });

  it('platform_ops holds NO privilege on the table, any column of it, or the function, and no other web-tier login can write it', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect((await admin.query(`SELECT has_table_privilege('platform_ops', $1, $2) AS ok`, [TABLE, privilege])).rows[0].ok, privilege).toBe(false);
    }
    expect((await admin.query(`SELECT has_any_column_privilege('platform_ops', $1, 'SELECT, INSERT, UPDATE, REFERENCES') AS ok`, [TABLE])).rows[0].ok).toBe(false);
    expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [FN])).rows[0].ok).toBe(false);
    expect((await admin.query(`SELECT 1 FROM pg_proc WHERE oid = $1::regprocedure AND proowner = 'platform_ops'::regrole`, [FN])).rowCount).toBe(0);
    // runners itself is unchanged: no new column for the table-wide grant to reach.
    expect((await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'runners' AND column_name = 'sandbox_unavailable'`)).rowCount).toBe(0);
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

  it('sets each closed reason and clears it with null (the row goes away)', async () => {
    for (const reason of REASONS) {
      await record(reason);
      expect(await stored(), reason).toBe(reason);
    }
    await record(null);
    expect(await stored()).toBeNull();
    await record(null);
    expect(await stored()).toBeNull();
  });

  it('writes nothing when the value is unchanged', async () => {
    await record('bwrap_missing');
    const before = (await admin.query<{ x: string }>(`SELECT xmin::text AS x FROM ${TABLE} WHERE runner_id = $1`, [runner])).rows[0]!.x;
    await record('bwrap_missing');
    expect((await admin.query<{ x: string }>(`SELECT xmin::text AS x FROM ${TABLE} WHERE runner_id = $1`, [runner])).rows[0]!.x).toBe(before);
    await record('socat_missing');
    expect((await admin.query<{ x: string }>(`SELECT xmin::text AS x FROM ${TABLE} WHERE runner_id = $1`, [runner])).rows[0]!.x).not.toBe(before);
    await record(null);
  });

  it('refuses a value outside the set (22023), and the table constraint holds for a direct write', async () => {
    await expect(record('other')).rejects.toMatchObject({ code: '22023' });
    await expect(admin.query(`INSERT INTO ${TABLE} (runner_id, account_id, reason) VALUES ($1, $2, 'other')`, [runner, refs.accountId])).rejects.toMatchObject({ code: '23514' });
    expect(await stored()).toBeNull();
  });

  it('touches only the runner the session names, in the session account, and never a revoked one', async () => {
    const other = await insertRunner(admin, refs.accountId, refs.userId);
    await record('socat_missing');
    expect(await stored(other)).toBeNull();
    const stranger = await seedAccount(admin, randomUUID());
    await record('userns_disabled', runner, stranger.accountId);
    expect(await stored()).toBe('socat_missing');
    await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [runner]);
    await record('bwrap_missing');
    expect(await stored()).toBe('socat_missing');
    await record(null);
    expect(await stored()).toBe('socat_missing');
    await admin.query('UPDATE runners SET revoked_at = NULL WHERE id = $1', [runner]);
    await record(null);
  });

  it("a tenant reads its own runners' reasons and never another account's; the row follows its runner when that is deleted", async () => {
    const mine = await insertRunner(admin, refs.accountId, refs.userId);
    const stranger = await seedAccount(admin, randomUUID());
    const theirs = await insertRunner(admin, stranger.accountId, stranger.userId);
    await admin.query(`INSERT INTO ${TABLE} (runner_id, account_id, reason) VALUES ($1, $2, 'bwrap_missing'), ($3, $4, 'socat_missing')`, [mine, refs.accountId, theirs, stranger.accountId]);
    const seen = await withTenant(appPool, refs.accountId, (c) => c.query<{ runner_id: string }>(`SELECT runner_id FROM ${TABLE}`));
    expect(seen.rows.map((r) => r.runner_id)).toEqual([mine]);
    await expect(withTenant(appPool, refs.accountId, (c) => c.query(`INSERT INTO ${TABLE} (runner_id, account_id, reason) VALUES ($1, $2, 'bwrap_missing')`, [runner, refs.accountId]))).rejects.toMatchObject({ code: '42501' });
    await admin.query('DELETE FROM runners WHERE id = $1', [mine]);
    expect((await admin.query(`SELECT 1 FROM ${TABLE} WHERE runner_id = $1`, [mine])).rowCount).toBe(0);
  });

  it('refuses a session with no runner (42501) and a direct platform_ops login', async () => {
    await expect(withTenant(appPool, refs.accountId, async (client) => client.query('SELECT runner_sandbox_status_record($1)', ['bwrap_missing']))).rejects.toMatchObject({ code: '42501' });
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      // With a valid account and runner in the session: platform_ops holds no EXECUTE, so the grant is what stops it (the body's own platform_ops check is a second wall that the grant makes unreachable).
      const client = await ops.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.account_id', $1, true), set_config('app.runner_id', $2, true)`, [refs.accountId, runner]);
        await expect(client.query('SELECT runner_sandbox_status_record($1)', ['bwrap_missing'])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      await expect(ops.query(`SELECT 1 FROM ${TABLE}`)).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query(`INSERT INTO ${TABLE} (runner_id, account_id, reason) VALUES ($1, $2, 'bwrap_missing')`, [runner, refs.accountId])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });
});
