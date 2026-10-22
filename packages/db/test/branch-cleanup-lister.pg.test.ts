import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { listDueBranchCleanups } from '../src/branchCleanupLister.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'branch_cleanup_lister';
const FN = 'branch_cleanup_list_due(integer)';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (0886). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'stage', 'updated_at'].map((c) => `column work_items.${c} SELECT`),
  ...['account_id', 'work_item_id'].map((c) => `column plane_pushes.${c} SELECT`),
  ...['id', 'account_id', 'work_item_id', 'transition_id', 'state', 'next_attempt_at', 'updated_at'].map((c) => `column branch_cleanups.${c} SELECT`),
  ...['id', 'account_id', 'work_item_id', 'to_stage', 'created_at'].map((c) => `column work_item_transitions.${c} SELECT`),
  ...['id', 'deleted_at'].map((c) => `column accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

/**
 * [pg] D#598 P1f-5d: the cross-account list of closed or merged paired items whose branches are still to be cleaned up (migration 0886). Pins the role
 * (shape, exact grants, the four policies, who may execute) and what the list returns, as the real roles. Acceptance 4: rows for every tenant and
 * nothing else; a non-lister role gets `insufficient_privilege`.
 */
describe(`migration 0886: ${ROLE} and branch_cleanup_list_due [pg]`, () => {
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

    it('holds exactly the column grants the list reads, and nothing table-wide: no title, repository, branch or sha', async () => {
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

    it('has one row policy on each of accounts, branch_cleanups, plane_pushes, work_item_transitions and work_items, each for this role alone', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(
        `SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`,
        [ROLE],
      );
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['accounts SELECT', 'branch_cleanups SELECT', 'plane_pushes SELECT', 'work_item_transitions SELECT', 'work_items SELECT']);
      for (const r of rows) expect(r.roles).toEqual([ROLE]);
    });
  });

  describe('the function', () => {
    it('is SECURITY DEFINER, STABLE, with a pinned search_path, owned by the role, and EXECUTE for the run-writer login alone', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null; owner: string; grantees: string[]; grantable: boolean }>(
        `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                            FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: ['agent_run_writer'], grantable: false });
      for (const who of ['platform_ops', 'partner_user', 'app_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
    });

    it('called as platform_ops or as app_user, it fails on privileges (insufficient_privilege)', async () => {
      for (const [name, url] of [['platform_ops', process.env.DATABASE_URL_PLATFORM_OPS], ['app_user', process.env.DATABASE_URL_APP_USER]] as const) {
        const pool = createPool(url!);
        try {
          await expect(pool.query('SELECT * FROM branch_cleanup_list_due(10)'), name).rejects.toMatchObject({ code: '42501' });
        } finally {
          await pool.end();
        }
      }
    });

    it('answers 22023 to a limit outside 1..200 and to NULL', async () => {
      for (const arg of [0, 201, -1, null]) {
        await expect(writerPool.query('SELECT * FROM branch_cleanup_list_due($1)', [arg]), String(arg)).rejects.toMatchObject({ code: '22023' });
      }
      await writerPool.query('SELECT * FROM branch_cleanup_list_due(200)');
      await writerPool.query('SELECT * FROM branch_cleanup_list_due(1)');
    });
  });

  describe('what it lists', () => {
    /** A paired item at `stage` in `t`'s account: its own work item row and (when `paired`) a plane_pushes row. */
    async function item(t: SeedRefs, o: { stage?: string; paired?: boolean; cleaned?: boolean } = {}): Promise<string> {
      const id = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, t.accountId, t.repoId]);
      await admin.query(`UPDATE work_items SET stage = $2 WHERE id = $1`, [id, o.stage ?? 'merged']);
      if (o.paired ?? true) {
        await admin.query(`INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, 'acme/public-repo', $4)`, [t.accountId, id, t.repoId, 'a'.repeat(64)]);
      }
      if (o.cleaned) await cleanup(t, id, null);
      return id;
    }
    /** A move into a final stage, as recordStage writes it; returns its id. */
    let ref = 0;
    async function closeMove(t: SeedRefs, id: string, to = 'merged'): Promise<string> {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', $3, now(), 'control_plane', $4) RETURNING id`,
        [t.accountId, id, to, `lister:${++ref}:${randomUUID()}`],
      );
      return rows[0]!.id;
    }
    /** The cleanup row of one close (null: an item with no recorded move). */
    const cleanup = (t: SeedRefs, id: string, transitionId: string | null, o: { state?: 'final' | 'retrying'; dueInSeconds?: number } = {}) =>
      admin.query(
        `INSERT INTO branch_cleanups (account_id, work_item_id, transition_id, state, next_attempt_at) VALUES ($1, $2, $3, $4::text, CASE WHEN $4::text = 'retrying' THEN now() + make_interval(secs => $5::integer) END)`,
        [t.accountId, id, transitionId, o.state ?? 'final', o.dueInSeconds ?? 0],
      );
    const listed = async (limit = 200): Promise<Array<{ account_id: string; work_item_id: string }>> => (await writerPool.query('SELECT * FROM branch_cleanup_list_due($1)', [limit])).rows;
    const mine = (rows: Array<{ work_item_id: string }>, wanted: string[]): string[] => rows.map((r) => r.work_item_id).filter((id) => wanted.includes(id));

    it('returns merged, closed_unmerged and closed items of account A and account B, as (account, item) and nothing else', async () => {
      const a = await item(A, { stage: 'merged' });
      const b = await item(B, { stage: 'closed_unmerged' });
      const c = await item(B, { stage: 'closed' });
      const rows = (await listed()).filter((r) => [a, b, c].includes(r.work_item_id));
      expect(rows.map((r) => Object.keys(r).sort())).toEqual([['account_id', 'work_item_id'], ['account_id', 'work_item_id'], ['account_id', 'work_item_id']]);
      expect(rows).toContainEqual({ account_id: A.accountId, work_item_id: a });
      expect(rows).toContainEqual({ account_id: B.accountId, work_item_id: b });
      expect(rows).toContainEqual({ account_id: B.accountId, work_item_id: c });
    });

    it('returns none of: an item still in progress, an unpaired item, one that already has its cleanup row; and the TypeScript wrapper returns the same list as camelCase', async () => {
      const open = await item(A, { stage: 'in_progress' });
      const unpaired = await item(A, { paired: false });
      const done = await item(B, { cleaned: true });
      const due = await item(B);
      expect(mine(await listed(), [open, unpaired, done, due])).toEqual([due]);
      expect((await listDueBranchCleanups(writerPool)).filter((d) => d.workItemId === due)).toEqual([{ accountId: B.accountId, workItemId: due }]);
    });

    it('lists an item again for a NEW close: a final row covers one close, so reopen then close again is work (derived from the history, not a one-time stamp)', async () => {
      const id = await item(A, { paired: true });
      const first = await closeMove(A, id);
      await cleanup(A, id, first);
      expect(mine(await listed(), [id])).toEqual([]);
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [id]);
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [id]);
      await closeMove(A, id, 'closed');
      expect(mine(await listed(), [id])).toEqual([id]);
    });

    it('a retrying row is listed only once it is due, and a final row never is; an item that keeps failing sorts behind one never tried', async () => {
      const backing = await item(A, { paired: true });
      const due = await item(A, { paired: true });
      const fresh = await item(A, { paired: true });
      await cleanup(A, backing, null, { state: 'retrying', dueInSeconds: 600 });
      await cleanup(A, due, null, { state: 'retrying', dueInSeconds: -1 });
      expect(mine(await listed(), [backing, due, fresh])).toEqual([fresh, due]);
    });

    it('stops listing an item once it is reopened, and does not list an item of a deleted account', async () => {
      const gone = await seedAccount(admin, randomUUID());
      const reopened = await item(A);
      const orphan = await item(gone);
      expect(mine(await listed(), [reopened, orphan]).sort()).toEqual([reopened, orphan].sort());
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [reopened]);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [gone.accountId]);
      expect(mine(await listed(), [reopened, orphan])).toEqual([]);
    });

    it('no account takes more than 10 places in one call, so another account is listed beside a large one', async () => {
      const big = await seedAccount(admin, randomUUID());
      const small = await seedAccount(admin, randomUUID());
      const bigIds: string[] = [];
      for (let i = 0; i < 14; i++) bigIds.push(await item(big));
      const one = await item(small);
      const all = await listed();
      expect(mine(all, bigIds)).toHaveLength(10);
      expect(mine(all, [one])).toEqual([one]);
    });
  });
});
