import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { seedAccount, seedRun } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 H05b (correction C35): `ledger_account_run_budget_unique` --
 * `UNIQUE (account_id, run_id, budget)` -- so a run can never be settled
 * twice into the same budget. See
 * migrations/0629_ledger_account_run_budget_unique.sql's file header for
 * the full history (PR #171 fix round 2 recheck, unblocked by #174).
 *
 * Pass/fail 2-4 from the correction comment:
 *   2. two ledger rows for the same (account_id, run_id) with DIFFERENT
 *      budget values both succeed.
 *   3. two ledger rows for the same (account_id, run_id, budget) -- the
 *      second raises a unique violation (23505).
 *   4. run_id IS NULL rows are unaffected (NULL is distinct from NULL
 *      for uniqueness purposes), including across different budgets.
 * Pass/fail 1 and 5 (the constraint applies cleanly to every existing
 * fixture, and the db/spend suites plus scripts/check.sh exit 0) are
 * proved by the rest of the two suites passing unmodified, not by a
 * test in this file.
 */
describe('ledger: UNIQUE(account_id, run_id, budget) (D#2 H05b)', () => {
  let adminPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.SPEND_DATABASE_URL!);
    admin = await adminPool.connect();
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  const insertLedgerRow = (accountId: string, runId: string | null, budget: string, usd: number) =>
    admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget)
       VALUES ($1, $2, 'workflow', $3, $4, $5)`,
      [accountId, budget === 'model' ? 'model' : 'compute', usd, runId, budget],
    );

  it('a run legitimately settling both a model row and a compute row succeeds (different budgets, same run)', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);

    await expect(insertLedgerRow(accountId, runId, 'model', 1.0)).resolves.toBeDefined();
    await expect(insertLedgerRow(accountId, runId, 'foreground_compute', 0.5)).resolves.toBeDefined();

    const { rows } = await admin.query(`SELECT budget FROM ledger WHERE account_id = $1 AND run_id = $2`, [
      accountId,
      runId,
    ]);
    expect(rows.map((r) => r.budget).sort()).toEqual(['foreground_compute', 'model']);
  });

  it('a second ledger row for the same (account_id, run_id, budget) is rejected as a unique violation', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);

    await expect(insertLedgerRow(accountId, runId, 'model', 1.0)).resolves.toBeDefined();
    await expect(insertLedgerRow(accountId, runId, 'model', 1.0)).rejects.toMatchObject({
      code: PG_ERROR.UNIQUE_VIOLATION,
    });

    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ledger WHERE account_id = $1 AND run_id = $2`, [
      accountId,
      runId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('run_id IS NULL rows are unaffected -- multiple NULL-run_id rows for the same account and budget still insert', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);

    await expect(insertLedgerRow(accountId, null, 'model', 2.0)).resolves.toBeDefined();
    await expect(insertLedgerRow(accountId, null, 'model', 3.0)).resolves.toBeDefined();
    await expect(insertLedgerRow(accountId, null, 'foreground_compute', 4.0)).resolves.toBeDefined();

    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM ledger WHERE account_id = $1 AND run_id IS NULL`,
      [accountId],
    );
    expect(rows[0].n).toBe(3);
  });
});
