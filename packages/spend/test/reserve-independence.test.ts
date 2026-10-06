import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve } from '../src/reserve.js';
import { backgroundBudgetUsd, foregroundBudgetUsd } from '../src/plans.js';
import { seedAccount, seedRun } from './helpers/seed.js';

/**
 * D#2605 H05 pass/fail 4c: "Foreground and background budgets are
 * independent: exhausting one never blocks the other. Tests: with the
 * background budget spent, a customer-initiated Feature still reserves
 * and runs; with the foreground budget spent, the weekly sweep still
 * runs; a background run can never draw on the foreground budget,
 * whichever is larger."
 */
describe('reserve: foreground/background independence', () => {
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

  it('a customer-initiated Feature still reserves foreground compute after the background budget is fully spent', async () => {
    const accountId = randomUUID();
    const spentRunId = randomUUID();
    const featureRunId = randomUUID();
    await seedAccount(admin, accountId, { plan: 'starter' }); // background budget: the plan data's
    await seedRun(admin, accountId, spentRunId);
    await seedRun(admin, accountId, featureRunId);
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget)
       VALUES ($1, 'compute', 'workflow', $3, $2, 'background_compute')`,
      [accountId, spentRunId, backgroundBudgetUsd('starter', 0)],
    );

    const result = await reserve(appUserPool, {
      accountId,
      runId: featureRunId,
      plan: 'starter',
      trigger: 'foreground',
      estimateComputeUsd: 5,
    });
    expect(result.decision).toBe('admit');
  });

  it('the weekly sweep still runs after the foreground budget is fully spent', async () => {
    const accountId = randomUUID();
    const spentRunId = randomUUID();
    const sweepRunId = randomUUID();
    await seedAccount(admin, accountId, { plan: 'starter' }); // foreground budget: the plan data's
    await seedRun(admin, accountId, spentRunId);
    await seedRun(admin, accountId, sweepRunId);
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget)
       VALUES ($1, 'compute', 'sandbox', $3, $2, 'foreground_compute')`,
      [accountId, spentRunId, foregroundBudgetUsd('starter')],
    );

    const result = await reserve(appUserPool, {
      accountId,
      runId: sweepRunId,
      plan: 'starter',
      trigger: 'background',
      estimateComputeUsd: 2,
    });
    expect(result.decision).toBe('admit');
  });

  it('a background run can never draw on the (larger) foreground budget: it is still capped at the background total', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    // Scale: the foreground budget is larger than the background budget for
    // one repo (both from the plan data), so a bug that let a background call
    // check the foreground cap instead would wrongly admit this.
    const backgroundCap = backgroundBudgetUsd('scale', 1);
    await seedAccount(admin, accountId, { plan: 'scale' });
    await seedRun(admin, accountId, runId);
    expect(foregroundBudgetUsd('scale')).toBeGreaterThan(backgroundCap);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'scale',
      trigger: 'background',
      repoCount: 1,
      estimateComputeUsd: backgroundCap + 2, // over the background cap, under the foreground cap
    });
    expect(result).toEqual({ decision: 'deny', reason: 'compute_cap_exceeded' });
  });
});
