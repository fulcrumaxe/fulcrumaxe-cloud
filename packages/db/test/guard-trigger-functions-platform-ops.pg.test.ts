import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { insertRunner } from './helpers/runnerFixtures.js';

/**
 * D#2 hardening (security review of #522/#523, CWE-284/693; migration 0720).
 *
 * For each guard trigger function AND each definer helper behind them: a REAL platform_ops login must not be able to
 * drop, alter (IMMUTABLE, STABLE, SECURITY INVOKER, SET search_path, RENAME, OWNER TO), replace or rename it, nor
 * disable or drop its trigger, nor give itself the role that owns the helpers; and the guarded behaviour still works.
 *
 * Every attack runs in its own transaction that is ROLLED BACK. If a guard were missing the attack would succeed inside
 * that transaction and the test would fail, but it can never change the shared catalog, so the repo-wide ownership test
 * sees the real state whatever order the files run in.
 */
interface Ctx {
  admin: PoolClient;
  platformOps: Pool;
  appUser: Pool;
  refs: SeedRefs;
}
interface Target {
  fn: string; // schema-qualified, with argument list
  kind: 'trigger function' | 'helper';
  table?: string;
  triggers?: string[];
  owner: string;
  /** The guarded behaviour, still correct after the (refused) attacks. */
  prove: (ctx: Ctx) => Promise<void>;
}

const uniqueSha = (): string => randomUUID().replaceAll('-', '').padEnd(40, '0');

/** A second member of the account, registered as admin, owning one live runner. */
async function adminWithRunner(admin: PoolClient, refs: SeedRefs): Promise<{ userId: string; runnerId: string }> {
  const userId = randomUUID();
  await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
  await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [refs.accountId, userId]);
  return { userId, runnerId: await insertRunner(admin, refs.accountId, userId) };
}

const TARGETS: Target[] = [
  {
    fn: 'public.agent_runs_write_guard()',
    kind: 'trigger function',
    table: 'public.agent_runs',
    triggers: ['agent_runs_write_guard'],
    owner: 'migration',
    prove: async ({ platformOps, refs }) => {
      await expect(
        withTenant(platformOps, refs.accountId, (c) =>
          c.query(
            `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha)
             VALUES ($1, $2, $3, 'security-reviewer', 'production', 'succeeded', $4)`,
            [randomUUID(), refs.accountId, refs.workItemId, uniqueSha()],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/platform_ops may not/) });
    },
  },
  {
    fn: 'public.agent_runs_identity_immutable()',
    kind: 'trigger function',
    table: 'public.agent_runs',
    triggers: ['agent_runs_identity_immutable'],
    owner: 'migration',
    prove: async ({ admin, refs }) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha)
         VALUES ($1, $2, $3, 'code-reviewer', 'production', 'pending', $4)`,
        [id, refs.accountId, refs.workItemId, uniqueSha()],
      );
      // platform_ops has no column grant on `head_sha`, so the trigger is shown on the fixture superuser, which it binds too.
      await expect(admin.query(`UPDATE agent_runs SET head_sha = $2 WHERE id = $1`, [id, uniqueSha()])).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        message: expect.stringMatching(/head_sha are immutable after insert/),
      });
      expect((await admin.query(`SELECT head_sha FROM agent_runs WHERE id = $1`, [id])).rows[0].head_sha).toHaveLength(40);
    },
  },
  {
    fn: 'public.forbid_api_token_unrevoke()',
    kind: 'trigger function',
    table: 'public.api_tokens',
    triggers: ['trg_forbid_api_token_unrevoke'],
    owner: 'migration',
    prove: async ({ admin, refs }) => {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, revoked_at, revoked_reason)
         VALUES ($1, $2, $3, 'fxat_...own', '{read}', now() + interval '90 days', now(), 'user_requested') RETURNING id`,
        [refs.accountId, refs.userId, randomUUID()],
      );
      // The trigger binds every role, including the superuser fixture: if it had been dropped this would succeed.
      await expect(admin.query(`UPDATE api_tokens SET revoked_at = NULL WHERE id = $1`, [rows[0]!.id])).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
      expect((await admin.query(`SELECT revoked_at FROM api_tokens WHERE id = $1`, [rows[0]!.id])).rows[0].revoked_at).not.toBeNull();
    },
  },
  {
    fn: 'public.runner_revoke_on_member_change_trigger()',
    kind: 'trigger function',
    table: 'public.account_members',
    triggers: ['runner_revoke_on_member_demoted', 'runner_revoke_on_member_removed'],
    owner: 'migration',
    prove: async ({ admin, refs }) => {
      const { userId, runnerId } = await adminWithRunner(admin, refs);
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId]);
      const { rows } = await admin.query(`SELECT revoked_at, revoked_reason FROM runners WHERE id = $1`, [runnerId]);
      expect(rows[0].revoked_reason).toBe('member_demoted');
      expect(rows[0].revoked_at).not.toBeNull();
    },
  },
  {
    fn: 'public.model_connections_onboarding_mark_trigger()',
    kind: 'trigger function',
    table: 'public.model_connections',
    triggers: ['model_connections_onboarding_mark'],
    owner: 'migration',
    prove: async ({ admin, refs }) => {
      await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [refs.accountId]);
      expect((await admin.query(`SELECT onboarding_key_ok_at FROM accounts WHERE id = $1`, [refs.accountId])).rows[0].onboarding_key_ok_at).not.toBeNull();
    },
  },
  {
    fn: 'public.runner_revoke_on_member_change_apply(uuid, uuid)',
    kind: 'helper',
    owner: 'guard_definer',
    prove: async ({ admin, appUser, refs }) => {
      // Revoke by a demotion done as app_user (the owner), and the audit row names that owner.
      const { userId, runnerId } = await adminWithRunner(admin, refs);
      await withTenant(appUser, refs.accountId, refs.userId, (c) =>
        c.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId]),
      );
      const { rows } = await admin.query(`SELECT revoked_at, revoked_reason FROM runners WHERE id = $1`, [runnerId]);
      expect(rows[0].revoked_reason).toBe('member_demoted');
      expect(rows[0].revoked_at).not.toBeNull();
      const audit = await admin.query(`SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'runner.revoked' AND payload->>'runner_id' = $2`, [refs.accountId, runnerId]);
      expect(audit.rows).toEqual([{ actor: refs.userId }]);
    },
  },
  {
    fn: 'public.model_connections_onboarding_mark_apply(uuid)',
    kind: 'helper',
    owner: 'guard_definer',
    prove: async ({ admin, platformOps, refs }) => {
      // Only platform_ops (the validator's login) may change a connection's status.
      await withTenant(platformOps, refs.accountId, (c) => c.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [refs.accountId]));
      expect((await admin.query(`SELECT onboarding_key_ok_at FROM accounts WHERE id = $1`, [refs.accountId])).rows[0].onboarding_key_ok_at).not.toBeNull();
    },
  },
];

describe('platform_ops cannot remove or neuter a guard trigger function or its definer helper (0720)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOps.end();
    await appUser.end();
  });

  /** One attempt as platform_ops, in a transaction that is always rolled back. Resolves with the error code, or null if it succeeded. */
  async function attempt(sql: string): Promise<string | null> {
    const c = await platformOps.connect();
    try {
      await c.query('BEGIN');
      try {
        await c.query(sql);
        return null;
      } catch (e) {
        return (e as { code?: string }).code ?? 'unknown';
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  async function ownerOf(fn: string): Promise<{ owner: string; volatile: string; secdef: boolean; config: string[] | null }> {
    const { rows } = await admin.query(
      `SELECT pg_get_userbyid(proowner) AS owner, provolatile AS volatile, prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure`,
      [fn],
    );
    return rows[0];
  }

  it('the attacking pool is a non-superuser platform_ops login, and is not a member of guard_definer', async () => {
    const { rows } = await platformOps.query(
      `SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              pg_has_role('platform_ops', 'guard_definer', 'MEMBER') AS member`,
    );
    expect(rows[0]).toEqual({ u: 'platform_ops', su: false, member: false });
  });

  it('platform_ops cannot give itself guard_definer, or become it', async () => {
    for (const sql of ['GRANT guard_definer TO platform_ops', 'SET ROLE guard_definer', 'ALTER ROLE guard_definer LOGIN', 'ALTER ROLE guard_definer PASSWORD \'x\'']) {
      expect(await attempt(sql), sql).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    }
  });

  describe.each(TARGETS)('$kind $fn', (t) => {
    it('has the expected owner, is not owned by platform_ops, and each trigger is enabled', async () => {
      const o = await ownerOf(t.fn);
      expect(o.owner).not.toBe('platform_ops');
      if (t.owner === 'guard_definer') {
        expect(o).toMatchObject({ owner: 'guard_definer', secdef: true, volatile: 'v' });
        expect(o.config?.some((c) => c.startsWith('search_path=pg_catalog'))).toBe(true);
      } else {
        const tableOwner = (await admin.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.agent_runs'::regclass`)).rows[0].o;
        expect(o.owner).toBe(tableOwner);
      }
      for (const tg of t.triggers ?? []) {
        const r = await admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [t.table, tg]);
        expect(r.rows, tg).toEqual([{ tgenabled: 'O' }]);
      }
    });

    it('a platform_ops login cannot drop, alter, replace or rename it, or disable or drop its trigger', async () => {
      const bare = t.fn.replace(/\(.*\)$/, '');
      const attacks = [
        `DROP FUNCTION ${t.fn} CASCADE`,
        `DROP FUNCTION ${t.fn}`,
        `ALTER FUNCTION ${t.fn} IMMUTABLE`,
        `ALTER FUNCTION ${t.fn} STABLE`,
        `ALTER FUNCTION ${t.fn} SECURITY INVOKER`,
        `ALTER FUNCTION ${t.fn} SET search_path = public`,
        `ALTER FUNCTION ${t.fn} RESET ALL`,
        `ALTER FUNCTION ${t.fn} RENAME TO own_renamed`,
        `ALTER FUNCTION ${t.fn} OWNER TO platform_ops`,
        `ALTER FUNCTION ${t.fn} SET SCHEMA pg_catalog`,
        `CREATE OR REPLACE FUNCTION ${bare}(${t.fn.slice(t.fn.indexOf('(') + 1, -1)}) RETURNS ${t.kind === 'helper' ? 'void' : 'trigger'} LANGUAGE plpgsql AS $b$ BEGIN ${t.kind === 'helper' ? 'RETURN' : 'RETURN NEW'}; END $b$`,
        ...(t.table
          ? [
              `ALTER TABLE ${t.table} DISABLE TRIGGER USER`,
              `ALTER TABLE ${t.table} DISABLE TRIGGER ALL`,
              ...t.triggers!.flatMap((tg) => [`ALTER TABLE ${t.table} DISABLE TRIGGER ${tg}`, `DROP TRIGGER ${tg} ON ${t.table}`]),
            ]
          : []),
      ];
      for (const sql of attacks) {
        expect(await attempt(sql), sql).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      }
      // Nothing moved.
      const o = await ownerOf(t.fn);
      expect(o.owner).not.toBe('platform_ops');
      if (t.owner === 'guard_definer') expect(o).toMatchObject({ owner: 'guard_definer', secdef: true, volatile: 'v' });
    });

    it('the guarded behaviour still holds after those attempts', async () => {
      const refs = await seedAccount(admin, randomUUID());
      await t.prove({ admin, platformOps, appUser, refs });
    });
  });
});

describe('the definer helpers fail closed and cannot be used to do more than the trigger would (0720)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOps.end();
    await appUser.end();
  });

  it('both helpers are SECURITY DEFINER, owned by guard_definer, with a pinned search_path, and not executable by PUBLIC', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS to_public,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS platform_ops
         FROM pg_proc p WHERE p.proname IN ('runner_revoke_on_member_change_apply', 'model_connections_onboarding_mark_apply')
        ORDER BY 1`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ prosecdef: true, owner: 'guard_definer', to_public: false, app_user: true, platform_ops: true });
      expect(r.proconfig.some((c: string) => c.startsWith('search_path=pg_catalog')), r.proname).toBe(true);
    }
  });

  it('guard_definer is NOLOGIN, unprivileged, a member of nothing, with no member and no inheriting migration role', async () => {
    const { rows } = await admin.query(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
              (SELECT count(*) FROM pg_auth_members WHERE member = r.oid) AS memberships,
              (SELECT count(*) FROM pg_auth_members WHERE roleid = r.oid AND (inherit_option OR set_option)) AS live_members
         FROM pg_roles r WHERE rolname = 'guard_definer'`,
    );
    expect(rows[0]).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect(Number(rows[0].memberships)).toBe(0);
    expect(Number(rows[0].live_members)).toBe(0);
  });

  it('the two superseded definers (kept until a contract migration drops them) are called by no trigger', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = p.oid) AS triggers
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('runner_revoke_on_member_change', 'model_connections_onboarding_mark') AND p.prorettype = 'trigger'::regtype`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual(['model_connections_onboarding_mark', 'runner_revoke_on_member_change']);
    for (const r of rows) expect(Number(r.triggers), r.proname).toBe(0);
  });

  it('the trigger functions are not SECURITY DEFINER', async () => {
    const { rows } = await admin.query(
      `SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('runner_revoke_on_member_change_trigger', 'model_connections_onboarding_mark_trigger')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.prosecdef, r.proname).toBe(false);
  });

  /** Runs `body` in a transaction on a client of `pool`, then rolls back, so a DROP or REVOKE never persists. */
  async function rolledBack(pool: Pool, accountId: string, body: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      await body(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('if a helper is dropped (by the superuser fixture), the membership change or key save ERRORS instead of skipping', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const { userId, runnerId } = await adminWithRunner(admin, refs);
    await rolledBack(adminPool, refs.accountId, async (c) => {
      await c.query('DROP FUNCTION public.runner_revoke_on_member_change_apply(uuid, uuid)');
      await expect(c.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId])).rejects.toMatchObject({ code: '42883' });
    });
    await rolledBack(adminPool, refs.accountId, async (c) => {
      await c.query('DROP FUNCTION public.runner_revoke_on_member_change_apply(uuid, uuid)');
      await expect(c.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId])).rejects.toMatchObject({ code: '42883' });
    });
    await rolledBack(adminPool, refs.accountId, async (c) => {
      await c.query('DROP FUNCTION public.model_connections_onboarding_mark_apply(uuid)');
      await expect(c.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [refs.accountId])).rejects.toMatchObject({ code: '42883' });
    });
    expect((await admin.query(`SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId])).rows[0].role).toBe('admin');
    expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).toBeNull();
  });

  it('if EXECUTE on a helper is revoked from the writer, the guarded write ERRORS instead of skipping', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const { userId } = await adminWithRunner(admin, refs);
    await rolledBack(adminPool, refs.accountId, async (c) => {
      await c.query('REVOKE EXECUTE ON FUNCTION public.runner_revoke_on_member_change_apply(uuid, uuid) FROM platform_ops');
      await c.query('SET LOCAL ROLE platform_ops');
      await expect(c.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  it("the normal path still revokes a departed member's runners, and keeps an owner/admin's", async () => {
    const refs = await seedAccount(admin, randomUUID());
    const { userId, runnerId } = await adminWithRunner(admin, refs);
    await admin.query(`UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId]);
    expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).toBeNull();
    await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [refs.accountId, userId]);
    expect((await admin.query(`SELECT revoked_reason FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_reason).toBe('member_demoted');
  });

  it('calling the runner helper directly does nothing for a member who is still owner/admin', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const { userId, runnerId } = await adminWithRunner(admin, refs);
    await withTenant(appUser, refs.accountId, refs.userId, (c) => c.query('SELECT runner_revoke_on_member_change_apply($1, $2)', [refs.accountId, userId]));
    expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).toBeNull();
  });

  it('a direct cross-tenant call cannot name another tenant\'s user as the audit actor', async () => {
    const victim = await seedAccount(admin, randomUUID());
    const caller = await seedAccount(admin, randomUUID());
    // A runner registered by a user who is no longer an owner/admin of the victim account.
    const gone = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [gone, `${gone}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [victim.accountId, gone]);
    const runnerId = await insertRunner(admin, victim.accountId, gone);
    await withTenant(appUser, caller.accountId, caller.userId, (c) => c.query('SELECT runner_revoke_on_member_change_apply($1, $2)', [victim.accountId, gone]));
    const rows = (await admin.query(`SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'runner.revoked' AND payload->>'runner_id' = $2`, [victim.accountId, runnerId])).rows;
    expect(rows).toEqual([{ actor: 'system:membership' }]);
  });

  it('calling the mark helper directly does not mark an account that has no working key', async () => {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE model_connections SET status = 'broken' WHERE account_id = $1`, [refs.accountId]);
    await withTenant(appUser, refs.accountId, refs.userId, (c) => c.query('SELECT model_connections_onboarding_mark_apply($1)', [refs.accountId]));
    expect((await admin.query(`SELECT onboarding_key_ok_at FROM accounts WHERE id = $1`, [refs.accountId])).rows[0].onboarding_key_ok_at).toBeNull();
  });
});
