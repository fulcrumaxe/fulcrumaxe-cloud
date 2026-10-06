import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { insertApiToken, revokeAllMine, revokeToken, type Scope } from '../src/tokens/service.js';
import { removeMember, setMemberRole } from '../src/tenancy/membership.js';

/** D#31 C25 (API-5c) criteria 1 and 2: token create/revoke write `api_token.*` outbox rows in the same transaction, against real Postgres. */
describe('api_token.* domain events (API-5c)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await app.end();
  });

  async function addMember(accountId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const userId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return userId;
  }

  async function mint(pool: Pool, accountId: string, createdBy: string, scopes: Scope[] = ['read']): Promise<{ id: string }> {
    return insertApiToken(pool, {
      accountId,
      createdBy,
      tokenHash: `hash-${randomUUID()}`,
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
  }

  async function events(accountId: string): Promise<{ type: string; subject_id: string; payload: unknown }[]> {
    const { rows } = await admin.query(
      `SELECT type, subject_id, payload FROM domain_events WHERE account_id = $1 AND type LIKE 'api_token.%' ORDER BY seq`,
      [accountId],
    );
    return rows;
  }

  /** Rejects the COMMIT (the last statement of the transaction), so everything the transaction wrote must roll back together. */
  function failingCommit(base: Pool): Pool {
    return {
      connect: async () => {
        const client = await base.connect();
        const original = client.query.bind(client);
        client.query = ((...args: unknown[]) =>
          args[0] === 'COMMIT' ? Promise.reject(new Error('injected failure')) : (original as (...a: unknown[]) => unknown)(...args)) as typeof client.query;
        return client;
      },
    } as Pool;
  }

  it('create: exactly one api_token.created, subject = the token id, payload {}; a rolled-back create leaves no event', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const token = await mint(app, refs.accountId, refs.userId);
    expect(await events(refs.accountId)).toEqual([{ type: 'api_token.created', subject_id: token.id, payload: {} }]);

    const dedicated = createPool(process.env.DATABASE_URL_APP_USER!, { max: 1 });
    try {
      await expect(mint(failingCommit(dedicated), refs.accountId, refs.userId)).rejects.toThrow('injected failure');
    } finally {
      await dedicated.end();
    }
    expect(await events(refs.accountId)).toHaveLength(1);
    const { rows } = await admin.query('SELECT 1 FROM api_tokens WHERE account_id = $1', [refs.accountId]);
    expect(rows).toHaveLength(1);
  });

  it('revoke-one: one api_token.revoked with the reason; a 404 and a second revoke emit nothing', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const token = await mint(app, refs.accountId, refs.userId);
    expect(await revokeToken(app, { accountId: refs.accountId, userId: refs.userId }, token.id, 'user_requested')).toBe(true);
    expect(await revokeToken(app, { accountId: refs.accountId, userId: refs.userId }, token.id, 'user_requested')).toBe(false);
    expect(await revokeToken(app, { accountId: refs.accountId, userId: refs.userId }, randomUUID(), 'user_requested')).toBe(false);
    expect((await events(refs.accountId)).slice(1)).toEqual([
      { type: 'api_token.revoked', subject_id: token.id, payload: { reason: 'user_requested' } },
    ]);
  });

  it('revoke-all-mine: one event per token revoked; an empty pass emits nothing', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const a = await mint(app, refs.accountId, refs.userId);
    const b = await mint(app, refs.accountId, refs.userId);
    expect(await revokeAllMine(app, refs.accountId, refs.userId)).toBe(2);
    expect(await revokeAllMine(app, refs.accountId, refs.userId)).toBe(0);
    const revoked = (await events(refs.accountId)).filter((e) => e.type === 'api_token.revoked');
    expect(revoked.map((e) => e.subject_id).sort()).toEqual([a.id, b.id].sort());
    expect(revoked.every((e) => JSON.stringify(e.payload) === '{"reason":"user_requested"}')).toBe(true);
  });

  it('creator_demoted and creator_removed: one event per token, with the matching reason', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const demoted = await addMember(refs.accountId, 'admin');
    const removed = await addMember(refs.accountId, 'member');
    const d1 = await mint(app, refs.accountId, demoted);
    const r1 = await mint(app, refs.accountId, removed);
    const r2 = await mint(app, refs.accountId, removed);
    await setMemberRole(app, refs.accountId, refs.userId, demoted, 'member');
    await removeMember(app, refs.accountId, refs.userId, removed);
    const revoked = (await events(refs.accountId)).filter((e) => e.type === 'api_token.revoked');
    expect(revoked).toHaveLength(3);
    expect(revoked.find((e) => e.subject_id === d1.id)?.payload).toEqual({ reason: 'creator_demoted' });
    for (const id of [r1.id, r2.id]) expect(revoked.find((e) => e.subject_id === id)?.payload).toEqual({ reason: 'creator_removed' });
  });
});
