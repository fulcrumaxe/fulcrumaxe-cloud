import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 MC-7: the list of connected credentials is read by its own role, machine_sweep_lister, and by no setting. A session that sets the old `app.machine_sweep` flag (any role may
 * set a custom setting) gains nothing: no credential of another account is readable by table, by the reader or by the list, and the list is callable by platform_ops alone.
 */
describe('machine_sweep_lister [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let credA: string;
  let credB: string;

  const cred = async (r: SeedRefs): Promise<string> =>
    (await admin.query(`INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', $3, $4, $5, 1, 'a1b2', $2) RETURNING id`,
      [r.accountId, r.userId, randomBytes(40), randomBytes(12), randomBytes(60)])).rows[0].id;
  const code = async (c: PoolClient, sql: string, args: unknown[] = []): Promise<string> => {
    await c.query('SAVEPOINT p');
    try { await c.query(sql, args); return 'ok'; } catch (e) { return (e as { code: string }).code; } finally { await c.query('ROLLBACK TO SAVEPOINT p'); }
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    credA = await cred(a);
    credB = await cred(b);
  });
  afterAll(async () => { admin.release(); await adminPool.end(); await appPool.end(); await opsPool.end(); });

  it('a tenant session that sets the old flag sees no other account\'s credential, by table, by the reader, by SET ROLE or by the list', async () => {
    const out = await withTenant(appPool, a.accountId, a.userId, async (c) => {
      await c.query(`SELECT set_config('app.machine_sweep', 'on', true)`);
      const direct = (await c.query(`SELECT id FROM machine_provider_credentials`)).rows.map((r) => r.id);
      const viaReader = (await c.query(`SELECT o_id FROM machine_credential_use($1)`, [credB])).rowCount;
      return { direct, viaReader, ops: await code(c, 'SET ROLE machine_ops'), lister: await code(c, 'SET ROLE machine_sweep_lister'), list: await code(c, 'SELECT * FROM machine_sweep_credentials()') };
    });
    expect(out.direct).toContain(credA);
    expect(out.direct).not.toContain(credB);
    expect(out.viaReader).toBe(0);
    expect(out).toMatchObject({ ops: '42501', lister: '42501', list: '42501' });
  });

  it('platform_ops with the flag on cannot read a sealed column, call the reader or take either role, and the list holds only the three columns it returns', async () => {
    const c = await opsPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.machine_sweep', 'on', true)`);
      expect(await code(c, 'SELECT ciphertext FROM machine_provider_credentials')).toBe('42501');
      expect(await code(c, 'SELECT * FROM machine_credential_use($1)', [credB])).toBe('42501');
      expect(await code(c, 'SET ROLE machine_ops')).toBe('42501');
      expect(await code(c, 'SET ROLE machine_sweep_lister')).toBe('42501');
      const rows = (await c.query('SELECT * FROM machine_sweep_credentials()')).rows;
      await c.query('ROLLBACK');
      expect(rows.map((r) => r.credential_id)).toEqual(expect.arrayContaining([credA, credB]));
      expect(Object.keys(rows[0]).sort()).toEqual(['account_id', 'created_by', 'credential_id']);
    } finally { c.release(); }
  });

  it('the role can log in nowhere, has no members and no sealed column; the list belongs to it and platform_ops alone runs it; machine_ops has no sweep policy left', async () => {
    expect((await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'machine_sweep_lister'`)).rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
    expect((await admin.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = 'machine_sweep_lister'::regrole`)).rows.map((r) => r.rolname).filter((n) => n !== 'postgres')).toEqual([]);
    for (const col of ['ciphertext', 'nonce', 'wrapped_dek', 'kek_version', 'token_hint']) {
      expect((await admin.query(`SELECT has_column_privilege('machine_sweep_lister', 'machine_provider_credentials', $1, 'SELECT') AS ok`, [col])).rows[0].ok, col).toBe(false);
    }
    expect((await admin.query(`SELECT has_table_privilege('machine_sweep_lister', 'managed_servers', 'SELECT') AS ok`)).rows[0].ok).toBe(false);
    const fn = (await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p WHERE p.proname = 'machine_sweep_credentials'`)).rows;
    expect(fn).toEqual([{ owner: 'machine_sweep_lister', app: false, ops: true, pub: false }]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'machine_ops_sweep'`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT p.proname FROM pg_proc p WHERE p.proowner = 'machine_ops'::regrole AND has_function_privilege('platform_ops', p.oid, 'EXECUTE') ORDER BY 1`)).rows.map((r) => r.proname)).not.toContain('machine_sweep_credentials');
  });
});
