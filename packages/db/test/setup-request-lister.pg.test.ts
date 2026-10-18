import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { listDueSetupRequests } from '../src/setupRequestLister.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'setup_request_lister';
const FN = 'setup_request_list_due(integer,integer)';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (0874). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'kind', 'state', 'check_kind', 'check_ran_at', 'created_at', 'created_by'].map((c) => `column setup_requests.${c} SELECT`),
  ...['id', 'deleted_at'].map((c) => `column accounts.${c} SELECT`),
  ...['account_id', 'user_id', 'role'].map((c) => `column account_members.${c} SELECT`),
  'schema public USAGE',
].sort();

/**
 * [pg] D#598 P8b-L1, L2: the cross-account list of setup requests that are due for their automatic check (migration 0874). Pins the role
 * (shape, exact grants, the two policies, who may execute) and what the list returns, as the real roles.
 */
describe(`migration 0874: ${ROLE} and setup_request_list_due [pg]`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
  });

  describe('the role', () => {
    it('is NOLOGIN and unprivileged, has no member and is a member of nothing, and owns exactly the one lister', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole`, [ROLE])).rowCount, 'members').toBe(0);
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole`, [ROLE])).rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
      const objects = await admin.query(`SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole`, [ROLE]);
      expect(objects.rowCount, 'other objects').toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column grants the list reads, and nothing table-wide: no target, reason, link or check reason', async () => {
      const { rows } = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
    });

    it('has one row policy on each of account_members, accounts and setup_requests, each for this role alone', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(
        `SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`,
        [ROLE],
      );
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['account_members SELECT', 'accounts SELECT', 'setup_requests SELECT']);
      for (const r of rows) expect(r.roles).toEqual([ROLE]);
    });
  });

  describe('the function', () => {
    it('is SECURITY DEFINER, STABLE, with a pinned search_path, owned by the role, and EXECUTE for the run-writer login alone (L2)', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null; owner: string; grantees: string[]; grantable: boolean }>(
        `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                            FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]!.prosecdef).toBe(true);
      expect(rows[0]!.provolatile).toBe('s');
      expect(rows[0]!.owner).toBe(ROLE);
      expect(rows[0]!.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(rows[0]!.grantees).toEqual(['agent_run_writer']);
      expect(rows[0]!.grantable).toBe(false);
      for (const who of ['platform_ops', 'partner_user', 'app_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
    });

    it('L2: called as platform_ops, as app_user, and as a login that holds only app_user, it fails on privileges', async () => {
      for (const [name, url] of [['platform_ops', process.env.DATABASE_URL_PLATFORM_OPS], ['app_user', process.env.DATABASE_URL_APP_USER]] as const) {
        const pool = createPool(url!);
        try {
          await expect(pool.query('SELECT * FROM setup_request_list_due(10, 45)'), name).rejects.toMatchObject({ code: '42501' });
        } finally {
          await pool.end();
        }
      }
    });

    it('answers 22023 to a limit outside 1..200, an age outside 0..86400 seconds, and NULL for either', async () => {
      const bad: Array<[unknown, unknown]> = [[0, 45], [201, 45], [-1, 45], [null, 45], [10, -1], [10, 86401], [10, null]];
      for (const args of bad) {
        await expect(writerPool.query('SELECT * FROM setup_request_list_due($1, $2)', args), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
      }
      await writerPool.query('SELECT * FROM setup_request_list_due(200, 0)');
      await writerPool.query('SELECT * FROM setup_request_list_due(1, 86400)');
    });

    it('has the partial index the list reads', async () => {
      const { rows } = await admin.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_setup_requests_due'`);
      expect(rows[0]!.indexdef).toMatch(/\(check_ran_at NULLS FIRST, created_at\) INCLUDE \(id, account_id, kind\) WHERE .*state = 'open'.*check_kind IS NOT NULL/);
    });
  });

  describe('what it lists (L1)', () => {
    let seq = 0;
    async function request(t: SeedRefs, o: { check?: boolean; ranAgoSeconds?: number | null; state?: 'open' | 'done' | 'withdrawn'; kind?: string } = {}): Promise<string> {
      const id = randomUUID();
      const check = o.check ?? true;
      await admin.query(
        `INSERT INTO setup_requests (id, account_id, repo_id, work_item_id, origin, kind, target, env_name, reason, check_kind, created_by, check_ran_at)
         VALUES ($1, $2, $3, NULL, 'agent', $4, $5, $6, 'needed', $7, $8, CASE WHEN $9::integer IS NULL THEN NULL ELSE now() - make_interval(secs => $9::integer) END)`,
        [id, t.accountId, t.repoId, o.kind ?? 'env_var', `project-${++seq}`, (o.kind ?? 'env_var') === 'env_var' ? 'SOME_NAME' : null, check ? 'env_var_present' : null, t.userId, o.ranAgoSeconds ?? null],
      );
      if (o.state === 'done') await admin.query(`UPDATE setup_requests SET state = 'done', resolution = 'marked_done', resolved_by = created_by WHERE id = $1`, [id]);
      if (o.state === 'withdrawn') await admin.query(`UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn', resolved_by = created_by WHERE id = $1`, [id]);
      return id;
    }
    const listed = async (limit = 200, age = 45): Promise<string[]> =>
      (await writerPool.query<{ setup_request_id: string }>('SELECT setup_request_id FROM setup_request_list_due($1, $2)', [limit, age])).rows.map((r) => r.setup_request_id);
    const mine = (ids: string[], wanted: string[]): string[] => ids.filter((id) => wanted.includes(id));

    it('returns account A\'s and account B\'s due requests, as (account, request, kind) and nothing else', async () => {
      const a = await request(A);
      const b = await request(B);
      const rows = (await writerPool.query<Record<string, unknown>>('SELECT * FROM setup_request_list_due(200, 45)')).rows.filter((r) => r.setup_request_id === a || r.setup_request_id === b);
      expect(rows.map((r) => Object.keys(r).sort())).toEqual([['account_id', 'kind', 'setup_request_id'], ['account_id', 'kind', 'setup_request_id']]);
      expect(rows).toContainEqual({ account_id: A.accountId, setup_request_id: a, kind: 'env_var' });
      expect(rows).toContainEqual({ account_id: B.accountId, setup_request_id: b, kind: 'env_var' });
    });

    it('returns none of: a done request, a withdrawn one, one without a check, one checked within the interval; and one checked longer ago comes back', async () => {
      const open = await request(A);
      const done = await request(A, { state: 'done' });
      const withdrawn = await request(B, { state: 'withdrawn' });
      const noCheck = await request(A, { check: false, kind: 'app_not_installed' });
      const fresh = await request(B, { ranAgoSeconds: 10 });
      const stale = await request(B, { ranAgoSeconds: 50 });
      const ids = await listed();
      expect(mine(ids, [open, done, withdrawn, noCheck, fresh, stale]).sort()).toEqual([open, stale].sort());
    });

    it('a request checked within the interval is not listed, and is listed again with a shorter interval or once it has aged', async () => {
      const r = await request(A, { ranAgoSeconds: 30 });
      expect(mine(await listed(200, 45), [r])).toEqual([]);
      expect(mine(await listed(200, 20), [r])).toEqual([r]);
      await admin.query(`UPDATE setup_requests SET check_ran_at = now() - interval '46 seconds' WHERE id = $1`, [r]);
      expect(mine(await listed(200, 45), [r])).toEqual([r]);
    });

    it('lists a request that has never been checked before one that has, oldest check first, and honours the limit', async () => {
      const checkedLong = await request(A, { ranAgoSeconds: 600 });
      const checkedShort = await request(B, { ranAgoSeconds: 100 });
      const never = await request(A);
      const ordered = mine(await listed(), [checkedLong, checkedShort, never]);
      expect(ordered).toEqual([never, checkedLong, checkedShort]);
      const first = await listed(1);
      expect(first).toHaveLength(1);
    });

    it('does not list a request of a deleted account', async () => {
      const gone = await seedAccount(admin, randomUUID());
      const r = await request(gone);
      expect(mine(await listed(), [r])).toEqual([r]);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [gone.accountId]);
      expect(mine(await listed(), [r])).toEqual([]);
    });

    it('does not list a request whose proposer is no longer an owner or admin of the account (removed, or demoted to member)', async () => {
      const t = await seedAccount(admin, randomUUID());
      const stays = await request(t);
      const other = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [other, `${other}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [t.accountId, other]);
      expect(mine(await listed(), [stays])).toEqual([stays]);
      await admin.query(`UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`, [t.accountId, t.userId]);
      expect(mine(await listed(), [stays])).toEqual([stays]);
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [t.accountId, t.userId]);
      expect(mine(await listed(), [stays])).toEqual([]);
      await admin.query(`UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`, [t.accountId, t.userId]);
      expect(mine(await listed(), [stays])).toEqual([stays]);
      await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [t.accountId, t.userId]);
      expect(mine(await listed(), [stays])).toEqual([]);
    });

    it('no account takes more than 10 places in one call: 60 due requests in one account list 10, and another account\'s request is listed beside them whatever the limit', async () => {
      const big = await seedAccount(admin, randomUUID());
      const small = await seedAccount(admin, randomUUID());
      const bigIds: string[] = [];
      for (let i = 0; i < 60; i++) bigIds.push(await request(big));
      const one = await request(small);
      const all = await listed(200);
      expect(mine(all, bigIds)).toHaveLength(10);
      expect(mine(all, [one])).toEqual([one]);
      // with the shortest limit the cap still lets the other account in once it is the oldest
      const two = mine(await listed(200), [...bigIds, one]);
      expect(two).toHaveLength(11);
    });

    it('starvation: 50 stuck requests (their proposer left) in one account do not keep another account\'s request out of a 50-row call', async () => {
      const stuck = await seedAccount(admin, randomUUID());
      const fine = await seedAccount(admin, randomUUID());
      for (let i = 0; i < 55; i++) await request(stuck);
      await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [stuck.accountId, stuck.userId]);
      const wanted = await request(fine);
      expect(await listed(50)).toContain(wanted);
    });

    it('the TypeScript wrapper returns the same list as camelCase, with the default limit and interval', async () => {
      const r = await request(A);
      const found = (await listDueSetupRequests(writerPool)).filter((d) => d.setupRequestId === r);
      expect(found).toEqual([{ accountId: A.accountId, setupRequestId: r, kind: 'env_var' }]);
    });
  });
});
