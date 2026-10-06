import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * OPERATOR-SUB-EXCEPTION (0701): the ledger source for a run on the operator's own subscription, and the narrow
 * definer that writes the audit row naming which model path a started preview ran on.
 */
describe('operator subscription: ledger source and preview mode audit (0701)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool]) await p.end();
  });

  const insertLedger = (source: string) =>
    admin.query(`INSERT INTO ledger (account_id, kind, source, usd, budget) VALUES ($1, 'model', $2, 0, 'model')`, [a.accountId, source]);

  it('accepts operator_subscription and every source it accepted before, and still refuses anything else', async () => {
    for (const source of ['operator_subscription', 'customer_gateway', 'customer_anthropic', 'sandbox', 'workflow']) {
      await expect(insertLedger(source), source).resolves.toBeDefined();
    }
    for (const source of ['operator', 'Operator_Subscription', 'operator_subscription ', '', 'customer']) {
      await expect(insertLedger(source), JSON.stringify(source)).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('onboarding_preview_record_mode: owned by platform_ops, executable by agent_run_writer only', async () => {
    const { rows } = await admin.query(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS definer,
              has_function_privilege('agent_run_writer', p.oid, 'EXECUTE') AS writer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p WHERE p.proname = 'onboarding_preview_record_mode'`,
    );
    expect(rows).toEqual([{ owner: 'platform_ops', definer: true, writer: true, app: false, ops: false, pub: false }]);
  });

  it('a plain tenant login cannot call it', async () => {
    await expect(withTenant(appPool, a.accountId, (c) => c.query(`SELECT onboarding_preview_record_mode($1::uuid, 'customer_key')`, [randomUUID()]))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('the run-writer login gets a fixed refusal for an unknown mode and for a preview that is not running', async () => {
    const call = (mode: string) => withTenant(writerPool, a.accountId, (c) => c.query(`SELECT onboarding_preview_record_mode($1::uuid, $2::text)`, [randomUUID(), mode]));
    await expect(call('operator')).rejects.toMatchObject({ code: '22023' });
    await expect(call('')).rejects.toMatchObject({ code: '22023' });
    await expect(call('customer_key')).rejects.toMatchObject({ code: 'P0002' });
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'onboarding_preview.model_mode'`, [a.accountId]);
    expect(rows[0].n).toBe(0);
  });
});
