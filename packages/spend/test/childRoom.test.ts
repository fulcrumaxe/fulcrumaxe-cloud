import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { childEnvelopeRoom } from '../src/childRoom.js';
import { envelopeLockKey } from '../src/envelope.js';
import { seedAccount } from './helpers/seed.js';

/**
 * [pg] D#483 S5-b2c-1: what is left of a parent's envelope for a planned PR child's first run, decided under the envelope's own lock. The spend is the one sum
 * reserve() uses; every other launched item that has not started a run is spoken for.
 */
describe('childEnvelopeRoom', () => {
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

  async function fixture(amount = 3) {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const userId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', $3, 1, $4)`, [envelopeId, accountId, amount, userId]);
    const item = async (stage = 'triaged', withEnvelope = true) =>
      (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, kind, provenance, envelope_id, stage) VALUES ($1, 'small', 'internal', $2, $3) RETURNING id`, [accountId, withEnvelope ? envelopeId : null, stage])).rows[0]!.id;
    const parent = await item('spec_ready');
    const child = await item('triaged', false);
    return { accountId, envelopeId, item, parent, child };
  }
  const room = (f: { accountId: string; envelopeId: string; child: string }, firstRunUsd: number) =>
    withTenant(appUserPool, f.accountId, (c) => childEnvelopeRoom(c, { accountId: f.accountId, envelopeId: f.envelopeId, childId: f.child, firstRunUsd }));

  it('an unspent envelope has its whole amount; the price decides whether it fits, to the ten-thousandth', async () => {
    const f = await fixture(3);
    expect(await room(f, 1)).toEqual({ fits: true, remainingUsd: 3, pendingItems: 0 });
    expect(await room(f, 3)).toMatchObject({ fits: true });
    expect(await room(f, 3.0001)).toMatchObject({ fits: false, remainingUsd: 3 });
  });

  it('counts what the envelope\'s items have spent (the ledger), exactly: $0.10 spent leaves room for a $0.20 run in a $0.30 envelope', async () => {
    const f = await fixture(0.3);
    const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'succeeded') RETURNING id`, [f.accountId, f.parent])).rows[0]!.id;
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', 0.1, $2)`, [f.accountId, run]);
    expect(await room(f, 0.2)).toMatchObject({ fits: true, remainingUsd: 0.2 });
    expect(await room(f, 0.2001)).toMatchObject({ fits: false });
  });

  it('every OTHER launched item that has not started a run is spoken for, so a second launch sees the first', async () => {
    const f = await fixture(1.5);
    expect(await room(f, 1)).toMatchObject({ fits: true, pendingItems: 0 });
    const sibling = await f.item('triaged');
    const after = await room(f, 1);
    expect(after).toMatchObject({ fits: false, pendingItems: 1 });
    expect(after.remainingUsd).toBeCloseTo(0.5, 6);
    // An item that started a run is no longer pending: its spend and reservations are in the sum.
    await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`, [f.accountId, sibling]);
    expect(await room(f, 1)).toMatchObject({ fits: true, pendingItems: 0 });
    // A cancelled run does not start an item: a cancelled sibling is pending again.
    const other = await f.item('triaged');
    await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'cancelled')`, [f.accountId, other]);
    expect(await room(f, 1)).toMatchObject({ pendingItems: 1 });
  });

  it('fails closed: no such envelope, a price that is not a positive number', async () => {
    const f = await fixture();
    expect(await withTenant(appUserPool, f.accountId, (c) => childEnvelopeRoom(c, { accountId: f.accountId, envelopeId: randomUUID(), childId: f.child, firstRunUsd: 1 }))).toMatchObject({ fits: false, remainingUsd: 0 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.00001]) expect(await room(f, bad), String(bad)).toMatchObject({ fits: false });
  });

  it('waits for the envelope\'s lock, the one reserve() takes', async () => {
    const f = await fixture();
    const holder = await adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [envelopeLockKey(f.accountId, f.envelopeId)]);
      let done = false;
      const pending = room(f, 1).then((r) => {
        done = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done).toBe(false);
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({ fits: true });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
