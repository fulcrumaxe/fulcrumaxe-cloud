import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { seedVerifyRow } from './helpers/verifyRows.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const ROLE = 'verify_stage_lister';
const FN = 'verify_stage_list_enabled(integer,uuid)';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (1005). */
const EXPECTED_PRIVILEGES = [
  ...['repo_id', 'account_id', 'enabled'].map((c) => `column verify_settings.${c} SELECT`),
  ...['id', 'deleted_at', 'status'].map((c) => `column accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

/**
 * [pg] D#749 V3a, migration 1005: a deploy order names a real verify row of its own account (composite foreign key, cascade), and the verify sweep's cross-account list
 * (verify_stage_list_enabled) names only the repositories that turned verification on, in a live account. Real roles, real chain.
 */
describe(`migration 1005: verify_deploy_orders row key and ${ROLE} [pg]`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  const cloud = <T>(who: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, who.accountId, who.userId, fn);
  const place = (who: SeedRefs, rowId: string, over: { account?: string } = {}) =>
    cloud(who, (c) =>
      c.query<{ id: string }>(`INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`, [
        over.account ?? who.accountId, who.repoId, rowId, randomUUID().replaceAll('-', '') + 'abcdef01',
      ]),
    );
  async function newRepo(who: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [id, who.accountId, who.installationId, Math.floor(Math.random() * 1e9) + 10]);
    return id;
  }
  const enable = (who: SeedRefs, repoId: string, enabled = true) =>
    admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url) VALUES ($1, $2, $3, 'https://app.example')`, [repoId, who.accountId, enabled]);
  const listed = async (pool: Pool = writerPool, args: unknown[] = [200, null]): Promise<string[]> =>
    (await pool.query<{ repo_id: string }>('SELECT repo_id FROM verify_stage_list_enabled($1::int, $2::uuid)', args)).rows.map((r) => r.repo_id);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
    await writerPool.end();
  });

  describe('the order names a real verify row of its own account', () => {
    it('an order for a row that does not exist, or that belongs to another account, is refused by the key', async () => {
      await expect(place(a, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      const theirs = await seedVerifyRow(admin, b);
      await expect(place(a, theirs), 'a row of another account').rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      const mine = await seedVerifyRow(admin, a);
      expect((await place(a, mine)).rows).toHaveLength(1);
    });

    it('the order goes with its row: deleting the row, or the work item the row hangs from, removes the order', async () => {
      const row = await seedVerifyRow(admin, a);
      const order = (await place(a, row)).rows[0]!.id;
      expect((await admin.query(`SELECT 1 FROM verify_deploy_orders WHERE id = $1`, [order])).rowCount).toBe(1);
      await admin.query(`DELETE FROM verify_rows WHERE id = $1`, [row]);
      expect((await admin.query(`SELECT 1 FROM verify_deploy_orders WHERE id = $1`, [order])).rowCount).toBe(0);

      const row2 = await seedVerifyRow(admin, a);
      const order2 = (await place(a, row2)).rows[0]!.id;
      const item = (await admin.query<{ work_item_id: string }>(`SELECT work_item_id FROM verify_rows WHERE id = $1`, [row2])).rows[0]!.work_item_id;
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [item]);
      expect((await admin.query(`SELECT 1 FROM verify_deploy_orders WHERE id = $1`, [order2])).rowCount).toBe(0);
    });

    it('the key is composite and cascades: it is on (account_id, verify_row_id) against verify_rows (account_id, id), ON DELETE CASCADE', async () => {
      const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'verify_deploy_orders_row_fk'`);
      expect(rows[0]!.def).toBe('FOREIGN KEY (account_id, verify_row_id) REFERENCES verify_rows(account_id, id) ON DELETE CASCADE');
    });
  });

  describe('verify_settings.enabled_since', () => {
    const since = async (repoId: string) => (await admin.query<{ s: Date | null; e: boolean }>(`SELECT enabled_since AS s, enabled AS e FROM verify_settings WHERE repo_id = $1`, [repoId])).rows[0]!;

    it('is stamped when a row is inserted enabled and is empty when it is not; a supplied value is replaced', async () => {
      const on = await newRepo(a);
      const off = await newRepo(a);
      await admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url, enabled_since) VALUES ($1, $2, true, 'https://app.example', now() - interval '9 days')`, [on, a.accountId]);
      await enable(a, off, false);
      expect(Date.now() - (await since(on)).s!.getTime()).toBeLessThan(60_000);
      expect((await since(off)).s).toBeNull();
    });

    it('moves only on the off -> on move; it is cleared by off and the database refuses a row whose stamp and switch disagree', async () => {
      const repo = await newRepo(a);
      await enable(a, repo);
      const first = (await since(repo)).s!;
      await admin.query(`UPDATE verify_settings SET base_url = 'https://other.example', updated_at = now() + interval '1 minute' WHERE repo_id = $1`, [repo]);
      expect((await since(repo)).s!.getTime()).toBe(first.getTime());
      await admin.query(`UPDATE verify_settings SET enabled = false WHERE repo_id = $1`, [repo]);
      expect((await since(repo)).s).toBeNull();
      await admin.query(`UPDATE verify_settings SET enabled = true WHERE repo_id = $1`, [repo]);
      expect((await since(repo)).s!.getTime()).toBeGreaterThanOrEqual(first.getTime());
      await admin.query('ALTER TABLE verify_settings DISABLE TRIGGER verify_settings_stamp_enabled_since');
      try {
        await expect(admin.query(`UPDATE verify_settings SET enabled_since = NULL WHERE repo_id = $1`, [repo])).rejects.toMatchObject({ constraint: 'verify_settings_enabled_since_check' });
      } finally {
        await admin.query('ALTER TABLE verify_settings ENABLE TRIGGER verify_settings_stamp_enabled_since');
      }
    });

    it('an owner or admin saving through the app login cannot write the stamp: it holds no grant on the column', async () => {
      const repo = await newRepo(a);
      await enable(a, repo);
      await expect(cloud(a, (c) => c.query(`UPDATE verify_settings SET enabled_since = now() - interval '5 days' WHERE repo_id = $1`, [repo]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await cloud(a, (c) => c.query(`UPDATE verify_settings SET base_url = 'https://saved.example' WHERE repo_id = $1`, [repo]));
      expect((await since(repo)).e).toBe(true);
    });
  });

  describe('verify_stage_list_enabled', () => {
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
      expect(policies.rows.map((r) => r.t)).toEqual(['accounts SELECT', 'verify_settings SELECT']);
      for (const r of policies.rows) expect(r.roles).toEqual([ROLE]);
    });

    it('the function is SECURITY DEFINER, STABLE, search_path pinned, EXECUTE for the run-writer login alone; platform_ops and app_user are refused; a bad limit is refused', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: ['agent_run_writer'] });
      for (const url of [process.env.DATABASE_URL_PLATFORM_OPS, process.env.DATABASE_URL_APP_USER]) {
        const pool = createPool(url!);
        try {
          await expect(pool.query('SELECT * FROM verify_stage_list_enabled(10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        } finally {
          await pool.end();
        }
      }
      for (const arg of [0, 201, null]) await expect(writerPool.query('SELECT * FROM verify_stage_list_enabled($1)', [arg])).rejects.toMatchObject({ code: '22023' });
    });

    it('the refusal inside the function body stands on its own: with EXECUTE granted to the platform_ops login (the grant that already stops it removed), the call is still refused', async () => {
      // The missing grant alone would keep this login out, so the body's own check is only visible once the grant is given. The grant is committed (a second session cannot see an
      // open transaction's) and taken back in the finally, so no other case sees it.
      await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO platform_ops`);
      const pool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        const who = await pool.query<{ s: string }>('SELECT session_user AS s');
        expect(who.rows[0]!.s).toBe('platform_ops');
        await expect(pool.query('SELECT * FROM verify_stage_list_enabled(10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
        // The same call from the run-writer login (the grant it holds) is answered.
        await expect(writerPool.query('SELECT * FROM verify_stage_list_enabled(10)')).resolves.toBeDefined();
      } finally {
        await pool.end();
        await admin.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM platform_ops`);
      }
    });

    it('names only repositories whose settings say enabled, in a live active account: off by default, switched off, and a deleted account are absent', async () => {
      const on = await newRepo(a);
      const off = await newRepo(a);
      const never = await newRepo(a);
      const gone = await newRepo(b);
      await enable(a, on);
      await enable(a, off, false);
      await enable(b, gone);
      expect(await listed()).toEqual(expect.arrayContaining([on, gone]));
      expect(await listed()).not.toContain(off);
      expect(await listed()).not.toContain(never);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [b.accountId]);
      try {
        expect(await listed()).toContain(on);
        expect(await listed()).not.toContain(gone);
      } finally {
        await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [b.accountId]);
      }
      // Switching it off is the undo: it leaves the list on the next read.
      await admin.query(`UPDATE verify_settings SET enabled = false WHERE repo_id = $1`, [on]);
      expect(await listed()).not.toContain(on);
    });

    it('returns exactly two ids per repository (no URL, no journeys) and is walked in repository order by the keyset, whatever the page size', async () => {
      const repos: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await newRepo(a);
        await enable(a, r);
        repos.push(r);
      }
      const all = await listed();
      const mine = all.filter((r) => repos.includes(r));
      expect(mine).toEqual([...repos].sort());
      expect(all).toEqual([...all].sort());
      const first = await writerPool.query('SELECT * FROM verify_stage_list_enabled(2)');
      expect(Object.keys(first.rows[0]).sort()).toEqual(['account_id', 'repo_id']);
      const walked: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page: string[] = await listed(writerPool, [2, after]);
        walked.push(...page);
        if (page.length < 2) break;
        after = page[page.length - 1]!;
      }
      expect(walked).toEqual(all);
    });

    it('a reader that has no tenant sees the same list as the sweep needs, but the settings table itself stays closed to it', async () => {
      const bare = await appPool.connect();
      try {
        expect((await bare.query(`SELECT 1 FROM verify_settings`)).rowCount).toBe(0);
      } finally {
        bare.release();
      }
    });
  });
});
