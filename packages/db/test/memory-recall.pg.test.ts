import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'memory_recall_definer';

/** D#601 MEM-3 (migration 0806): the repository node id column and the one definer that stamps `last_recalled_at`. */
describe('memory recall (D#601 MEM-3, 0806)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  async function entry(accountId: string, status = 'approved'): Promise<string> {
    const id = randomUUID();
    const body = `entry ${id}`;
    await admin.query(
      `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256)
       VALUES ($1, $2, 'account', NULL, 'fact', $3, 'person', $4, 1, $5)`,
      [id, accountId, body, status, createHash('sha256').update(body).digest('hex')],
    );
    return id;
  }
  const stamp = async (id: string) => (await admin.query<{ s: Date | null }>('SELECT last_recalled_at AS s FROM memory_entries WHERE id = $1', [id])).rows[0]!.s;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  it('stamps approved entries of the session account for a userless session, and nothing else', async () => {
    const mine = await entry(a.accountId);
    const proposed = await entry(a.accountId, 'proposed');
    const theirs = await entry(b.accountId);
    const n = await withTenant(appPool, a.accountId, async (c) => (await c.query<{ n: number }>('SELECT memory_mark_recalled($1::uuid[]) AS n', [[mine, proposed, theirs, randomUUID()]])).rows[0]!.n);
    expect(n).toBe(1);
    expect(await stamp(mine)).not.toBeNull();
    expect(await stamp(proposed)).toBeNull();
    expect(await stamp(theirs)).toBeNull();
  });

  it('answers 0 for no ids, refuses more than 500, a person session, a session with no account and a platform_ops login', async () => {
    const id = await entry(a.accountId);
    const call = (c: PoolClient, ids: string[] | null) => c.query('SELECT memory_mark_recalled($1::uuid[]) AS n', [ids]);
    expect((await withTenant(appPool, a.accountId, (c) => call(c, []))).rows[0]!.n).toBe(0);
    expect((await withTenant(appPool, a.accountId, (c) => call(c, null))).rows[0]!.n).toBe(0);
    await expect(withTenant(appPool, a.accountId, (c) => call(c, Array.from({ length: 501 }, () => randomUUID())))).rejects.toMatchObject({ code: '22023' });
    await expect(withTenant(appPool, a.accountId, a.userId, (c) => call(c, [id]))).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT memory_mark_recalled($1::uuid[])', [[id]])).rejects.toMatchObject({ code: '42501' });
    await expect(opsPool.query('SELECT memory_mark_recalled($1::uuid[])', [[id]])).rejects.toMatchObject({ code: '42501' });
    expect(await stamp(id)).toBeNull();
  });

  it('app_user cannot write last_recalled_at itself; the column stays out of the five entry points', async () => {
    const id = await entry(a.accountId);
    await expect(withTenant(appPool, a.accountId, (c) => c.query('UPDATE memory_entries SET last_recalled_at = now() WHERE id = $1', [id]))).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query(`SELECT has_column_privilege('memory_definer', 'public.memory_entries', 'last_recalled_at', 'UPDATE') AS can`)).rows[0]!.can).toBe(false);
  });

  it('the role is NOLOGIN, has no members, owns exactly the one function, and holds exactly four column grants and nothing on platform_ops', async () => {
    const role = (await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE])).rows[0];
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rows[0]!.n).toBe(0);
    const owned = await admin.query<{ proname: string; prosecdef: boolean; proconfig: string[]; app: boolean; ops: boolean; pub: boolean; grantable: boolean }>(
      `SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
              COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub, COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
         FROM pg_proc p WHERE p.proowner = $1::regrole`,
      [ROLE],
    );
    expect(owned.rows).toEqual([{ proname: 'memory_mark_recalled', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], app: true, ops: false, pub: false, grantable: false }]);
    const held = await admin.query<{ x: string }>(
      `SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type AS x
         FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE a.grantee = $1::regrole::oid
       UNION ALL SELECT 'table ' || c.relname || ' ' || a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = $1::regrole::oid
       UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = $1::regrole::oid AND n.nspname = 'public'`,
      [ROLE],
    );
    expect(held.rows.map((r) => r.x).sort()).toEqual(
      ['column memory_entries.id SELECT', 'column memory_entries.account_id SELECT', 'column memory_entries.status SELECT', 'column memory_entries.last_recalled_at UPDATE', 'column accounts.id SELECT', 'column accounts.deleted_at SELECT', 'schema public USAGE'].sort(),
    );
    // The 0759-style diff: platform_ops gains nothing on the memory table or the new function.
    expect((await admin.query(`SELECT has_any_column_privilege('platform_ops', 'public.memory_entries', 'SELECT, INSERT, UPDATE, REFERENCES') AS can`)).rows[0]!.can).toBe(false);
  });

  it('repos.gh_node_id is nullable, takes a GitHub node id and refuses anything else', async () => {
    const repo = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repo, a.accountId, Math.floor(Math.random() * 1_000_000_000)]);
    expect((await admin.query('SELECT gh_node_id FROM repos WHERE id = $1', [repo])).rows[0]!.gh_node_id).toBeNull();
    await admin.query('UPDATE repos SET gh_node_id = $2 WHERE id = $1', [repo, 'R_kgDOAbCdEf']);
    for (const bad of ['abc', 'has space', 'a'.repeat(101), 'R_kg@1', '']) {
      await expect(admin.query('UPDATE repos SET gh_node_id = $2 WHERE id = $1', [repo, bad]), bad).rejects.toMatchObject({ code: '23514' });
    }
  });
});
