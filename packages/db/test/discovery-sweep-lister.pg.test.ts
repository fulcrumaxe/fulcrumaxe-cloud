import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'discovery_sweep_lister';
const FN = 'discovery_sweep_list_due(integer,uuid,uuid)';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (0952). */
const EXPECTED_PRIVILEGES = [
  ...['repo_id', 'trigger', 'trigger_ref'].map((c) => `column discovery_runs.${c} SELECT`),
  ...['account_id', 'repo_id', 'frequency', 'version'].map((c) => `column discovery_settings.${c} SELECT`),
  ...['id', 'account_id', 'installation_id', 'product'].map((c) => `column repos.${c} SELECT`),
  ...['id', 'deleted_at', 'status'].map((c) => `column accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

/** [pg] D#483 S5-g2 (migration 0952): who may run the sweep's cross-account list, what it returns, and the `sweep` trigger. */
describe(`migrations 0952 and 0955: ${ROLE} and discovery_sweep_list_due [pg]`, () => {
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
        await expect(pool.query('SELECT * FROM discovery_sweep_list_due(10, NULL, NULL)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
    for (const bad of ['0', '501', 'NULL']) await expect(writerPool.query(`SELECT * FROM discovery_sweep_list_due(${bad}, NULL, NULL)`)).rejects.toMatchObject({ code: '22023' });
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
    const res = { rows: await listed() };
    expect((await writerPool.query('SELECT * FROM discovery_sweep_list_due(500, NULL, NULL)')).fields.map((f) => f.name)).toEqual(['account_id', 'repo_id', 'period_ref']);
    await expect(admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'nightly', 'x')`, [due.accountId, due.repoId])).rejects.toMatchObject({ code: '23514' });
    const all = [due, done, old, gone, dead, kit].map((t) => t.repoId);
    expect(new Set(res.rows.map((r) => r.repo_id).filter((id) => all.includes(id)))).toEqual(new Set([due.repoId, old.repoId]));
  });

  type Key = Array<{ account_id: string; repo_id: string }>;
  /** One page, as the lister answers it: strictly after the cursor (account, repo), in repo id order. */
  const page = async (after: [string, string] | null = null, limit = 500): Promise<Key> =>
    (await writerPool.query('SELECT account_id, repo_id FROM discovery_sweep_list_due($1, $2, $3)', [limit, after?.[0] ?? null, after?.[1] ?? null])).rows;
  /** Every due row: all pages walked. The database is shared, so the whole list can be longer than one page. */
  const listed = async (): Promise<Key> => {
    const all: Key = [];
    for (let p = await page(); p.length > 0; p = await page([p[p.length - 1]!.account_id, p[p.length - 1]!.repo_id])) all.push(...p);
    return all;
  };
  const setting = (t: SeedRefs, frequency: string, version: number) => admin.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, $3, $4, $5)`, [t.accountId, t.repoId, frequency, version, t.userId]);
  const seedLow = () => seedAccount(admin, `00000000-${randomUUID().slice(9)}`);

  it('C26-g2f-1: a repository whose newest setting is off is not listed, nor is its old run needed; weekly and daily and none stay listed; turned back on, it is listed again the same UTC day', async () => {
    const [off, back, weekly, none] = [await seedLow(), await seedLow(), await seedLow(), await seedLow()] as [SeedRefs, SeedRefs, SeedRefs, SeedRefs];
    await setting(off, 'off', 1);
    await setting(back, 'off', 1);
    await setting(weekly, 'weekly', 1);
    const ids = (rows: Array<{ repo_id: string }>) => new Set(rows.map((r) => r.repo_id).filter((id) => [off, back, weekly, none].some((t) => t.repoId === id)));
    expect(ids(await listed())).toEqual(new Set([weekly.repoId, none.repoId]));
    await setting(back, 'daily', 2);
    expect(ids(await listed())).toEqual(new Set([back.repoId, weekly.repoId, none.repoId]));
  });

  it('C26-g2f-2: a repository of an account that is not active is not listed, and is listed again once the account is active', async () => {
    const lapsed = await seedLow();
    await admin.query(`UPDATE accounts SET stripe_customer_id = NULL, status = 'unsubscribed' WHERE id = $1`, [lapsed.accountId]);
    expect((await listed()).some((r) => r.repo_id === lapsed.repoId)).toBe(false);
    await admin.query(`UPDATE accounts SET stripe_customer_id = $2, status = 'active' WHERE id = $1`, [lapsed.accountId, `cus_${randomUUID()}`]);
    expect((await listed()).some((r) => r.repo_id === lapsed.repoId)).toBe(true);
  });

  it('pages by a keyset cursor in (repo, account) order: strictly after the cursor, in order, no row twice, even with more than one page of due rows; exactly one null is refused like a bad limit', async () => {
    const three = [await seedLow(), await seedLow(), await seedLow()];
    // more than a page (500) of due repositories in one account, removed again at the end
    const bulk = await seedLow();
    await admin.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) SELECT $1, $2, g, 'team' FROM generate_series(1000, 1600) g`, [bulk.accountId, bulk.installationId]);
    try {
      const all = await listed();
      expect(all.length).toBeGreaterThan(500);
      const order = all.map((r) => r.repo_id + r.account_id);
      expect(order).toEqual([...order].sort());
      const walked: string[] = [];
      let after: [string, string] | null = null;
      for (let p = await page(after, 7); p.length > 0; p = await page(after, 7)) {
        walked.push(...p.map((r) => r.repo_id));
        after = [p[p.length - 1]!.account_id, p[p.length - 1]!.repo_id];
      }
      expect(walked).toEqual(all.map((r) => r.repo_id));
      expect(new Set(walked).size).toBe(walked.length);
      for (const t of three) expect(walked).toContain(t.repoId);
      expect(await page([all[all.length - 1]!.account_id, all[all.length - 1]!.repo_id])).toEqual([]);
    } finally {
      await admin.query(`DELETE FROM repos WHERE account_id = $1 AND gh_repo_id >= 1000`, [bulk.accountId]);
    }
    for (const args of [['ffffffff-0000-4000-8000-000000000000', null], [null, 'ffffffff-0000-4000-8000-000000000000']]) {
      await expect(writerPool.query('SELECT * FROM discovery_sweep_list_due(10, $1, $2)', args)).rejects.toMatchObject({ code: '22023' });
    }
    await expect(admin.query('SELECT * FROM discovery_sweep_list_due(10)')).rejects.toMatchObject({ code: '42883' }); // the old one-argument signature is gone
  });
});
