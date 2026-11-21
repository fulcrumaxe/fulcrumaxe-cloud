import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

const MIGRATION = '1048_engine_quantity.sql';

/**
 * D#845 ON-22a: the 1048 backfill on a database that already holds accounts. Until 1048 every subscription was a hosted plan, so an account with a subscription on file is marked `hosted_plan_paid`
 * and keeps its plan and cap (the standing gates still decide whether it may run); an account with no subscription on file stays unmarked. This is what keeps every existing hosted customer whole on deploy.
 */
describe('migrate: the 1048 upgrade path (hosted_plan_paid backfill)', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let tmp: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });
  afterEach(async () => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
    await dbs.dropAll();
  });
  afterAll(async () => {
    await adminPool.end();
  });

  it('marks the accounts that have a subscription on file, keeps their plan, cap and standing, and leaves every other account unmarked', async () => {
    const dbName = await dbs.create('fx_1048_upgrade');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const pool = createPool(url.toString());
    try {
      const all = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      tmp = mkdtempSync(path.join(tmpdir(), 'fx-1048-upgrade-'));
      for (const f of all.filter((name) => name < MIGRATION)) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmp, f));
      await runMigrations(pool, tmp);

      const paying = randomUUID();
      const ended = randomUUID();
      const pastDue = randomUUID();
      const unsubscribed = randomUUID();
      const customerOnly = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status, stripe_subscription_id, stripe_subscription_status, compute_cap_usd_month) VALUES ($1, 'scale', $2, 'active', 'sub_a', 'active', 200)`, [paying, `cus_${paying}`]);
      await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status, stripe_subscription_id, stripe_subscription_status, subscription_ended_at) VALUES ($1, 'team', $2, 'cancelled', 'sub_b', 'canceled', now())`, [ended, `cus_${ended}`]);
      await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status, stripe_subscription_id, stripe_subscription_status, past_due_since) VALUES ($1, 'team', $2, 'past_due', 'sub_c', 'past_due', now())`, [pastDue, `cus_${pastDue}`]);
      await pool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [unsubscribed]);
      await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [customerOnly, `cus_${customerOnly}`]);

      const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
      expect(result.applied).toContain(MIGRATION);

      const { rows } = await pool.query<{ id: string; plan: string; status: string; hosted_plan_paid: boolean; engine_quantity: number; engine_quantity_below_live_at: Date | null; cap: string }>(
        `SELECT id, plan, status, hosted_plan_paid, engine_quantity, engine_quantity_below_live_at, compute_cap_usd_month::text AS cap FROM accounts`,
      );
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[paying]).toMatchObject({ plan: 'scale', status: 'active', hosted_plan_paid: true, engine_quantity: 0, engine_quantity_below_live_at: null, cap: '200.00' });
      // An ended or past-due subscription is marked too: the standing gates, not this fact, refuse those.
      expect(by[ended]).toMatchObject({ plan: 'team', status: 'cancelled', hosted_plan_paid: true });
      expect(by[pastDue]).toMatchObject({ plan: 'team', status: 'past_due', hosted_plan_paid: true });
      expect(by[unsubscribed]!.hosted_plan_paid).toBe(false);
      // A customer with no subscription on file (unreachable through the live writer, which sets both in one transaction) is not marked.
      expect(by[customerOnly]!.hosted_plan_paid).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
