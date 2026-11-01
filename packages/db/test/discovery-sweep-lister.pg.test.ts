import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'discovery_sweep_lister';
const FN = 'discovery_sweep_list_due(integer)';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (0952). */
const EXPECTED_PRIVILEGES = [
  ...['repo_id', 'trigger', 'trigger_ref'].map((c) => `column discovery_runs.${c} SELECT`),
  ...['account_id', 'repo_id', 'frequency', 'version'].map((c) => `column discovery_settings.${c} SELECT`),
  ...['id', 'account_id', 'installation_id', 'product'].map((c) => `column repos.${c} SELECT`),
  ...['id', 'deleted_at'].map((c) => `column accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

/** [pg] D#483 S5-g2 (migration 0952): who may run the sweep's cross-account list, what it returns, and the `sweep` trigger. */
describe(`migration 0952: ${ROLE} and discovery_sweep_list_due [pg]`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
  });

  it('the role is NOLOGIN and unprivileged, a member of nothing, owns exactly the lister, and holds exactly the columns it reads', async () => {
    const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
    const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
    expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
    const held = await admin.query<{ x: string }>(
      `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
       SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
       UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
         FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
       UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
      [ROLE],
    );
    expect(held.rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
    const policies = await admin.query<{ t: string; roles: string[] }>(`SELECT tablename || ' ' || cmd AS t, roles::text[] AS roles FROM pg_policies WHERE $1 = ANY(roles) ORDER BY 1`, [ROLE]);
    expect(policies.rows.map((r) => r.t)).toEqual(['accounts SELECT', 'discovery_runs SELECT', 'discovery_settings SELECT', 'repos SELECT']);
    for (const r of policies.rows) expect(r.roles).toEqual([ROLE]);
  });

  it('is owned by the lister role and executable by the run-writer login alone: platform_ops and app_user are refused, and so is a bad limit', async () => {
    const owner = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p WHERE p.oid = $1::regprocedure AND p.proowner = $2::regrole AND p.prosecdef AND p.provolatile = 's' AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)`, [FN, ROLE]);
    expect(owner.rows[0]!.n).toBe(1);
    for (const url of [process.env.DATABASE_URL_PLATFORM_OPS, process.env.DATABASE_URL_APP_USER]) {
      const pool = createPool(url!);
      try {
        await expect(pool.query('SELECT * FROM discovery_sweep_list_due(10)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
    for (const bad of ['0', '501', 'NULL']) await expect(writerPool.query(`SELECT * FROM discovery_sweep_list_due(${bad})`)).rejects.toMatchObject({ code: '22023' });
  });

  const sweepRun = (t: SeedRefs, ref: string) => admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'sweep', $3)`, [t.accountId, t.repoId, ref]);

  it('lists a connected product repository of a live account until a sweep run exists for the current period, and no other (old period, disconnected, sitekit, deleted account); the trigger check refuses an unknown word', async () => {
    // The list is ordered by account and a page is 500 repositories: ids that sort first keep these accounts inside it.
    const seed = () => seedAccount(admin, `00000000-${randomUUID().slice(9)}`);
    const [due, done, old, gone, dead, kit] = [await seed(), await seed(), await seed(), await seed(), await seed(), await seed()] as [SeedRefs, SeedRefs, SeedRefs, SeedRefs, SeedRefs, SeedRefs];
    await sweepRun(done, (await admin.query<{ d: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`)).rows[0]!.d);
    await sweepRun(old, '2000-01-01');
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [gone.repoId]);
    await admin.query(`UPDATE repos SET product = 'sitekit' WHERE id = $1`, [kit.repoId]);
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [dead.accountId]);
    const res = await writerPool.query<{ repo_id: string }>('SELECT * FROM discovery_sweep_list_due(500)');
    expect(res.fields.map((f) => f.name)).toEqual(['account_id', 'repo_id', 'period_ref']);
    await expect(admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'nightly', 'x')`, [due.accountId, due.repoId])).rejects.toMatchObject({ code: '23514' });
    const all = [due, done, old, gone, dead, kit].map((t) => t.repoId);
    expect(new Set(res.rows.map((r) => r.repo_id).filter((id) => all.includes(id)))).toEqual(new Set([due.repoId, old.repoId]));
  });
});
