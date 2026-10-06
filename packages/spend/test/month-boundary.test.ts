import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { monthToDateUsd } from '../src/reserve.js';
import { seedAccount, seedRun } from './helpers/seed.js';

/**
 * D#2605 H05 / #173 review comment: `monthToDateUsd`'s calendar-month
 * boundary must be UTC, not the server's local timezone -- otherwise it
 * disagrees with `@fx/core`'s `emitBudgetExhaustedOnce`, whose own
 * month boundary was already UTC.
 *
 * Run this file under a non-UTC TZ to see the boundary bug directly,
 * e.g.:
 *   TZ=America/Los_Angeles pnpm --filter @fx/spend test month-boundary
 *   TZ=Pacific/Auckland    pnpm --filter @fx/spend test month-boundary
 *
 * On current main (before the fix), both of the above fail: the old
 * `monthStart()` read `now.getFullYear()/now.getMonth()`, which is the
 * PROCESS's local calendar, not UTC's. Under UTC itself (`TZ=UTC` or no
 * TZ override on a UTC host) the two calendars always agree, so the test
 * passes either way -- this is the "no behavior change on UTC hosts"
 * property the fix must preserve.
 */
describe('monthToDateUsd: UTC calendar-month boundary (D#2605 H05, #173 review comment)', () => {
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

  it('splits spend at the UTC month turn near 2026-10-01T00:00:00Z, regardless of the process TZ', async () => {
    const accountId = randomUUID();
    const septemberRunId = randomUUID();
    const octoberRunId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, septemberRunId);
    await seedRun(admin, accountId, octoberRunId);

    // Straddles the UTC month turn: 30 minutes before, and 30 minutes
    // after, 2026-10-01T00:00:00Z. This is still September 30 evening in
    // America/Los_Angeles (UTC-7) at BOTH timestamps, and already October 1
    // in Pacific/Auckland (UTC+13) at BOTH timestamps -- only the UTC
    // calendar puts these two spends in different months.
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, created_at)
       VALUES ($1, 'model', 'customer_gateway', 10, $2, 'model', '2026-09-30T23:30:00Z')`,
      [accountId, septemberRunId],
    );
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, created_at)
       VALUES ($1, 'model', 'customer_gateway', 20, $2, 'model', '2026-10-01T00:30:00Z')`,
      [accountId, octoberRunId],
    );

    // "now" is 2026-10-01T02:00:00Z -- already into October by the UTC
    // calendar, but still September 30 evening in America/Los_Angeles.
    const now = new Date('2026-10-01T02:00:00Z');
    const octoberMonthToDate = await monthToDateUsd(admin, accountId, 'model', now);

    // Only the October-UTC entry belongs to October's month-to-date total.
    // The September-UTC entry is the PREVIOUS calendar month and must not
    // be folded in, no matter what timezone this test process runs under.
    expect(octoberMonthToDate).toBe(20);
  });

  it('excludes spend from the UTC month turn near 2026-09-30T23:59:59Z (one second earlier)', async () => {
    const accountId = randomUUID();
    const septemberRunId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, septemberRunId);

    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, created_at)
       VALUES ($1, 'model', 'customer_gateway', 15, $2, 'model', '2026-09-30T23:59:59Z')`,
      [accountId, septemberRunId],
    );

    // "now" is one second later, at the UTC month turn itself.
    const now = new Date('2026-10-01T00:00:00Z');
    const octoberMonthToDate = await monthToDateUsd(admin, accountId, 'model', now);

    expect(octoberMonthToDate).toBe(0);
  });
});
