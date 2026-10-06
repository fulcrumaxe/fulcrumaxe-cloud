import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@fx/core/src/tenancy/errors.js';
import { createPool } from '../src/pg.js';
import { setAccountBudgets, setSharePublicFigures } from '../src/accountSettings.js';
import type { BillingCtx } from '../src/types.js';
import { seedAccountWithMember } from './helpers/seed.js';

// The mock passes every call through to the real audit helper unless a test
// arms `state.failNext`, which makes the audit step throw after the accounts
// write has already run in the same transaction.
const state = vi.hoisted(() => ({ failNext: false }));
vi.mock('../src/audit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/audit.js')>();
  return {
    ...real,
    recordAccountAction: (...args: Parameters<typeof real.recordAccountAction>) => {
      if (state.failNext) {
        state.failNext = false;
        throw new Error('injected audit failure');
      }
      return real.recordAccountAction(...args);
    },
  };
});

describe('account settings writes (D#31 API-7d, real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;

  const ctxFor = (principal: { accountId: string; userId: string }): BillingCtx => ({ pool: platformOpsPool, principal });

  async function auditRows(accountId: string) {
    const { rows } = await admin.query<{ actor: string; action: string; payload: Record<string, unknown> }>(
      `SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'account.%' ORDER BY created_at, id`,
      [accountId],
    );
    return rows;
  }
  async function column(accountId: string, name: 'model_budget_usd_month' | 'share_public_figures'): Promise<unknown> {
    const { rows } = await admin.query(`SELECT ${name} AS v FROM accounts WHERE id = $1`, [accountId]);
    return rows[0].v;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
  });
  beforeEach(() => {
    state.failNext = false;
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  it('setAccountBudgets writes the budget and one account.budgets_changed row: actor, before, after', async () => {
    const me = await seedAccountWithMember(admin, 'owner');
    const result = await setAccountBudgets(ctxFor(me), { accountId: me.accountId, modelUsdMonth: 250.5 });
    expect(result).toEqual({ ok: true, before: { model_usd_month: 0 }, after: { model_usd_month: 250.5 } });
    expect(Number(await column(me.accountId, 'model_budget_usd_month'))).toBe(250.5);
    const rows = await auditRows(me.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'account.budgets_changed',
      actor: me.userId,
      payload: { before: { model_usd_month: 0 }, after: { model_usd_month: 250.5 } },
    });
  });

  it('setSharePublicFigures writes the flag and one account.share_public_figures_changed row', async () => {
    const me = await seedAccountWithMember(admin, 'admin');
    const result = await setSharePublicFigures(ctxFor(me), { accountId: me.accountId, value: true });
    expect(result).toEqual({ ok: true, before: false, after: true });
    expect(await column(me.accountId, 'share_public_figures')).toBe(true);
    const rows = await auditRows(me.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'account.share_public_figures_changed',
      actor: me.userId,
      payload: { before: false, after: true },
    });
  });

  it('the same value again still writes exactly one more row (the PATCH exception to rows-only-on-change), budgets', async () => {
    const me = await seedAccountWithMember(admin, 'owner');
    await setAccountBudgets(ctxFor(me), { accountId: me.accountId, modelUsdMonth: 40 });
    expect(await setAccountBudgets(ctxFor(me), { accountId: me.accountId, modelUsdMonth: 40 })).toMatchObject({
      ok: true,
      before: { model_usd_month: 40 },
      after: { model_usd_month: 40 },
    });
    const rows = await auditRows(me.accountId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload).toEqual({ before: { model_usd_month: 40 }, after: { model_usd_month: 40 } });
  });

  it('the same value again still writes exactly one more row, share_public_figures', async () => {
    const me = await seedAccountWithMember(admin, 'owner');
    expect(await setSharePublicFigures(ctxFor(me), { accountId: me.accountId, value: false })).toMatchObject({ ok: true });
    const rows = await auditRows(me.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ before: false, after: false });
  });

  it('atomicity: if the audit step throws, setAccountBudgets leaves accounts unchanged and no row', async () => {
    const me = await seedAccountWithMember(admin, 'owner');
    await admin.query(`UPDATE accounts SET model_budget_usd_month = 12 WHERE id = $1`, [me.accountId]);
    state.failNext = true;
    await expect(setAccountBudgets(ctxFor(me), { accountId: me.accountId, modelUsdMonth: 99 })).rejects.toThrow(
      'injected audit failure',
    );
    expect(Number(await column(me.accountId, 'model_budget_usd_month'))).toBe(12);
    expect(await auditRows(me.accountId)).toHaveLength(0);
  });

  it('atomicity: if the audit step throws, setSharePublicFigures leaves accounts unchanged and no row', async () => {
    const me = await seedAccountWithMember(admin, 'owner');
    state.failNext = true;
    await expect(setSharePublicFigures(ctxFor(me), { accountId: me.accountId, value: true })).rejects.toThrow(
      'injected audit failure',
    );
    expect(await column(me.accountId, 'share_public_figures')).toBe(false);
    expect(await auditRows(me.accountId)).toHaveLength(0);
  });

  it('a plain member is refused with ForbiddenError and nothing is written', async () => {
    const me = await seedAccountWithMember(admin, 'member');
    await expect(setAccountBudgets(ctxFor(me), { accountId: me.accountId, modelUsdMonth: 5 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setSharePublicFigures(ctxFor(me), { accountId: me.accountId, value: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(Number(await column(me.accountId, 'model_budget_usd_month'))).toBe(0);
    expect(await column(me.accountId, 'share_public_figures')).toBe(false);
    expect(await auditRows(me.accountId)).toHaveLength(0);
  });

  it('a caller with no membership on the account gets account_not_found and nothing is written', async () => {
    const target = await seedAccountWithMember(admin, 'owner');
    const stranger = await seedAccountWithMember(admin, 'owner');
    const ctx = ctxFor({ accountId: target.accountId, userId: stranger.userId });
    expect(await setAccountBudgets(ctx, { accountId: target.accountId, modelUsdMonth: 5 })).toEqual({
      ok: false,
      reason: 'account_not_found',
    });
    expect(await setSharePublicFigures(ctx, { accountId: target.accountId, value: true })).toEqual({
      ok: false,
      reason: 'account_not_found',
    });
    expect(await auditRows(target.accountId)).toHaveLength(0);
  });

  it('an unknown account id is account_not_found', async () => {
    const me = await seedAccountWithMember(admin, 'owner');
    const ghost = randomUUID();
    expect(await setAccountBudgets(ctxFor(me), { accountId: ghost, modelUsdMonth: 5 })).toEqual({
      ok: false,
      reason: 'account_not_found',
    });
  });
});
