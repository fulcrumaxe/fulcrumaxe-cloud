import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { getUsage } from '../src/usage.js';
import { foregroundBudgetUsd, backgroundBudgetUsd, planIds } from '../src/plans.js';
import { COMPUTE_NOTICE_SENTENCES, computeNoticeFor } from '../src/computeNotice.js';
import type { BudgetUsage } from '../src/usage.js';
import type { PlanId } from '../src/types.js';
import { seedAccount } from './helpers/seed.js';

/**
 * D#483 S5-k3 (rule 1 only): the notice at 80% of the compute allowance. S5k3-1 (79 / 80 / 100%), S5k3-3 (a new month) and the derived
 * undo (a higher cap, a lower cap), over a real database. The item-level half (no stage change, no halted_at, reservations still admitted)
 * is in packages/pipeline/test/computeNotice.pg.test.ts, where the real start path lives.
 */

const budget = (spent: number, limit: number, reserved = 0): BudgetUsage => ({ spent_usd: spent, reserved_usd: reserved, limit_usd: limit });
const none = budget(0, 100);

describe('computeNoticeFor (pure)', () => {
  it('the sentence is pinned by its hash, so this file holds no copy of it, and the notice carries exactly that table entry', () => {
    // The text is read from the one table (S5k3-6). Its exact wording, owner-approved 2026-10-16, is pinned by hash.
    expect(createHash('sha256').update(COMPUTE_NOTICE_SENTENCES.compute_allowance_80).digest('hex')).toBe(
      'a66cbd56b5f08369f8e5e2c97e157b8dc90ba0205b19c4fb68dcba0454c16811',
    );
    expect(computeNoticeFor({ foreground_compute: budget(80, 100), background_compute: none })).toEqual({
      code: 'compute_allowance_80',
      message: COMPUTE_NOTICE_SENTENCES.compute_allowance_80,
    });
  });

  it('the lines are exact: 79.99% none, 80% a notice, 99.99% a notice, 100% none (the pause shows instead)', () => {
    const at = (spent: number) => computeNoticeFor({ foreground_compute: budget(spent, 100), background_compute: none });
    expect(at(79.99)).toBeNull();
    expect(at(80)).not.toBeNull();
    expect(at(99.9999)).not.toBeNull();
    expect(at(100)).toBeNull();
    expect(at(140)).toBeNull();
  });

  it('spent and reserved count together, as the cap check counts them', () => {
    expect(computeNoticeFor({ foreground_compute: budget(50, 100, 30), background_compute: none })).not.toBeNull();
    expect(computeNoticeFor({ foreground_compute: budget(50, 100, 29.9999), background_compute: none })).toBeNull();
  });

  it('either compute budget can raise it, one notice only; a budget at its cap replaces it, even beside a fuller-looking one', () => {
    expect(computeNoticeFor({ foreground_compute: none, background_compute: budget(85, 100) })).not.toBeNull();
    const both = computeNoticeFor({ foreground_compute: budget(85, 100), background_compute: budget(90, 100) });
    expect(both).toEqual({ code: 'compute_allowance_80', message: COMPUTE_NOTICE_SENTENCES.compute_allowance_80 });
    expect(computeNoticeFor({ foreground_compute: budget(85, 100), background_compute: budget(100, 100) })).toBeNull();
  });

  it('a budget with no cap (0) never raises a notice and never divides by zero', () => {
    expect(computeNoticeFor({ foreground_compute: budget(5, 0), background_compute: budget(0, 0) })).toBeNull();
  });
});

describe('getUsage compute_notice (S5k3-1, S5k3-3, derived undo)', () => {
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

  async function member(plan: PlanId = 'starter'): Promise<{ accountId: string; userId: string }> {
    const accountId = randomUUID();
    const userId = randomUUID();
    await seedAccount(admin, accountId, { plan });
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
    return { accountId, userId };
  }

  /** Settled foreground compute worth `share` of the cap, in this month. */
  async function spendShare(accountId: string, plan: PlanId, share: number): Promise<void> {
    const usd = Math.round(foregroundBudgetUsd(plan) * share * 1e4) / 1e4;
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, budget) VALUES ($1, 'compute', 'sandbox', $2, 'foreground_compute')`,
      [accountId, usd],
    );
  }

  const noticeOf = async (m: { accountId: string; userId: string }, now?: Date) =>
    (await getUsage({ pool: appUserPool, principal: m }, now ? { now } : {})).compute_notice;

  it('S5k3-1: 79% shows nothing; 80% shows exactly one notice with the table sentence; 100% shows none (the pause applies instead)', async () => {
    const m79 = await member();
    await spendShare(m79.accountId, 'starter', 0.79);
    expect(await noticeOf(m79)).toBeNull();

    const m80 = await member();
    await spendShare(m80.accountId, 'starter', 0.8);
    expect(await noticeOf(m80)).toEqual({ code: 'compute_allowance_80', message: COMPUTE_NOTICE_SENTENCES.compute_allowance_80 });

    const m100 = await member();
    await spendShare(m100.accountId, 'starter', 1);
    expect(await noticeOf(m100)).toBeNull();
  });

  it('an open reservation counts toward the 80% line, as it does toward the cap', async () => {
    const m = await member();
    await spendShare(m.accountId, 'starter', 0.5);
    await admin.query(
      `INSERT INTO spend_reservations (account_id, usd_reserved, state, budget) VALUES ($1, $2, 'open', 'foreground_compute')`,
      [m.accountId, Math.round(foregroundBudgetUsd('starter') * 0.3 * 1e4) / 1e4],
    );
    expect(await noticeOf(m)).not.toBeNull();
  });

  it('S5k3-3: a new month clears the notice with no person action (and last month does not count toward it)', async () => {
    const m = await member();
    await spendShare(m.accountId, 'starter', 0.85);
    expect(await noticeOf(m)).not.toBeNull();
    const nextMonth = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    expect(await noticeOf(m, nextMonth)).toBeNull();
  });

  it('the notice is derived, never stored: a higher cap removes it at once and a lower cap brings it back', async () => {
    const bigger = planIds().find((p) => foregroundBudgetUsd(p) > foregroundBudgetUsd('starter') * 1.5);
    expect(bigger, 'the plan data needs a plan with a clearly larger foreground budget').toBeDefined();
    const m = await member('starter');
    await spendShare(m.accountId, 'starter', 0.85);
    expect(await noticeOf(m)).not.toBeNull();
    await admin.query(`UPDATE accounts SET plan = $2 WHERE id = $1`, [m.accountId, bigger]);
    expect(await noticeOf(m)).toBeNull();
    await admin.query(`UPDATE accounts SET plan = 'starter' WHERE id = $1`, [m.accountId]);
    expect(await noticeOf(m)).not.toBeNull();
    // Nothing was written along the way: no table holds a notice.
    const columns = await admin.query(`SELECT 1 FROM information_schema.columns WHERE column_name ILIKE '%compute%notice%' AND table_schema = 'public'`);
    expect(columns.rowCount).toBe(0);
  });

  it('the notice does not change what the cap check sees: usage and caps are the same figures with or without it', async () => {
    const m = await member();
    await spendShare(m.accountId, 'starter', 0.9);
    const u = await getUsage({ pool: appUserPool, principal: m });
    expect(u.foreground_compute.limit_usd).toBe(foregroundBudgetUsd('starter'));
    expect(u.background_compute.limit_usd).toBe(backgroundBudgetUsd('starter', 0));
    expect(u.compute_notice).not.toBeNull();
  });
});
