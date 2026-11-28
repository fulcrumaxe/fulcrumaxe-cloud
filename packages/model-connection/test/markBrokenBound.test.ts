import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool } from '@fx/db/src/pool.js';
import { connect } from '../src/connect.js';
import { markBroken } from '../src/markBroken.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

/** A late 401 names the connection and key it was sent with; markBroken writes only when that is still what is stored. */
describe('markBroken bound to the exact connection and key', () => {
  let adminPool: Pool, admin: PoolClient, appUserPool: Pool, opsPool: Pool, ctx: ReturnType<typeof ctxFactory>;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    ctx = ctxFactory(appUserPool, opsPool);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), opsPool.end()]);
  });

  const live = async (accountId: string) => (await admin.query(`SELECT id, key_nonce, status FROM model_connections WHERE account_id = $1`, [accountId])).rows[0] as { id: string; key_nonce: Buffer; status: string };
  const brokenAt = async (accountId: string) => (await admin.query(`SELECT key_broken_at FROM accounts WHERE id = $1`, [accountId])).rows[0].key_broken_at;
  async function setup() {
    const t = await seedAccountWithMember(admin, 'owner');
    await connect(ctx(t, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), { provider: 'ai_gateway', key: 'sk-bound-one' });
    return t;
  }

  it('the exact id and nonce: the connection is marked broken and the account paused', async () => {
    const t = await setup();
    const row = await live(t.accountId);
    await markBroken(opsPool, t.accountId, 401, { connectionId: row.id, nonce: row.key_nonce });
    expect((await live(t.accountId)).status).toBe('broken');
    expect(await brokenAt(t.accountId)).not.toBeNull();
  });

  it('the same id with another nonce (the key was rotated): nothing is written', async () => {
    const t = await setup();
    const row = await live(t.accountId);
    await markBroken(opsPool, t.accountId, 401, { connectionId: row.id, nonce: Buffer.alloc(row.key_nonce.length, 7) });
    expect((await live(t.accountId)).status).not.toBe('broken');
    expect(await brokenAt(t.accountId)).toBeNull();
  });

  it('the right nonce with another connection id: nothing is written', async () => {
    const t = await setup();
    const row = await live(t.accountId);
    await markBroken(opsPool, t.accountId, 403, { connectionId: randomUUID(), nonce: row.key_nonce });
    expect((await live(t.accountId)).status).not.toBe('broken');
    expect(await brokenAt(t.accountId)).toBeNull();
  });

  it('an account with no connection: nothing is written and nothing throws', async () => {
    const t = await seedAccountWithMember(admin, 'owner');
    await expect(markBroken(opsPool, t.accountId, 401, { connectionId: randomUUID(), nonce: Buffer.alloc(12) })).resolves.toBeUndefined();
    expect(await brokenAt(t.accountId)).toBeNull();
  });

  it('with no binding the old behaviour holds: marks whatever is stored', async () => {
    const t = await setup();
    await markBroken(opsPool, t.accountId, 401);
    expect((await live(t.accountId)).status).toBe('broken');
  });
});
