import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount } from './helpers/seed.js';

/** The per-repo opt-in for auto-merge on a runner repo's local reviews (0733): who can write it, what ties it to the repo, what it audits. */
interface Acct {
  accountId: string;
  repoId: string;
  owner: string;
  admin: string;
  member: string;
}

describe('repo_local_review_optins (0733)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  async function account(mode = 'runner_local'): Promise<Acct> {
    const refs = await seedAccount(admin, randomUUID());
    const ids: Record<string, string> = { owner: refs.userId };
    await admin.query(`UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, refs.userId]);
    for (const role of ['admin', 'member'] as const) {
      const id = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [refs.accountId, id, role]);
      ids[role] = id;
    }
    await admin.query('UPDATE repos SET execution_mode = $2 WHERE id = $1', [refs.repoId, mode]);
    return { accountId: refs.accountId, repoId: refs.repoId, owner: ids.owner!, admin: ids.admin!, member: ids.member! };
  }
  /** A tenant session for the account, with the acting user when there is one. */
  const inSession = <T>(accountId: string, user: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> => (user ? withTenant(appPool, accountId, user, fn) : withTenant(appPool, accountId, fn));
  const set = (a: Acct, user: string | null, repoId: string, enabled: boolean, copySha?: string) =>
    inSession(a.accountId, user, async (c) =>
      (await c.query<{ changed: boolean }>('SELECT repo_local_review_optin_set($1, $2, $3) AS changed', [repoId, enabled, copySha ?? null])).rows[0]!.changed,
    );
  const fail = async (act: () => Promise<unknown>): Promise<{ code?: string; message?: string }> => {
    try {
      await act();
    } catch (error) {
      return error as { code?: string; message?: string };
    }
    throw new Error('the call was accepted');
  };
  const rows = async (a: Acct) => (await admin.query('SELECT * FROM repo_local_review_optins WHERE account_id = $1', [a.accountId])).rows;
  const audits = async (a: Acct) => (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'repo.local_review_auto_merge.%' ORDER BY created_at`, [a.accountId])).rows;

  it('is off by default: a repo has no row until an owner or admin turns it on', async () => {
    const a = await account();
    expect(await rows(a)).toEqual([]);
  });

  it('lets an owner or an admin turn it on and off, each change writing one audit row with the acting user', async () => {
    const a = await account();
    expect(await set(a, a.admin, a.repoId, true)).toBe(true);
    expect(await rows(a)).toMatchObject([{ account_id: a.accountId, repo_id: a.repoId, execution_mode: 'runner_local', enabled_by: a.admin }]);
    expect(await set(a, a.owner, a.repoId, false)).toBe(true);
    expect(await rows(a)).toEqual([]);
    expect(await audits(a)).toMatchObject([
      { actor: a.admin, action: 'repo.local_review_auto_merge.enabled', payload: { repo_id: a.repoId } },
      { actor: a.owner, action: 'repo.local_review_auto_merge.disabled', payload: { repo_id: a.repoId } },
    ]);
  });

  describe('the copy hash (the wording the client showed)', () => {
    const SHA = 'a'.repeat(32) + 'b'.repeat(32);

    it('is recorded in the audit row of the change it came with, and an absent hash records none', async () => {
      const a = await account();
      await set(a, a.owner, a.repoId, true, SHA);
      await set(a, a.owner, a.repoId, false);
      await set(a, a.owner, a.repoId, true);
      const payloads = (await audits(a)).map((r) => r.payload);
      expect(payloads[0]).toEqual({ repo_id: a.repoId, copy_sha256: SHA });
      expect(payloads[1]).toEqual({ repo_id: a.repoId });
      expect(payloads[2]).toEqual({ repo_id: a.repoId });
      // The hash can come with an off as well.
      await set(a, a.owner, a.repoId, false, SHA);
      expect((await audits(a)).at(-1)!.payload).toEqual({ repo_id: a.repoId, copy_sha256: SHA });
    });

    it('is refused unless it is 64 lowercase hex characters, and a refusal changes nothing', async () => {
      const a = await account();
      for (const bad of ['x', '', SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, `${'g'.repeat(64)}`, `${SHA}\n`]) {
        expect((await fail(() => set(a, a.owner, a.repoId, true, bad))).code, JSON.stringify(bad)).toBe('22023');
      }
      expect(await rows(a)).toEqual([]);
      expect(await audits(a)).toEqual([]);
    });

    it('is optional: the two-argument call still works', async () => {
      const a = await account();
      expect(await withTenant(appPool, a.accountId, a.owner, async (c) => (await c.query('SELECT repo_local_review_optin_set($1, true) AS changed', [a.repoId])).rows[0]!.changed)).toBe(true);
    });
  });

  it('a repeat changes nothing and writes no second audit row', async () => {
    const a = await account();
    expect(await set(a, a.owner, a.repoId, true)).toBe(true);
    expect(await set(a, a.admin, a.repoId, true)).toBe(false);
    expect(await set(a, a.owner, a.repoId, false)).toBe(true);
    expect(await set(a, a.owner, a.repoId, false)).toBe(false);
    expect(await audits(a)).toHaveLength(2);
  });

  it('refuses a member, no user, and another account, each leaving the rows and the audit as they were', async () => {
    const a = await account();
    const b = await account();
    for (const [label, act] of [
      ['a member', () => set(a, a.member, a.repoId, true)],
      ['no user', () => set(a, null, a.repoId, true)],
      ["another account's owner", () => set(a, b.owner, a.repoId, true)],
    ] as const) {
      expect((await fail(act)).code, label).toBe('42501');
    }
    // An owner of another account naming this account's repo from their own tenant: no such repo.
    expect((await fail(() => set(b, b.owner, a.repoId, true))).code).toBe('P0002');
    expect(await rows(a)).toEqual([]);
    expect(await audits(a)).toEqual([]);
    expect(await audits(b)).toEqual([]);
    // A member also cannot turn it off.
    await set(a, a.owner, a.repoId, true);
    expect((await fail(() => set(a, a.member, a.repoId, false))).code).toBe('42501');
    expect(await rows(a)).toHaveLength(1);
  });

  it('refuses an unknown repo and a null argument', async () => {
    const a = await account();
    expect((await fail(() => set(a, a.owner, randomUUID(), true))).code).toBe('P0002');
    expect((await fail(() => withTenant(appPool, a.accountId, a.owner, (c) => c.query('SELECT repo_local_review_optin_set(NULL, true)')))).code).toBe('22023');
    expect((await fail(() => withTenant(appPool, a.accountId, a.owner, (c) => c.query('SELECT repo_local_review_optin_set($1, NULL)', [a.repoId])))).code).toBe('22023');
  });

  describe('it is tied to the repo being on a runner', () => {
    it('cannot be turned on for a sandbox repo', async () => {
      const a = await account('sandbox');
      expect((await fail(() => set(a, a.owner, a.repoId, true))).code).toBe('55000');
      expect(await rows(a)).toEqual([]);
      expect(await audits(a)).toEqual([]);
    });

    it('stops the repo leaving runner_local while it is on, and lets it go once it is off', async () => {
      const a = await account();
      await set(a, a.owner, a.repoId, true);
      expect((await fail(() => admin.query(`UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1`, [a.repoId]))).code).toBe('23503');
      expect((await admin.query('SELECT execution_mode FROM repos WHERE id = $1', [a.repoId])).rows[0]!.execution_mode).toBe('runner_local');
      await set(a, a.owner, a.repoId, false);
      await admin.query(`UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1`, [a.repoId]);
      // Back to a runner: the old opt-in is gone, it does not come back on its own.
      await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [a.repoId]);
      expect(await rows(a)).toEqual([]);
    });

    it('goes with the repo', async () => {
      const a = await account();
      await set(a, a.owner, a.repoId, true);
      await admin.query('DELETE FROM repos WHERE id = $1', [a.repoId]);
      expect(await rows(a)).toEqual([]);
    });
  });

  describe('who can write the table other than through the function', () => {
    it('app_user can read its own account only, and write nothing directly', async () => {
      const a = await account();
      const b = await account();
      await set(a, a.owner, a.repoId, true);
      await set(b, b.owner, b.repoId, true);
      const seen = await withTenant(appPool, a.accountId, async (c) => (await c.query('SELECT account_id FROM repo_local_review_optins')).rows);
      expect(seen).toEqual([{ account_id: a.accountId }]);
      const direct = await withTenant(appPool, a.accountId, a.admin, async (c) => {
        const out: Array<string | undefined> = [];
        for (const sql of [
          `INSERT INTO repo_local_review_optins (account_id, repo_id, enabled_by) VALUES ('${a.accountId}', '${randomUUID()}', '${a.admin}')`,
          `UPDATE repo_local_review_optins SET enabled_by = '${a.member}'`,
          'DELETE FROM repo_local_review_optins',
        ]) {
          await c.query('SAVEPOINT s');
          out.push(await fail(() => c.query(sql)).then((e) => e.code));
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
        return out;
      });
      expect(direct).toEqual(['42501', '42501', '42501']);
      expect(await rows(a)).toHaveLength(1);
    });

    it('a direct platform_ops login is refused by the function and by the trigger, which a cascade does not trip', async () => {
      const a = await account();
      await set(a, a.owner, a.repoId, true);
      const viaFunction = await opsPool.connect();
      try {
        await viaFunction.query('BEGIN');
        await viaFunction.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, a.owner]);
        expect((await fail(() => viaFunction.query('SELECT repo_local_review_optin_set($1, true)', [a.repoId]))).code).toBe('42501');
      } finally {
        await viaFunction.query('ROLLBACK').catch(() => undefined);
        viaFunction.release();
      }
      expect((await fail(() => opsPool.query(`INSERT INTO repo_local_review_optins (account_id, repo_id, enabled_by) VALUES ($1, $2, $3)`, [a.accountId, randomUUID(), a.admin]))).code).toBe('42501');
      expect((await fail(() => opsPool.query('DELETE FROM repo_local_review_optins WHERE account_id = $1', [a.accountId]))).code).toBe('42501');
      expect(await rows(a)).toHaveLength(1);
    });

    it('the guard on this table cannot be dropped, altered or disabled by a platform_ops login, so a direct insert stays refused (CWE-284)', async () => {
      const a = await account();
      const guard = (await admin.query<{ fn: string; owner: string; ops_is_member: boolean }>(
        `SELECT p.proname AS fn, p.proowner::regrole::text AS owner, pg_has_role('platform_ops', p.proowner, 'MEMBER') AS ops_is_member
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE c.relname = 'repo_local_review_optins' AND NOT t.tgisinternal`,
      )).rows;
      expect(guard.map((g) => g.fn)).toEqual(['runner_tables_platform_ops_guard']);
      expect(guard[0]).toMatchObject({ ops_is_member: false });
      expect(guard[0]!.owner).not.toBe('platform_ops');
      for (const sql of [
        'DROP FUNCTION runner_tables_platform_ops_guard() CASCADE',
        'DROP TRIGGER repo_local_review_optins_platform_ops_guard ON repo_local_review_optins',
        'ALTER TABLE repo_local_review_optins DISABLE TRIGGER ALL',
        'ALTER TABLE repo_local_review_optins DISABLE TRIGGER repo_local_review_optins_platform_ops_guard',
        'ALTER FUNCTION runner_tables_platform_ops_guard() OWNER TO platform_ops',
      ]) {
        const client = await opsPool.connect();
        try {
          await client.query('BEGIN');
          expect((await fail(() => client.query(sql))).code, sql).toBe('42501');
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      }
      expect((await fail(() => opsPool.query(`INSERT INTO repo_local_review_optins (account_id, repo_id, enabled_by) VALUES ($1, $2, $3)`, [a.accountId, a.repoId, a.admin]))).code).toBe('42501');
      expect(await rows(a)).toEqual([]);
      expect(await audits(a)).toEqual([]);
    });

    it('platform_ops holds no TRUNCATE on the table, so it cannot empty it past the row guard', async () => {
      const { rows } = await admin.query<{ can: boolean }>(`SELECT has_table_privilege('platform_ops', 'repo_local_review_optins', 'TRUNCATE') AS can`);
      expect(rows[0]!.can).toBe(false);
      const client = await opsPool.connect();
      try {
        await client.query('BEGIN');
        expect((await fail(() => client.query('TRUNCATE repo_local_review_optins'))).code).toBe('42501');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('the function is SECURITY DEFINER with a pinned search_path, owned by platform_ops, executable by app_user and no one else', async () => {
      const { rows: fn } = await admin.query<{ owner: string; secdef: boolean; config: string[]; grantees: string[] }>(
        `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                (SELECT array_agg(s.g ORDER BY s.g) FROM (SELECT DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS g
                   FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.privilege_type = 'EXECUTE') s) AS grantees
           FROM pg_proc p WHERE p.proname = 'repo_local_review_optin_set' AND p.pronamespace = 'public'::regnamespace`,
      );
      expect(fn).toHaveLength(1);
      expect(fn[0]).toMatchObject({ owner: 'platform_ops', secdef: true, grantees: ['app_user', 'platform_ops'] });
      expect(fn[0]!.config).toContain('search_path=pg_catalog, public, pg_temp');
    });
  });
});
