import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withPartner } from '../src/withPartner.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2607 (partner hook) X1 refinement: partners.status is
 * pending|active|suspended -- 'pending' is a reseller application awaiting
 * approval. Platform-wide table: only platform_ops has any grant or policy
 * on it; app_user gets nothing.
 */
describe('partners table', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  let appUserPool: Pool;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  it("platform_ops can create a 'pending' reseller application", async () => {
    const id = randomUUID();
    await platformOpsPool.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'pending', 'New Reseller')`,
      [id],
    );
    const { rows } = await platformOpsPool.query('SELECT status FROM partners WHERE id = $1', [
      id,
    ]);
    expect(rows[0].status).toBe('pending');
  });

  it('an invalid status is rejected by the CHECK constraint', async () => {
    await expect(
      platformOpsPool.query(
        `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'affiliate', 'archived', 'X')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('an invalid kind is rejected by the CHECK constraint', async () => {
    await expect(
      platformOpsPool.query(
        `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'wholesaler', 'active', 'X')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('app_user has no privileges on partners at all', async () => {
    await expect(
      appUserPool.query(`SELECT 1 FROM partners LIMIT 1`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('partners has RLS enabled and forced, scoped TO platform_ops only', async () => {
    const { rows } = await adminPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = 'partners'`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const { rows: policies } = await adminPool.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partners'`,
    );
    // D#2607 P01 adds `partner_self` (a partner session may read its own
    // row) alongside H02/X1's original platform_ops-only policy.
    expect(policies.map((p) => p.policyname).sort()).toEqual(
      ['partner_self', 'platform_ops_full_access'].sort(),
    );
  });
});

/**
 * D#2607 P01. Roles: partner_user and platform_ops, both NOBYPASSRLS,
 * owning no tables -- every row either can touch is reached through an
 * explicit policy in migrations/0200_partners.sql, never ownership.
 */
describe('partner_user role', () => {
  let adminPool: Pool;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('partner_user and platform_ops both have rolbypassrls = false', async () => {
    const { rows } = await adminPool.query<{ rolname: string; rolbypassrls: boolean }>(
      "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('partner_user', 'platform_ops')",
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.rolbypassrls).toBe(false);
    }
  });

  it('partner_user owns no tables', async () => {
    const { rows } = await adminPool.query(
      "SELECT tablename FROM pg_tables WHERE tableowner = 'partner_user'",
    );
    expect(rows).toEqual([]);
  });
});

/**
 * D#2607 P01 pass/fail item 9: withPartner's SET LOCAL settings must not
 * leak to the next pooled connection, on either the success or the error
 * path -- same discipline as test/with-tenant.test.ts asserts for
 * withTenant, kept here (rather than a new file) because withPartner.ts
 * has no dedicated test file in P01's own file scope.
 */
describe('withPartner', () => {
  let pool: Pool;

  beforeAll(() => {
    // max: 1, same reasoning as with-tenant.test.ts: forces every
    // acquisition to reuse the same connection so a leak is directly
    // observable on the very next connect().
    pool = createPool(process.env.DATABASE_URL_PARTNER_USER!, { max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sets app.partner_id and app.user_id for the duration of the callback', async () => {
    const partnerId = randomUUID();
    const userId = randomUUID();
    const seen = await withPartner(pool, partnerId, userId, async (client) => {
      const { rows } = await client.query<{ p: string; u: string }>(
        "SELECT current_setting('app.partner_id', true) AS p, current_setting('app.user_id', true) AS u",
      );
      return rows[0];
    });
    expect(seen).toEqual({ p: partnerId, u: userId });
  });

  it('does not leak app.partner_id to the next pooled connection (success path)', async () => {
    const partnerId = randomUUID();
    await withPartner(pool, partnerId, async () => {});

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.partner_id', true) AS v",
      );
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
      expect(rows[0].v).not.toBe(partnerId);
    } finally {
      client.release();
    }
  });

  it('does not leak app.partner_id to the next pooled connection (error path)', async () => {
    const partnerId = randomUUID();
    await expect(
      withPartner(pool, partnerId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.partner_id', true) AS v",
      );
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
      expect(rows[0].v).not.toBe(partnerId);
    } finally {
      client.release();
    }
  });

  it('RESET in finally also clears a SESSION-level override (same fix as withTenant)', async () => {
    const partnerId = randomUUID();
    const sessionLevelValue = randomUUID();
    await withPartner(pool, partnerId, async (client) => {
      await client.query('SELECT set_config($1, $2, false)', ['app.partner_id', sessionLevelValue]);
    });

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.partner_id', true) AS v",
      );
      expect(rows[0].v).not.toBe(sessionLevelValue);
    } finally {
      client.release();
    }
  });

  it('rejects a non-UUID partnerId before ever acquiring a connection', async () => {
    let fnCalled = false;
    await expect(
      withPartner(pool, 'not-a-uuid', async () => {
        fnCalled = true;
      }),
    ).rejects.toThrow(/uuid/i);
    expect(fnCalled).toBe(false);
  });
});

/**
 * D#2607 P01 fix-round finding 9: withPartner did not check which role it
 * was connected as. Handed the platform_ops pool by mistake, the session
 * would get full access (platform_ops' policies are all USING (true)),
 * silently defeating every partner_id scoping withPartner exists to set up.
 */
describe('withPartner role assertion (finding 9)', () => {
  let partnerUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(() => {
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    await partnerUserPool.end();
    await platformOpsPool.end();
  });

  it('succeeds when connected as partner_user', async () => {
    const partnerId = randomUUID();
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        const { rows } = await client.query('SELECT current_user');
        return rows[0].current_user;
      }),
    ).resolves.toBe('partner_user');
  });

  it('fails closed when handed the platform_ops pool instead', async () => {
    const partnerId = randomUUID();
    let fnCalled = false;
    await expect(
      withPartner(platformOpsPool, partnerId, async () => {
        fnCalled = true;
      }),
    ).rejects.toThrow(/expected to be connected as 'partner_user'/i);
    // The transaction is rolled back before fn ever runs.
    expect(fnCalled).toBe(false);
  });
});

/**
 * D#2607 P01 pass/fail item 2: partner_user's column privileges on shared
 * customer tables, asserted with has_column_privilege / has_table_privilege
 * and pinned by an exact snapshot. See migrations/0200_partners.sql's
 * top-of-file divergence note for the two columns the frozen Spec text
 * named that do not exist in the merged schema (repos.gh_full_name,
 * agent_runs.model) and what was granted in their place.
 */
describe('partner_user column privileges', () => {
  let adminPool: Pool;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('has SELECT on exactly the expected columns of each shared customer table', async () => {
    const EXPECTED: Record<string, string[]> = {
      accounts: ['id', 'plan', 'status', 'created_at', 'partner_id'],
      account_members: ['account_id', 'user_id', 'role'],
      users: ['id', 'email'],
      repos: ['id', 'account_id', 'product', 'gh_repo_id'],
      agent_runs: ['id', 'account_id', 'role', 'status', 'usd', 'created_at'],
      ledger: ['account_id', 'kind', 'usd', 'created_at'],
    };

    const { rows } = await adminPool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.column_privileges
       WHERE grantee = 'partner_user' AND privilege_type = 'SELECT'
         AND table_name IN ('accounts', 'account_members', 'users', 'repos', 'agent_runs', 'ledger')
       ORDER BY table_name, column_name`,
    );

    const actual: Record<string, string[]> = {};
    for (const row of rows) {
      (actual[row.table_name] ??= []).push(row.column_name);
    }
    for (const table of Object.keys(EXPECTED)) {
      expect((actual[table] ?? []).sort()).toEqual([...EXPECTED[table]].sort());
    }
  });

  it('has no privilege at all on model_connections, spend_reservations, installations or audit_log', async () => {
    for (const table of ['model_connections', 'spend_reservations', 'installations', 'audit_log']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await adminPool.query<{ has: boolean }>(
          `SELECT has_table_privilege('partner_user', $1, $2) AS has`,
          [table, priv],
        );
        expect(rows[0].has).toBe(false);
      }
    }
  });

  it('has no privilege on agent_runs.envelope, cc_session_id or sandbox_name', async () => {
    for (const column of ['envelope', 'cc_session_id', 'sandbox_name']) {
      const { rows } = await adminPool.query<{ has: boolean }>(
        `SELECT has_column_privilege('partner_user', 'agent_runs', $1, 'SELECT') AS has`,
        [column],
      );
      expect(rows[0].has).toBe(false);
    }
  });
});

/**
 * D#2607 P01 pass/fail item 7: a trigger rejects accounts.partner_id
 * pointing at an affiliate and referred_by_partner_id pointing at a
 * reseller.
 */
describe('accounts_partner_kind_check trigger', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let refs: SeedRefs;
  let resellerId: string;
  let affiliateId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
    resellerId = randomUUID();
    affiliateId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'R'), ($2, 'affiliate', 'active', 'A')`,
      [resellerId, affiliateId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  it('rejects partner_id pointing at an affiliate', async () => {
    await expect(
      platformOpsPool.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
        affiliateId,
        refs.accountId,
      ]),
    ).rejects.toThrow(/must reference a reseller partner/i);
  });

  it('rejects referred_by_partner_id pointing at a reseller', async () => {
    await expect(
      platformOpsPool.query('UPDATE accounts SET referred_by_partner_id = $1 WHERE id = $2', [
        resellerId,
        refs.accountId,
      ]),
    ).rejects.toThrow(/must reference an affiliate partner/i);
  });

  it('accepts partner_id pointing at a reseller and referred_by_partner_id pointing at an affiliate', async () => {
    const newAccountId = randomUUID();
    // D#69 (migration 0606): no `status` literal here -- this INSERT sets
    // no stripe_customer_id, so the derived (and default) status is
    // 'unsubscribed'; a literal 'active' would now be rejected (security
    // review MUST-fix 4, Spec A5). This test is only about the partner_id/
    // referred_by_partner_id FK checks below, not the resulting status.
    await platformOpsPool.query(
      `INSERT INTO accounts (id, plan, partner_id) VALUES ($1, 'starter', $2)`,
      [newAccountId, resellerId],
    );
    const otherAccountId = randomUUID();
    await platformOpsPool.query(
      `INSERT INTO accounts (id, plan, referred_by_partner_id) VALUES ($1, 'starter', $2)`,
      [otherAccountId, affiliateId],
    );
    const { rows } = await admin.query('SELECT partner_id FROM accounts WHERE id = $1', [
      newAccountId,
    ]);
    expect(rows[0].partner_id).toBe(resellerId);
  });
});

/**
 * D#2607 P01: support_grants' 60-minute CHECK (pass/fail item 3's "grant
 * inserted with a 61-minute expiry -> check violation").
 */
describe('support_grants', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('a 61-minute expiry is a CHECK violation', async () => {
    await expect(
      withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        await client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
           VALUES ($1, 'platform', $2, now() + interval '61 minutes')`,
          [refs.accountId, refs.userId],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('a 60-minute expiry is accepted', async () => {
    await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
           VALUES ($1, 'platform', $2, now() + interval '60 minutes')`,
          [refs.accountId, refs.userId],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('a partner-kind grant must name the account\'s own partner', async () => {
    const partnerId = randomUUID();
    const otherPartnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'R1'), ($2, 'reseller', 'active', 'R2')`,
      [partnerId, otherPartnerId],
    );
    const ownedAccountId = randomUUID();
    // D#69 (migration 0606): no `status` literal -- see the earlier test
    // in this file for why.
    await admin.query(
      `INSERT INTO accounts (id, plan, partner_id) VALUES ($1, 'starter', $2)`,
      [ownedAccountId, partnerId],
    );
    // refs.userId is a real user (from the outer seedAccount call), just
    // not yet a member of ownedAccountId -- fine, this test is only about
    // the trigger's account/partner check, not account_members.

    await expect(
      withTenant(appUserPool, ownedAccountId, refs.userId, async (client) => {
        await client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
           VALUES ($1, 'partner', $2, $3, now() + interval '60 minutes')`,
          [ownedAccountId, otherPartnerId, refs.userId],
        );
      }),
    ).rejects.toThrow(/grantee_partner_id must be the account's own partner/i);
  });

  // D#2607 P01 fix-round finding 1: created_at sat in the tenant's grant,
  // so a forward-dated row satisfied the 60-minute CHECK against a
  // spoofed baseline instead of real time, yielding a ~10-year read.
  // created_at is now forced to server time on INSERT and frozen on
  // UPDATE for app_user (see support_grants_created_at_guard).
  it('a forward-dated created_at no longer extends the 60-minute cap (finding 1)', async () => {
    // Exactly the exploit shape: created_at spoofed 10 years out, expires_at
    // just inside a 60-minute window of THAT spoofed created_at. Pre-fix,
    // the CHECK evaluated against the tenant-supplied created_at and passed,
    // handing back an expires_at ~10 years in the future. Post-fix, the
    // trigger overwrites created_at to real now() before the CHECK runs, so
    // the same statement is now a CHECK violation.
    await expect(
      withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        await client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, created_at, expires_at)
           VALUES ($1, 'platform', $2, now() + interval '10 years', now() + interval '10 years' + interval '59 minutes')`,
          [refs.accountId, refs.userId],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('created_at is server-set: an explicit tenant value is silently overwritten with real time (finding 1)', async () => {
    let insertedId: string;
    // A value that would satisfy the CHECK either way (honored or
    // overwritten) so this isolates the "what got stored" question from
    // the "did the CHECK reject it" question above.
    await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, created_at, expires_at)
         VALUES ($1, 'platform', $2, now() - interval '30 minutes', now() + interval '10 minutes')
         RETURNING id`,
        [refs.accountId, refs.userId],
      );
      insertedId = rows[0].id;
    });
    const { rows } = await admin.query(
      `SELECT created_at, extract(epoch from (now() - created_at)) AS age_seconds
       FROM support_grants WHERE id = $1`,
      [insertedId!],
    );
    // Stored created_at tracks real now(), not the now()-30min the tenant
    // sent -- a 30-minute-old row would show age_seconds ~1800, not ~0.
    expect(Math.abs(Number(rows[0].age_seconds))).toBeLessThan(10);
  });

  it('created_at is immutable for app_user: UPDATE cannot move it (finding 1)', async () => {
    let insertedId: string;
    await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
         VALUES ($1, 'platform', $2, now() + interval '10 minutes') RETURNING id`,
        [refs.accountId, refs.userId],
      );
      insertedId = rows[0].id;
    });
    await expect(
      withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        await client.query(
          `UPDATE support_grants SET created_at = now() + interval '10 years' WHERE id = $1`,
          [insertedId],
        );
      }),
    ).rejects.toThrow(/support_grants: created_at is immutable/i);
  });
});

/**
 * D#2607 P01 pass/fail item 8: partner_suspend_account only ever changes a
 * row when the caller's app.partner_id owns the target account; a
 * cross-partner attempt changes 0 rows and still writes a
 * partner_audit_log row recording the refusal.
 *
 * D#2607 P01 fix-round finding 1: the function now ALSO requires an
 * owner/admin partner_members row for (caller_partner_id, caller_user_id)
 * before touching anything -- see the describe block below this one for
 * the forged/missing-actor cases that finding exists to close.
 */
describe('partner_suspend_account', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let partnerUserPool: Pool;
  let refs: SeedRefs;
  let ownPartnerId: string;
  let otherPartnerId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    ownPartnerId = randomUUID();
    otherPartnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Own'), ($2, 'reseller', 'active', 'Other')`,
      [ownPartnerId, otherPartnerId],
    );
    refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      ownPartnerId,
      refs.accountId,
    ]);
    // refs.userId must be an owner/admin member of ownPartnerId now that
    // finding 1's membership check is in place -- seedAccount only makes
    // it an account_members owner, not a partner_members one.
    await admin.query(
      `INSERT INTO partner_members (partner_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [ownPartnerId, refs.userId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await partnerUserPool.end();
  });

  it('suspends an account the caller\'s partner owns', async () => {
    await withPartner(partnerUserPool, ownPartnerId, refs.userId, async (client) => {
      await client.query('SELECT partner_suspend_account($1)', [refs.accountId]);
    });

    const { rows } = await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [
      refs.accountId,
    ]);
    expect(rows[0].status).toBe('paused');

    const { rows: auditRows } = await admin.query(
      `SELECT action FROM partner_audit_log WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ownPartnerId],
    );
    expect(auditRows[0].action).toBe('suspend_account');

    const { rows: customerAuditRows } = await admin.query(
      `SELECT action FROM audit_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [refs.accountId],
    );
    expect(customerAuditRows[0].action).toBe('partner_suspend');
  });

  it('security review SHOULD-fix 7: a repeat suspend COALESCEs -- the original partner_suspended_at timestamp is kept, not reset', async () => {
    // A dedicated account, not the describe block's shared `refs.accountId`
    // -- other tests in this block also suspend that one, which would
    // pollute both the timestamp and the audit-row count below.
    const target = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [ownPartnerId, target.accountId]);

    await withPartner(partnerUserPool, ownPartnerId, refs.userId, async (client) => {
      await client.query('SELECT partner_suspend_account($1)', [target.accountId]);
    });
    const { rows: firstRows } = await admin.query<{ partner_suspended_at: Date }>(
      'SELECT partner_suspended_at FROM accounts WHERE id = $1',
      [target.accountId],
    );
    const firstSuspendedAt = firstRows[0]!.partner_suspended_at;
    expect(firstSuspendedAt).not.toBeNull();

    // A real clock tick to make a reset (if the fix regressed) detectable.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await withPartner(partnerUserPool, ownPartnerId, refs.userId, async (client) => {
      await client.query('SELECT partner_suspend_account($1)', [target.accountId]);
    });
    const { rows: secondRows } = await admin.query<{ partner_suspended_at: Date }>(
      'SELECT partner_suspended_at FROM accounts WHERE id = $1',
      [target.accountId],
    );
    expect(secondRows[0]!.partner_suspended_at.getTime()).toBe(firstSuspendedAt.getTime());

    // The audit trail still records both calls, even though the
    // timestamp itself did not move on the second one.
    const { rows: auditRows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_audit_log WHERE partner_id = $1 AND action = 'suspend_account' AND payload ->> 'account_id' = $2`,
      [ownPartnerId, target.accountId],
    );
    expect(Number(auditRows[0]!.n)).toBe(2);
  });

  it('refuses to suspend another partner\'s account: 0 rows changed, refusal audited', async () => {
    const victim = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      otherPartnerId,
      victim.accountId,
    ]);

    await withPartner(partnerUserPool, ownPartnerId, refs.userId, async (client) => {
      await client.query('SELECT partner_suspend_account($1)', [victim.accountId]);
    });

    const { rows } = await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [
      victim.accountId,
    ]);
    expect(rows[0].status).toBe('active');

    const { rows: auditRows } = await admin.query(
      `SELECT action, payload FROM partner_audit_log WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ownPartnerId],
    );
    expect(auditRows[0].action).toBe('suspend_account_refused');
    expect(auditRows[0].payload.account_id).toBe(victim.accountId);
  });

  // D#2607 P01 fix-round finding 1: partner_suspend_account used to record
  // whatever app.user_id said as the actor, with no membership check at
  // all -- a forged actor (a real user, just not a member of the caller's
  // partner) was written verbatim into the customer's own audit_log AND
  // into partner_audit_log. Reproduces the reviewer's exact repro shape
  // (session as ownPartnerId, app.user_id set to another partner's owner).
  it('a forged actor (real user, not a member of the caller\'s partner) is refused: 0 rows changed, no audit row at all (finding 1)', async () => {
    // A real user who belongs to a DIFFERENT partner, not ownPartnerId.
    const forgedActorId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      forgedActorId,
      `${forgedActorId}@example.test`,
    ]);
    await admin.query(
      `INSERT INTO partner_members (partner_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [otherPartnerId, forgedActorId],
    );

    const beforeAuditCount = await admin.query(
      `SELECT count(*)::int AS n FROM partner_audit_log WHERE partner_id = $1`,
      [ownPartnerId],
    );
    const beforeCustomerAuditCount = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1`,
      [refs.accountId],
    );

    await expect(
      withPartner(partnerUserPool, ownPartnerId, forgedActorId, async (client) => {
        await client.query('SELECT partner_suspend_account($1)', [refs.accountId]);
      }),
    ).rejects.toThrow(/not an owner\/admin member of partner/i);

    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id = $1',
      [refs.accountId],
    );
    // Unchanged from whatever the account's status was going in (the
    // earlier test in this file already suspended it, so this just proves
    // "unchanged", not "active" specifically).
    expect(rows[0].status).toBe('paused');

    const afterAuditCount = await admin.query(
      `SELECT count(*)::int AS n FROM partner_audit_log WHERE partner_id = $1`,
      [ownPartnerId],
    );
    const afterCustomerAuditCount = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1`,
      [refs.accountId],
    );
    // No audit row of ANY kind -- not even a "refused" one, since that row
    // would itself carry the unverified actor. The whole point of raising
    // before any INSERT/UPDATE is that nothing gets written under a forged
    // identity.
    expect(afterAuditCount.rows[0].n).toBe(beforeAuditCount.rows[0].n);
    expect(afterCustomerAuditCount.rows[0].n).toBe(beforeCustomerAuditCount.rows[0].n);
  });

  it('an unset actor (no app.user_id at all) is refused the same way (finding 1)', async () => {
    await expect(
      withPartner(partnerUserPool, ownPartnerId, async (client) => {
        await client.query('SELECT partner_suspend_account($1)', [refs.accountId]);
      }),
    ).rejects.toThrow(/not an owner\/admin member of partner/i);
  });

  it('a member with role \'support\' (not owner/admin) is refused (finding 1)', async () => {
    const supportUserId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      supportUserId,
      `${supportUserId}@example.test`,
    ]);
    await admin.query(
      `INSERT INTO partner_members (partner_id, user_id, role) VALUES ($1, $2, 'support')`,
      [ownPartnerId, supportUserId],
    );
    await expect(
      withPartner(partnerUserPool, ownPartnerId, supportUserId, async (client) => {
        await client.query('SELECT partner_suspend_account($1)', [refs.accountId]);
      }),
    ).rejects.toThrow(/not an owner\/admin member of partner/i);
  });
});

/**
 * D#2607 P01 fix-round finding 2: the created_at guard was scoped on
 * `current_user = 'app_user'`, which missed any LOGIN role that merely
 * inherits app_user's grants. Reproduces the reviewer's exact fixture: a
 * role that is IN ROLE app_user but is never literally named 'app_user'.
 */
describe('support_grants_created_at_guard: inheriting member roles (finding 2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  let memberPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());

    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_svc') THEN
          CREATE ROLE tenant_svc LOGIN IN ROLE app_user;
        END IF;
      END
      $$;
    `);

    const base = new URL(process.env.DATABASE_URL_APP_USER!);
    base.username = 'tenant_svc';
    memberPool = createPool(base.toString());
  });

  afterAll(async () => {
    await memberPool.end();
    admin.release();
    await adminPool.end();
  });

  it('a forward-dated created_at is rejected for an inheriting member role, same as app_user', async () => {
    await expect(
      withTenant(memberPool, refs.accountId, refs.userId, async (client) => {
        await client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, created_at, expires_at)
           VALUES ($1, 'platform', $2, now() + interval '10 years', now() + interval '10 years' + interval '59 minutes')`,
          [refs.accountId, refs.userId],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('created_at is immutable for an inheriting member role, same as app_user', async () => {
    let insertedId: string;
    await withTenant(memberPool, refs.accountId, refs.userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
         VALUES ($1, 'platform', $2, now() + interval '10 minutes') RETURNING id`,
        [refs.accountId, refs.userId],
      );
      insertedId = rows[0].id;
    });
    await expect(
      withTenant(memberPool, refs.accountId, refs.userId, async (client) => {
        await client.query(`UPDATE support_grants SET created_at = now() + interval '10 years' WHERE id = $1`, [
          insertedId,
        ]);
      }),
    ).rejects.toThrow(/support_grants: created_at is immutable/i);
  });
});

/**
 * D#2607 P01 fix-round finding 8: support_grants.granted_by_user_id used to
 * accept any user id app_user supplied, with no check that it names a real
 * member of the grant's own account.
 */
describe('support_grants.granted_by_user_id integrity (finding 8)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('a granted_by_user_id that is not a member of the grant\'s account is rejected', async () => {
    const stranger = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      stranger,
      `${stranger}@example.test`,
    ]);
    await expect(
      withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        await client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
           VALUES ($1, 'platform', $2, now() + interval '60 minutes')`,
          [refs.accountId, stranger],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a granted_by_user_id that IS a real member of the account is accepted', async () => {
    await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
           VALUES ($1, 'platform', $2, now() + interval '60 minutes')`,
          [refs.accountId, refs.userId],
        ),
      ).resolves.toBeDefined();
    });
  });
});

/**
 * D#2607 P01 fix-round finding 8: partner_escalations' INSERT grant to
 * partner_user is now column-scoped to (partner_id, account_id, subject,
 * body) -- status and created_at are no longer settable by the partner.
 */
describe('partner_escalations column-scoped insert (finding 8)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let partnerUserPool: Pool;
  let partnerId: string;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    partnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Esc Partner')`,
      [partnerId],
    );
    refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerId,
      refs.accountId,
    ]);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await partnerUserPool.end();
  });

  it('an ordinary insert (no status/created_at) succeeds and defaults status to open', async () => {
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO partner_escalations (partner_id, account_id, subject, body)
         VALUES ($1, $2, 'help', 'body') RETURNING status`,
        [partnerId, refs.accountId],
      );
      expect(rows[0].status).toBe('open');
    });
  });

  it('a partner cannot set status on insert (column not in its grant)', async () => {
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        await client.query(
          `INSERT INTO partner_escalations (partner_id, account_id, subject, body, status)
           VALUES ($1, $2, 'help', 'body', 'resolved')`,
          [partnerId, refs.accountId],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a partner cannot set created_at on insert (column not in its grant)', async () => {
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        await client.query(
          `INSERT INTO partner_escalations (partner_id, account_id, subject, body, created_at)
           VALUES ($1, $2, 'help', 'body', now() - interval '30 days')`,
          [partnerId, refs.accountId],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });
});

/**
 * D#2607 P01: support_access_log is append-only -- no UPDATE or DELETE
 * grant to any role, including platform_ops.
 */
describe('support_access_log', () => {
  let adminPool: Pool;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('no role has UPDATE or DELETE on support_access_log', async () => {
    for (const role of ['app_user', 'partner_user', 'platform_ops']) {
      for (const priv of ['UPDATE', 'DELETE']) {
        const { rows } = await adminPool.query<{ has: boolean }>(
          `SELECT has_table_privilege($1, 'support_access_log', $2) AS has`,
          [role, priv],
        );
        expect(rows[0].has).toBe(false);
      }
    }
  });
});
