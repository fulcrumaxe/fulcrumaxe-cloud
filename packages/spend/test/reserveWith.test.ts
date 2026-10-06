import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve, reserveWith } from '../src/reserve.js';
import { seedAccount } from './helpers/seed.js';

/**
 * D#31 API-1 criterion 8: `reserveWith(client, params)` runs the same
 * admission logic as `reserve`, but against a client the CALLER already
 * opened a transaction on -- so a caller like the future retry action
 * (API-6) can claim an idempotency key, call `reserveWith`, and insert
 * its own `agent_runs` row all inside ONE transaction that either
 * commits together or rolls back together.
 *
 * The three writes below are ordered `agent_runs` insert -> claim ->
 * `reserveWith`, not the Spec prose's own listing order ("claims an
 * idempotency key, calls reserveWith, inserts an agent_runs row") --
 * `spend_reservations.(account_id, run_id)` has a non-deferrable
 * `FOREIGN KEY ... REFERENCES agent_runs (account_id, id)`
 * (0001_core.sql), so `reserveWith`'s own `INSERT INTO
 * spend_reservations` would fail its FK check immediately if the run
 * didn't already exist in this same transaction. What the criterion
 * actually tests -- three writes sharing one transaction, all rolled
 * back together by one throw -- holds regardless of which order the
 * three statements run in; only the FK forces this particular order.
 */
describe('reserveWith: composes into a caller-owned transaction', () => {
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

  it('rolls back the idempotency claim, the reservation and the agent_runs insert together', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);

    const client = await appUserPool.connect();
    let threw = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);

      await client.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status)
         VALUES ($1, $2, 'executor', 'local', 'running')`,
        [runId, accountId],
      );

      await client.query(
        `INSERT INTO idempotency_keys (account_id, key, principal_id, method, path, request_sha256, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', now() + interval '24 hours')`,
        [accountId, 'reserve-with-test-key', `session:${randomUUID()}`, 'POST', '/api/v1/runs/x/retry', 'deadbeef'],
      );

      const result = await reserveWith(client, {
        accountId,
        runId,
        plan: 'starter',
        estimateModelUsd: 1,
        monthlyModelBudgetUsd: 600,
      });
      expect(result.decision).toBe('admit');

      throw new Error('simulated failure after all three writes');
    } catch {
      threw = true;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(threw).toBe(true);

    // Sequential, not Promise.all: `admin` is a single PoolClient, and
    // pg deprecates overlapping `.query()` calls on the same client (it
    // would still queue them internally, but with a runtime warning).
    const idem = await admin.query('SELECT 1 FROM idempotency_keys WHERE account_id = $1', [accountId]);
    const reservations = await admin.query('SELECT 1 FROM spend_reservations WHERE account_id = $1', [
      accountId,
    ]);
    const runs = await admin.query('SELECT 1 FROM agent_runs WHERE account_id = $1', [accountId]);
    expect(idem.rowCount).toBe(0);
    expect(reservations.rowCount).toBe(0);
    expect(runs.rowCount).toBe(0);
  });

  it("reserve() still passes unchanged (it's now withTenant(...) around reserveWith)", async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`,
      [runId, accountId],
    );

    const result = await reserve(appUserPool, {
      accountId,
      runId,
      plan: 'starter',
      estimateModelUsd: 1,
      monthlyModelBudgetUsd: 600,
    });
    expect(result.decision).toBe('admit');
  });
});
