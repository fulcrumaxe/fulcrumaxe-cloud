import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { readCronLastTicks, recordCronConnected } from '../src/cronLastTick.js';

/**
 * CRON-OBS-1: cron_last_tick (0926) against real Postgres: platform_ops writes and reads it, app_user cannot touch it, an upsert never moves a
 * time backwards, and the column checks refuse a malformed sweep name.
 */
describe('cron_last_tick (0926)', () => {
  let admin: Pool;
  let platformOps: Pool;
  let appUser: Pool;

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
    await appUser.end();
  });
  beforeEach(async () => {
    await admin.query('DELETE FROM cron_last_tick');
  });

  const T0 = Date.parse('2026-10-27T12:00:00Z');

  it('inserts a row on the first connect and updates the same row on the next', async () => {
    await recordCronConnected(platformOps, 'api-sweep', T0);
    await recordCronConnected(platformOps, 'api-sweep', T0 + 60_000);
    await recordCronConnected(platformOps, 'reconcile', T0);
    const rows = await readCronLastTicks(platformOps);
    expect([...rows.keys()].sort()).toEqual(['api-sweep', 'reconcile']);
    expect(rows.get('api-sweep')).toEqual({ sweep: 'api-sweep', lastTickAt: T0 + 60_000, lastConnectedAt: T0 + 60_000 });
    expect((await admin.query('SELECT count(*)::int AS n FROM cron_last_tick')).rows[0].n).toBe(2);
  });

  it('never moves a time backwards (an instance with a slow clock)', async () => {
    await recordCronConnected(platformOps, 'api-sweep', T0 + 120_000);
    await recordCronConnected(platformOps, 'api-sweep', T0);
    expect((await readCronLastTicks(platformOps)).get('api-sweep')!.lastConnectedAt).toBe(T0 + 120_000);
  });

  it('refuses a malformed sweep name', async () => {
    await expect(recordCronConnected(platformOps, 'Bad Name; drop', T0)).rejects.toThrow(/cron_last_tick_sweep_check|check constraint/i);
  });

  it('app_user can neither read nor write it (RLS forced, no grant)', async () => {
    await recordCronConnected(platformOps, 'api-sweep', T0);
    await expect(appUser.query('SELECT * FROM cron_last_tick')).rejects.toThrow(/permission denied/i);
    await expect(appUser.query(`INSERT INTO cron_last_tick VALUES ('x', now(), now())`)).rejects.toThrow(/permission denied/i);
  });

  it('platform_ops cannot delete rows (insert, select and update only)', async () => {
    await recordCronConnected(platformOps, 'api-sweep', T0);
    await expect(platformOps.query('DELETE FROM cron_last_tick')).rejects.toThrow(/permission denied/i);
  });
});
