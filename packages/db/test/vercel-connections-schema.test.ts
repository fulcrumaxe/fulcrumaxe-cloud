import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';

/** D#598 P8d-2 (migration 0885): the sealed Vercel token table. */
describe('vercel_connections schema', () => {
  let admin: Pool;
  let appUser: Pool;

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await admin.end();
    await appUser.end();
  });

  async function seed(): Promise<{ accountId: string; userId: string }> {
    const accountId = randomUUID();
    const userId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    return { accountId, userId };
  }
  /** Inserts a row for `accountId` while the tenant is `as` (the same account unless a test says otherwise). */
  const insert = (accountId: string, userId: string, extra: { team?: string | null; status?: string; as?: string } = {}) =>
    withTenant(appUser, extra.as ?? accountId, userId, (client) =>
      client.query(
        `INSERT INTO vercel_connections (id, account_id, token_ciphertext, token_nonce, wrapped_dek, kek_version, token_fingerprint, team_id, status, created_by)
         VALUES ($1, $2, '\\x00', '\\x00', '\\x00', 1, 'abcd', $3, $4, $5)`,
        [randomUUID(), accountId, extra.team ?? null, extra.status ?? 'ok', userId],
      ),
    );

  it('holds only bytea for the sealed material and no free-form text beyond the tail, team id and status', async () => {
    const { rows } = await admin.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vercel_connections'`,
    );
    const types = new Map(rows.map((r) => [r.column_name, r.data_type]));
    for (const c of ['token_ciphertext', 'token_nonce', 'wrapped_dek']) expect(types.get(c)).toBe('bytea');
    expect(rows.filter((r) => r.data_type === 'text').map((r) => r.column_name).sort()).toEqual(['status', 'team_id', 'token_fingerprint']);
  });

  it('one row per account; a team id and a status outside the closed shapes are refused', async () => {
    const a = await seed();
    await insert(a.accountId, a.userId, { team: 'team_abc1' });
    await expect(insert(a.accountId, a.userId)).rejects.toMatchObject({ code: '23505' });
    const b = await seed();
    await expect(insert(b.accountId, b.userId, { team: 'not-a-team' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert(b.accountId, b.userId, { status: 'maybe' })).rejects.toMatchObject({ code: '23514' });
  });

  it('row security: another tenant sees, changes and deletes nothing, and no tenant set sees nothing', async () => {
    const a = await seed();
    const b = await seed();
    await insert(a.accountId, a.userId);
    const seen = await withTenant(appUser, b.accountId, b.userId, (c) => c.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [a.accountId]));
    expect(seen.rowCount).toBe(0);
    const touched = await withTenant(appUser, b.accountId, b.userId, async (c) => {
      const u = await c.query(`UPDATE vercel_connections SET status = 'rejected' WHERE account_id = $1`, [a.accountId]);
      const d = await c.query('DELETE FROM vercel_connections WHERE account_id = $1', [a.accountId]);
      return [u.rowCount, d.rowCount];
    });
    expect(touched).toEqual([0, 0]);
    await expect(insert(a.accountId, b.userId, { as: b.accountId })).rejects.toMatchObject({ code: '42501' });
    expect((await appUser.query('SELECT 1 FROM vercel_connections')).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [a.accountId])).rowCount).toBe(1);
  });
});
