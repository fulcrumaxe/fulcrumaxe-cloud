import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { reserve, type ReserveParams } from '../src/reserve.js';
import { checkHeadroom } from '../src/headroom.js';
import { foregroundBudgetUsd } from '../src/plans.js';
import { seedAccount, seedModelConnectionOk, seedRun, seedRunWithWorkItem } from './helpers/seed.js';

/**
 * D#483 S5-k1b: checkHeadroom answers "would this reservation be admitted" with the arithmetic of reserve() and writes nothing.
 * Each case builds one real account state, asks both, and holds them to the same decision and the same denial reason. A case a future check of reserve() adds
 * must be added here; the matrix covers every denial reason reserve() has today plus the admit that sits right on each edge.
 */
describe('checkHeadroom: the read-only twin of reserve()', () => {
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

  type Params = Omit<ReserveParams, 'accountId' | 'runId'>;
  interface Case {
    name: string;
    expected: { decision: 'admit' } | { decision: 'deny'; reason: string };
    setup?: (accountId: string, workItemId: string) => Promise<void>;
    status?: 'active' | 'past_due' | 'paused';
    params: Params;
    withItem?: boolean;
  }

  const spendUsd = async (accountId: string, runId: string, usd: number, budget: 'model' | 'foreground_compute' = 'model'): Promise<void> => {
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, $2, 'customer_gateway', $3, $4, $5)`, [
      accountId,
      budget === 'model' ? 'model' : 'compute',
      usd,
      runId,
      budget,
    ]);
  };

  const attachEnvelope = async (accountId: string, workItemId: string, amount: number): Promise<void> => {
    const userId = randomUUID();
    const envelopeId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 1, $4)`, [envelopeId, accountId, amount, userId]);
    await admin.query('UPDATE work_items SET envelope_id = $1 WHERE id = $2', [envelopeId, workItemId]);
  };

  const seedConnection = async (accountId: string, status: 'ok' | 'broken', code: string | null): Promise<void> => {
    await admin.query(
      `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status, last_error_code)
       VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, $6, $7)`,
      [accountId, Buffer.from('ciphertext'), Buffer.from('nonce'), Buffer.from('wrapped'), `fp-${randomUUID()}`, status, code],
    );
  };

  const fgCap = foregroundBudgetUsd('starter');
  const base: Params = { plan: 'starter', estimateModelUsd: 10, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40 };

  const cases: Case[] = [
    { name: 'admit: room everywhere', expected: { decision: 'admit' }, params: base },
    { name: 'per_spawn_cap_exceeded', expected: { decision: 'deny', reason: 'per_spawn_cap_exceeded' }, params: { ...base, estimateModelUsd: 50, perSpawnCapUsd: 40 } },
    { name: 'admit: estimate exactly at the per-run limit', expected: { decision: 'admit' }, params: { ...base, estimateModelUsd: 40, perSpawnCapUsd: 40 } },
    {
      name: 'model_budget_exceeded',
      expected: { decision: 'deny', reason: 'model_budget_exceeded' },
      params: { ...base, monthlyModelBudgetUsd: 50 },
      setup: async (a) => {
        const r = randomUUID();
        await seedRun(admin, a, r);
        await spendUsd(a, r, 45);
      },
    },
    {
      name: 'admit: model budget exactly used up by the estimate',
      expected: { decision: 'admit' },
      params: { ...base, monthlyModelBudgetUsd: 50 },
      setup: async (a) => {
        const r = randomUUID();
        await seedRun(admin, a, r);
        await spendUsd(a, r, 40);
      },
    },
    {
      name: 'model_budget_exceeded by an OPEN reservation',
      expected: { decision: 'deny', reason: 'model_budget_exceeded' },
      params: { ...base, monthlyModelBudgetUsd: 50 },
      setup: async (a) => {
        const r = randomUUID();
        await seedRun(admin, a, r);
        await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 45, 'open', 'model', 'run')`, [a, r]);
      },
    },
    {
      name: 'work_item_cap_exceeded',
      expected: { decision: 'deny', reason: 'work_item_cap_exceeded' },
      withItem: true,
      params: { ...base, estimateModelUsd: 12, workItemKind: 'small' },
      setup: async (a, w) => {
        const r = randomUUID();
        await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [r, a, w]);
        await spendUsd(a, r, 55);
      },
    },
    {
      name: 'envelope_exceeded (D#483 S5-d: the item\'s spend envelope, which replaces the item cap)',
      expected: { decision: 'deny', reason: 'envelope_exceeded' },
      withItem: true,
      params: { ...base, estimateModelUsd: 12, workItemKind: 'small' },
      setup: async (a, w) => attachEnvelope(a, w, 10),
    },
    {
      name: 'admit: inside the envelope even where the item cap would have refused',
      expected: { decision: 'admit' },
      withItem: true,
      params: { ...base, estimateModelUsd: 12, workItemKind: 'small' },
      setup: async (a, w) => {
        await attachEnvelope(a, w, 12);
        const r = randomUUID();
        await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [r, a, w]);
        await spendUsd(a, r, 0);
      },
    },
    {
      name: 'compute_cap_exceeded',
      expected: { decision: 'deny', reason: 'compute_cap_exceeded' },
      params: { ...base, trigger: 'foreground', estimateComputeUsd: 5 },
      setup: async (a) => {
        const r = randomUUID();
        await seedRun(admin, a, r);
        await spendUsd(a, r, fgCap - 1, 'foreground_compute');
      },
    },
    {
      name: 'admit: compute exactly at the cap',
      expected: { decision: 'admit' },
      params: { ...base, trigger: 'foreground', estimateComputeUsd: 5 },
      setup: async (a) => {
        const r = randomUUID();
        await seedRun(admin, a, r);
        await spendUsd(a, r, fgCap - 5, 'foreground_compute');
      },
    },
    {
      name: 'model_credits_exhausted (D#483 S5-k2: the connection is broken for out-of-credit)',
      expected: { decision: 'deny', reason: 'model_credits_exhausted' },
      params: base,
      setup: async (a) => seedConnection(a, 'broken', 'credits_exhausted'),
    },
    {
      name: 'admit: connection broken for credits but the run draws no model estimate (compute only)',
      expected: { decision: 'admit' },
      params: { ...base, estimateModelUsd: 0, trigger: 'foreground', estimateComputeUsd: 1 },
      setup: async (a) => seedConnection(a, 'broken', 'credits_exhausted'),
    },
    {
      name: 'admit: the credits connection reads ok again (the pause lifts with no person action)',
      expected: { decision: 'admit' },
      params: base,
      setup: async (a) => seedConnection(a, 'ok', null),
    },
    {
      name: 'admit: a connection broken for a rejected key is not the credits pause (the account stop owns that)',
      expected: { decision: 'admit' },
      params: base,
      setup: async (a) => seedConnection(a, 'broken', '401'),
    },
    {
      name: 'model_connection_not_ok still wins for a preview even when broken for credits',
      expected: { decision: 'deny', reason: 'model_connection_not_ok' },
      params: { ...base, purpose: 'preview' },
      setup: async (a) => seedConnection(a, 'broken', 'credits_exhausted'),
    },
    { name: 'account_not_active (paused)', expected: { decision: 'deny', reason: 'account_not_active' }, status: 'paused', params: base },
    { name: 'admit: past_due inside the seven day grace', expected: { decision: 'admit' }, status: 'past_due', params: base },
    { name: 'model_connection_not_ok (preview, no connection)', expected: { decision: 'deny', reason: 'model_connection_not_ok' }, params: { ...base, purpose: 'preview' } },
    {
      name: 'admit: preview with an ok connection',
      expected: { decision: 'admit' },
      params: { ...base, purpose: 'preview' },
      setup: async (a) => seedModelConnectionOk(admin, a),
    },
  ];

  it.each(cases)('$name', async (c) => {
    const accountId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(admin, accountId, c.status ? { status: c.status } : {});
    if (c.withItem) await seedRunWithWorkItem(admin, accountId, randomUUID(), workItemId, 'small');
    await c.setup?.(accountId, workItemId);
    const params: Params = { ...c.params, ...(c.withItem ? { workItemId } : {}) };

    const answer = await checkHeadroom(appUserPool, { ...params, accountId });
    expect(answer.decision).toBe(c.expected.decision);
    if (c.expected.decision === 'deny') expect(answer).toEqual({ decision: 'deny', reason: c.expected.reason });

    // The same state, asked of reserve(), gives the same answer.
    const runId = randomUUID();
    await seedRun(admin, accountId, runId);
    const real = await reserve(appUserPool, { ...params, accountId, runId });
    expect(real.decision).toBe(answer.decision);
    if (real.decision === 'deny') expect(real).toEqual({ decision: 'deny', reason: (answer as { reason: string }).reason });
  });

  it('writes nothing: no reservation row, no budget.exhausted event, however many times it is asked', async () => {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(admin, accountId);
    await seedRun(admin, accountId, runId);
    await spendUsd(accountId, runId, 45);
    const denied: Params = { ...base, monthlyModelBudgetUsd: 50 };
    for (let i = 0; i < 3; i += 1) expect(await checkHeadroom(appUserPool, { ...denied, accountId })).toEqual({ decision: 'deny', reason: 'model_budget_exceeded' });
    const admitted = await checkHeadroom(appUserPool, { ...base, accountId });
    expect(admitted).toEqual({ decision: 'admit', reservations: [] });

    const reservations = await admin.query(`SELECT count(*)::text AS n FROM spend_reservations WHERE account_id = $1`, [accountId]);
    expect(reservations.rows[0].n).toBe('0');
    const events = await admin.query(`SELECT count(*)::text AS n FROM domain_events WHERE account_id = $1`, [accountId]);
    expect(events.rows[0].n).toBe('0');
  });

  it('runs in a READ ONLY transaction: a write attempted on its connection is refused by the database', async () => {
    // The mechanism the claim above rests on, proved directly: the same BEGIN READ ONLY the function opens refuses an insert.
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const client = await appUserPool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
      await expect(client.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', 'model', 'run')`, [accountId, randomUUID()])).rejects.toThrow(/read-only/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('checkHeadroom itself opens a READ ONLY transaction: a write on the connection it uses, mid-check, is refused by the database', async () => {
    // The pool handed in wraps each client so that, when the function reads the account row, the same connection first tries an insert. If the
    // function's BEGIN lost its READ ONLY the insert would succeed and `refusal` would stay null.
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    let refusal: string | null = null;
    let attempted = false;
    const spy = {
      connect: async () => {
        const client = await appUserPool.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...a: unknown[]) => {
          if (typeof a[0] === 'string' && a[0].includes('FROM accounts WHERE id')) {
            attempted = true;
            await original('SAVEPOINT probe_write');
            try {
              await original(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', 'model', 'run')`, [accountId, randomUUID()]);
            } catch (err) {
              refusal = (err as { message: string }).message;
            }
            await original('ROLLBACK TO SAVEPOINT probe_write');
          }
          return original(...a);
        };
        return client;
      },
    } as unknown as Pool;
    const answer = await checkHeadroom(spy, { ...base, accountId });
    expect(answer).toEqual({ decision: 'admit', reservations: [] });
    expect(attempted).toBe(true);
    expect(refusal).toMatch(/read-only/i);
    const rows = await admin.query(`SELECT count(*)::text AS n FROM spend_reservations WHERE account_id = $1`, [accountId]);
    expect(rows.rows[0].n).toBe('0');
  });
});
