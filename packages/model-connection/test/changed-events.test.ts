import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect } from '../src/connect.js';
import { remove } from '../src/remove.js';
import { test as testConnection } from '../src/validate.js';
import { InvalidModelKeyError } from '../src/errors.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

/**
 * ONBOARDING-STATE: every change to whether the account has a working key says so on the account's event stream,
 * in the transaction that made it, so the open Onboarding window re-reads. The payload is a fixed word.
 */
describe('model_connection.changed', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let ctx: ReturnType<typeof ctxFactory>;
  const kek = fakeKekSource();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    ctx = ctxFactory(appUserPool, platformOpsPool);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  const changed = async (accountId: string) =>
    (await admin.query(`SELECT payload, subject_id FROM domain_events WHERE account_id = $1 AND type = 'model_connection.changed' ORDER BY seq`, [accountId])).rows;
  const states = async (accountId: string) => (await changed(accountId)).map((r) => r.payload.state);
  const run = (a: { accountId: string; userId: string }, outcome: Parameters<typeof fakeHttpClient>[0]) => ctx(a, fakeHttpClient(outcome), kek);

  it('connect: ok announces ok; an unreachable provider announces unvalidated; a rejected key announces nothing', async () => {
    const ok = await seedAccountWithMember(admin, 'owner');
    await connect(run(ok, { kind: 'ok' }), { provider: 'ai_gateway', key: 'sk-fake-ok' });
    expect(await states(ok.accountId)).toEqual(['ok']);

    const flaky = await seedAccountWithMember(admin, 'owner');
    await connect(run(flaky, { kind: 'network_error', code: 'timeout', message: 'no response' }), { provider: 'ai_gateway', key: 'sk-fake-net' });
    expect(await states(flaky.accountId)).toEqual(['unvalidated']);

    const bad = await seedAccountWithMember(admin, 'owner');
    await expect(
      connect(run(bad, { kind: 'rejected', code: '401', message: 'rejected' }), { provider: 'ai_gateway', key: 'sk-fake-bad' }),
    ).rejects.toThrow(InvalidModelKeyError);
    expect(await states(bad.accountId)).toEqual([]);
  });

  it('the event carries the connection id as its subject and no key material or error text', async () => {
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(run(a, { kind: 'ok' }), { provider: 'ai_gateway', key: 'sk-secret-canary' });
    const id = (await admin.query(`SELECT id FROM model_connections WHERE account_id = $1`, [a.accountId])).rows[0].id;
    const rows = await changed(a.accountId);
    expect(rows).toEqual([{ payload: { state: 'ok' }, subject_id: id }]);
    expect(JSON.stringify(rows)).not.toContain('canary');
  });

  it('replacing the key announces the new state (a key replaced by an unvalidated one is not a working key)', async () => {
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(run(a, { kind: 'ok' }), { provider: 'ai_gateway', key: 'sk-first' });
    await connect(run(a, { kind: 'network_error', code: 'timeout', message: 'x' }), { provider: 'ai_gateway', key: 'sk-second' });
    expect(await states(a.accountId)).toEqual(['ok', 'unvalidated']);
  });

  it('a re-check that finds the key rejected announces broken; one that finds it working announces ok', async () => {
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(run(a, { kind: 'ok' }), { provider: 'ai_gateway', key: 'sk-first' });
    await testConnection(run(a, { kind: 'rejected', code: '401', message: 'rejected' }));
    expect((await admin.query(`SELECT status FROM model_connections WHERE account_id = $1`, [a.accountId])).rows[0].status).toBe('broken');
    await testConnection(run(a, { kind: 'ok' }));
    expect(await states(a.accountId)).toEqual(['ok', 'broken', 'ok']);
  });

  it('remove announces removed in the same transaction as the delete; removing nothing announces nothing', async () => {
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(run(a, { kind: 'ok' }), { provider: 'ai_gateway', key: 'sk-first' });
    await remove(run(a, { kind: 'ok' }));
    expect((await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [a.accountId])).rowCount).toBe(0);
    expect(await states(a.accountId)).toEqual(['ok', 'removed']);
    await expect(remove(run(a, { kind: 'ok' }))).rejects.toThrow();
    expect(await states(a.accountId)).toEqual(['ok', 'removed']);
  });

  it('a member who may not remove leaves the key and the stream untouched', async () => {
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(run(a, { kind: 'ok' }), { provider: 'ai_gateway', key: 'sk-first' });
    const member = await seedAccountWithMember(admin, 'member');
    await expect(remove(run({ accountId: a.accountId, userId: member.userId }, { kind: 'ok' }))).rejects.toThrow();
    expect(await states(a.accountId)).toEqual(['ok']);
    expect((await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [a.accountId])).rowCount).toBe(1);
  });
});
