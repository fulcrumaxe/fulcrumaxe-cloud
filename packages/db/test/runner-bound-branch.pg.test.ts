import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { plannedFixture } from './helpers/plannedChildren.js';

const ROLE = 'runner_bound_definer';
const FN = 'resolve_runner_bound_branch(uuid,uuid)';
const PROXY_LOGIN = 'fx_rbound_test_login';

/** Everything the role holds, exactly: column SELECT on what the body reads, and the schema. */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'work_item_id', 'job_signed'].map((c) => `column agent_runs.${c} SELECT`),
  ...['id', 'account_id', 'gh_number', 'parent_id', 'planned_pr_key'].map((c) => `column work_items.${c} SELECT`),
  ...['account_id', 'run_id', 'kind', 'payload', 'seq'].map((c) => `column run_events.${c} SELECT`),
  'schema public USAGE',
].sort();

describe('migration 0828: resolve_runner_bound_branch (D#599 PL-2b-2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let opsPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DROP ROLE IF EXISTS ${PROXY_LOGIN}`);
    await admin.query(`CREATE ROLE ${PROXY_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT run_binding_resolver TO ${PROXY_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL!);
    u.username = PROXY_LOGIN;
    u.password = '';
    proxyPool = createPool(u.toString());
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await Promise.all([proxyPool.end(), opsPool.end(), appPool.end()]);
    await admin.query(`REVOKE run_binding_resolver FROM ${PROXY_LOGIN}`);
    await admin.query(`DROP ROLE ${PROXY_LOGIN}`);
    admin.release();
    await adminPool.end();
  });

  interface World {
    refs: SeedRefs;
    run: string;
  }

  /** An item with issue number 7 and a runner run whose signed job continues `branch` (with `pr` as its pull request number). */
  async function world(o: { issue?: number; branch?: string; pr?: number | null; event?: { branch: string; pr_number: number } | null } = {}): Promise<World> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE work_items SET gh_number = $2 WHERE id = $1', [refs.workItemId, o.issue ?? 7]);
    const run = randomUUID();
    const branch = o.branch ?? 'fx/issue-7';
    const pr = o.pr === undefined ? 12 : o.pr;
    const job = { job: { continues: { parent_run_id: randomUUID(), session_id: null, branch, ...(pr === null ? {} : { pr_number: pr }) } }, signature: 'x' };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed)
       VALUES ($1, $2, $3, 'executor', 'runner', 'running', 'runner_verified', $4, $5::jsonb)`,
      [run, refs.accountId, refs.workItemId, refs.repoId, JSON.stringify(job)],
    );
    const event = o.event === undefined ? { branch, pr_number: pr ?? 12 } : o.event;
    if (event) await bind(refs, run, event);
    return { refs, run };
  }
  const bind = (refs: SeedRefs, run: string, payload: Record<string, unknown>) =>
    admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), 'runner.continues_bound', $3::jsonb)", [refs.accountId, run, JSON.stringify(payload)]);
  const ask = async (w: World, over: { account?: string; run?: string } = {}): Promise<string | null> => {
    const { rows } = await proxyPool.query<{ branch: string | null }>('SELECT resolve_runner_bound_branch($1, $2) AS branch', [over.account ?? w.refs.accountId, over.run ?? w.run]);
    expect(rows).toHaveLength(1);
    return rows[0]!.branch;
  };

  it('answers the branch when the event, the signed job and the item agree', async () => {
    expect(await ask(await world())).toBe('fx/issue-7');
  });

  it('answers NULL when there is no event', async () => {
    expect(await ask(await world({ event: null }))).toBeNull();
  });

  it("answers NULL when the event names a branch other than the job's, or another pull request number", async () => {
    expect(await ask(await world({ event: { branch: 'fx/issue-8', pr_number: 12 } }))).toBeNull();
    expect(await ask(await world({ event: { branch: 'fx/issue-7', pr_number: 13 } }))).toBeNull();
  });

  it("answers NULL when the item's own issue number is another one, even though the event and the job agree", async () => {
    expect(await ask(await world({ issue: 9 }))).toBeNull();
  });

  it('answers NULL for a job with no pull request number, for a run branch, and for an unknown run or account', async () => {
    expect(await ask(await world({ pr: null, event: { branch: 'fx/issue-7', pr_number: 12 } }))).toBeNull();
    const runBranch = `fx/${randomUUID()}-g1`;
    expect(await ask(await world({ branch: runBranch, pr: 12 }))).toBeNull();
    const w = await world();
    expect(await ask(w, { run: randomUUID() })).toBeNull();
    expect(await ask(w, { account: randomUUID() })).toBeNull();
  });

  it("does not answer for another account's run", async () => {
    const a = await world();
    const b = await world();
    expect(await ask(a, { account: b.refs.accountId })).toBeNull();
  });

  describe('who holds what', () => {
    it('the role is NOLOGIN and unprivileged, a member of nothing with no member, and owns exactly its one function', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column SELECT grants the body reads', async () => {
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

    it('has a row policy of its own on each of the three tables, and only those', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(`SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`, [ROLE]);
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['agent_runs SELECT', 'run_events SELECT', 'work_items SELECT']);
      for (const p of rows) expect(p.roles).toEqual([ROLE]);
    });

    it('is a SECURITY DEFINER with a pinned search_path, owned by the role; EXECUTE is held by run_binding_resolver and the owner only', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[]; owner: string; grantees: string[] }>(
        `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: [ROLE, 'run_binding_resolver'].sort() });
    });

    it('app_user, platform_ops, agent_run_writer and partner_user cannot execute it, and platform_ops and app_user calls are refused', async () => {
      for (const who of ['app_user', 'agent_run_writer', 'platform_ops', 'partner_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
      for (const pool of [appPool, opsPool]) {
        await expect(pool.query('SELECT resolve_runner_bound_branch($1, $2)', [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('platform_ops gains no privilege on the three tables beyond what earlier migrations gave it (the new role is not a platform_ops member)', async () => {
      expect((await admin.query(`SELECT pg_has_role('platform_ops', $1, 'MEMBER') AS m`, [ROLE])).rows[0].m).toBe(false);
      expect((await admin.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'runner_bound_definer_select' AND 'platform_ops' = ANY(roles)`)).rowCount).toBe(0);
    });

    it('the proxy login can read none of the three tables itself', async () => {
      for (const table of ['agent_runs', 'work_items', 'run_events']) {
        await expect(proxyPool.query(`SELECT * FROM ${table} LIMIT 1`), table).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  describe('D#483 S5-b2c-3 (migration 0922): a planned PR child', () => {
    /** A child whose runner run continues `branch`, with the cloud's binding event. The parent's issue number is 41; the child's key is api. */
    async function child(o: { parentNumber?: number | null; branch?: string; event?: boolean } = {}): Promise<World & { sibling: string }> {
      const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
      await admin.query('UPDATE work_items SET gh_number = $2 WHERE id = $1', [f.parent, o.parentNumber === undefined ? 41 : o.parentNumber]);
      const run = randomUUID();
      const branch = o.branch ?? 'fx/41-api';
      const job = { job: { continues: { parent_run_id: randomUUID(), session_id: null, branch, pr_number: 52 } }, signature: 'x' };
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed) VALUES ($1, $2, $3, 'executor', 'runner', 'running', 'runner_verified', $4, $5::jsonb)`,
        [run, f.t.accountId, f.kids.api, f.t.repoId, JSON.stringify(job)],
      );
      if (o.event !== false) await bind(f.t, run, { branch, pr_number: 52 });
      return { refs: f.t, run, sibling: f.kids.ui! };
    }

    it("answers the child's own branch, fx/<parent's number>-<key>, when the event, the job and the child agree", async () => {
      expect(await ask(await child())).toBe('fx/41-api');
    });

    it("answers NULL for the parent's fx/issue-<n>, a sibling's branch, the key under another number, and a missing event", async () => {
      for (const branch of ['fx/issue-41', 'fx/41-ui', 'fx/42-api', 'fx/4-api']) expect(await ask(await child({ branch })), branch).toBeNull();
      expect(await ask(await child({ event: false }))).toBeNull();
    });

    it('answers NULL when the parent has no issue number or is gone (fail closed, no fallback)', async () => {
      expect(await ask(await child({ parentNumber: null }))).toBeNull();
      const w = await child();
      await admin.query('DELETE FROM work_items WHERE id = (SELECT parent_id FROM work_items WHERE id = (SELECT work_item_id FROM agent_runs WHERE id = $1))', [w.run]);
      expect(await ask(w)).toBeNull();
    });

    it('a top-level item is answered as before: its own fx/issue-<n>', async () => {
      expect(await ask(await world({ issue: 7, branch: 'fx/issue-7' }))).toBe('fx/issue-7');
    });
  });
});
