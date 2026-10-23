import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_VERIFY_ATTEMPTS } from '../../core/src/plan/proposalVerification.js';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'proposal_verify_lister';
const FN = 'proposal_verify_list_due(integer)';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (0889). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'repo_id', 'state', 'owner_process', 'verification', 'verify_attempts', 'created_at'].map((c) => `column proposals.${c} SELECT`),
  ...['id', 'account_id', 'execution_mode'].map((c) => `column repos.${c} SELECT`),
  ...['id', 'deleted_at'].map((c) => `column accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

/**
 * [pg] D#483 S4-b2a: the cross-account list of proposals waiting for the claim verifier (migration 0889). Pins the role (shape, exact grants, the
 * policies, who may execute) and what the list returns, as the real roles.
 */
describe(`migration 0889: ${ROLE} and proposal_verify_list_due [pg]`, () => {
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
    expect(policies.rows.map((r) => r.t)).toEqual(['accounts SELECT', 'proposals SELECT', 'repos SELECT']);
    for (const r of policies.rows) expect(r.roles).toEqual([ROLE]);
  });

  it('the function is SECURITY DEFINER, STABLE, search_path pinned, EXECUTE for the run-writer login alone; platform_ops and app_user are refused', async () => {
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
        await expect(pool.query('SELECT * FROM proposal_verify_list_due(10)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
    for (const arg of [0, 201, null]) await expect(writerPool.query('SELECT * FROM proposal_verify_list_due($1)', [arg])).rejects.toMatchObject({ code: '22023' });
  });

  let n = 0;
  async function proposal(t: SeedRefs, o: { verification?: string; attempts?: number; state?: string; owner?: string; repoId?: string } = {}): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', 't', 'external', $4) RETURNING id`,
      [t.accountId, o.repoId ?? t.repoId, `gh:issue:${++n}`, o.owner ?? 'product'],
    );
    const id = rows[0]!.id;
    if (o.verification !== undefined) await admin.query(`UPDATE proposals SET verification = $2, verified_at = now(), verify_attempts = $3 WHERE id = $1`, [id, o.verification, o.attempts ?? 0]);
    if (o.state === 'withdrawn') await admin.query(`UPDATE proposals SET state = 'withdrawn' WHERE id = $1`, [id]);
    return id;
  }
  const listed = async (wanted: string[]): Promise<string[]> =>
    (await writerPool.query<{ account_id: string; proposal_id: string }>('SELECT * FROM proposal_verify_list_due(200)')).rows.map((r) => r.proposal_id).filter((id) => wanted.includes(id));

  it('lists pending and retryable proposals of every account as (account, proposal), oldest first, and nothing that is not waiting', async () => {
    const a = await proposal(A);
    const b = await proposal(B);
    const retry = await proposal(A, { verification: 'check_failed', attempts: MAX_VERIFY_ATTEMPTS - 1 });
    const spent = await proposal(A, { verification: 'check_failed', attempts: MAX_VERIFY_ATTEMPTS });
    const done = await proposal(A, { verification: 'refuted' });
    const unchecked = await proposal(A, { verification: 'not_checked' });
    const withdrawn = await proposal(B, { state: 'withdrawn' });
    const internal = await proposal(B, { owner: 'internal_loop' });
    expect(await listed([a, b, retry, spent, done, unchecked, withdrawn, internal])).toEqual([a, b, retry]);
    const row = (await writerPool.query('SELECT * FROM proposal_verify_list_due(200)')).rows.find((r) => r.proposal_id === b);
    expect(row).toEqual({ account_id: B.accountId, proposal_id: b });
  });

  // D#483 S4-b2c (0893): a Cloud-verified repository's verifier is a runner job, so its proposals are listed; a Local-only one's still are not.
  it('lists a Cloud-verified repository, and still leaves out a Local-only one', async () => {
    const repo = async (mode: string): Promise<string> => {
      const id = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, $4, 'team', 'o', $5, $6)`, [id, A.accountId, A.installationId, Math.floor(Math.random() * 1e9), `r${id.slice(0, 8)}`, mode]);
      return id;
    };
    const verified = await proposal(A, { repoId: await repo('runner_verified') });
    const local = await proposal(A, { repoId: await repo('runner_local') });
    expect(await listed([verified, local])).toEqual([verified]);
    const policy = await admin.query<{ qual: string }>(`SELECT qual FROM pg_policies WHERE tablename = 'repos' AND policyname = 'proposal_verify_lister_select'`);
    expect(policy.rows[0]!.qual).toMatch(/sandbox.*runner_verified/);
    expect(policy.rows[0]!.qual).not.toMatch(/runner_local/);
  });

  it('leaves out a repository on the person own machine and a deleted account, and gives one account at most 10 places', async () => {
    const runnerRepo = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, $4, 'team', 'o', 'r', 'runner_local')`, [runnerRepo, A.accountId, A.installationId, Math.floor(Math.random() * 1e9)]);
    const local = await proposal(A, { repoId: runnerRepo });
    const gone = await seedAccount(admin, randomUUID());
    const orphan = await proposal(gone);
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [gone.accountId]);
    expect(await listed([local, orphan])).toEqual([]);
    const big = await seedAccount(admin, randomUUID());
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await proposal(big));
    expect(await listed(ids)).toEqual(ids.slice(0, 10));
  });
});
