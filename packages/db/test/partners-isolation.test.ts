import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { withPartner } from '../src/withPartner.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2607 P01 pass/fail item 4: two resellers (A, B), one affiliate (C) and
 * a direct account. Partner A must read 0 rows of B's data across every
 * scoped table; an affiliate must read 0 accounts rows at all; a direct
 * account must be invisible to every partner; app.partner_id unset must
 * yield 0 rows (fail closed).
 */
describe('cross-partner isolation', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let partnerUserPool: Pool;
  let appUserPool: Pool;

  let partnerA: string;
  let partnerB: string;
  let partnerC: string;

  let refsA: SeedRefs;
  let refsB: SeedRefs;
  let refsDirect: SeedRefs;

  const TABLES_BY_ACCOUNT: readonly [string, string][] = [
    ['accounts', 'id'],
    ['account_members', 'account_id'],
    ['repos', 'account_id'],
    ['agent_runs', 'account_id'],
    ['ledger', 'account_id'],
  ];
  const TABLES_BY_PARTNER: readonly [string, string][] = [
    ['partner_branding', 'partner_id'],
    ['partner_domains', 'partner_id'],
    ['partner_retail_prices', 'partner_id'],
    ['partner_escalations', 'partner_id'],
  ];

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);

    partnerA = randomUUID();
    partnerB = randomUUID();
    partnerC = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES
         ($1, 'reseller', 'active', 'Reseller A'),
         ($2, 'reseller', 'active', 'Reseller B'),
         ($3, 'affiliate', 'active', 'Affiliate C')`,
      [partnerA, partnerB, partnerC],
    );

    refsA = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerA,
      refsA.accountId,
    ]);
    refsB = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerB,
      refsB.accountId,
    ]);
    refsDirect = await seedAccount(admin, randomUUID());

    for (const [partnerId, refs] of [
      [partnerA, refsA],
      [partnerB, refsB],
    ] as const) {
      await admin.query(
        `INSERT INTO partner_branding (partner_id, product_name) VALUES ($1, $2)`,
        [partnerId, `Product ${partnerId}`],
      );
      await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
        partnerId,
        `${partnerId}.example.test`,
      ]);
      await admin.query(
        `INSERT INTO partner_retail_prices (partner_id, product, plan, retail_usd) VALUES ($1, 'hosted', 'starter', 99.00)`,
        [partnerId],
      );
      await admin.query(
        `INSERT INTO partner_escalations (partner_id, account_id, subject, body) VALUES ($1, $2, 'help', 'body')`,
        [partnerId, refs.accountId],
      );
    }
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await partnerUserPool.end();
    await appUserPool.end();
  });

  it("partner A reads its own account-scoped rows and 0 of partner B's", async () => {
    await withPartner(partnerUserPool, partnerA, async (client) => {
      for (const [table, col] of TABLES_BY_ACCOUNT) {
        const own = await client.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [
          refsA.accountId,
        ]);
        expect(own.rows.length).toBeGreaterThan(0);

        const foreign = await client.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [
          refsB.accountId,
        ]);
        expect(foreign.rows).toEqual([]);
      }
    });
  });

  it("partner A reads its own partner-scoped rows and 0 of partner B's", async () => {
    await withPartner(partnerUserPool, partnerA, async (client) => {
      for (const [table, col] of TABLES_BY_PARTNER) {
        const own = await client.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [partnerA]);
        expect(own.rows.length).toBeGreaterThan(0);

        const foreign = await client.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [
          partnerB,
        ]);
        expect(foreign.rows).toEqual([]);
      }
    });
  });

  it('a direct account (no partner) is invisible to every partner', async () => {
    for (const partnerId of [partnerA, partnerB]) {
      await withPartner(partnerUserPool, partnerId, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM accounts WHERE id = $1', [
          refsDirect.accountId,
        ]);
        expect(rows).toEqual([]);
      });
    }
  });

  it('an affiliate session reads 0 accounts rows, even for an account it referred', async () => {
    const referred = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET referred_by_partner_id = $1 WHERE id = $2', [
      partnerC,
      referred.accountId,
    ]);

    await withPartner(partnerUserPool, partnerC, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM accounts');
      expect(rows).toEqual([]);
    });
  });

  it('app.partner_id unset yields 0 rows (fail closed)', async () => {
    const client = await partnerUserPool.connect();
    try {
      const { rows } = await client.query('SELECT 1 FROM accounts WHERE id = $1', [
        refsA.accountId,
      ]);
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('as app_user, setting app.partner_id changes nothing: still only its own account, 0 partner rows (re-asserts X1)', async () => {
    const client = await appUserPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', refsA.accountId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.partner_id', partnerB]);
      const { rows } = await client.query('SELECT id FROM accounts');
      expect(rows.map((r) => r.id)).toEqual([refsA.accountId]);
      await client.query('COMMIT');
    } finally {
      await client.query('RESET app.account_id; RESET app.partner_id').catch(() => {});
      client.release();
    }
  });
});

/**
 * D#2607 Spec amendment X-user-id (discussioncomment-18486915), binding on
 * P01: any policy that reads app.user_id must join account_members or
 * partner_members itself, rather than trust the setting.
 */
describe('X-user-id amendment', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let partnerUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await partnerUserPool.end();
  });

  it('every policy whose expression mentions app.user_id also joins account_members or partner_members', async () => {
    const { rows } = await admin.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      withcheck: string | null;
    }>(
      `SELECT tablename, policyname, qual, with_check AS withcheck
       FROM pg_policies WHERE schemaname = 'public'`,
    );

    const offenders: string[] = [];
    for (const row of rows) {
      const expr = `${row.qual ?? ''} ${row.withcheck ?? ''}`;
      if (expr.includes('app.user_id') && !expr.includes('account_members') && !expr.includes('partner_members')) {
        offenders.push(`${row.tablename}.${row.policyname}`);
      }
    }
    // Fails on a deliberately-planted violation, so the check isn't vacuous.
    expect(offenders).toEqual([]);
  });

  it('a policy that mentions app.user_id without a join IS caught (deliberate-failure fixture)', async () => {
    await admin.query(`
      CREATE TABLE x_user_id_violation_fixture (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      ALTER TABLE x_user_id_violation_fixture ENABLE ROW LEVEL SECURITY;
      CREATE POLICY unsafe_trust ON x_user_id_violation_fixture
        USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid);
    `);
    try {
      const { rows } = await admin.query<{ qual: string | null }>(
        `SELECT qual FROM pg_policies WHERE tablename = 'x_user_id_violation_fixture'`,
      );
      const expr = rows[0].qual ?? '';
      const isOffender =
        expr.includes('app.user_id') && !expr.includes('account_members') && !expr.includes('partner_members');
      expect(isOffender).toBe(true);
    } finally {
      await admin.query('DROP TABLE x_user_id_violation_fixture');
    }
  });

  it('setting app.user_id to a non-member does not change what app_user sees or can write (item 2)', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const stranger = randomUUID();

    await withTenant(appUserPool, refs.accountId, stranger, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM account_members WHERE account_id = $1', [
        refs.accountId,
      ]);
      // Unchanged from the no-user_id baseline in with-tenant.test.ts /
      // account_members' own policy: still exactly the seeded rows for this
      // account, nothing added or removed by the bogus app.user_id.
      expect(rows.length).toBeGreaterThan(0);

      // D#76 retarget: app_user's audit_log INSERT grant is gone entirely
      // now (writes go through audit_write()), so this probe can no
      // longer use audit_log to prove its point. `ledger` still allows an
      // ordinary app_user INSERT the same way audit_log used to, so it's
      // the one that keeps this test's actual purpose: a non-member
      // app.user_id changes nothing about what app_user can write.
      await expect(
        client.query(
          `INSERT INTO ledger (account_id, kind, source, usd) VALUES ($1, 'model', 'sandbox', 0.01)`,
          [refs.accountId],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('partner_user has no direct privilege on support_grants regardless of app.user_id/app.partner_id (item 3)', async () => {
    const partnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'X')`,
      [partnerId],
    );
    await withPartner(partnerUserPool, partnerId, randomUUID(), async (client) => {
      await expect(client.query('SELECT 1 FROM support_grants LIMIT 1')).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });
  });

  it('support_access_log INSERT is rejected when app.user_id names a member of a DIFFERENT partner than app.partner_id (item 3)', async () => {
    const partnerA = randomUUID();
    const partnerB = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'A'), ($2, 'reseller', 'active', 'B')`,
      [partnerA, partnerB],
    );
    const refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerB,
      refs.accountId,
    ]);

    // A real member of partner A only.
    const memberOfA = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      memberOfA,
      `${memberOfA}@example.test`,
    ]);
    await admin.query(`INSERT INTO partner_members (partner_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      partnerA,
      memberOfA,
    ]);

    // A grant from the account to partner B (its own reseller).
    const grantId = randomUUID();
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
       VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes')`,
      [grantId, refs.accountId, partnerB, refs.userId],
    );

    // Claim to be memberOfA while sessioned as partner B -- no partner_members
    // row has (partnerB, memberOfA), so the join in the policy must reject this,
    // even though the grant itself is valid and for the right account.
    await withPartner(partnerUserPool, partnerB, memberOfA, async (client) => {
      await expect(
        client.query(
          `INSERT INTO support_access_log (grant_id, account_id, actor_user_id, path) VALUES ($1, $2, $3, '/runs')`,
          [grantId, refs.accountId, memberOfA],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    // Sanity: the SAME member, sessioned as their OWN partner (A) with a
    // matching grant, succeeds -- proving the rejection above is about the
    // partner_id/user_id mismatch, not some other error.
    const grantForA = randomUUID();
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerA,
      refs.accountId,
    ]);
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
       VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes')`,
      [grantForA, refs.accountId, partnerA, refs.userId],
    );
    await withPartner(partnerUserPool, partnerA, memberOfA, async (client) => {
      await expect(
        client.query(
          `INSERT INTO support_access_log (grant_id, account_id, actor_user_id, path) VALUES ($1, $2, $3, '/runs')`,
          [grantForA, refs.accountId, memberOfA],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('run_events: partner reads under its own grant, 0 rows for another partner, 0 for no/expired/revoked grant (item 3)', async () => {
    const partnerId = randomUUID();
    const otherPartnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Grantee'), ($2, 'reseller', 'active', 'Other')`,
      [partnerId, otherPartnerId],
    );
    const refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerId,
      refs.accountId,
    ]);

    // No grant yet.
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows).toEqual([]);
    });

    // Expired grant.
    const expiredGrant = randomUUID();
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, created_at, expires_at)
       VALUES ($1, $2, 'partner', $3, $4, now() - interval '2 hours', now() - interval '1 hour')`,
      [expiredGrant, refs.accountId, partnerId, refs.userId],
    );
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows).toEqual([]);
    });

    // Revoked grant.
    const revokedGrant = randomUUID();
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at, revoked_at)
       VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes', now())`,
      [revokedGrant, refs.accountId, partnerId, refs.userId],
    );
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows).toEqual([]);
    });

    // Active grant for THIS partner: reads succeed.
    const activeGrant = randomUUID();
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
       VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes')`,
      [activeGrant, refs.accountId, partnerId, refs.userId],
    );
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });

    // Same active grant, but read from the OTHER partner's session: 0 rows.
    await withPartner(partnerUserPool, otherPartnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows).toEqual([]);
    });
  });

  // D#2607 P01 fix-round finding 3: has_active_support_grant() only ever
  // checked the grant row itself. If platform_ops moved the account to a
  // DIFFERENT partner (or soft-deleted it) while the grant was still
  // active, the ORIGINAL partner kept reading run_events until the grant's
  // own expiry -- up to 60 more minutes. Reproduces the reviewer's exact
  // repro: grant active, then account moved.
  it('a former partner reads 0 run_events after the account moves to a different partner, even with an active grant (finding 3)', async () => {
    const partnerId = randomUUID();
    const newOwnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Former'), ($2, 'reseller', 'active', 'NewOwner')`,
      [partnerId, newOwnerId],
    );
    const refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerId,
      refs.accountId,
    ]);

    const activeGrant = randomUUID();
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
       VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes')`,
      [activeGrant, refs.accountId, partnerId, refs.userId],
    );

    // Grant is active and the partner still owns the account: reads succeed.
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });

    // The account moves to a different partner. The grant row itself is
    // untouched -- still active, still names the FORMER partner.
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      newOwnerId,
      refs.accountId,
    ]);

    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows).toEqual([]);
    });
  });

  it('0 run_events for an active grant once the account is soft-deleted (finding 3)', async () => {
    const partnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'SoftDel')`,
      [partnerId],
    );
    const refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
      partnerId,
      refs.accountId,
    ]);
    const activeGrant = randomUUID();
    await admin.query(
      `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
       VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes')`,
      [activeGrant, refs.accountId, partnerId, refs.userId],
    );

    await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [refs.accountId]);

    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows).toEqual([]);
    });
  });
});

/**
 * D#2607 P01 fix-round finding 5: has_active_support_grant, support_grant_matches
 * and partner_account_visible now derive app.partner_id from the session
 * instead of taking it as a parameter, closing the cross-partner-oracle
 * shape (any partner id could previously be passed as an argument from any
 * partner's own session).
 */
describe('SECURITY DEFINER helpers derive partner id from the session (finding 5)', () => {
  let adminPool: Pool;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('has_active_support_grant, support_grant_matches and partner_account_visible take no partner-id argument', async () => {
    const { rows } = await adminPool.query<{ proname: string; pronargs: number }>(
      `SELECT proname, pronargs FROM pg_proc
       WHERE proname IN ('has_active_support_grant', 'support_grant_matches', 'partner_account_visible')
         AND pronamespace = 'public'::regnamespace`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r.pronargs]));
    // has_active_support_grant(target_account_id), partner_account_visible(target_account_id)
    expect(byName.has_active_support_grant).toBe(1);
    expect(byName.partner_account_visible).toBe(1);
    // support_grant_matches(target_grant_id, target_account_id)
    expect(byName.support_grant_matches).toBe(2);
  });
});

/**
 * D#2607 P01 fix-round finding 2: partner_domains carried a blanket
 * UPDATE grant, so a partner could self-verify a domain, repoint an
 * already-verified hostname, or reverse a platform takedown. Partners may
 * now only create unverified rows -- no UPDATE grant at all, and INSERT is
 * column-scoped to (partner_id, hostname, txt_token_hash).
 */
describe('partner_domains write restrictions (finding 2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let partnerUserPool: Pool;
  let partnerId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);

    partnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Domain Partner')`,
      [partnerId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await partnerUserPool.end();
  });

  it('a partner can create an unverified row (the one thing it is allowed to do)', async () => {
    await withPartner(partnerUserPool, partnerId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2) RETURNING txt_verified_at, vercel_state`,
        [partnerId, `create-ok-${randomUUID()}.example.test`],
      );
      expect(rows[0].txt_verified_at).toBeNull();
      expect(rows[0].vercel_state).toBeNull();
    });
  });

  it('a partner cannot set verified on INSERT (column not in its grant)', async () => {
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        await client.query(
          `INSERT INTO partner_domains (partner_id, hostname, txt_verified_at) VALUES ($1, $2, now())`,
          [partnerId, `create-verified-${randomUUID()}.example.test`],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a partner cannot self-verify an existing row (no UPDATE grant at all)', async () => {
    const hostname = `verify-${randomUUID()}.example.test`;
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      partnerId,
      hostname,
    ]);
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        await client.query(
          `UPDATE partner_domains SET txt_verified_at = now() WHERE hostname = $1`,
          [hostname],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a partner cannot repoint an already-verified row\'s hostname', async () => {
    const hostname = `verified-${randomUUID()}.example.test`;
    await admin.query(
      `INSERT INTO partner_domains (partner_id, hostname, txt_verified_at) VALUES ($1, $2, now())`,
      [partnerId, hostname],
    );
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        await client.query(`UPDATE partner_domains SET hostname = $1 WHERE hostname = $2`, [
          `stolen-${randomUUID()}.example.test`,
          hostname,
        ]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a partner cannot clear a platform takedown', async () => {
    const hostname = `takendown-${randomUUID()}.example.test`;
    await admin.query(
      `INSERT INTO partner_domains (partner_id, hostname, txt_verified_at, vercel_state, detached_at)
       VALUES ($1, $2, now(), 'suspended', now())`,
      [partnerId, hostname],
    );
    await expect(
      withPartner(partnerUserPool, partnerId, async (client) => {
        await client.query(
          `UPDATE partner_domains SET detached_at = NULL, vercel_state = 'attached' WHERE hostname = $1`,
          [hostname],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const { rows } = await admin.query(
      `SELECT detached_at, vercel_state FROM partner_domains WHERE hostname = $1`,
      [hostname],
    );
    expect(rows[0].detached_at).not.toBeNull();
    expect(rows[0].vercel_state).toBe('suspended');
  });
});

/**
 * D#2607 P01 fix-round finding 4: hostname uniqueness is now a partial
 * unique index scoped to verified rows, and a partner may DELETE its own
 * still-unverified rows (only those).
 */
describe('partner_domains squatting and delete (finding 4)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let partnerUserPool: Pool;
  let squatterId: string;
  let ownerId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    squatterId = randomUUID();
    ownerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Squatter'), ($2, 'reseller', 'active', 'Owner')`,
      [squatterId, ownerId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await partnerUserPool.end();
  });

  it('an unverified squat on a hostname does not block the real owner\'s verified claim', async () => {
    const hostname = `contested-${randomUUID()}.example.test`;

    // The squatter claims it first, unverified.
    await withPartner(partnerUserPool, squatterId, async (client) => {
      await client.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
        squatterId,
        hostname,
      ]);
    });

    // The real owner also inserts an unverified row for the SAME hostname
    // -- pre-fix this would have been a UNIQUE violation on insert.
    await withPartner(partnerUserPool, ownerId, async (client) => {
      await expect(
        client.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
          ownerId,
          hostname,
        ]),
      ).resolves.toBeDefined();
    });

    // platform_ops verifies the real owner's row -- succeeds, since no
    // OTHER verified row exists yet for this hostname.
    await expect(
      admin.query(
        `UPDATE partner_domains SET txt_verified_at = now() WHERE partner_id = $1 AND hostname = $2`,
        [ownerId, hostname],
      ),
    ).resolves.toBeDefined();

    const { rows } = await admin.query(
      `SELECT partner_id, txt_verified_at FROM partner_domains WHERE hostname = $1 ORDER BY partner_id`,
      [hostname],
    );
    const verifiedRow = rows.find((r) => r.txt_verified_at !== null);
    expect(verifiedRow.partner_id).toBe(ownerId);
  });

  it('once one row for a hostname is verified, verifying a SECOND row for the same hostname is a unique violation', async () => {
    const hostname = `race-${randomUUID()}.example.test`;
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      squatterId,
      hostname,
    ]);
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      ownerId,
      hostname,
    ]);
    await admin.query(
      `UPDATE partner_domains SET txt_verified_at = now() WHERE partner_id = $1 AND hostname = $2`,
      [ownerId, hostname],
    );
    await expect(
      admin.query(
        `UPDATE partner_domains SET txt_verified_at = now() WHERE partner_id = $1 AND hostname = $2`,
        [squatterId, hostname],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('a partner can delete its own unverified row', async () => {
    const hostname = `mine-unverified-${randomUUID()}.example.test`;
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      squatterId,
      hostname,
    ]);
    await withPartner(partnerUserPool, squatterId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM partner_domains WHERE partner_id = $1 AND hostname = $2`,
        [squatterId, hostname],
      );
      expect(rowCount).toBe(1);
    });
    const { rows } = await admin.query(`SELECT 1 FROM partner_domains WHERE hostname = $1`, [
      hostname,
    ]);
    expect(rows).toEqual([]);
  });

  it('a partner cannot delete ANOTHER partner\'s unverified row', async () => {
    const hostname = `theirs-unverified-${randomUUID()}.example.test`;
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      ownerId,
      hostname,
    ]);
    await withPartner(partnerUserPool, squatterId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM partner_domains WHERE partner_id = $1 AND hostname = $2`,
        [ownerId, hostname],
      );
      // RLS silently filters out the row rather than erroring -- 0 rows
      // affected, not a permission error, since squatterId DOES have the
      // DELETE grant, just not a matching row under its own USING clause.
      expect(rowCount).toBe(0);
    });
    const { rows } = await admin.query(`SELECT 1 FROM partner_domains WHERE hostname = $1`, [
      hostname,
    ]);
    expect(rows.length).toBe(1);
  });

  it('a partner cannot delete its own ALREADY-VERIFIED row', async () => {
    const hostname = `mine-verified-${randomUUID()}.example.test`;
    await admin.query(
      `INSERT INTO partner_domains (partner_id, hostname, txt_verified_at) VALUES ($1, $2, now())`,
      [squatterId, hostname],
    );
    await withPartner(partnerUserPool, squatterId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM partner_domains WHERE partner_id = $1 AND hostname = $2`,
        [squatterId, hostname],
      );
      expect(rowCount).toBe(0);
    });
    const { rows } = await admin.query(`SELECT 1 FROM partner_domains WHERE hostname = $1`, [
      hostname,
    ]);
    expect(rows.length).toBe(1);
  });

  // D#2607 P01 merge-round finding S2: the delete policy's `txt_verified_at
  // IS NULL` leg alone let a partner remove a row platform_ops had already
  // ATTACHED but not yet verified -- attached_at is platform-only to set,
  // but nothing stopped the partner from unilaterally deleting the row out
  // from under an in-progress attach. Reproduces the reviewer's exact
  // repro: unverified + attached, still rejected.
  it('a partner cannot delete its own unverified row once it has been ATTACHED (finding S2)', async () => {
    const hostname = `mine-attached-unverified-${randomUUID()}.example.test`;
    await admin.query(
      `INSERT INTO partner_domains (partner_id, hostname, attached_at) VALUES ($1, $2, now())`,
      [squatterId, hostname],
    );
    await withPartner(partnerUserPool, squatterId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM partner_domains WHERE partner_id = $1 AND hostname = $2`,
        [squatterId, hostname],
      );
      expect(rowCount).toBe(0);
    });
    const { rows } = await admin.query(`SELECT 1 FROM partner_domains WHERE hostname = $1`, [
      hostname,
    ]);
    expect(rows.length).toBe(1);
  });

  it('a partner CAN still delete its own unverified, UNATTACHED row (attached_at leg does not overreach)', async () => {
    const hostname = `mine-unattached-unverified-${randomUUID()}.example.test`;
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      squatterId,
      hostname,
    ]);
    await withPartner(partnerUserPool, squatterId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM partner_domains WHERE partner_id = $1 AND hostname = $2`,
        [squatterId, hostname],
      );
      expect(rowCount).toBe(1);
    });
    const { rows } = await admin.query(`SELECT 1 FROM partner_domains WHERE hostname = $1`, [
      hostname,
    ]);
    expect(rows).toEqual([]);
  });
});

/**
 * D#2607 P01 merge-round finding W1: hostname must be canonical form --
 * lowercase, no trailing dot, no surrounding whitespace. Punycode labels
 * (xn--...) are ordinary lowercase-alnum-hyphen hostname characters and
 * pass through unchanged. Reproduces the reviewer's three rejected
 * variants plus the accepted punycode case.
 */
describe('partner_domains canonical hostname CHECK (finding W1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let partnerId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    partnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Hostname Partner')`,
      [partnerId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it.each([
    ['uppercase letters', (u: string) => `Upper-${u}.Example.test`],
    ['a trailing dot', (u: string) => `dot-${u}.example.test.`],
    ['surrounding whitespace', (u: string) => ` space-${u}.example.test `],
  ])('rejects a hostname with %s', async (_label, makeHostname) => {
    const hostname = makeHostname(randomUUID());
    await expect(
      admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
        partnerId,
        hostname,
      ]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('accepts a lowercase punycode hostname', async () => {
    const hostname = `xn--nxasmq6b-${randomUUID().slice(0, 8)}.example.test`;
    await expect(
      admin.query(
        `INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2) RETURNING hostname`,
        [partnerId, hostname],
      ),
    ).resolves.toMatchObject({ rows: [{ hostname }] });
  });
});

/**
 * D#2607 P01 merge-round finding W2: a UNIQUE index on txt_token_hash means
 * a copycat row can never carry the real owner's verification hash, even
 * before P05 moves token generation server-side. Defence in depth: two
 * DIFFERENT hostnames, same hash, second insert must fail.
 */
describe('partner_domains txt_token_hash uniqueness (finding W2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let ownerId: string;
  let copycatId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    ownerId = randomUUID();
    copycatId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Owner'), ($2, 'reseller', 'active', 'Copycat')`,
      [ownerId, copycatId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it('a copycat row cannot carry the real owner\'s txt_token_hash', async () => {
    const sharedHash = `hash-${randomUUID()}`;
    await admin.query(
      `INSERT INTO partner_domains (partner_id, hostname, txt_token_hash) VALUES ($1, $2, $3)`,
      [ownerId, `owner-${randomUUID()}.example.test`, sharedHash],
    );
    await expect(
      admin.query(
        `INSERT INTO partner_domains (partner_id, hostname, txt_token_hash) VALUES ($1, $2, $3)`,
        [copycatId, `copycat-${randomUUID()}.example.test`, sharedHash],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('two rows with NO token yet (NULL) do not collide with each other', async () => {
    await admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
      ownerId,
      `no-token-a-${randomUUID()}.example.test`,
    ]);
    await expect(
      admin.query(`INSERT INTO partner_domains (partner_id, hostname) VALUES ($1, $2)`, [
        copycatId,
        `no-token-b-${randomUUID()}.example.test`,
      ]),
    ).resolves.toBeDefined();
  });
});
