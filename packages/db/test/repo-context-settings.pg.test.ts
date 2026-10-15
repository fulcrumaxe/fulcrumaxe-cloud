import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'repo_context_settings_definer';
const FN = 'repo_context_settings_apply(uuid,integer)';

/** D#600 CX-2: the per-repository memory slot size (migration 0796), its one writer, and the privilege line around it. Real Postgres, row security forced. */
describe('migration 0796: repo_context_settings and repo_context_settings_apply', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs; // its seeded user is the owner
  let b: SeedRefs;
  let adminUser: string;
  let member: string;

  const addMember = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  };
  const apply = (user: string, repo: string, bytes: number | null, accountId = a.accountId) =>
    withTenant(appPool, accountId, user, (c) => c.query('SELECT repo_context_settings_apply($1::uuid, $2::int)', [repo, bytes]));
  const stored = (repo = a.repoId) => admin.query('SELECT memory_slot_bytes, updated_by FROM repo_context_settings WHERE repo_id = $1', [repo]).then((r) => r.rows[0] ?? null);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminUser = await addMember(a.accountId, 'admin');
    member = await addMember(a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('an owner or admin sets the size and resets it; a reset removes the row, so no copy of the default is stored', async () => {
    await apply(a.userId, a.repoId, 6000);
    expect(await stored()).toEqual({ memory_slot_bytes: 6000, updated_by: a.userId });
    await apply(adminUser, a.repoId, 1024);
    expect(await stored()).toEqual({ memory_slot_bytes: 1024, updated_by: adminUser });
    await apply(adminUser, a.repoId, 8192);
    expect((await stored())?.memory_slot_bytes).toBe(8192);
    await apply(a.userId, a.repoId, null);
    expect(await stored()).toBeNull();
    await apply(a.userId, a.repoId, null); // resetting a reset is fine
  });

  it('refuses 0, 1023, 8193 and 9000 with invalid_message, and writes nothing', async () => {
    await apply(a.userId, a.repoId, 4096);
    for (const bad of [0, 1023, 8193, 9000, -1]) {
      await expect(apply(a.userId, a.repoId, bad), String(bad)).rejects.toMatchObject({ code: '22023', message: 'invalid_message' });
    }
    expect((await stored())?.memory_slot_bytes).toBe(4096);
    await expect(apply(a.userId, null as unknown as string, 4096)).rejects.toMatchObject({ code: '22023', message: 'invalid_message' });
    await apply(a.userId, a.repoId, null);
  });

  it('the table itself refuses an out-of-range size even to the table owner', async () => {
    for (const bad of [0, 1023, 8193]) {
      await expect(admin.query('INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by) VALUES ($1, $2, $3, $4)', [a.accountId, a.repoId, bad, a.userId]), String(bad)).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('a plain member, a stranger and a user of another account are refused (42501); a repository of another account does not exist for the caller', async () => {
    await expect(apply(member, a.repoId, 2048)).rejects.toMatchObject({ code: '42501' });
    await expect(apply(randomUUID(), a.repoId, 2048)).rejects.toMatchObject({ code: '42501' });
    await expect(apply(b.userId, a.repoId, 2048, a.accountId)).rejects.toMatchObject({ code: '42501' });
    await expect(apply(a.userId, b.repoId, 2048)).rejects.toMatchObject({ code: 'P0002' });
    expect(await stored()).toBeNull();
    expect(await stored(b.repoId)).toBeNull();
  });

  it('row security is forced: an account reads only its own rows, and app_user cannot write the table', async () => {
    await apply(a.userId, a.repoId, 5000);
    await apply(b.userId, b.repoId, 7000, b.accountId);
    const own = await withTenant(appPool, a.accountId, (c) => c.query('SELECT repo_id, memory_slot_bytes FROM repo_context_settings'));
    expect(own.rows).toEqual([{ repo_id: a.repoId, memory_slot_bytes: 5000 }]);
    const other = await withTenant(appPool, b.accountId, (c) => c.query('SELECT repo_id FROM repo_context_settings WHERE repo_id = $1', [a.repoId]));
    expect(other.rowCount).toBe(0);
    await expect(withTenant(appPool, a.accountId, (c) => c.query('UPDATE repo_context_settings SET memory_slot_bytes = 1024'))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appPool, a.accountId, (c) => c.query('DELETE FROM repo_context_settings'))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appPool, a.accountId, (c) => c.query('INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by) VALUES ($1, $2, 2048, $3)', [a.accountId, a.repoId, a.userId]))).rejects.toMatchObject({ code: '42501' });
    const { rows } = await admin.query('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass', ['repo_context_settings']);
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await apply(a.userId, a.repoId, null);
    await apply(b.userId, b.repoId, null, b.accountId);
  });

  it('removing the repository removes its setting (undo by derivation: no row, the default)', async () => {
    const extra = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [extra, a.accountId, Math.floor(Math.random() * 1e9)]);
    await apply(a.userId, extra, 3000);
    expect(await stored(extra)).not.toBeNull();
    await admin.query('DELETE FROM repos WHERE id = $1', [extra]);
    expect(await stored(extra)).toBeNull();
  });

  it('the privilege line: the definer is NOLOGIN and owns exactly the one function; EXECUTE is app_user alone; platform_ops holds nothing', async () => {
    const role = await admin.query('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
    const fn = await admin.query(
      `SELECT p.prosecdef, p.proconfig, (SELECT array_agg(DISTINCT pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner AND x.grantee <> 0) AS grantees,
              pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(fn.rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'], owner: ROLE });
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query('SELECT 1 FROM repo_context_settings')).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query('SELECT repo_context_settings_apply(gen_random_uuid(), 2048)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });
});
