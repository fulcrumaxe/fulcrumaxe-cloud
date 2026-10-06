import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve } from '../src/reserve.js';
import { foregroundBudgetUsd } from '../src/plans.js';
import { seedAccount, seedModelConnectionOk, seedRun, seedRunWithWorkItem } from './helpers/seed.js';

/**
 * D#2605 H05 pass/fail 1 and 5: each denial case gets its own reason, and
 * `reserve` is denied when accounts.status != 'active' except for
 * purpose: 'preview' (which instead requires an ok model_connections row).
 */
describe('reserve: denial reasons', () => {
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

  it('per_spawn_cap_exceeded: a single estimate over the per-spawn cap is denied without touching the DB aggregate', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 50,
      monthlyModelBudgetUsd: 600,
      perSpawnCapUsd: 40,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'per_spawn_cap_exceeded' });
  });

  it('model_budget_exceeded: month-to-date settled spend + estimate crossing the customer budget is denied', async () => {
    const accountId = randomUUID();
    const priorRunId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, priorRunId);
    await seedRun(admin, accountId, runId);
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget)
       VALUES ($1, 'model', 'customer_gateway', 45, $2, 'model')`,
      [accountId, priorRunId],
    );

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 10,
      monthlyModelBudgetUsd: 50,
      perSpawnCapUsd: 40,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'model_budget_exceeded' });

    // D#31 API-4a criterion 5: this deny path emits `budget.exhausted` in
    // the same transaction.
    const events = await admin.query(
      `SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'budget.exhausted'`,
      [accountId],
    );
    expect(events.rows).toEqual([{ payload: { budget: 'model' } }]);
  });

  it('compute_cap_exceeded: month-to-date compute spend on the SAME budget + estimate crossing that budget cap is denied', async () => {
    const accountId = randomUUID();
    const priorRunId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId, { plan: 'starter' });
    await seedRun(admin, accountId, priorRunId);
    await seedRun(admin, accountId, runId);
    // Spend 5 below Starter's foreground compute budget (from the plan data), so the 10 estimate below crosses it.
    const priorUsd = foregroundBudgetUsd('starter') - 5;
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget)
       VALUES ($1, 'compute', 'sandbox', $3, $2, 'foreground_compute')`,
      [accountId, priorRunId, priorUsd],
    );

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      trigger: 'foreground',
      estimateComputeUsd: 10,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'compute_cap_exceeded' });

    const events = await admin.query(
      `SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'budget.exhausted'`,
      [accountId],
    );
    expect(events.rows).toEqual([{ payload: { budget: 'foreground_compute' } }]);
  });

  it('budget.exhausted: 3 denials for the same (account, budget) in one calendar month emit exactly 1 event', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);

    for (let i = 0; i < 3; i++) {
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      const result = await reserve(appUserPool, {
        accountId,
        runId,
        plan: 'starter',
        estimateModelUsd: 100,
        monthlyModelBudgetUsd: 50,
        perSpawnCapUsd: 200,
      });
      expect(result).toEqual({ decision: 'deny', reason: 'model_budget_exceeded' });
    }

    const events = await admin.query(
      `SELECT count(*)::text AS count FROM domain_events WHERE account_id = $1 AND type = 'budget.exhausted'`,
      [accountId],
    );
    expect(events.rows[0].count).toBe('1');
  });

  it("work_item_cap_exceeded: a Small's committed model spend + estimate crossing its own cap is denied", async () => {
    const accountId = randomUUID();
    const priorRunId = randomUUID();
    const runId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRunWithWorkItem(admin, accountId, priorRunId, workItemId, 'small');
    // The SAME work item, a second run (a fix round) -- agent_runs
    // composite FK requires each run row to exist before ledger/
    // reservations reference it.
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
       VALUES ($1, $2, $3, 'executor', 'local', 'running')`,
      [runId, accountId, workItemId],
    );
    // Small's default cap is 66 in the test data; commit 55 already against this item.
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget)
       VALUES ($1, 'model', 'customer_gateway', 55, $2, 'model')`,
      [accountId, priorRunId],
    );

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      workItemId,
      workItemKind: 'small',
      estimateModelUsd: 12,
      monthlyModelBudgetUsd: 600,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'work_item_cap_exceeded' });
  });

  it('account_not_active: a paused account is denied for an ordinary run', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId, { status: 'paused' });
    await seedRun(admin, accountId, runId);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 5,
      monthlyModelBudgetUsd: 600,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'account_not_active' });
  });

  it('preview exception: a paused account CAN reserve a preview when it has an ok model connection', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId, { status: 'paused' });
    await seedRun(admin, accountId, runId);
    await seedModelConnectionOk(admin, accountId);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      purpose: 'preview',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
    });
    expect(result.decision).toBe('admit');
  });

  it('model_connection_not_ok: a preview with no ok model connection is denied even for an active account', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId, { status: 'active' });
    await seedRun(admin, accountId, runId);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      purpose: 'preview',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'model_connection_not_ok' });
  });

  it('admits and records which budget each reservation drew on, when every check passes', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      trigger: 'background',
      estimateModelUsd: 5,
      estimateComputeUsd: 2,
      monthlyModelBudgetUsd: 600,
    });
    expect(result.decision).toBe('admit');
    if (result.decision !== 'admit') throw new Error('unreachable');
    expect(result.reservations).toHaveLength(2);
    const budgets = result.reservations.map((r) => r.budget).sort();
    expect(budgets).toEqual(['background_compute', 'model']);

    const { rows } = await admin.query(
      `SELECT budget, usd_reserved, state FROM spend_reservations WHERE account_id = $1 AND run_id = $2 ORDER BY budget`,
      [accountId, runId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === 'open')).toBe(true);
  });
});

/**
 * D#69 MUST-fix 3, owner decision 18504921: runs CONTINUE for 7 days from
 * the first failed charge, with the "update your card" banner, before
 * `reserve()` starts refusing them. Migration 0606's own header note: a
 * stored `past_due` status never ages into `cancelled` on its own -- it
 * is only re-derived when something WRITES the row -- so `reserve()`
 * cannot trust the stored `status` string alone at day 8; it must
 * re-check `past_due_since` against the SAME 7-day boundary at READ time,
 * on every call. This suite proves exactly that: one `past_due_since`
 * write (day 0), then three `reserve()` calls against the injectable
 * `now` clock, with NO further write to the row in between.
 */
describe('reserve: D#69 7-day payment-failure grace period (owner decision 18504921), evaluated at read time', () => {
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

  it('day 0 and day 6 are admitted, day 8 is refused -- through the real reserve() path, off ONE never-rewritten past_due_since row', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);

    const firstFailure = new Date();
    await admin.query('UPDATE accounts SET past_due_since = $1 WHERE id = $2', [firstFailure, accountId]);

    const storedStatus = async () =>
      (
        await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId])
      ).rows[0]!.status;
    // The write above derived 'past_due' at write time (it was fresh) --
    // this row is never written again for the rest of this test.
    expect(await storedStatus()).toBe('past_due');

    const day = (n: number) => new Date(firstFailure.getTime() + n * 24 * 60 * 60 * 1000);

    const day0 = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
      now: day(0),
    });
    expect(day0.decision).toBe('admit');

    const day6 = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
      now: day(6),
    });
    expect(day6.decision).toBe('admit');

    const day8 = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
      now: day(8),
    });
    expect(day8).toEqual({ decision: 'deny', reason: 'account_not_active' });

    // The day-8 denial came from reserve()'s own read-time check, not
    // from a fresh write re-deriving the stored column to 'cancelled' --
    // confirm the row itself was never rewritten between calls.
    expect(await storedStatus()).toBe('past_due');
  });

  it('day 7 exactly is already expired (grace is `>`, strictly within the window), matching migration 0606 compute_account_status', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);

    const firstFailure = new Date();
    await admin.query('UPDATE accounts SET past_due_since = $1 WHERE id = $2', [firstFailure, accountId]);

    const day7 = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
      now: new Date(firstFailure.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    expect(day7).toEqual({ decision: 'deny', reason: 'account_not_active' });
  });

  it('preview purpose is unaffected -- it never reaches the past_due/active gate at all', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);
    await seedModelConnectionOk(admin, accountId);

    const firstFailure = new Date();
    await admin.query('UPDATE accounts SET past_due_since = $1 WHERE id = $2', [firstFailure, accountId]);

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      purpose: 'preview',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
      now: new Date(firstFailure.getTime() + 30 * 24 * 60 * 60 * 1000),
    });
    expect(result.decision).toBe('admit');
  });
});
