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

  const ledger = (accountId: string, budget: string, usd: number, at: string, runId: string | null = null) =>
    admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, budget, created_at, run_id)
       VALUES ($1, $2, 'customer_gateway', $3, $4, $5, $6)`,
      [accountId, budget === 'model' ? 'model' : 'compute', usd, budget, at, runId],
    );
  const reservation = (accountId: string, budget: string, usd: number, state: string) =>
    admin.query(`INSERT INTO spend_reservations (account_id, usd_reserved, state, budget) VALUES ($1, $2, $3, $4)`, [
      accountId,
      usd,
      state,
      budget,
    ]);
  /** A bare agent_runs row of the given role, enough to hang a ledger or runner_run_usage row on. */
  const seedRunOfRole = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, $3, 'local', 'succeeded')`, [
      id,
      accountId,
      role,
    ]);
    return id;
  };
  const runnerUsage = (accountId: string, runId: string, apiEquivalentUsd: number, at: string) =>
    admin.query(
      `INSERT INTO runner_run_usage (account_id, run_id, runner_id, credential_mode, api_equivalent_usd, price_table_version, recorded_at)
       VALUES ($1, $2, $3, 'subscription', $4, 'v1', $5)`,
      [accountId, runId, randomUUID(), apiEquivalentUsd, at],
    );

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
      own_plan_api_equivalent_usd: 0,
      role_breakdown: [],
      compute_notice: null,
    });
  });

  describe('role_breakdown', () => {
    it('criterion 1: two roles, spend summed per role, ordered biggest spend first, every other figure untouched', async () => {
      const { accountId, userId } = await seedMember('scale', 2);
      await admin.query(`UPDATE accounts SET model_budget_usd_month = 600 WHERE id = $1`, [accountId]);
      const execRun1 = await seedRunOfRole(accountId, 'executor');
      const execRun2 = await seedRunOfRole(accountId, 'executor');
      const reviewRun = await seedRunOfRole(accountId, 'code-reviewer');
      await ledger(accountId, 'model', 10.5, '2026-09-02T08:00:00Z', execRun1);
      await ledger(accountId, 'model', 2.25, '2026-09-14T08:00:00Z', execRun2);
      await ledger(accountId, 'model', 4, '2026-09-05T08:00:00Z', reviewRun);

      const usage = await getUsage({ pool: appUserPool, principal: { accountId, userId } }, {
        now: new Date('2026-09-15T12:00:00Z'),
      });
      expect(usage.role_breakdown).toEqual([
        { role: 'executor', runs: 2, spend_usd: 12.75, own_plan_api_equivalent_usd: 0 },
        { role: 'code-reviewer', runs: 1, spend_usd: 4, own_plan_api_equivalent_usd: 0 },
      ]);
      expect(usage.model.spent_usd).toBe(16.75);
      expect(usage.foreground_compute).toEqual({ spent_usd: 0, reserved_usd: 0, limit_usd: 71 });
      expect(usage.background_compute).toEqual({ spent_usd: 0, reserved_usd: 0, limit_usd: 32 });
      expect(usage.period_start).toBe('2026-09-01T00:00:00.000Z');
      expect(usage.own_plan_api_equivalent_usd).toBe(0);
      expect(usage.compute_notice).toBe(null);
    });

    it('criterion 2: a role with only runner_run_usage rows has spend_usd 0 and own_plan summed, never in a budget', async () => {
      const { accountId, userId } = await seedMember('starter', 0);
      const run1 = await seedRunOfRole(accountId, 'code-reviewer');
      const run2 = await seedRunOfRole(accountId, 'code-reviewer');
      await runnerUsage(accountId, run1, 3.5, '2026-09-10T00:00:00Z');
      await runnerUsage(accountId, run2, 1.25, '2026-09-11T00:00:00Z');

      const usage = await getUsage({ pool: appUserPool, principal: { accountId, userId } }, {
        now: new Date('2026-09-15T00:00:00Z'),
      });
      expect(usage.role_breakdown).toEqual([{ role: 'code-reviewer', runs: 2, spend_usd: 0, own_plan_api_equivalent_usd: 4.75 }]);
      expect(usage.own_plan_api_equivalent_usd).toBe(4.75);
      expect(usage.model.spent_usd).toBe(0);
      expect(usage.foreground_compute.spent_usd).toBe(0);
      expect(usage.background_compute.spent_usd).toBe(0);
    });

    it('criterion 3: a ledger row with no run_id is in the budget total but in no role_breakdown row', async () => {
      const { accountId, userId } = await seedMember('starter', 0);
      const run1 = await seedRunOfRole(accountId, 'executor');
      await ledger(accountId, 'model', 5, '2026-09-05T00:00:00Z', run1);
      await ledger(accountId, 'model', 3, '2026-09-06T00:00:00Z'); // no run_id: a workflow row, say

      const usage = await getUsage({ pool: appUserPool, principal: { accountId, userId } }, {
        now: new Date('2026-09-15T00:00:00Z'),
      });
      expect(usage.model.spent_usd).toBe(8);
      expect(usage.role_breakdown).toEqual([{ role: 'executor', runs: 1, spend_usd: 5, own_plan_api_equivalent_usd: 0 }]);
      const breakdownTotal = usage.role_breakdown.reduce((s, r) => s + r.spend_usd, 0);
      const budgetTotal = usage.model.spent_usd + usage.foreground_compute.spent_usd + usage.background_compute.spent_usd;
      expect(breakdownTotal).toBeLessThan(budgetTotal);
    });

    it('criterion 4: ordered by spend desc, then own_plan desc, then role asc, the same way on a repeated read', async () => {
      const { accountId, userId } = await seedMember('starter', 0);
      const cRun = await seedRunOfRole(accountId, 'c-role');
      const aRun = await seedRunOfRole(accountId, 'a-role');
      const bRun = await seedRunOfRole(accountId, 'b-role');
      const dRun = await seedRunOfRole(accountId, 'd-role');
      const eRun = await seedRunOfRole(accountId, 'e-role');
      await ledger(accountId, 'model', 10, '2026-09-05T00:00:00Z', cRun);
      await ledger(accountId, 'model', 5, '2026-09-05T00:00:00Z', aRun);
      await ledger(accountId, 'model', 5, '2026-09-05T00:00:00Z', bRun);
      await ledger(accountId, 'model', 5, '2026-09-05T00:00:00Z', dRun);
      await ledger(accountId, 'model', 5, '2026-09-05T00:00:00Z', eRun);
      await runnerUsage(accountId, dRun, 2, '2026-09-06T00:00:00Z'); // ties d-role with a/b/e on spend; own_plan breaks the tie

      const ctx = { pool: appUserPool, principal: { accountId, userId } };
      const order = (u: Awaited<ReturnType<typeof getUsage>>) => u.role_breakdown.map((r) => r.role);
      const expected = ['c-role', 'd-role', 'a-role', 'b-role', 'e-role'];
      expect(order(await getUsage(ctx, { now: new Date('2026-09-15T00:00:00Z') }))).toEqual(expected);
      expect(order(await getUsage(ctx, { now: new Date('2026-09-15T00:00:00Z') }))).toEqual(expected);
    });

    it('criterion 5: the same UTC month boundary as the budgets', async () => {
      const { accountId, userId } = await seedMember('starter', 0);
      const before = await seedRunOfRole(accountId, 'executor');
      const inMonth = await seedRunOfRole(accountId, 'executor');
      const after = await seedRunOfRole(accountId, 'executor');
      await ledger(accountId, 'model', 100, '2026-08-31T23:59:59Z', before);
      await ledger(accountId, 'model', 10, '2026-09-01T00:00:00Z', inMonth);
      await ledger(accountId, 'model', 7, '2026-10-01T00:00:00Z', after);

      const usage = await getUsage({ pool: appUserPool, principal: { accountId, userId } }, {
        now: new Date('2026-09-15T12:00:00Z'),
      });
      expect(usage.role_breakdown).toEqual([{ role: 'executor', runs: 1, spend_usd: 10, own_plan_api_equivalent_usd: 0 }]);
    });

    it("criterion 6: an account with no runs answers [], and never another account's runs", async () => {
      const mine = await seedMember('starter', 0);
      const other = await seedMember('starter', 0);
      const otherRun = await seedRunOfRole(other.accountId, 'executor');
      await ledger(other.accountId, 'model', 50, '2026-09-05T00:00:00Z', otherRun);

      const usage = await getUsage({ pool: appUserPool, principal: mine }, { now: new Date('2026-09-15T00:00:00Z') });
      expect(usage.role_breakdown).toEqual([]);
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
