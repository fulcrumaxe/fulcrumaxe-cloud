import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'runner_routing_definer';
const SET_FN = 'runner_routing_set(text,uuid,jsonb)';

/** D#605 FL-4: runner_routing on repos and work items, its one writer, claimable_since, and the privilege line around them (migration 0798). */
describe('migration 0798: runner routing columns, runner_routing_set and claimable_since', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs; // account A: its seeded user is the owner
  let b: SeedRefs;
  let runner: string;
  let adminUser: string;
  let member: string;

  const addMember = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, a.accountId, a.userId);
    adminUser = await addMember(a.accountId, 'admin');
    member = await addMember(a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const set = (user: string, kind: string, id: string, routing: unknown, accountId = a.accountId): Promise<unknown> =>
    withTenant(appPool, accountId, user, (client) => client.query('SELECT runner_routing_set($1, $2::uuid, $3::jsonb)', [kind, id, routing === null ? null : JSON.stringify(routing)]));
  const stored = async (table: 'repos' | 'work_items', id: string) => (await admin.query(`SELECT runner_routing FROM ${table} WHERE id = $1`, [id])).rows[0].runner_routing;
  const audits = async (accountId: string) => (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'runner.routing_set' ORDER BY created_at`, [accountId])).rows;

  describe('runner_routing_set', () => {
    it('an owner and an admin set the rules on a repo and on a work item, and each real change writes one audit row naming the previous rules', async () => {
      const rules = { require: { os: 'macos', arch: 'arm64', engine: 'microvm', labels: ['gpu'], heavy_labels: ['bigbox'] }, prefer: [runner] };
      await set(a.userId, 'repo', a.repoId, rules);
      expect(await stored('repos', a.repoId)).toEqual(rules);
      await set(adminUser, 'work_item', a.workItemId, { require: { os: 'linux' } });
      expect(await stored('work_items', a.workItemId)).toEqual({ require: { os: 'linux' } });
      await set(a.userId, 'repo', a.repoId, null);
      expect(await stored('repos', a.repoId)).toBeNull();
      const rows = await audits(a.accountId);
      expect(rows.map((r) => r.payload.kind)).toEqual(['repo', 'work_item', 'repo']);
      expect(rows[0]).toMatchObject({ actor: a.userId, payload: { id: a.repoId, routing: rules, previous: null } });
      expect(rows[2].payload.previous).toEqual(rules);
    });

    it('a member is refused 42501 and nothing is written', async () => {
      const before = (await audits(a.accountId)).length;
      await expect(set(member, 'repo', a.repoId, { require: { os: 'linux' } })).rejects.toMatchObject({ code: '42501' });
      expect(await stored('repos', a.repoId)).toBeNull();
      expect((await audits(a.accountId)).length).toBe(before);
    });

    it('another account\'s repo or item does not exist for the caller (P0002), and a preferred runner of another account is refused as invalid (22023) with nothing written', async () => {
      await expect(set(a.userId, 'repo', b.repoId, null)).rejects.toMatchObject({ code: 'P0002' });
      await expect(set(a.userId, 'work_item', b.workItemId, null)).rejects.toMatchObject({ code: 'P0002' });
      const foreign = await insertRunner(admin, b.accountId, b.userId);
      await expect(set(a.userId, 'repo', a.repoId, { prefer: [foreign] })).rejects.toMatchObject({ code: '22023' });
      await expect(set(a.userId, 'repo', a.repoId, { prefer: [randomUUID()] })).rejects.toMatchObject({ code: '22023' });
      expect(await stored('repos', a.repoId)).toBeNull();
    });

    it('a removed runner cannot be named in prefer', async () => {
      const gone = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [gone]);
      await expect(set(a.userId, 'repo', a.repoId, { prefer: [gone] })).rejects.toMatchObject({ code: '22023' });
    });

    it.each([
      ['an unknown top-level key', { allow: [] }],
      ['an unknown require key', { require: { gpu: true } }],
      ['os windows', { require: { os: 'windows' } }],
      ['arch ppc', { require: { arch: 'ppc' } }],
      ['engine docker', { require: { engine: 'docker' } }],
      ['a label GPU!', { require: { labels: ['GPU!'] } }],
      ['a label that starts with a hyphen', { require: { labels: ['-gpu'] } }],
      ['a 33-character label', { require: { labels: ['a'.repeat(33)] } }],
      ['a 17th label', { require: { labels: Array.from({ length: 17 }, (_v, i) => `l${i}`) } }],
      ['a repeated label', { require: { heavy_labels: ['gpu', 'gpu'] } }],
      ['a non-string label', { require: { labels: [1] } }],
      ['labels that are not a list', { require: { labels: 'gpu' } }],
      ['a prefer entry that is not a uuid', { prefer: ['desktop'] }],
      ['a repeated prefer entry', { prefer: [randomUUID().toLowerCase(), 'x'] }],
      ['a prefer that is not a list', { prefer: 'x' }],
      ['an array', []],
      ['a string', 'x'],
    ])('refuses %s as invalid (22023) and writes nothing', async (_name, routing) => {
      const before = (await audits(a.accountId)).length;
      await expect(set(a.userId, 'repo', a.repoId, routing)).rejects.toMatchObject({ code: '22023' });
      expect((await audits(a.accountId)).length).toBe(before);
    });

    it('refuses a 21st preferred runner', async () => {
      await expect(set(a.userId, 'repo', a.repoId, { prefer: Array.from({ length: 21 }, () => randomUUID()) })).rejects.toMatchObject({ code: '22023' });
    });
  });

  describe('the column is written only by that function (the guard trigger)', () => {
    it('app_user cannot set it by INSERT or UPDATE on either table, whether the value is valid or not', async () => {
      const value = JSON.stringify({ require: { os: 'linux' } });
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query('UPDATE repos SET runner_routing = $2::jsonb WHERE id = $1', [a.repoId, value]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query('UPDATE work_items SET runner_routing = $2::jsonb WHERE id = $1', [a.workItemId, value]))).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(appPool, a.accountId, a.userId, (c) => c.query(`INSERT INTO work_items (account_id, repo_id, kind, title, state, runner_routing) VALUES ($1, $2, 'task', 't', 'open', $3::jsonb)`, [a.accountId, a.repoId, value])),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(appPool, a.accountId, a.userId, (c) => c.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, runner_routing) VALUES ($1, $2, 777, 'team', $3::jsonb)`, [a.accountId, a.installationId, value])),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await stored('repos', a.repoId)).toBeNull();
      expect(await stored('work_items', a.workItemId)).toEqual({ require: { os: 'linux' } });
    });

    it('app_user still updates the table\'s other columns, and a row written with other columns keeps its rules', async () => {
      await set(a.userId, 'repo', a.repoId, { require: { os: 'macos' } });
      await withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE repos SET settings = settings WHERE id = $1`, [a.repoId]));
      expect(await stored('repos', a.repoId)).toEqual({ require: { os: 'macos' } });
      await set(a.userId, 'repo', a.repoId, null);
    });

    it('a superuser (the migrator) still cannot store a value that breaks the schema', async () => {
      await expect(admin.query(`UPDATE repos SET runner_routing = '{"require":{"os":"windows"}}' WHERE id = $1`, [a.repoId])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE work_items SET runner_routing = '[]' WHERE id = $1`, [a.workItemId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('privileges', () => {
    it('the role is NOLOGIN and unprivileged, has no member, is a member of nothing, and owns exactly the one function', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([SET_FN]);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('platform_ops holds no privilege on the function or the new check, and no grant on repos, work_items or the stamps', async () => {
      for (const fn of [SET_FN, 'runner_routing_valid(jsonb)']) {
        expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [fn])).rows[0].ok, fn).toBe(false);
      }
      for (const table of ['repos', 'work_items']) {
        expect((await admin.query(`SELECT has_column_privilege('platform_ops', $1, 'runner_routing', 'SELECT, INSERT, UPDATE') AS ok`, [table])).rows[0].ok, table).toBe(false);
      }
      expect((await admin.query(`SELECT has_any_column_privilege('platform_ops', 'runner_claim_stamps', 'SELECT, INSERT, UPDATE') AS ok`)).rows[0].ok).toBe(false);
      expect((await admin.query(`SELECT has_column_privilege('platform_ops', 'agent_runs', 'claimable_since', 'SELECT, UPDATE') AS ok`)).rows[0].ok).toBe(false);
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        await expect(ops.query(`SELECT runner_routing_set('repo', gen_random_uuid(), NULL)`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ops.end();
      }
    });

    it('the function is SECURITY DEFINER with a pinned search_path and EXECUTE for app_user alone; nobody but app_user and the role may run the check', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, p.proconfig,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [SET_FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'] });
      const check = await admin.query(
        `SELECT coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = 'runner_routing_valid(jsonb)'::regprocedure`,
      );
      expect(check.rows[0].grantees).toEqual([ROLE]);
    });

    it('app_user reads the poll stamps of its own account only, and cannot write them', async () => {
      const other = await insertRunner(admin, b.accountId, b.userId);
      await admin.query(`INSERT INTO runner_claim_stamps (runner_id, account_id, last_claim_at) VALUES ($1, $2, now()), ($3, $4, now())`, [runner, a.accountId, other, b.accountId]);
      const seen = await withTenant(appPool, a.accountId, (c) => c.query<{ runner_id: string }>('SELECT runner_id FROM runner_claim_stamps'));
      expect(seen.rows.map((r) => r.runner_id)).toEqual([runner]);
      await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE runner_claim_stamps SET last_claim_at = now()`))).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('agent_runs.claimable_since', () => {
    const insertRun = async (status: string): Promise<string> => {
      const id = randomUUID();
      await admin.query(`SET session_replication_role = replica`);
      try {
        await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', $3, 'runner_local')`, [id, a.accountId, status]);
      } finally {
        await admin.query(`SET session_replication_role = DEFAULT`);
      }
      return id;
    };

    it('is set when a run is made, and again by a move into pending, and not by a move that leaves it pending or goes elsewhere', async () => {
      const id = await insertRun('running');
      await admin.query(`UPDATE agent_runs SET claimable_since = now() - interval '1 hour' WHERE id = $1`, [id]);
      const made = (await admin.query(`SELECT claimable_since < now() - interval '59 minutes' AS old FROM agent_runs WHERE id = $1`, [id])).rows[0];
      expect(made.old).toBe(true);
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [id]);
      await admin.query(`SET session_replication_role = DEFAULT`);
      expect((await admin.query(`SELECT claimable_since < now() - interval '59 minutes' AS old FROM agent_runs WHERE id = $1`, [id])).rows[0].old).toBe(true);
      await admin.query(`UPDATE agent_runs SET status = 'pending' WHERE id = $1`, [id]);
      const after = (await admin.query(`SELECT claimable_since > now() - interval '1 minute' AS fresh FROM agent_runs WHERE id = $1`, [id])).rows[0];
      expect(after).toEqual({ fresh: true });
      const fresh = await insertRun('pending');
      expect((await admin.query(`SELECT claimable_since > now() - interval '1 minute' AS fresh FROM agent_runs WHERE id = $1`, [fresh])).rows[0].fresh).toBe(true);
    });

    it('app_user can read it and cannot write it', async () => {
      const id = await insertRun('pending');
      const read = await withTenant(appPool, a.accountId, (c) => c.query(`SELECT claimable_since FROM agent_runs WHERE id = $1`, [id]));
      expect(read.rows).toHaveLength(1);
      await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE agent_runs SET claimable_since = now() WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '42501' });
    });
  });
});
