import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@fx/core/src/tenancy/errors.js';
import { createPool } from '../src/pg.js';
import { pauseAccount, resumeAccount } from '../src/accountLifecycle.js';
import type { BillingCtx } from '../src/types.js';
import { seedAccountWithMember } from './helpers/seed.js';

// D#31 API-7c-1: pause/resume regain auditing through recordAccountAction.
// The mock passes every call through to the real helper unless a test arms
// `state.failNext`, which lets the atomicity test make the audit step throw
// after the accounts write has already run in the same transaction.
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

describe('pause / resume audit (D#31 API-7c-1, real Postgres)', () => {
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

  async function pausedAt(accountId: string): Promise<Date | null> {
    const { rows } = await admin.query(`SELECT owner_paused_at FROM accounts WHERE id = $1`, [accountId]);
    return rows[0].owner_paused_at;
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

  it('pause writes exactly one account.paused row: actor = the user, before/after status', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    expect(await pauseAccount(ctxFor({ accountId, userId }), { accountId })).toEqual({ ok: true });
    const rows = await auditRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'account.paused',
      actor: userId,
      payload: { before_status: 'active', after_status: 'paused' },
    });
  });

  it('pausing an already-paused account is a no-op: still ok, no new row', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    await pauseAccount(ctxFor({ accountId, userId }), { accountId });
    expect(await pauseAccount(ctxFor({ accountId, userId }), { accountId })).toEqual({ ok: true });
    expect(await auditRows(accountId)).toHaveLength(1);
  });

  it('resume writes exactly one account.resumed row, after_status read back after the trigger derived it', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'admin');
    await pauseAccount(ctxFor({ accountId, userId }), { accountId });
    expect(await resumeAccount(ctxFor({ accountId, userId }), { accountId })).toEqual({ ok: true });
    const rows = await auditRows(accountId);
    expect(rows.map((r) => r.action)).toEqual(['account.paused', 'account.resumed']);
    expect(rows[1]).toMatchObject({ actor: userId, payload: { before_status: 'paused', after_status: 'active' } });
  });

  it('resuming a paused-and-past-due account records after_status past_due', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    await admin.query(`UPDATE accounts SET past_due_since = now() WHERE id = $1`, [accountId]);
    await pauseAccount(ctxFor({ accountId, userId }), { accountId });
    await resumeAccount(ctxFor({ accountId, userId }), { accountId });
    const rows = await auditRows(accountId);
    expect(rows[1]!.payload).toMatchObject({ before_status: 'paused', after_status: 'past_due' });
  });

  it('a refused transition (resume when not paused) writes no row', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    expect(await resumeAccount(ctxFor({ accountId, userId }), { accountId })).toEqual({
      ok: false,
      reason: 'illegal_transition',
    });
    expect(await auditRows(accountId)).toHaveLength(0);
  });

  it('atomicity: if the audit step throws, pause rolls back (owner_paused_at unchanged, no row)', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    state.failNext = true;
    await expect(pauseAccount(ctxFor({ accountId, userId }), { accountId })).rejects.toThrow('injected audit failure');
    expect(await pausedAt(accountId)).toBeNull();
    expect(await auditRows(accountId)).toHaveLength(0);
  });

  it('atomicity: if the audit step throws, resume rolls back (still paused, only the pause row remains)', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    await pauseAccount(ctxFor({ accountId, userId }), { accountId });
    const paused = await pausedAt(accountId);
    expect(paused).not.toBeNull();
    state.failNext = true;
    await expect(resumeAccount(ctxFor({ accountId, userId }), { accountId })).rejects.toThrow('injected audit failure');
    expect(await pausedAt(accountId)).toEqual(paused);
    expect(await auditRows(accountId)).toHaveLength(1);
  });

  it('atomicity against the real function: an audit call the function itself rejects leaves the earlier accounts write rollback-able', async () => {
    // The function re-checks owner/admin on its own. A rejected call inside
    // a transaction that already wrote accounts must not leave that write
    // committed once the transaction is rolled back.
    const { accountId } = await seedAccountWithMember(admin, 'owner');
    const client = await platformOpsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [accountId]);
      await expect(
        client.query(`SELECT audit_write_account_action($1, $2, 'account.paused', '{}'::jsonb)`, [accountId, randomUUID()]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await pausedAt(accountId)).toBeNull();
  });

  it('a plain member is refused before any write or audit row', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'member');
    await expect(pauseAccount(ctxFor({ accountId, userId }), { accountId })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await pausedAt(accountId)).toBeNull();
    expect(await auditRows(accountId)).toHaveLength(0);
  });

  it("another account's owner cannot pause or leave a row on this account (two-tenant isolation)", async () => {
    const a = await seedAccountWithMember(admin, 'owner');
    const b = await seedAccountWithMember(admin, 'owner');
    expect(await pauseAccount(ctxFor({ accountId: a.accountId, userId: b.userId }), { accountId: a.accountId })).toEqual({
      ok: false,
      reason: 'account_not_found',
    });
    expect(await pausedAt(a.accountId)).toBeNull();
    expect(await auditRows(a.accountId)).toHaveLength(0);
    expect(await auditRows(b.accountId)).toHaveLength(0);
  });
});
