import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { reserve, type ReserveParams } from '../src/reserve.js';
import { envelopeSpentUsd } from '../src/envelope.js';
import { seedAccount } from './helpers/seed.js';

/**
 * [pg] D#483 S5-b2c-3, acceptance 8: a planned PR child's round draws on the PARENT's envelope. A child's `envelope_id` is the parent's (migration 0920), and reserve() sums the spend
 * of every item that draws on one envelope under its lock, so a child's reservation counts with the parent's and the siblings' spend. With the envelope used up by a sibling the round is
 * denied `envelope_exceeded` (the existing spending-limit pause) and no reservation is made; raising the envelope (a new version) lets the same ask through.
 */
describe('a planned PR child\'s round draws on its parent\'s envelope', () => {
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

  const base = { plan: 'starter', estimateModelUsd: 3, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40 } as const;

  async function family(amount: number) {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const userId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', $3, 1, $4)`, [envelopeId, accountId, amount, userId]);
    const item = async (parent: string | null) => {
      const id = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, envelope_id, parent_id) VALUES ($1, $2, 'feature', 'internal', $3, $4)`, [id, accountId, envelopeId, parent]);
      return id;
    };
    const parent = await item(null);
    return { accountId, userId, envelopeId, parent, child: await item(parent), sibling: await item(parent) };
  }
  const run = async (accountId: string, workItemId: string, status = 'succeeded'): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', $4)`, [id, accountId, workItemId, status]);
    return id;
  };
  const spend = async (accountId: string, runId: string, usd: number) =>
    admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [accountId, usd, runId]);
  const ask = async (accountId: string, workItemId: string, extra: Partial<ReserveParams> = {}) => {
    const runId = await run(accountId, workItemId, 'pending');
    return { runId, result: await reserve(appUserPool, { ...base, ...extra, accountId, runId, workItemId }) };
  };
  const reservations = async (accountId: string, runId: string): Promise<number> =>
    Number((await admin.query('SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1 AND run_id = $2', [accountId, runId])).rows[0].n);

  it('the reservation of a child\'s round is counted in the envelope with the parent\'s and a sibling\'s spend', async () => {
    const f = await family(10);
    await spend(f.accountId, await run(f.accountId, f.parent), 2);
    await spend(f.accountId, await run(f.accountId, f.sibling), 3);
    const first = await ask(f.accountId, f.child);
    expect(first.result.decision).toBe('admit');
    expect(await reservations(f.accountId, first.runId)).toBeGreaterThan(0);
    expect(await withTenant(appUserPool, f.accountId, (c) => envelopeSpentUsd(c, f.accountId, f.envelopeId))).toBe(8);
  });

  it('with the envelope used up by a sibling, the round takes the spending-limit pause: no reservation; raising the envelope lets the same ask through', async () => {
    const f = await family(10);
    await spend(f.accountId, await run(f.accountId, f.sibling), 8.5);
    const denied = await ask(f.accountId, f.child);
    expect(denied.result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
    expect(await reservations(f.accountId, denied.runId)).toBe(0);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', 20, 2, $3)`, [f.envelopeId, f.accountId, f.userId]);
    const again = await ask(f.accountId, f.child);
    expect(again.result.decision).toBe('admit');
    expect(await reservations(f.accountId, again.runId)).toBeGreaterThan(0);
  });
});
