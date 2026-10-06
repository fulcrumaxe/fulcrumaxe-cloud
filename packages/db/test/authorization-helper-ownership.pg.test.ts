import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF2, type F2Fixture } from './helpers/members.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 hardening (security review of #522/#523, CWE-693/284; migration 0721).
 *
 * The helpers that answer "who is the caller and in what role" are STABLE SECURITY DEFINER functions that policies and
 * definers build their owner/admin checks on. The owner of a function can change its attributes (volatility, search_path,
 * security mode), rename, replace or drop it, so none of them may be owned by the platform_ops login. They belong to the
 * NOLOGIN role guard_definer.
 *
 * Every attempt below runs in its own transaction that is ROLLED BACK. A missing guard would let the statement succeed
 * inside that transaction (and the test fail) without ever changing the shared catalog.
 */
interface Helper {
  fn: string; // schema-qualified, with argument list
  returns: string;
  /** pg_proc.provolatile expected: unchanged from the original definition. */
  volatility: 'v' | 's';
  /** Roles that must keep EXECUTE besides the owner. */
  executors: string[];
}

const HELPERS: Helper[] = [
  { fn: 'public.current_member_role()', returns: 'text', volatility: 's', executors: ['app_user', 'platform_ops'] },
  { fn: 'public.current_member_user_id()', returns: 'uuid', volatility: 's', executors: ['app_user', 'platform_ops'] },
  { fn: 'public.current_member_email()', returns: 'text', volatility: 's', executors: ['app_user', 'platform_ops'] },
  { fn: 'public.has_open_invitation(uuid, uuid, text)', returns: 'boolean', volatility: 'v', executors: ['app_user', 'platform_ops'] },
  { fn: 'public.partner_account_visible(uuid)', returns: 'boolean', volatility: 's', executors: ['partner_user', 'platform_ops'] },
  { fn: 'public.has_active_support_grant(uuid)', returns: 'boolean', volatility: 's', executors: ['partner_user', 'platform_ops'] },
  { fn: 'public.support_grant_matches(uuid, uuid)', returns: 'boolean', volatility: 's', executors: ['partner_user', 'platform_ops'] },
];

describe('platform_ops cannot alter, replace or drop an authorization helper (0721)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOps: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOps.end();
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

  async function state(fn: string): Promise<{ owner: string; volatile: string; secdef: boolean; config: string[] | null }> {
    const { rows } = await admin.query(
      `SELECT pg_get_userbyid(proowner) AS owner, provolatile AS volatile, prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure`,
      [fn],
    );
    return rows[0];
  }

  it('the attacking pool is a non-superuser platform_ops login that is not a member of guard_definer', async () => {
    const { rows } = await platformOps.query(
      `SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              pg_has_role('platform_ops', 'guard_definer', 'MEMBER') AS member`,
    );
    expect(rows[0]).toEqual({ u: 'platform_ops', su: false, member: false });
  });

  describe.each(HELPERS)('$fn', (h) => {
    it('is owned by guard_definer, still SECURITY DEFINER, same volatility, search_path pinned, not executable by PUBLIC', async () => {
      const s = await state(h.fn);
      expect(s).toMatchObject({ owner: 'guard_definer', secdef: true, volatile: h.volatility });
      expect(s.config?.some((c) => c.startsWith('search_path=public'))).toBe(true);
      const { rows } = await admin.query(
        `SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS to_public,
                bool_and(has_function_privilege(r, $1::regprocedure, 'EXECUTE')) AS executors
           FROM unnest($2::text[]) AS r`,
        [h.fn, h.executors],
      );
      expect(rows[0]).toEqual({ to_public: false, executors: true });
    });

    it('a platform_ops login cannot alter, replace, rename, move, re-own or drop it', async () => {
      const name = h.fn.slice(0, h.fn.indexOf('('));
      const args = h.fn.slice(h.fn.indexOf('(') + 1, -1);
      const attacks = [
        `ALTER FUNCTION ${h.fn} IMMUTABLE`,
        `ALTER FUNCTION ${h.fn} STABLE`,
        `ALTER FUNCTION ${h.fn} VOLATILE`,
        `ALTER FUNCTION ${h.fn} SECURITY INVOKER`,
        `ALTER FUNCTION ${h.fn} SECURITY DEFINER`,
        `ALTER FUNCTION ${h.fn} SET search_path = public`,
        `ALTER FUNCTION ${h.fn} RESET ALL`,
        `ALTER FUNCTION ${h.fn} RENAME TO own_renamed`,
        `ALTER FUNCTION ${h.fn} OWNER TO platform_ops`,
        `ALTER FUNCTION ${h.fn} SET SCHEMA pg_catalog`,
        `CREATE OR REPLACE FUNCTION ${name}(${args}) RETURNS ${h.returns} LANGUAGE sql AS $b$ SELECT NULL $b$`,
        `DROP FUNCTION ${h.fn}`,
        `DROP FUNCTION ${h.fn} CASCADE`,
      ];
      for (const sql of attacks) {
        expect(await attempt(sql), sql).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      }
      expect(await state(h.fn)).toMatchObject({ owner: 'guard_definer', secdef: true, volatile: h.volatility });
    });
  });

  it('guard_definer is still NOLOGIN, unprivileged, a member of nothing, and owns only its helpers', async () => {
    const { rows } = await admin.query(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
              (SELECT count(*) FROM pg_auth_members WHERE member = r.oid) AS memberships,
              (SELECT count(*) FROM pg_auth_members WHERE roleid = r.oid AND (inherit_option OR set_option)) AS live_members,
              has_schema_privilege('guard_definer', 'public', 'CREATE') AS can_create
         FROM pg_roles r WHERE rolname = 'guard_definer'`,
    );
    expect(rows[0]).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, can_create: false });
    expect(Number(rows[0].memberships)).toBe(0);
    expect(Number(rows[0].live_members)).toBe(0);
    const owned = await admin.query(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p WHERE p.proowner = 'guard_definer'::regrole ORDER BY 1`);
    const expected = [
      ...HELPERS.map((h) => h.fn.replace(/^public\./, '')),
      'runner_revoke_on_member_change_apply(uuid,uuid)',
      'model_connections_onboarding_mark_apply(uuid)',
    ].sort();
    expect(owned.rows.map((r) => (r.fn as string).replace(/^public\./, '')).sort()).toEqual(expected.map((e) => e.replaceAll(', ', ',')));
  });
});

describe('a pooled connection never lets a plain member borrow an owner/admin answer (0721)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let onePool: Pool;
  let f: F2Fixture;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    // A single physical connection serves both callers, as a pooler would.
    onePool = createPool(process.env.DATABASE_URL_APP_USER!, { max: 1 });
    f = await seedF2(admin);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await onePool.end();
  });

  it('owner revokes a runner, then a plain member on the same connection is refused for another member\'s runner', async () => {
    // The answer is only safe to reuse across callers while the helper stays STABLE and owned by a role nobody can log in as.
    expect((await admin.query(`SELECT provolatile, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'public.current_member_role()'::regprocedure`)).rows[0]).toEqual({ provolatile: 's', owner: 'guard_definer' });
    // runner_revoke gates on current_member_role(): owner/admin may revoke any runner, a member only their own.
    const ownerRunner = await insertRunner(admin, f.accountId, f.a1);
    const memberTarget = await insertRunner(admin, f.accountId, f.a1);
    const own = await insertRunner(admin, f.accountId, f.m1);

    const pidOf = (c: PoolClient): Promise<number> => c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid').then((r) => r.rows[0]!.pid);
    const pids: number[] = [];
    await withTenant(onePool, f.accountId, f.o1, async (c) => {
      pids.push(await pidOf(c));
      await c.query(`SELECT runner_revoke($1, 'revoked')`, [ownerRunner]);
    });
    await expect(
      withTenant(onePool, f.accountId, f.m1, async (c) => {
        pids.push(await pidOf(c));
        await c.query(`SELECT runner_revoke($1, 'revoked')`, [memberTarget]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/may not revoke this runner/) });
    expect(pids[0]).toBe(pids[1]);
    expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [memberTarget])).rows[0].revoked_at).toBeNull();
    // The same member may still revoke their own runner, so the refusal above is about the role, not a broken function.
    await withTenant(onePool, f.accountId, f.m1, (c) => c.query(`SELECT runner_revoke($1, 'revoked')`, [own]));
    expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [own])).rows[0].revoked_at).not.toBeNull();
  });
});

describe('no function used for authorization is owned by platform_ops (repo-wide, 0721)', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await admin.end();
  });

  /**
   * A function counts as an authorization helper when a row-level security policy calls it, or when it is STABLE or
   * IMMUTABLE, SECURITY DEFINER and derives its answer from the caller's session settings (app.account_id, app.user_id,
   * app.partner_id ...), which is the shape whose cached result could be reused by the next caller.
   * ALLOWLIST: entries are security decisions and need the reviewer's sign-off; each says why the owner cannot be moved.
   */
  const ALLOWLIST: ReadonlyArray<{ fn: string; reason: string }> = [
    {
      fn: 'onboarding_live_readonly_installations()',
      reason: 'a tenant-scoped data read for the onboarding screen, not an authorization decision; same class, tracked as a follow-up',
    },
  ];

  async function authorizationFunctions(): Promise<Array<{ fn: string; owner: string; why: string }>> {
    const { rows } = await admin.query(
      `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
              CASE WHEN EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid)
                   THEN 'called by a policy' ELSE 'session-derived stable definer' END AS why
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND (EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid)
               OR (p.prosecdef AND p.provolatile IN ('s', 'i') AND p.prosrc ~ 'current_setting\\(''app\\.'))
        ORDER BY 1`,
    );
    return rows;
  }

  it('finds authorization functions at all (the query is not vacuous) and includes the membership helpers', async () => {
    const all = await authorizationFunctions();
    expect(all.length).toBeGreaterThan(5);
    const names = all.map((r) => r.fn);
    for (const n of ['current_member_role()', 'current_member_user_id()', 'current_member_email()']) {
      expect(names, n).toContain(n);
    }
  });

  it('none is owned by platform_ops', async () => {
    const bad = (await authorizationFunctions()).filter((r) => r.owner === 'platform_ops' && !ALLOWLIST.some((a) => a.fn === r.fn));
    expect(bad).toEqual([]);
  });

  it('every allowlist entry is still needed (no stale exemptions)', async () => {
    const all = await authorizationFunctions();
    for (const a of ALLOWLIST) expect(all.some((r) => r.fn === a.fn), `${a.fn} (${a.reason})`).toBe(true);
  });
});

