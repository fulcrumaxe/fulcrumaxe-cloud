import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { reserve, type ReserveParams } from '../src/reserve.js';
import { checkHeadroom } from '../src/headroom.js';
import { envelopeRunUsd, envelopeSpentUsd } from '../src/envelope.js';
import { EnvelopeWriteError, remainingAccountBudgetUsd, writeEnvelopeVersion } from '../src/envelopeWrite.js';
import { foregroundBudgetUsd } from '../src/plans.js';
import { seedAccount } from './helpers/seed.js';

/** D#483 S5-d: the spend envelope inside reserve(), against real Postgres and the app_user login the product uses. */
describe('approval envelopes', () => {
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

  async function fixture(amount: number | null, opts: { items?: number; kind?: 'small' | 'feature' } = {}) {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const userId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    const envelopeId = randomUUID();
    if (amount !== null) {
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', $3, 1, $4)`, [envelopeId, accountId, amount, userId]);
    }
    const items: string[] = [];
    for (let i = 0; i < (opts.items ?? 1); i += 1) {
      const id = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, envelope_id) VALUES ($1, $2, $3, 'internal', $4)`, [id, accountId, opts.kind ?? 'small', amount === null ? null : envelopeId]);
      items.push(id);
    }
    return { accountId, userId, envelopeId, items };
  }
  const run = async (accountId: string, workItemId: string, status = 'succeeded'): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', $4)`, [id, accountId, workItemId, status]);
    return id;
  };
  const ledger = (accountId: string, runId: string, usd: number, budget: 'model' | 'foreground_compute' = 'model') =>
    admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, $2, 'customer_gateway', $3, $4, $5)`, [accountId, budget === 'model' ? 'model' : 'compute', usd, runId, budget]);
  const ask = async (accountId: string, workItemId: string, extra: Partial<ReserveParams> = {}) => {
    const runId = await run(accountId, workItemId, 'pending');
    return { runId, result: await reserve(appUserPool, { ...base, ...extra, accountId, runId, workItemId }) };
  };
  const reservations = async (accountId: string, runId: string): Promise<number> =>
    Number((await admin.query('SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1 AND run_id = $2', [accountId, runId])).rows[0].n);

  it('S5d-1: app_user can read and add, never change or remove (versions, charges, asks), and cannot repoint an item', async () => {
    const f = await fixture(10);
    for (const sql of [
      `UPDATE approval_envelopes SET amount_usd = 999 WHERE account_id = $1`,
      `DELETE FROM approval_envelopes WHERE account_id = $1`,
      `UPDATE envelope_run_charges SET usd = 1 WHERE account_id = $1`,
      `DELETE FROM envelope_run_charges WHERE account_id = $1`,
      `UPDATE envelope_pause_asks SET envelope_version = 2 WHERE account_id = $1`,
      `DELETE FROM envelope_pause_asks WHERE account_id = $1`,
      `UPDATE work_items SET envelope_id = NULL WHERE account_id = $1`,
    ]) {
      await expect(withTenant(appUserPool, f.accountId, (c) => c.query(sql, [f.accountId]))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('S5d-2: a run whose reservation would pass the envelope is not reserved; spend stays within envelope + the run in flight', async () => {
    const f = await fixture(10);
    const item = f.items[0]!;
    await ledger(f.accountId, await run(f.accountId, item), 4); // settled
    const inFlight = await run(f.accountId, item, 'running');
    await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 3, 'open', 'model', 'run')`, [f.accountId, inFlight]);

    const over = await ask(f.accountId, item, { estimateModelUsd: 3.01 });
    expect(over.result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
    expect(await reservations(f.accountId, over.runId)).toBe(0);

    const exact = await ask(f.accountId, item, { estimateModelUsd: 3 });
    expect(exact.result.decision).toBe('admit');
    const spent = await withTenant(appUserPool, f.accountId, (c) => envelopeSpentUsd(c, f.accountId, f.envelopeId));
    expect(spent).toBeLessThanOrEqual(10);
    const next = await ask(f.accountId, item, { estimateModelUsd: 0.5 });
    expect(next.result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
  });

  it('counts compute as well as model, and the runs of every item on a batch envelope', async () => {
    const f = await fixture(10, { items: 2 });
    await ledger(f.accountId, await run(f.accountId, f.items[0]!), 2);
    await ledger(f.accountId, await run(f.accountId, f.items[1]!), 5, 'foreground_compute');
    expect((await ask(f.accountId, f.items[0]!, { estimateModelUsd: 3 })).result.decision).toBe('admit');
    expect((await ask(f.accountId, f.items[1]!, { estimateModelUsd: 0.5 })).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
  });

  it('two runs racing on one batch envelope cannot both pass (the per-envelope lock)', async () => {
    const f = await fixture(10, { items: 2 });
    const runs = await Promise.all(Array.from({ length: 12 }, (_, i) => run(f.accountId, f.items[i % 2]!, 'pending')));
    const results = await Promise.all(runs.map((runId, i) => reserve(appUserPool, { ...base, accountId: f.accountId, runId, workItemId: f.items[i % 2]! })));
    expect(results.filter((r) => r.decision === 'admit')).toHaveLength(3);
    expect(results.filter((r) => r.decision === 'deny' && r.reason === 'envelope_exceeded')).toHaveLength(9);
  });

  it('12 concurrent subscription runs (no model estimate) on one batch envelope: exactly 3 admitted. Only the per-envelope lock serialises these, since they take no budget lock', async () => {
    const f = await fixture(10, { items: 2 });
    const runs = await Promise.all(Array.from({ length: 12 }, (_, i) => run(f.accountId, f.items[i % 2]!, 'pending')));
    const results = await Promise.all(
      runs.map((runId, i) => reserve(appUserPool, { plan: 'starter', estimateModelUsd: 0, envelopeFloorUsd: 3, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40, modelBrokeredBy: 'operator_subscription', accountId: f.accountId, runId, workItemId: f.items[i % 2]! })),
    );
    expect(results.filter((r) => r.decision === 'admit')).toHaveLength(3);
    expect(results.filter((r) => r.decision === 'deny' && r.reason === 'envelope_exceeded')).toHaveLength(9);
  });

  describe('exact-cent boundaries (money is compared in whole ten-thousandths, never as binary fractions)', () => {
    const both = async (f: { accountId: string; items: string[] }, p: Partial<ReserveParams>) => {
      const head = await checkHeadroom(appUserPool, { ...base, ...p, accountId: f.accountId, workItemId: f.items[0]! });
      const real = (await ask(f.accountId, f.items[0]!, p)).result;
      expect(real.decision).toBe(head.decision);
      return real.decision;
    };
    it('0.10 settled + a 0.20 run fits a 0.30 envelope; one ten-thousandth more does not', async () => {
      const f = await fixture(0.3);
      await ledger(f.accountId, await run(f.accountId, f.items[0]!), 0.1);
      expect(await both(f, { estimateModelUsd: 0.2001 })).toBe('deny');
      expect(await both(f, { estimateModelUsd: 0.2 })).toBe('admit');
    });
    it('a run made of 0.1 model + 0.2 compute (0.30000000000000004 in floating point) fits a 0.30 envelope', async () => {
      const f = await fixture(0.3);
      expect(await both(f, { estimateModelUsd: 0.1, estimateComputeUsd: 0.2, trigger: 'foreground' })).toBe('admit');
      const g = await fixture(0.3);
      expect(await both(g, { estimateModelUsd: 0.1001, estimateComputeUsd: 0.2, trigger: 'foreground' })).toBe('deny');
    });
    it('a no-model run priced 0.1 plus compute 0.2 fits 0.30, and its charge is the exact floor', async () => {
      const f = await fixture(0.3);
      const a = await ask(f.accountId, f.items[0]!, { estimateModelUsd: 0, envelopeFloorUsd: 0.1, estimateComputeUsd: 0.2, trigger: 'foreground' });
      expect(a.result.decision).toBe('admit');
      expect((await admin.query('SELECT usd::text FROM envelope_run_charges WHERE run_id = $1', [a.runId])).rows).toEqual([{ usd: '0.1000' }]);
    });
    it('envelopeRunUsd sums in whole ten-thousandths', () => {
      expect(envelopeRunUsd({ estimateModelUsd: 0.1, estimateComputeUsd: 0.2 })).toBe(0.3);
      expect(envelopeRunUsd({ estimateModelUsd: 0, envelopeFloorUsd: 0.1, estimateComputeUsd: 0.2 })).toBe(0.3);
    });
  });

  it('replaces the plan cap for an item with an envelope; an item with none keeps the cap', async () => {
    const withEnv = await fixture(100, { kind: 'small' });
    await ledger(withEnv.accountId, await run(withEnv.accountId, withEnv.items[0]!), 55);
    expect((await ask(withEnv.accountId, withEnv.items[0]!, { estimateModelUsd: 12, workItemKind: 'small' })).result.decision).toBe('admit');
    const without = await fixture(null, { kind: 'small' });
    await ledger(without.accountId, await run(without.accountId, without.items[0]!), 55);
    expect((await ask(without.accountId, without.items[0]!, { estimateModelUsd: 12, workItemKind: 'small' })).result).toEqual({ decision: 'deny', reason: 'work_item_cap_exceeded' });
  });

  it('a new version of the envelope is the current amount: a raise clears the denial, a lowering brings it back', async () => {
    const f = await fixture(5);
    const item = f.items[0]!;
    await ledger(f.accountId, await run(f.accountId, item), 4);
    expect((await ask(f.accountId, item)).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', 50, 2, $3)`, [f.envelopeId, f.accountId, f.userId]);
    expect((await ask(f.accountId, item)).result.decision).toBe('admit');
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', 5, 3, $3)`, [f.envelopeId, f.accountId, f.userId]);
    expect((await ask(f.accountId, item)).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
  });

  it('fails closed: an envelope id with no row, and another account\'s envelope, deny', async () => {
    const f = await fixture(10);
    await admin.query('UPDATE work_items SET envelope_id = $1 WHERE id = $2', [randomUUID(), f.items[0]!]);
    expect((await ask(f.accountId, f.items[0]!)).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
    const other = await fixture(1000);
    await admin.query('UPDATE work_items SET envelope_id = $1 WHERE id = $2', [other.envelopeId, f.items[0]!]);
    expect((await ask(f.accountId, f.items[0]!)).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
  });

  describe('a run that reserves no model money (an operator subscription run)', () => {
    const noModel = { estimateModelUsd: 0 } as const;
    it('with no estimate it fails closed; with one it is charged to the envelope, once', async () => {
      const f = await fixture(10);
      const item = f.items[0]!;
      expect((await ask(f.accountId, item, noModel)).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
      const a = await ask(f.accountId, item, { ...noModel, envelopeFloorUsd: 4 });
      expect(a.result.decision).toBe('admit');
      expect((await admin.query('SELECT usd::text FROM envelope_run_charges WHERE run_id = $1', [a.runId])).rows).toEqual([{ usd: '4.0000' }]);
      expect((await ask(f.accountId, item, { ...noModel, envelopeFloorUsd: 4 })).result.decision).toBe('admit');
      expect((await ask(f.accountId, item, { ...noModel, envelopeFloorUsd: 4 })).result).toEqual({ decision: 'deny', reason: 'envelope_exceeded' });
    });
    it('a charge stops counting when its run never started (derived, nothing stamped)', async () => {
      const f = await fixture(10);
      const item = f.items[0]!;
      const a = await ask(f.accountId, item, { ...noModel, envelopeFloorUsd: 8 });
      expect(await withTenant(appUserPool, f.accountId, (c) => envelopeSpentUsd(c, f.accountId, f.envelopeId))).toBe(8);
      await admin.query(`UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1`, [a.runId]);
      expect(await withTenant(appUserPool, f.accountId, (c) => envelopeSpentUsd(c, f.accountId, f.envelopeId))).toBe(0);
      const b = await ask(f.accountId, item, { ...noModel, envelopeFloorUsd: 8 });
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [b.runId]);
      expect(await withTenant(appUserPool, f.accountId, (c) => envelopeSpentUsd(c, f.accountId, f.envelopeId))).toBe(0);
    });
    it('envelopeRunUsd: model + compute, or the floor + compute, or null', () => {
      expect(envelopeRunUsd({ estimateModelUsd: 3, estimateComputeUsd: 1, envelopeFloorUsd: 99 })).toBe(4);
      expect(envelopeRunUsd({ estimateModelUsd: 0, estimateComputeUsd: 1, envelopeFloorUsd: 2 })).toBe(3);
      expect(envelopeRunUsd({ estimateModelUsd: 0 })).toBeNull();
      expect(envelopeRunUsd({ estimateModelUsd: 0, envelopeFloorUsd: 0 })).toBeNull();
    });
  });

  describe('checkHeadroom is the same check, and writes nothing', () => {
    it('gives the same answer as reserve() on both sides of the edge and writes no row', async () => {
      const f = await fixture(10);
      const item = f.items[0]!;
      await ledger(f.accountId, await run(f.accountId, item), 7);
      for (const [estimate, expected] of [[3, 'admit'], [3.01, 'deny']] as const) {
        const answer = await checkHeadroom(appUserPool, { ...base, estimateModelUsd: estimate, accountId: f.accountId, workItemId: item });
        expect(answer.decision).toBe(expected);
        if (answer.decision === 'deny') expect(answer.reason).toBe('envelope_exceeded');
        const real = (await ask(f.accountId, item, { estimateModelUsd: estimate })).result;
        expect(real.decision).toBe(answer.decision);
      }
      const noModel = await checkHeadroom(appUserPool, { ...base, estimateModelUsd: 0, envelopeFloorUsd: 2, accountId: f.accountId, workItemId: item });
      expect(noModel).toEqual({ decision: 'deny', reason: 'envelope_exceeded' }); // the admitted $3 above already holds the last of the envelope
      expect((await admin.query('SELECT count(*)::int AS n FROM envelope_run_charges WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(0);
    });
  });

  describe('the writer', () => {
    const asPerson = async <T>(accountId: string, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
      const c = await appUserPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
        await c.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    };

    it('S5d-4: an amount above what the account can still spend is refused over_account_budget, and nothing is written', async () => {
      const f = await fixture(null);
      const remaining = await asPerson(f.accountId, f.userId, (c) => remainingAccountBudgetUsd(c, f.accountId));
      expect(remaining).toBe(foregroundBudgetUsd('starter')); // no model budget set on the fixture account
      await expect(asPerson(f.accountId, f.userId, (c) => writeEnvelopeVersion(c, { accountId: f.accountId, scope: 'item', amountUsd: remaining + 0.01 }))).rejects.toMatchObject({ code: 'over_account_budget' });
      expect((await admin.query('SELECT count(*)::int AS n FROM approval_envelopes WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(0);
      const ok = await asPerson(f.accountId, f.userId, (c) => writeEnvelopeVersion(c, { accountId: f.accountId, scope: 'item', amountUsd: remaining }));
      expect(ok.version).toBe(1);
    });

    it('the remaining budget is model left plus foreground compute left, with open reservations counted as spent', async () => {
      const f = await fixture(null);
      await admin.query('UPDATE accounts SET model_budget_usd_month = 20 WHERE id = $1', [f.accountId]);
      const item = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'small', 'internal')`, [item, f.accountId]);
      const r = await run(f.accountId, item);
      await ledger(f.accountId, r, 12);
      await ledger(f.accountId, r, foregroundBudgetUsd('starter') - 1, 'foreground_compute');
      await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 3, 'open', 'model', 'run')`, [f.accountId, r]);
      expect(await asPerson(f.accountId, f.userId, (c) => remainingAccountBudgetUsd(c, f.accountId))).toBe(5 + 1);
      const w = (amountUsd: number) => asPerson(f.accountId, f.userId, (c) => writeEnvelopeVersion(c, { accountId: f.accountId, scope: 'item', amountUsd }));
      await expect(w(6.01)).rejects.toBeInstanceOf(EnvelopeWriteError);
      expect((await w(6)).version).toBe(1);
    });

    it('writes version 1, then 2 under the same id; the highest version is current; a stranger id is envelope_not_found', async () => {
      const f = await fixture(null);
      const w = (extra: Partial<Parameters<typeof writeEnvelopeVersion>[1]>) => asPerson(f.accountId, f.userId, (c) => writeEnvelopeVersion(c, { accountId: f.accountId, scope: 'batch', amountUsd: 5, ...extra }));
      const v1 = await w({});
      const v2 = await w({ envelopeId: v1.envelopeId, amountUsd: 8, marginPct: 25 });
      expect(v2).toEqual({ envelopeId: v1.envelopeId, version: 2 });
      const rows = (await admin.query('SELECT version, amount_usd::text, created_by FROM approval_envelopes WHERE id = $1 ORDER BY version', [v1.envelopeId])).rows;
      expect(rows).toEqual([{ version: 1, amount_usd: '5.0000', created_by: f.userId }, { version: 2, amount_usd: '8.0000', created_by: f.userId }]);
      await expect(w({ envelopeId: randomUUID() })).rejects.toMatchObject({ code: 'envelope_not_found' });
      await expect(w({ amountUsd: -1 })).rejects.toMatchObject({ code: 'invalid_amount' });
      await expect(w({ amountUsd: Number.NaN })).rejects.toMatchObject({ code: 'invalid_amount' });
    });

    it('two writers racing to the same next version: one wins, the other gets version_conflict', async () => {
      const f = await fixture(10);
      // The writers must both have read version 1 before either inserts version 2. Without that, one can finish before the other starts, and the
      // second then legitimately writes version 3 (two successes, not a race). So each writer waits at its INSERT until both have reached it.
      let arrived = 0;
      let release!: () => void;
      const both = new Promise<void>((resolve) => { release = resolve; });
      const gated = (c: PoolClient): PoolClient =>
        new Proxy(c, {
          get(target, prop, receiver) {
            if (prop !== 'query') return Reflect.get(target, prop, receiver);
            return async (...args: unknown[]) => {
              if (typeof args[0] === 'string' && args[0].includes('INSERT INTO approval_envelopes')) {
                arrived += 1;
                if (arrived === 2) release();
                await both;
              }
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      const results = await Promise.allSettled([1, 2].map(() => asPerson(f.accountId, f.userId, (c) => writeEnvelopeVersion(gated(c), { accountId: f.accountId, envelopeId: f.envelopeId, scope: 'batch', amountUsd: 6 }))));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected' && (r.reason as EnvelopeWriteError).code === 'version_conflict')).toHaveLength(1);
    });

    it('only an owner or admin of the account can write, and only as themselves', async () => {
      const f = await fixture(null);
      const member = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [f.accountId, member]);
      await expect(asPerson(f.accountId, member, (c) => writeEnvelopeVersion(c, { accountId: f.accountId, scope: 'item', amountUsd: 1 }))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appUserPool, f.accountId, (c) => writeEnvelopeVersion(c, { accountId: f.accountId, scope: 'item', amountUsd: 1 }))).rejects.toBeDefined(); // no session user at all
      expect((await admin.query('SELECT count(*)::int AS n FROM approval_envelopes WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(0);
    });
  });
});
