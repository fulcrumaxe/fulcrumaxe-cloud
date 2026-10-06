import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#2605 H02 security fix round 2, items 4 and 8: billing/lifecycle
 * columns on `accounts` (plan, status, both spend caps, account creation
 * itself, and D#2607's partner_id/referred_by_partner_id) are
 * platform_ops-only. `app_user` gets no INSERT and no UPDATE on `accounts`
 * at all -- there is currently no customer-editable column.
 */
describe('accounts privileges: billing/lifecycle columns are platform_ops-only', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  it('app_user cannot INSERT a new account (no privilege at all)', async () => {
    // Reproduces the confirmed exploit exactly: claim a brand-new,
    // never-before-used id as app.account_id (nothing stops a client from
    // picking any uuid before it has a real account), then insert a row
    // whose id matches it. That satisfies tenant_isolation's WITH CHECK
    // (id = app.account_id) on its own -- inserting a row under SOME OTHER
    // id, as the previous version of this test did, is blocked by RLS
    // regardless of the INSERT grant, and doesn't isolate this fix at all.
    const newAccountId = randomUUID();
    await expect(
      withTenant(appUserPool, newAccountId, async (client) => {
        await client.query(
          `INSERT INTO accounts (id, plan, status) VALUES ($1, 'starter', 'active')`,
          [newAccountId],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('app_user cannot UPDATE plan, status, or either spend cap on its own account', async () => {
    const attempts = [
      `UPDATE accounts SET plan = 'scale' WHERE id = $1`,
      `UPDATE accounts SET status = 'paused' WHERE id = $1`,
      `UPDATE accounts SET model_budget_usd_month = 999999 WHERE id = $1`,
      `UPDATE accounts SET compute_cap_usd_month = 999999 WHERE id = $1`,
    ];
    for (const sql of attempts) {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(sql, [refsA.accountId]);
        }),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  // D#69 B1 (migration 0660): the Stripe subscription columns are written
  // by the webhook (platform_ops) only.
  const SUBSCRIPTION_COLUMN_WRITES: Array<[string, string]> = [
    ['stripe_subscription_id', `'sub_1'`],
    ['stripe_subscription_status', `'active'`],
    ['stripe_cancel_at_period_end', `true`],
    ['stripe_current_period_end', `now()`],
    ['stripe_synced_at', `now()`],
    ['subscription_ended_at', `now()`],
    ['terms_accepted_at', `now()`],
    ['terms_policy_version', `'v1'`],
  ];

  it.each(SUBSCRIPTION_COLUMN_WRITES)('app_user cannot UPDATE %s (42501), platform_ops can', async (column, value) => {
    await expect(
      withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query(`UPDATE accounts SET ${column} = ${value} WHERE id = $1`, [refsA.accountId]);
      }),
    ).rejects.toMatchObject({ code: '42501' });

    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    await expect(
      platformOpsPool.query(`UPDATE accounts SET ${column} = ${value} WHERE id = $1`, [accountId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('app_user cannot write partner_id or referred_by_partner_id (D#2607 item 8)', async () => {
    const partnerId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Acme')`,
      [partnerId],
    );

    await expect(
      withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [
          partnerId,
          refsA.accountId,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query('UPDATE accounts SET referred_by_partner_id = $1 WHERE id = $2', [
          partnerId,
          refsA.accountId,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a partner cannot be both the reseller and the affiliate on the same account (CHECK constraint)', async () => {
    const resellerId = randomUUID();
    const affiliateId = randomUUID();
    await admin.query(
      `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Reseller Co'),
                                                            ($2, 'affiliate', 'active', 'Affiliate Co')`,
      [resellerId, affiliateId],
    );
    await expect(
      platformOpsPool.query(
        `UPDATE accounts SET partner_id = $1, referred_by_partner_id = $2 WHERE id = $3`,
        [resellerId, affiliateId, refsA.accountId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it(
    'app_user cannot DELETE its own account (security fix round 3 warning 2 -- ' +
      'ledger/audit_log must outlive the account they describe, so deletion is platform_ops-only)',
    async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query('DELETE FROM accounts WHERE id = $1', [refsA.accountId]);
        }),
      ).rejects.toThrow(/permission denied/i);

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query('SELECT 1 FROM accounts WHERE id = $1', [
        refsA.accountId,
      ]);
      expect(rows).toHaveLength(1);
    },
  );

  it(
    'platform_ops CANNOT hard-delete an account either (security fix round 4 -- ' +
      'deletion is soft-delete only, see test/account-soft-delete.test.ts)',
    async () => {
      const newAccountId = randomUUID();
      // D#69 (migration 0606): no `status` literal -- no stripe_customer_id
      // here either, so the default/derived 'unsubscribed' already
      // agrees; this test is only about the DELETE privilege below.
      await platformOpsPool.query(
        `INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`,
        [newAccountId],
      );
      await expect(
        platformOpsPool.query('DELETE FROM accounts WHERE id = $1', [newAccountId]),
      ).rejects.toThrow(/permission denied/i);

      const { rows } = await admin.query('SELECT 1 FROM accounts WHERE id = $1', [
        newAccountId,
      ]);
      expect(rows).toHaveLength(1);
    },
  );

  it('platform_ops CAN insert a new account and set plan/caps freely -- and, D#69, drive status only through its markers', async () => {
    const newAccountId = randomUUID();
    await platformOpsPool.query(
      `INSERT INTO accounts (id, plan, model_budget_usd_month, compute_cap_usd_month)
       VALUES ($1, 'team', 500, 200)`,
      [newAccountId],
    );
    // D#69 (migration 0606): status is derived, so plan/caps are still
    // freely writable, but a status transition is now driven by setting
    // past_due_since -- not a literal `status = 'past_due'` write.
    await platformOpsPool.query(
      `UPDATE accounts SET plan = 'scale', past_due_since = now() WHERE id = $1`,
      [newAccountId],
    );

    const { rows } = await platformOpsPool.query<{ plan: string; status: string }>(
      'SELECT plan, status FROM accounts WHERE id = $1',
      [newAccountId],
    );
    expect(rows[0]).toEqual({ plan: 'scale', status: 'past_due' });
  });

  it('D#69: even platform_ops cannot write a `status` literal that disagrees with the derived value (42501)', async () => {
    const newAccountId = randomUUID();
    await platformOpsPool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [newAccountId]);

    await expect(
      platformOpsPool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [newAccountId]),
    ).rejects.toThrow(/derived/i);
  });

  it('platform_ops has BYPASSRLS = false (its access comes from its own explicit policy, not a bypass)', async () => {
    const { rows } = await admin.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'platform_ops'",
    );
    expect(rows[0].rolbypassrls).toBe(false);
  });
});
