import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve, reserveWith, ReserveTransactionContractError } from '../src/reserve.js';
import { seedAccount, seedRun } from './helpers/seed.js';

/**
 * D#31 API-1 part A fix round (CWE-362/667): `reserveWith`'s admission
 * decision depends on reading a committed/open total and then inserting
 * a reservation with nobody else changing that total in between. The
 * `pg_advisory_xact_lock` in src/reserve.ts only provides that when BOTH
 * of the following hold, and this suite proves each one -- on a real,
 * concurrently-issued set of connections against ONE account and ONE
 * $100 budget, exactly like test/reserve-concurrency.test.ts's own
 * 50-parallel shape, so a fix here can never look safe only because the
 * test's own concurrency was too weak to trigger the race:
 *
 *   (a) autocommit: `client` must already be inside an open transaction.
 *       On an autocommit client, `pg_advisory_xact_lock` is released by
 *       the very statement that took it, so it serializes nothing.
 *   (b) REPEATABLE READ: even inside a transaction, REPEATABLE READ's
 *       snapshot is taken at the transaction's first statement, before
 *       reserveWith ever acquires the lock -- so every caller unblocked
 *       by the lock still reads the SAME pre-lock snapshot and all of
 *       them admit against it.
 *
 * Both must now be refused with `ReserveTransactionContractError`,
 * before any reservation is admitted. (c) READ COMMITTED is the one
 * isolation level reserveWith accepts, and is exercised here as the
 * positive control. (d) SERIALIZABLE is refused for the same reason as
 * (a) and (b) (D#31 fix round 2): Postgres's serializable-snapshot
 * checks (SSI) only flag a conflict between two SERIALIZABLE
 * transactions, so a SERIALIZABLE reserveWith racing READ COMMITTED
 * reserve() callers is invisible to SSI and can read a stale
 * month-to-date total -- measured at $110 committed against a $100 cap
 * in 8 of 8 runs before this fix. The mixed tests below exercise exactly
 * that race directly.
 */
describe('reserveWith: transaction and isolation contract (D#31 fix round)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.SPEND_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = new Pool({ connectionString: process.env.SPEND_DATABASE_URL_APP_USER!, max: 60 });
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  async function seedFifty(): Promise<{ accountId: string; runIds: string[] }> {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const runIds = Array.from({ length: 50 }, () => randomUUID());
    for (const runId of runIds) {
      await seedRun(admin, accountId, runId);
    }
    return { accountId, runIds };
  }

  async function committedModelUsd(accountId: string): Promise<number> {
    const { rows } = await admin.query<{ sum: string }>(
      `SELECT COALESCE(SUM(usd_reserved), 0)::text AS sum FROM spend_reservations
       WHERE account_id = $1 AND budget = 'model' AND state = 'open'`,
      [accountId],
    );
    return Number(rows[0].sum);
  }

  it('(a) autocommit: admits ZERO of 50 parallel $10 calls against a $100 cap, and each throws the typed error', async () => {
    const { accountId, runIds } = await seedFifty();

    const outcomes = await Promise.all(
      runIds.map(async (runId) => {
        const client = await appUserPool.connect();
        try {
          // Deliberately no BEGIN -- this client is in Postgres's default
          // autocommit mode, exactly the shape a careless caller (or a
          // future caller that forgets withTenant) would pass in.
          return await reserveWith(client, {
            accountId,
            runId,
            plan: 'starter',
            estimateModelUsd: 10,
            monthlyModelBudgetUsd: 100,
            perSpawnCapUsd: 10,
          })
            .then(() => ({ threw: false as const }))
            .catch((err: unknown) => ({ threw: true as const, err }));
        } finally {
          client.release();
        }
      }),
    );

    for (const outcome of outcomes) {
      expect(outcome.threw).toBe(true);
      if (outcome.threw) {
        expect(outcome.err).toBeInstanceOf(ReserveTransactionContractError);
      }
    }
    expect(await committedModelUsd(accountId)).toBe(0);
  });

  it('(b) REPEATABLE READ with a prior statement: admits ZERO of 50 parallel $10 calls, and each throws the typed error', async () => {
    const { accountId, runIds } = await seedFifty();

    const outcomes = await Promise.all(
      runIds.map(async (runId) => {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          // "with a prior statement": fixes the snapshot before
          // reserveWith is ever called, same as a real caller who reads
          // something else first in the same transaction.
          await client.query('SELECT 1');
          try {
            const result = await reserveWith(client, {
              accountId,
              runId,
              plan: 'starter',
              estimateModelUsd: 10,
              monthlyModelBudgetUsd: 100,
              perSpawnCapUsd: 10,
            });
            return { threw: false as const, result };
          } catch (err) {
            return { threw: true as const, err };
          } finally {
            await client.query('ROLLBACK').catch(() => {});
          }
        } finally {
          client.release();
        }
      }),
    );

    for (const outcome of outcomes) {
      expect(outcome.threw).toBe(true);
      if (outcome.threw) {
        expect(outcome.err).toBeInstanceOf(ReserveTransactionContractError);
      }
    }
    expect(await committedModelUsd(accountId)).toBe(0);
  });

  it('(c) READ COMMITTED: admits exactly 10 of 50 parallel $10 calls, committing exactly $100', async () => {
    const { accountId, runIds } = await seedFifty();

    const results = await Promise.all(
      runIds.map(async (runId) => {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
          try {
            const result = await reserveWith(client, {
              accountId,
              runId,
              plan: 'starter',
              estimateModelUsd: 10,
              monthlyModelBudgetUsd: 100,
              perSpawnCapUsd: 10,
            });
            await client.query('COMMIT');
            return result;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          }
        } finally {
          client.release();
        }
      }),
    );

    const admitted = results.filter((r) => r.decision === 'admit');
    expect(admitted.length).toBe(10);
    expect(await committedModelUsd(accountId)).toBe(100);
  });

  it('(d) SERIALIZABLE: refused with the typed error, before any reservation is admitted', async () => {
    const { accountId, runIds } = await seedFifty();

    const outcomes = await Promise.all(
      runIds.map(async (runId) => {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
          try {
            const result = await reserveWith(client, {
              accountId,
              runId,
              plan: 'starter',
              estimateModelUsd: 10,
              monthlyModelBudgetUsd: 100,
              perSpawnCapUsd: 10,
            });
            return { threw: false as const, result };
          } catch (err) {
            return { threw: true as const, err };
          } finally {
            await client.query('ROLLBACK').catch(() => {});
          }
        } finally {
          client.release();
        }
      }),
    );

    for (const outcome of outcomes) {
      expect(outcome.threw).toBe(true);
      if (outcome.threw) {
        expect(outcome.err).toBeInstanceOf(ReserveTransactionContractError);
      }
    }
    expect(await committedModelUsd(accountId)).toBe(0);
  });

  it(
    'mixed: 25 reserve() (READ COMMITTED) + 25 SERIALIZABLE reserveWith against a $100 cap -- ' +
      'the SERIALIZABLE ones all throw, and exactly $100 is committed',
    async () => {
      const { accountId, runIds } = await seedFifty();
      const rcRunIds = runIds.slice(0, 25);
      const serRunIds = runIds.slice(25);

      const rcOutcomes = Promise.all(
        rcRunIds.map((runId) =>
          reserve(appUserPool, {
            accountId,
            runId,
            plan: 'starter',
            estimateModelUsd: 10,
            monthlyModelBudgetUsd: 100,
            perSpawnCapUsd: 10,
          })
            .then((result) => ({ threw: false as const, result }))
            .catch((err: unknown) => ({ threw: true as const, err })),
        ),
      );

      const serOutcomes = Promise.all(
        serRunIds.map(async (runId) => {
          const client = await appUserPool.connect();
          try {
            await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
            await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
            try {
              const result = await reserveWith(client, {
                accountId,
                runId,
                plan: 'starter',
                estimateModelUsd: 10,
                monthlyModelBudgetUsd: 100,
                perSpawnCapUsd: 10,
              });
              return { threw: false as const, result };
            } catch (err) {
              return { threw: true as const, err };
            } finally {
              await client.query('ROLLBACK').catch(() => {});
            }
          } finally {
            client.release();
          }
        }),
      );

      const [rcResults, serResults] = await Promise.all([rcOutcomes, serOutcomes]);

      for (const outcome of serResults) {
        expect(outcome.threw).toBe(true);
        if (outcome.threw) {
          expect(outcome.err).toBeInstanceOf(ReserveTransactionContractError);
        }
      }

      const rcAdmitted = rcResults.filter((r) => !r.threw && r.result.decision === 'admit');
      expect(rcAdmitted.length).toBe(10);
      expect(await committedModelUsd(accountId)).toBe(100);
    },
    30000,
  );

  it(
    'mixed: 49 reserve() (READ COMMITTED) + 1 SERIALIZABLE reserveWith against a $100 cap -- ' +
      'never exceeds $100 committed',
    async () => {
      const { accountId, runIds } = await seedFifty();
      const rcRunIds = runIds.slice(0, 49);
      const serRunId = runIds[49];

      const rcOutcomes = Promise.all(
        rcRunIds.map((runId) =>
          reserve(appUserPool, {
            accountId,
            runId,
            plan: 'starter',
            estimateModelUsd: 10,
            monthlyModelBudgetUsd: 100,
            perSpawnCapUsd: 10,
          })
            .then((result) => ({ threw: false as const, result }))
            .catch((err: unknown) => ({ threw: true as const, err })),
        ),
      );

      const serOutcome = (async () => {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
          try {
            const result = await reserveWith(client, {
              accountId,
              runId: serRunId,
              plan: 'starter',
              estimateModelUsd: 10,
              monthlyModelBudgetUsd: 100,
              perSpawnCapUsd: 10,
            });
            return { threw: false as const, result };
          } catch (err) {
            return { threw: true as const, err };
          } finally {
            await client.query('ROLLBACK').catch(() => {});
          }
        } finally {
          client.release();
        }
      })();

      const [rcResults, serResult] = await Promise.all([rcOutcomes, serOutcome]);

      expect(serResult.threw).toBe(true);
      if (serResult.threw) {
        expect(serResult.err).toBeInstanceOf(ReserveTransactionContractError);
      }

      const rcAdmitted = rcResults.filter((r) => !r.threw && r.result.decision === 'admit');
      const committed = await committedModelUsd(accountId);
      expect(committed).toBeLessThanOrEqual(100);
      expect(committed).toBe(rcAdmitted.length * 10);
    },
    30000,
  );
});
