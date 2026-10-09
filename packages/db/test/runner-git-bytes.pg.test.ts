import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migrate.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const MIGRATION = '0766_runner_git_upload_pack_bytes.sql';
const ROLE = 'runner_git_bytes_definer';
const FN = 'runner_git_bytes_account(uuid,bigint)';
const PROXY_LOGIN = 'fx_rgitb_test_login';
const GIB = 1024 ** 3;
const BUDGET = 2 * GIB;

/** Everything the role holds, exactly: two columns of repos and the one counter table. */
const EXPECTED_PRIVILEGES = [
  'column repos.id SELECT',
  'column repos.account_id SELECT',
  'table runner_git_upload_pack_bytes SELECT',
  'table runner_git_upload_pack_bytes INSERT',
  'table runner_git_upload_pack_bytes UPDATE',
  'table runner_git_upload_pack_bytes DELETE',
  'schema public USAGE',
].sort();

describe(`migration 0766: ${ROLE} and runner_git_bytes_account, the enforced daily byte budget (D#6 R5a-2c, C28 section 3)`, () => {
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

  const repo = async (): Promise<SeedRefs> => seedAccount(admin, randomUUID());
  /** The proxy's one call: bytes = 0 asks, bytes > 0 adds and then answers. */
  const account = async (repoId: string, bytes: number | string): Promise<boolean> =>
    (await proxyPool.query<{ spent: boolean }>(`SELECT runner_git_bytes_account($1, $2) AS spent`, [repoId, bytes])).rows[0]!.spent;
  const total = async (repoId: string): Promise<number> =>
    Number((await admin.query<{ b: string }>(`SELECT coalesce(sum(bytes), 0)::text AS b FROM runner_git_upload_pack_bytes WHERE repo_id = $1`, [repoId])).rows[0]!.b);

  it('is open for a repository with no bytes, and asking writes nothing', async () => {
    const r = await repo();
    expect(await account(r.repoId, 0)).toBe(false);
    expect(await total(r.repoId)).toBe(0);
  });

  it('is spent exactly when the day total reaches the allowance of 2 GiB, and stays spent', async () => {
    const r = await repo();
    expect(await account(r.repoId, BUDGET - 1)).toBe(false);
    expect(await account(r.repoId, 0)).toBe(false);
    expect(await account(r.repoId, 1)).toBe(true);
    expect(await total(r.repoId)).toBe(BUDGET);
    expect(await account(r.repoId, 0)).toBe(true);
    // One response may run past the allowance (by its own size); the next ask is refused.
    expect(await account(r.repoId, 5 * GIB)).toBe(true);
    expect(await total(r.repoId)).toBe(BUDGET + 5 * GIB);
  });

  it('counts per repository, never across repositories', async () => {
    const [a, b] = [await repo(), await repo()];
    await account(a.repoId, BUDGET);
    expect(await account(b.repoId, 0)).toBe(false);
  });

  it('adds concurrent responses without losing any', async () => {
    const r = await repo();
    await Promise.all([1, 2, 3, 4].map(() => account(r.repoId, GIB)));
    expect(await total(r.repoId)).toBe(4 * GIB);
    expect(await account(r.repoId, 0)).toBe(true);
  });

  it('starts a new count on the next UTC day, and deletes that repository\'s rows older than two days', async () => {
    const r = await repo();
    await account(r.repoId, BUDGET);
    await admin.query(`UPDATE runner_git_upload_pack_bytes SET utc_day = utc_day - 1 WHERE repo_id = $1`, [r.repoId]);
    expect(await account(r.repoId, 0)).toBe(false);
    await admin.query(`INSERT INTO runner_git_upload_pack_bytes (account_id, repo_id, utc_day, bytes) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 3, 7)`, [r.accountId, r.repoId]);
    await account(r.repoId, 1);
    const days = await admin.query(`SELECT utc_day FROM runner_git_upload_pack_bytes WHERE repo_id = $1 AND utc_day < (now() AT TIME ZONE 'UTC')::date - 2`, [r.repoId]);
    expect(days.rows).toEqual([]);
  });

  it('answers a repository that does not exist as spent (the caller refuses), and refuses a bad argument with 22023', async () => {
    expect(await account(randomUUID(), 0)).toBe(true);
    const r = await repo();
    for (const bad of [-1, 1_099_511_627_777]) {
      await expect(account(r.repoId, bad), String(bad)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE ?? '22023' });
    }
    await expect(proxyPool.query(`SELECT runner_git_bytes_account(NULL, 1)`)).rejects.toMatchObject({ code: '22023' });
    await expect(proxyPool.query(`SELECT runner_git_bytes_account($1, NULL)`, [r.repoId])).rejects.toMatchObject({ code: '22023' });
    expect(await total(r.repoId)).toBe(0);
  });

  it('the allowance is a constant inside the function: its signature takes no limit, and the text names 2147483648', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8');
    expect(sql).toMatch(/v_budget\s+CONSTANT\s+bigint\s*:=\s*2147483648;/);
    expect(2147483648).toBe(BUDGET);
  });

  it('is a SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE is held by run_binding_resolver and the owner only', async () => {
    const { rows } = await admin.query(
      `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a), '{}') AS grantees,
              coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(rows[0]).toEqual({ prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: [ROLE, 'run_binding_resolver'].sort(), grantable: false });
  });

  it('app_user, agent_run_writer, platform_ops and partner_user cannot execute it, and calling it as app_user or platform_ops is refused', async () => {
    for (const who of ['app_user', 'agent_run_writer', 'platform_ops', 'partner_user']) {
      expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
    }
    for (const pool of [appPool, opsPool]) {
      await expect(pool.query(`SELECT runner_git_bytes_account($1, 0)`, [randomUUID()])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
  });

  it('run_binding_resolver holds EXECUTE on exactly three functions, and the proxy login can read nothing', async () => {
    const { rows } = await admin.query<{ proname: string }>(`SELECT DISTINCT p.proname FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = 'run_binding_resolver'::regrole::oid AND a.privilege_type = 'EXECUTE' ORDER BY 1`);
    expect(rows.map((x) => x.proname)).toEqual(['resolve_runner_git_request', 'resolve_sandbox_run', 'runner_git_bytes_account']);
    await expect(proxyPool.query(`SELECT 1 FROM runner_git_upload_pack_bytes LIMIT 1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(proxyPool.query(`INSERT INTO runner_git_upload_pack_bytes (account_id, repo_id, utc_day, bytes) VALUES ($1, $1, now(), 1)`, [randomUUID()])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('the role is NOLOGIN and unprivileged, a member of nothing, with exactly the listed privileges, and owns exactly its one function', async () => {
    const attrs = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    expect(attrs.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole OR roleid = $1::regrole`, [ROLE])).rows).toEqual([]);
    const held = await admin.query<{ x: string }>(
      `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
       SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
      [ROLE],
    );
    expect(held.rows.map((x) => x.x).sort()).toEqual(EXPECTED_PRIVILEGES);
    const owned = await admin.query<{ fn: string }>(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
    expect(owned.rows.map((x) => x.fn)).toEqual([FN]);
    expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [ROLE])).rows[0].c).toBe(false);
  });

  it('the table has row security forced, and its foreign key cascades on deleting the repository', async () => {
    const flags = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'runner_git_upload_pack_bytes'`);
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const fk = await admin.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'runner_git_upload_pack_bytes'::regclass AND contype = 'f'`);
    expect(fk.rows).toEqual([{ confdeltype: 'c' }]);
  });

  it('the migration never grants platform_ops a privilege, revokes one from it or makes it an owner', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const statement of sql.split(';')) {
      if (/\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement)) expect(statement, statement.trim().slice(0, 80)).not.toMatch(/\b(TO|FROM)\s+platform_ops\b/i);
    }
  });
});
