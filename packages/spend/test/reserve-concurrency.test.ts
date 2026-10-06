import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve } from '../src/reserve.js';
import { seedAccount, seedRun } from './helpers/seed.js';

/**
 * D#2605 H05 pass/fail 2: "Concurrency: 50 parallel reserve calls against
 * a $100 cap with $10 estimates never commit more than 10 (Postgres test
 * using a row lock or serializable transaction)."
 *
 * reserve() serializes concurrent calls for the same (account, budget)
 * pair with a transaction-scoped Postgres advisory lock, taken BEFORE
 * reading the month-to-date aggregate -- see src/reserve.ts's file-level
 * comment. This test is what actually proves that holds: 50 real,
 * concurrently-issued client connections against ONE account and ONE
 * $100 budget, each independently deciding whether $10 more fits.
 */
describe('reserve: concurrency', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.SPEND_DATABASE_URL!);
    admin = await adminPool.connect();
    // A dedicated pool with enough connections that every one of the 50
    // concurrent reserve() calls gets its own client rather than queueing
    // behind pg's default pool size -- queueing would serialize them for
    // the wrong reason (pool exhaustion, not the advisory lock this test
    // means to exercise).
    appUserPool = new Pool({ connectionString: process.env.SPEND_DATABASE_URL_APP_USER!, max: 60 });
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('never admits more than 10 of 50 parallel $10 reservations against a $100 budget', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);

    const runIds = Array.from({ length: 50 }, () => randomUUID());
    for (const runId of runIds) {
      await seedRun(admin, accountId, runId);
    }

    const results = await Promise.all(
      runIds.map((runId) =>
        reserve(appUserPool, {
          accountId,
          runId,
          plan: 'starter',
          estimateModelUsd: 10,
          monthlyModelBudgetUsd: 100,
          perSpawnCapUsd: 10,
        }),
      ),
    );

    const admitted = results.filter((r) => r.decision === 'admit');
    expect(admitted.length).toBe(10);
    expect(results.length - admitted.length).toBe(40);
    for (const r of results) {
      if (r.decision === 'deny') {
        expect(r.reason).toBe('model_budget_exceeded');
      }
    }

    const { rows } = await admin.query<{ sum: string }>(
      `SELECT COALESCE(SUM(usd_reserved), 0)::text AS sum FROM spend_reservations
       WHERE account_id = $1 AND budget = 'model' AND state = 'open'`,
      [accountId],
    );
    expect(Number(rows[0].sum)).toBeLessThanOrEqual(100);
    expect(Number(rows[0].sum)).toBe(100);
  });
});
