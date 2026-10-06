import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * A runner's runs stay out of the token and run KPIs. The KPI views (0623) count only runtime IN ('local',
 * 'production'), and a runner run never writes the ledger, so widening agent_runs.runtime to include 'runner' must
 * change no KPI figure.
 *
 * One merged work item has a production run (100 tokens in, 50 out) and a runner run (1000 in, 500 out, usd 9.99).
 * The item shows 150 tokens and no model cost, and v_kpi_runs has no row for the runner run.
 */
describe('runner runs are excluded from the KPI views', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  const workItem = randomUUID();
  const productionRun = randomUUID();
  const runnerRun = randomUUID();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
    await admin.query('DELETE FROM agent_runs WHERE account_id = $1', [refs.accountId]);
    await admin.query('DELETE FROM work_items WHERE account_id = $1', [refs.accountId]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [workItem, refs.accountId, refs.repoId]);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, tokens_in, tokens_out) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 100, 50)`,
      [productionRun, refs.accountId, workItem],
    );
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, tokens_in, tokens_out, usd) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 1000, 500, 9.99)`,
      [runnerRun, refs.accountId, workItem],
    );
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('v_kpi_work_items counts 150 tokens and no model cost', async () => {
    const { rows } = await withTenant(appPool, refs.accountId, (c) => c.query('SELECT tokens, model_usd, compute_usd FROM v_kpi_work_items WHERE work_item_id = $1', [workItem]));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].tokens)).toBe(150);
    expect(Number(rows[0].model_usd)).toBe(0);
    expect(Number(rows[0].compute_usd)).toBe(0);
  });

  it('v_kpi_runs has a row for the production run and none for the runner run', async () => {
    const { rows } = await withTenant(appPool, refs.accountId, (c) => c.query<{ run_id: string; runtime: string }>('SELECT run_id, runtime FROM v_kpi_runs WHERE work_item_id = $1', [workItem]));
    expect(rows).toEqual([{ run_id: productionRun, runtime: 'production' }]);
  });

  it('the runner run does exist, and writes nothing to the ledger', async () => {
    const run = await admin.query('SELECT runtime, usd FROM agent_runs WHERE id = $1', [runnerRun]);
    expect(run.rows[0].runtime).toBe('runner');
    expect(Number(run.rows[0].usd)).toBe(9.99);
    const ledger = await admin.query('SELECT 1 FROM ledger WHERE account_id = $1 AND run_id = $2', [refs.accountId, runnerRun]);
    expect(ledger.rowCount).toBe(0);
  });
});
