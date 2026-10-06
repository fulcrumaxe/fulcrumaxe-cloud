import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve } from '../src/reserve.js';
import { settle } from '../src/settle.js';
import { seedAccount, seedRun } from './helpers/seed.js';

/**
 * D#2605 H05 pass/fail 6: "settle(run) writes ledger rows and releases
 * the unused reservation. Settled + open never exceeds the cap in a
 * randomized property test (fast-check or a seeded loop, 1,000
 * iterations)."
 *
 * Uses a seeded LCG rather than adding fast-check as a new dependency --
 * the Spec text explicitly allows either ("fast-check OR a seeded loop"),
 * and packages/spend has no other property test that would justify the
 * extra dependency (Simplicity First).
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

describe('settle: property (1,000 seeded iterations)', () => {
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

  it(
    'settled ledger + open reservations never exceed the model budget, across 1,000 random reserve/settle ops',
    async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      const CAP_USD = 50;
      const rng = makeRng(0xc0ffee);

      for (let i = 0; i < 1000; i++) {
        const runId = randomUUID();
        await seedRun(admin, accountId, runId);
        const estimate = Math.round((1 + rng() * 9) * 100) / 100; // $1.00-$10.00
        const result = await reserve(appUserPool, {
          accountId,
          runId,
          plan: 'starter',
          estimateModelUsd: estimate,
          monthlyModelBudgetUsd: CAP_USD,
          perSpawnCapUsd: 10,
        });

        if (result.decision === 'admit' && rng() < 0.5) {
          // Settle immediately, for an actual cost at or below the
          // estimate (a run never legitimately spends more than what it
          // reserved -- meter() kills it first).
          const actualUsd = Math.round(estimate * rng() * 100) / 100;
          await settle(appUserPool, {
            accountId,
            runId,
            entries: [{ budget: 'model', actualUsd, source: 'customer_gateway' }],
          });
        }

        const { rows } = await admin.query<{ committed: string }>(
          `SELECT (
             (SELECT COALESCE(SUM(usd), 0) FROM ledger
                WHERE account_id = $1 AND budget = 'model')
             +
             (SELECT COALESCE(SUM(usd_reserved), 0) FROM spend_reservations
                WHERE account_id = $1 AND budget = 'model' AND state = 'open')
           )::text AS committed`,
          [accountId],
        );
        expect(Number(rows[0].committed)).toBeLessThanOrEqual(CAP_USD + 1e-9);
      }
    },
    120_000,
  );
});
