import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect } from '../src/connect.js';
import { type ModelConnectionCtx } from '../src/types.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

/**
 * D#2 fix round 3, W1 regression test.
 *
 * Before the fix, recordInitialValidation() re-checked a concurrent
 * rotation by comparing `key_fingerprint` -- a 4-hex-character (16-bit)
 * truncated HMAC that exists purely for DISPLAY (D#31 criterion 4). 16
 * bits means an actual collision is well within brute-force reach (the
 * re-review's probe found one in under 2,000,000 tries), and a collision
 * is exactly the case this check exists to catch: if a rotated key
 * happens to share the old key's fingerprint, the OLD (fingerprint-based)
 * check would have wrongly concluded "nothing changed" and attached
 * connect()'s outcome to a row that now holds a completely different,
 * unvalidated key.
 *
 * Rather than brute-forcing a real HMAC-SHA256 collision (slow and
 * nondeterministic), this test proves the fix directly: it forges a
 * `key_fingerprint` collision on the rotated row via SQL (something an
 * attacker doesn't need SQL access to eventually hit by chance -- 16 bits
 * of keyspace does it) while the row's `key_nonce` -- fresh random bytes
 * from the rotation's own `seal()` call -- is, as always, genuinely
 * different. If validate.ts's re-check were still comparing
 * `key_fingerprint`, it would treat the forged match as "no rotation
 * happened" and wrongly write A's "ok" outcome onto the rotated row. This
 * test proves it does not.
 */
describe('W1: rotation re-check compares key_nonce, not the collision-prone key_fingerprint', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let ctx: ReturnType<typeof ctxFactory>;

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

  it('a rotated row whose key_fingerprint is forced to collide with the old one is still never marked "ok" for the old outcome', async () => {
    const { accountId, userId: ownerId } = await seedAccountWithMember(admin, 'owner');
    const secondAdminId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [secondAdminId, `${secondAdminId}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [
      accountId,
      secondAdminId,
    ]);
    const kek = fakeKekSource();

    await connect(ctx({ accountId, userId: ownerId }, fakeHttpClient({ kind: 'ok' }), kek), {
      provider: 'ai_gateway',
      key: 'sk-w1-old',
    });

    // Gates platformOpsPool.connect() so A's own connect() call pauses
    // exactly between its tenant write (committed by the time this runs)
    // and recordInitialValidation's row lock -- same rig as
    // test/toctou.test.ts's "connect() never attaches its outcome" test.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const reachedP = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gatedOps = {
      connect: async () => {
        reached();
        await gate;
        return platformOpsPool.connect();
      },
    } as unknown as Pool;

    const gatedCtx: ModelConnectionCtx = {
      pool: appUserPool,
      platformOpsPool: gatedOps,
      principal: { accountId, userId: ownerId },
      httpClient: fakeHttpClient({ kind: 'ok' }),
      kek,
    };
    const aPromise = connect(gatedCtx, { provider: 'ai_gateway', key: 'sk-w1-A-validated-ok' });
    await reachedP;

    // A's tenant write has already committed -- read what it stored.
    const aRow = (
      await admin.query('SELECT key_fingerprint, key_nonce FROM model_connections WHERE account_id = $1', [accountId])
    ).rows[0];

    // The second admin rotates to a DIFFERENT key, validated as
    // network_error (so if this outcome were the one that landed, status
    // would never read "ok" either -- keeping the assertion below
    // unambiguous about WHICH write it is catching).
    await connect(
      ctx({ accountId, userId: secondAdminId }, fakeHttpClient({ kind: 'network_error', code: 'timeout', message: 'n' }), kek),
      { provider: 'ai_gateway', key: 'sk-w1-B-never-validated' },
    );

    // Forge the collision: force the rotated row's key_fingerprint back
    // to A's original value, as SQL a real HMAC-SHA256 collision would
    // eventually produce for free. key_nonce is untouched -- B's own
    // seal() already gave it fresh random bytes, genuinely different from
    // A's.
    await admin.query('UPDATE model_connections SET key_fingerprint = $2 WHERE account_id = $1', [
      accountId,
      aRow.key_fingerprint,
    ]);
    const midRow = (
      await admin.query('SELECT key_fingerprint, key_nonce FROM model_connections WHERE account_id = $1', [accountId])
    ).rows[0];
    // Sanity: the forged fingerprint collision is real, and the nonce
    // still genuinely differs -- otherwise this test would not be
    // exercising what it claims to.
    expect(midRow.key_fingerprint).toBe(aRow.key_fingerprint);
    expect(Buffer.compare(midRow.key_nonce, aRow.key_nonce)).not.toBe(0);

    release();
    await aPromise;

    const finalRow = (
      await admin.query('SELECT status, key_fingerprint FROM model_connections WHERE account_id = $1', [accountId])
    ).rows[0];

    // The forged key_fingerprint collision is still in place...
    expect(finalRow.key_fingerprint).toBe(aRow.key_fingerprint);
    // ...but A's "ok" outcome was for the FIRST key, not this one. If the
    // re-check still compared key_fingerprint, the forged collision above
    // would make it wrongly conclude "nothing changed" and write "ok"
    // here. It must not: the row is B's now, and B's own outcome
    // (network_error) never sets status either.
    expect(finalRow.status).not.toBe('ok');
  });
});
