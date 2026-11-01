import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'discovery_drain_lister';
const FN = 'discovery_drain_list()';

/** Everything the role holds, exactly: column SELECT on what the list reads, and nothing table-wide (0949). */
const EXPECTED_PRIVILEGES = [
  ...['account_id', 'state', 'created_at'].map((c) => `column discovery_runs.${c} SELECT`),
  ...['id', 'account_id', 'installation_id'].map((c) => `column repos.${c} SELECT`),
  ...['account_id', 'repo_id', 'state'].map((c) => `column proposals.${c} SELECT`),
  ...['id', 'deleted_at'].map((c) => `column accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

/**
 * [pg] D#483 S4-c2: the cross-account list the discovery drain starts from (migration 0949). Pins the role (shape, exact grants, the policies, who may
 * execute) and what the list returns, as the real roles.
 */
describe(`migration 0949: ${ROLE} and discovery_drain_list [pg]`, () => {
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
    expect(policies.rows.map((r) => r.t)).toEqual(['accounts SELECT', 'discovery_runs SELECT', 'proposals SELECT', 'repos SELECT']);
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
        await expect(pool.query('SELECT * FROM discovery_drain_list()')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
  });

  const listed = async (wanted: string[]): Promise<string[]> => (await writerPool.query<{ account_id: string }>('SELECT * FROM discovery_drain_list()')).rows.map((r) => r.account_id).filter((id) => wanted.includes(id));
  const queue = (t: SeedRefs, ref: string) => admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'installation_created', $3)`, [t.accountId, t.repoId, ref]);
  const proposal = (t: SeedRefs, state = 'new') =>
    admin.query(`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, state) VALUES ($1, $2, 'gh:issue:1', '{github_issue}', 't', 'external', 'product', $3)`, [t.accountId, t.repoId, state]);

  it('returns the account id and no other column, for a queued run and for a removed repository with a new proposal, and nothing else', async () => {
    const queued = await seedAccount(admin, randomUUID());
    const removed = await seedAccount(admin, randomUUID());
    const connected = await seedAccount(admin, randomUUID());
    const withdrawnOnly = await seedAccount(admin, randomUUID());
    const running = await seedAccount(admin, randomUUID());
    const gone = await seedAccount(admin, randomUUID());
    await queue(queued, 'a');
    await queue(running, 'b');
    await admin.query(`UPDATE discovery_runs SET state = 'running', started_at = now() WHERE account_id = $1`, [running.accountId]);
    await proposal(removed);
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [removed.repoId]);
    await proposal(connected);
    await proposal(withdrawnOnly, 'withdrawn');
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [withdrawnOnly.repoId]);
    await queue(gone, 'c');
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [gone.accountId]);
    const all = [queued, removed, connected, withdrawnOnly, running, gone].map((t) => t.accountId);
    expect(new Set(await listed(all))).toEqual(new Set([queued.accountId, removed.accountId]));
    const res = await writerPool.query('SELECT * FROM discovery_drain_list()');
    expect(res.fields.map((f) => f.name)).toEqual(['account_id']);
    expect(Object.keys(res.rows[0])).toEqual(['account_id']);
  });
});
