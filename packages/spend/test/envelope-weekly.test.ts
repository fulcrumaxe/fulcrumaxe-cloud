import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { envelopeAdmits, envelopeSpentUsd, spendSince, weekStartUtc } from '../src/envelope.js';
import { readAutostart } from '../src/envelopeSettings.js';
import { seedAccount } from './helpers/seed.js';

const DAY = 24 * 3600 * 1000;

describe('weekStartUtc (D#483 S5-e2: the weekly auto-start envelope renews Monday 00:00 UTC)', () => {
  it.each([
    ['Monday 00:00:00.000 is its own week start', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z'],
    ['Sunday 23:59:59.999 still belongs to the week before', '2026-10-11T23:59:59.999Z', '2026-10-05T00:00:00.000Z'],
    ['Monday 00:00:00.001', '2026-10-12T00:00:00.001Z', '2026-10-12T00:00:00.000Z'],
    ['Wednesday noon', '2026-10-14T12:34:56.000Z', '2026-10-12T00:00:00.000Z'],
    ['crossing a month end', '2026-11-01T10:00:00.000Z', '2026-10-26T00:00:00.000Z'],
    ['crossing a year end', '2027-01-01T10:00:00.000Z', '2026-12-28T00:00:00.000Z'],
    ['leap day', '2028-02-29T10:00:00.000Z', '2028-02-28T00:00:00.000Z'],
  ])('%s', (_label, now, expected) => {
    expect(weekStartUtc(new Date(now)).toISOString()).toBe(expected);
  });

  it('does not depend on the process time zone', () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = tz;
        expect(weekStartUtc(new Date('2026-10-11T23:59:59.999Z')).toISOString(), tz).toBe('2026-10-05T00:00:00.000Z');
        expect(weekStartUtc(new Date('2026-10-12T00:00:00.000Z')).toISOString(), tz).toBe('2026-10-12T00:00:00.000Z');
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

/** D#483 S5-e2: the weekly auto-start envelope renews every Monday 00:00 UTC and nothing rolls over, in the check reserve() and headroom() share. */
describe('the weekly auto-start envelope renews, with no rollover', () => {
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

  // A Wednesday, so "this week" began on Monday 2026-10-12 and "last week" on 2026-10-05.
  const WED = new Date('2026-10-14T12:00:00.000Z');
  const MON_NEXT = new Date('2026-10-19T00:00:00.000Z');

  async function fixture(scope: 'weekly_autostart' | 'item', amount: number) {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const userId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, $3, $4, 1, $5)`, [envelopeId, accountId, scope, amount, userId]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, envelope_id) VALUES ($1, $2, 'small', 'internal', $3)`, [itemId, accountId, envelopeId]);
    return { accountId, envelopeId, itemId };
  }
  async function spendAt(f: { accountId: string; itemId: string }, usd: number, at: Date): Promise<void> {
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'succeeded')`, [runId, f.accountId, f.itemId]);
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, created_at) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model', $4)`, [f.accountId, usd, runId, at]);
  }
  const admits = (f: { accountId: string; envelopeId: string }, runUsd: number, now: Date) =>
    withTenant(appUserPool, f.accountId, (c) => envelopeAdmits(c, f.accountId, f.envelopeId, runUsd, now));
  const spent = (f: { accountId: string; envelopeId: string }, now: Date) => withTenant(appUserPool, f.accountId, (c) => envelopeSpentUsd(c, f.accountId, f.envelopeId, now));

  it('spend before Monday 00:00 UTC does not count against this week, and spend after it does', async () => {
    const f = await fixture('weekly_autostart', 10);
    await spendAt(f, 9, new Date('2026-10-11T23:59:59.000Z')); // last week, a second before the renewal
    expect(await spent(f, WED)).toBe(0);
    expect(await admits(f, 10, WED)).toBe(true);
    await spendAt(f, 8, new Date('2026-10-12T00:00:00.000Z')); // this week, the instant it began
    expect(await spent(f, WED)).toBe(8);
    expect(await admits(f, 2, WED)).toBe(true);
    expect(await admits(f, 2.0001, WED)).toBe(false);
  });

  it('no rollover: an unspent week gives the next week the same amount, not more', async () => {
    const f = await fixture('weekly_autostart', 10);
    // Nothing was spent last week or this week; next week still admits 10 and refuses 10.0001.
    expect(await admits(f, 10, MON_NEXT)).toBe(true);
    expect(await admits(f, 10.0001, MON_NEXT)).toBe(false);
    expect(await admits(f, 20, MON_NEXT)).toBe(false);
  });

  it('the week turning over frees what the last week spent', async () => {
    const f = await fixture('weekly_autostart', 10);
    await spendAt(f, 10, new Date('2026-10-14T09:00:00.000Z'));
    expect(await admits(f, 0.0001, WED)).toBe(false);
    expect(await admits(f, 10, new Date(MON_NEXT.getTime() - 1))).toBe(false);
    expect(await admits(f, 10, MON_NEXT)).toBe(true);
    expect(await spent(f, MON_NEXT)).toBe(0);
  });

  it('an item or batch envelope is not windowed: all of its spend counts, however old', async () => {
    const f = await fixture('item', 10);
    await spendAt(f, 9, new Date(WED.getTime() - 40 * DAY));
    expect(await spent(f, WED)).toBe(9);
    expect(await admits(f, 1.0001, WED)).toBe(false);
    expect(await withTenant(appUserPool, f.accountId, (c) => spendSince(c, f.accountId, f.envelopeId, WED))).toBe('-infinity');
  });

  it('an envelope with no row counts everything and fails closed (never admits)', async () => {
    const f = await fixture('weekly_autostart', 10);
    expect(await withTenant(appUserPool, f.accountId, (c) => envelopeAdmits(c, f.accountId, randomUUID(), 1, WED))).toBe(false);
  });

  it('readAutostart reports this week\'s spend and what is left, and the Monday it renews', async () => {
    const f = await fixture('weekly_autostart', 10);
    await spendAt(f, 7, new Date('2026-10-05T10:00:00.000Z'));
    await spendAt(f, 4, new Date('2026-10-13T10:00:00.000Z'));
    const state = await withTenant(appUserPool, f.accountId, (c) => readAutostart(c, f.accountId, WED));
    expect(state).toMatchObject({ envelopeId: f.envelopeId, version: 1, amountUsd: 10, enabled: true, spentThisWeekUsd: 4, remainingThisWeekUsd: 6 });
    expect(state.weekStartsAt.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(state.renewsAt.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    const next = await withTenant(appUserPool, f.accountId, (c) => readAutostart(c, f.accountId, MON_NEXT));
    expect(next).toMatchObject({ spentThisWeekUsd: 0, remainingThisWeekUsd: 10 });
  });
});
