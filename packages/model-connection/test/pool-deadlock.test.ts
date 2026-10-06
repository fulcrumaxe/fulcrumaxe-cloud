import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect } from '../src/connect.js';
import { test as testConnection } from '../src/validate.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

/**
 * D#2 fix round 3, R1 regression test.
 *
 * Before the fix, recordInitialValidation() and test() each took the
 * model_connections row's platform_ops `FOR UPDATE` lock and THEN
 * borrowed a SEPARATE app_user pool connection while still holding it
 * (recordInitialValidation to re-read key_fingerprint; test() to
 * read/decrypt the key itself). Under pool pressure -- more concurrent
 * callers than the app_user pool has connections -- that deadlocks: every
 * app_user connection ends up blocked waiting on ONE caller's row lock,
 * and every one of those lock-holders is itself blocked waiting for an
 * app_user connection nobody can free. Nobody makes progress.
 *
 * validate.ts's fix removes the lock-then-borrow shape entirely: the
 * app_user read (and, for test(), the HTTP validation) now always
 * happens BEFORE any platform_ops transaction opens, and the row lock is
 * held only for the brief re-check-and-write at the end. This test fires
 * more concurrent connect()/test() calls against ONE account than a
 * deliberately small app_user pool has connections, and asserts they all
 * complete -- no hang -- well within a bounded timeout.
 */
describe('pool deadlock regression (R1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  it('N concurrent connect()/test() calls on one account, N greater than the app_user pool size, all complete with no hang', async () => {
    // Deliberately smaller than CONCURRENCY below. connectionTimeoutMillis
    // (R1's other, defense-in-depth ask) means a regression fails LOUDLY --
    // a rejected promise -- instead of hanging the whole suite forever.
    const POOL_MAX = 3;
    const CONNECTION_TIMEOUT_MS = 4_000;
    const appUserPool = createPool(process.env.DATABASE_URL_APP_USER!, {
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });
    const ctx = ctxFactory(appUserPool, platformOpsPool);
    const kek = fakeKekSource();

    try {
      const { accountId, userId: ownerId } = await seedAccountWithMember(admin, 'owner');
      await connect(ctx({ accountId, userId: ownerId }, fakeHttpClient({ kind: 'ok' }), kek), {
        provider: 'ai_gateway',
        key: 'sk-pool-deadlock-0',
      });

      const CONCURRENCY = 12; // > POOL_MAX, mixing connect() (admins) and test() (members)
      const members: Array<{ userId: string; kind: 'admin' | 'member' }> = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        const kind = i % 2 === 0 ? 'admin' : 'member';
        const uid = randomUUID();
        await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [uid, `${uid}@example.test`]);
        await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [
          accountId,
          uid,
          kind,
        ]);
        members.push({ userId: uid, kind });
      }

      const calls = members.map(({ userId, kind }, i) =>
        kind === 'admin'
          ? connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), kek), {
              provider: 'ai_gateway',
              key: `sk-pool-deadlock-${i}`,
            })
          : testConnection(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), kek)),
      );

      const TIMEOUT_MS = 20_000;
      const outcome = await Promise.race([
        Promise.allSettled(calls).then((results) => ({ hung: false as const, results })),
        new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), TIMEOUT_MS)),
      ]);

      expect(outcome.hung).toBe(false);
      if (!outcome.hung) {
        const rejected = outcome.results.filter((r) => r.status === 'rejected');
        expect(rejected).toEqual([]);
      }
    } finally {
      await appUserPool.end().catch(() => undefined);
    }
  }, 30_000);
});
