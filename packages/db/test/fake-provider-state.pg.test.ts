import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { randomBytes } from 'node:crypto';
import { FakeProviderStateFull, withFakeProviderState } from '../src/fakeProviderState.js';

/** D#845 MC-13a: fake_provider_state (1064) against real Postgres: platform_ops only, row security forced, no tenant access, changes serialised under a row lock. */
describe('fake_provider_state (1064)', () => {
  let admin: Pool;
  let platformOps: Pool;
  let appUser: Pool;

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await Promise.all([admin.end(), platformOps.end(), appUser.end()]);
  });
  beforeEach(async () => {
    await admin.query('DELETE FROM fake_provider_state');
  });

  const empty = () => ({ n: 0 });

  it('forces row security and grants platform_ops select, insert and update only', async () => {
    const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'fake_provider_state'`);
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await withFakeProviderState(platformOps, 'hetzner', empty, (s) => { s.n = 1; });
    await expect(platformOps.query('DELETE FROM fake_provider_state')).rejects.toThrow(/permission denied/i);
  });

  it('keeps the document across calls, and a second call sees the first', async () => {
    await withFakeProviderState(platformOps, 'hetzner', empty, (s) => { s.n = 5; });
    expect(await withFakeProviderState(platformOps, 'hetzner', empty, (s) => s.n)).toBe(5);
  });

  it('serialises concurrent changes under the row lock (no lost update)', async () => {
    await Promise.all(Array.from({ length: 12 }, () => withFakeProviderState(platformOps, 'hetzner', empty, (s) => { s.n += 1; })));
    expect(await withFakeProviderState(platformOps, 'hetzner', empty, (s) => s.n)).toBe(12);
  });

  it('rolls back a change whose callback throws', async () => {
    await withFakeProviderState(platformOps, 'hetzner', empty, (s) => { s.n = 2; });
    await expect(withFakeProviderState(platformOps, 'hetzner', empty, (s) => { s.n = 99; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withFakeProviderState(platformOps, 'hetzner', empty, (s) => s.n)).toBe(2);
  });

  it('gives tenants nothing: app_user can neither read nor write it', async () => {
    await withFakeProviderState(platformOps, 'hetzner', empty, (s) => { s.n = 1; });
    await expect(appUser.query('SELECT * FROM fake_provider_state')).rejects.toThrow(/permission denied/i);
    await expect(appUser.query(`INSERT INTO fake_provider_state (provider, state) VALUES ('hetzner', '{}')`)).rejects.toThrow(/permission denied/i);
    await expect(appUser.query(`UPDATE fake_provider_state SET state = '{}'`)).rejects.toThrow(/permission denied/i);
  });

  it('refuses an unknown provider and a non-object document', async () => {
    await expect(admin.query(`INSERT INTO fake_provider_state (provider, state) VALUES ('stripe', '{}')`)).rejects.toThrow(/check constraint/i);
    await expect(admin.query(`INSERT INTO fake_provider_state (provider, state) VALUES ('hetzner', '[]')`)).rejects.toThrow(/check constraint/i);
  });

  it('never gets stuck at the size limit: a growing write is refused cleanly, reads and shrinking writes still work', async () => {
    const big = (mb: number) => randomBytes(Math.floor((mb * 1024 * 1024 * 3) / 4)).toString('base64');
    await withFakeProviderState(platformOps, 'hetzner', () => ({ pad: '' }), (s) => { s.pad = big(3.5); });
    await expect(withFakeProviderState(platformOps, 'hetzner', () => ({ pad: '' }), (s) => { s.pad += big(1); })).rejects.toBeInstanceOf(FakeProviderStateFull);
    expect(await withFakeProviderState(platformOps, 'hetzner', () => ({ pad: '' }), (s) => s.pad.length)).toBeGreaterThan(3_000_000);
    await withFakeProviderState(platformOps, 'hetzner', () => ({ pad: '' }), (s) => { s.pad = ''; });
    expect(await withFakeProviderState(platformOps, 'hetzner', () => ({ pad: 'x' }), (s) => s.pad)).toBe('');
  });
});
