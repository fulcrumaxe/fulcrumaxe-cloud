import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { getBudgets, getUsage } from '../src/usage.js';
import { seedAccount } from './helpers/seed.js';

/**
 * D#31 API-7a criterion 1 (and 2's service half). Reading: `spent_usd` is
 * the month's settled ledger sum only and `reserved_usd` is the open
 * reservations only, so `spent + reserved` is the total committed and
 * nothing is counted twice.
 */
describe('getUsage / getBudgets (D#31 API-7a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.SPEND_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.SPEND_DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  async function seedMember(plan: 'starter' | 'scale', repos: number): Promise<{ accountId: string; userId: string }> {
    const accountId = randomUUID();
    const userId = randomUUID();
    await seedAccount(admin, accountId, { plan });
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
      accountId,
      userId,
    ]);
    for (let i = 0; i < repos; i += 1) {
      await admin.query(`INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'web')`, [accountId, i + 1]);
    }
    return { accountId, userId };
  }

  const ledger = (accountId: string, budget: string, usd: number, at: string) =>
    admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, budget, created_at)
       VALUES ($1, $2, 'customer_gateway', $3, $4, $5)`,
      [accountId, budget === 'model' ? 'model' : 'compute', usd, budget, at],
    );
  const reservation = (accountId: string, budget: string, usd: number, state: string) =>
    admin.query(`INSERT INTO spend_reservations (account_id, usd_reserved, state, budget) VALUES ($1, $2, $3, $4)`, [
      accountId,
      usd,
      state,
      budget,
    ]);

  it('every figure equals the hand-computed value on a scale account with 2 repos', async () => {
    const { accountId, userId } = await seedMember('scale', 2);
    await admin.query(`UPDATE accounts SET model_budget_usd_month = 600 WHERE id = $1`, [accountId]);
    // September (the month under test): model 10.50 + 2.25 = 12.75, foreground 3, background 4.1234.
    await ledger(accountId, 'model', 10.5, '2026-09-02T08:00:00Z');
    await ledger(accountId, 'model', 2.25, '2026-09-14T08:00:00Z');
    await ledger(accountId, 'foreground_compute', 3, '2026-09-03T08:00:00Z');
    await ledger(accountId, 'background_compute', 4.1234, '2026-09-04T08:00:00Z');
    // Outside the month: last month's row, and one dated after the period's end.
    await ledger(accountId, 'model', 100, '2026-08-31T23:59:59Z');
    await ledger(accountId, 'model', 7, '2026-10-01T00:00:00Z');
    // Open reservations count (model 5.50 + 1.25 = 6.75, background 2); settled and released never do.
    await reservation(accountId, 'model', 5.5, 'open');
    await reservation(accountId, 'model', 1.25, 'open');
    await reservation(accountId, 'background_compute', 2, 'open');
    await reservation(accountId, 'model', 9, 'settled');
    await reservation(accountId, 'foreground_compute', 8, 'released');

    const usage = await getUsage({ pool: appUserPool, principal: { accountId, userId } }, {
      now: new Date('2026-09-15T12:00:00Z'),
    });
    // Scale limits: foreground 71; background 18 + 7 x 2 repos = 32.
    expect(usage).toEqual({
      period_start: '2026-09-01T00:00:00.000Z',
      model: { spent_usd: 12.75, reserved_usd: 6.75, limit_usd: 600 },
      foreground_compute: { spent_usd: 3, reserved_usd: 0, limit_usd: 71 },
      background_compute: { spent_usd: 4.1234, reserved_usd: 2, limit_usd: 32 },
    });
  });

  it('gets the period boundary right at 23:59:59 UTC on the last day and at 00:00:00 UTC on the 1st', async () => {
    const { accountId, userId } = await seedMember('starter', 0);
    await ledger(accountId, 'model', 10, '2026-09-30T23:59:58Z');
    await ledger(accountId, 'model', 20, '2026-10-01T00:00:00Z');
    const ctx = { pool: appUserPool, principal: { accountId, userId } };

    const before = await getUsage(ctx, { now: new Date('2026-09-30T23:59:59Z') });
    expect(before.period_start).toBe('2026-09-01T00:00:00.000Z');
    expect(before.model.spent_usd).toBe(10);

    const after = await getUsage(ctx, { now: new Date('2026-10-01T00:00:00Z') });
    expect(after.period_start).toBe('2026-10-01T00:00:00.000Z');
    expect(after.model.spent_usd).toBe(20);
  });

  it("never reads another account's rows", async () => {
    const mine = await seedMember('starter', 0);
    const other = await seedMember('starter', 0);
    await ledger(other.accountId, 'model', 50, '2026-09-05T00:00:00Z');
    await reservation(other.accountId, 'model', 5, 'open');
    const usage = await getUsage({ pool: appUserPool, principal: mine }, { now: new Date('2026-09-15T00:00:00Z') });
    expect(usage.model).toEqual({ spent_usd: 0, reserved_usd: 0, limit_usd: 0 });
  });

  it('getBudgets: the stored cap, plan-data compute budgets, and a model budget of 0 returned as 0', async () => {
    const { accountId, userId } = await seedMember('starter', 1);
    await admin.query(`UPDATE accounts SET compute_cap_usd_month = 37 WHERE id = $1`, [accountId]);
    expect(await getBudgets({ pool: appUserPool, principal: { accountId, userId } })).toEqual({
      plan: 'starter',
      model_usd_month: 0,
      foreground_compute_usd_month: 17,
      background_compute_usd_month: 9,
      compute_cap_usd_month: 37,
    });
  });
});
