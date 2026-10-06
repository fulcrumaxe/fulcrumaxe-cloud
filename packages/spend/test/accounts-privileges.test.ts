import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { reserve } from '../src/reserve.js';
import { settle } from '../src/settle.js';
import { seedAccount, seedRun } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 amendment A3 (H02/H03 security-review criteria, binding on H05):
 * "Spend caps, plan and status are billing-owned. app_user has no INSERT
 * or UPDATE on accounts at all, so every cap check and status transition
 * runs as platform_ops ... Test: an app_user connection attempting to
 * change a cap, plan or status is refused."
 *
 * That grant boundary is H02's own (migrations/0001_core.sql) and is
 * already exhaustively tested there (packages/db/test/
 * accounts-privileges.test.ts). This file is H05's OWN confirmation of
 * the same boundary from this task's side: neither reserve() nor
 * settle() ever needs, and cannot obtain, write access to `accounts` --
 * both only ever SELECT it (reserve()'s status/purpose gate) or don't
 * touch it at all (settle() never reads or writes accounts).
 */
describe('accounts privileges, from H05: reserve()/settle() never write accounts', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let accountId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.SPEND_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.SPEND_DATABASE_URL_APP_USER!);
    accountId = randomUUID();
    await seedAccount(admin, accountId, { plan: 'starter', status: 'active' });
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('a full reserve() + settle() cycle leaves accounts.plan/status/caps exactly as seeded', async () => {
    const runId = randomUUID();
    await seedRun(admin, accountId, runId);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 5,
      monthlyModelBudgetUsd: 100,
    });
    expect(result.decision).toBe('admit');
    await settle(appUserPool, {
      accountId,
      runId,
      entries: [{ budget: 'model', actualUsd: 3, source: 'customer_gateway' }],
    });

    const { rows } = await admin.query(
      `SELECT plan, status, model_budget_usd_month, compute_cap_usd_month FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(rows[0]).toMatchObject({
      plan: 'starter',
      status: 'active',
      model_budget_usd_month: '0.00',
      compute_cap_usd_month: '0.00',
    });
  });

  it('the app_user connection reserve()/settle() use cannot change a cap, plan or status directly either', async () => {
    const attempts = [
      `UPDATE accounts SET plan = 'scale' WHERE id = $1`,
      `UPDATE accounts SET status = 'paused' WHERE id = $1`,
      `UPDATE accounts SET model_budget_usd_month = 999 WHERE id = $1`,
      `UPDATE accounts SET compute_cap_usd_month = 999 WHERE id = $1`,
    ];
    for (const sql of attempts) {
      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query(sql, [accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
  });
});
