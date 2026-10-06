import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { test as testConnection } from '../src/validate.js';
import { connect } from '../src/connect.js';
import { seal } from '../src/crypto.js';
import { buildAad, type ModelConnectionCtx } from '../src/types.js';
import { fakeHttpClient, gatedHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

/** Rotates account `accountId`'s stored key to `plaintextKey`, as app_user, keeping the row's own id for AAD. */
function rotateKey(appUserPool: Pool, accountId: string, connectionId: string, kek: ReturnType<typeof fakeKekSource>, plaintextKey: string): Promise<void> {
  const sealed = seal({ kek: kek.keyFor(1), aad: buildAad(accountId, connectionId) }, plaintextKey);
  return withTenant(appUserPool, accountId, async (client) => {
    await client.query(
      `UPDATE model_connections
         SET key_ciphertext = $2, key_nonce = $3, wrapped_dek = $4, kek_version = 1, key_fingerprint = $5
       WHERE account_id = $1`,
      [accountId, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, 'rotated'],
    );
  });
}

/**
 * D#2's Team Lead comment on this task originally described test() as
 * locking the model_connections row FOR UPDATE before reading the key and
 * holding the lock until the status write. D#2 fix round 3, R1 changed
 * that: holding the platform_ops row lock across a SEPARATELY BORROWED
 * app_user pool connection (needed to read/decrypt the key) can deadlock
 * the shared pool under concurrency (see validate.ts's own comments), so
 * test() now reads+validates the key BEFORE opening any platform_ops
 * transaction, and only takes the row lock right before the write -- at
 * which point it re-checks the row's live id/key_nonce against what it
 * just read, and skips the write if either changed. The invariant this
 * describe block proves is unchanged (a rotation racing test() never
 * leaves the row "ok" for a key it didn't validate); the mechanism is
 * different (skip-on-mismatch instead of block-via-lock), so the test
 * below now asserts that a concurrent rotation proceeds immediately
 * rather than blocking.
 */
describe('TOCTOU: test() never attaches its outcome to a key a concurrent rotation already replaced', () => {
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

  it('a key rotation during test()\'s HTTP validation is NOT blocked, but its outcome is never attached to the rotated key', async () => {
    const principal = await seedAccountWithMember(admin, 'owner');
    await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), kek), {
      provider: 'ai_gateway',
      key: 'sk-fake-original',
    });
    const before = await admin.query('SELECT id, status, key_fingerprint FROM model_connections WHERE account_id = $1', [
      principal.accountId,
    ]);
    expect(before.rows[0].status).toBe('ok');
    const connectionId: string = before.rows[0].id;

    // test() reads+decrypts the key via a plain (non-locking) SELECT,
    // THEN calls the HTTP client -- gatedHttpClient's validate() hangs
    // there until released. D#2 fix round 3, R1: no row lock is held at
    // this point (see the describe block's own header comment), so a
    // concurrent rotation is free to run immediately.
    const gate = gatedHttpClient();
    const testPromise = testConnection(ctx(principal, gate, kek));
    await gate.started;

    // A real concurrent UPDATE on the SAME row from a SEPARATE
    // connection -- completes right away, unblocked by any row lock. The
    // guard trigger (round-5 finding 2) resets status to unvalidated for
    // this non-platform_ops key-material change.
    await rotateKey(appUserPool, principal.accountId, connectionId, kek, 'sk-fake-rotated');
    const midRotated = await admin.query('SELECT status, key_fingerprint FROM model_connections WHERE account_id = $1', [
      principal.accountId,
    ]);
    expect(midRotated.rows[0].status).toBe('unvalidated');
    expect(midRotated.rows[0].key_fingerprint).toBe('rotated');

    // Resolve "ok" for the OLD key the validator already read/decrypted.
    gate.release({ kind: 'ok' });
    const outcome = await testPromise;
    expect(outcome.kind).toBe('ok');

    // test()'s write is skipped: its captured key_nonce no longer
    // matches the row's (now rotated) key_nonce, so this "ok" outcome --
    // for a key that no longer exists anywhere -- is never attached to
    // the row. Status stays exactly what the rotation itself left it as.
    const after = await admin.query('SELECT status, key_fingerprint FROM model_connections WHERE account_id = $1', [
      principal.accountId,
    ]);
    expect(after.rows[0].status).not.toBe('ok');
    expect(after.rows[0].status).toBe('unvalidated');
    expect(after.rows[0].key_fingerprint).toBe('rotated');
    expect(after.rows[0].key_fingerprint).not.toBe(before.rows[0].key_fingerprint);
  });

  it('a rotation that completes BEFORE test() starts is what gets validated (no race, sequential case)', async () => {
    const principal = await seedAccountWithMember(admin, 'owner');
    await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), kek), {
      provider: 'ai_gateway',
      key: 'sk-fake-original-2',
    });

    const existing = await admin.query('SELECT id FROM model_connections WHERE account_id = $1', [principal.accountId]);
    await rotateKey(appUserPool, principal.accountId, existing.rows[0].id, kek, 'sk-fake-rotated-2');

    const client = fakeHttpClient({ kind: 'ok' });
    const outcome = await testConnection(ctx(principal, client, kek));
    expect(outcome.kind).toBe('ok');
    expect(client.calls[0]!.plaintextKey).toBe('sk-fake-rotated-2');

    const { rows } = await admin.query('SELECT status FROM model_connections WHERE account_id = $1', [principal.accountId]);
    expect(rows[0].status).toBe('ok');
  });
});

/**
 * Security review finding 4 (CWE-367): connect() commits its tenant
 * write, then calls recordInitialValidation -- a gap in which a
 * concurrent rotation can replace the key material before that call
 * takes its row lock. Fixed by pinning recordInitialValidation to the
 * exact id/fingerprint connect() just wrote, and re-checking the
 * fingerprint under the lock before writing. This is the test that
 * proves the gap is closed: a real Postgres-backed race, gated on
 * platformOpsPool.connect() the same way D#2's Team Lead comment gated
 * test()'s HTTP call above.
 */
describe('TOCTOU: connect() never attaches its outcome to a key a concurrent rotation already replaced', () => {
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

  it('a rotation landing between connect()\'s commit and its recordInitialValidation lock is never marked "ok" for the wrong key', async () => {
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
      key: 'sk-d0',
    });

    // Gates platformOpsPool.connect() so connect()'s own call pauses
    // exactly between its tenant write (already committed by the time
    // this runs) and recordInitialValidation's row lock.
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
    const aPromise = connect(gatedCtx, { provider: 'ai_gateway', key: 'sk-d-validated-good' });
    await reachedP;

    // A second admin rotates to a key whose validation could not be
    // confirmed -- landing squarely in A's gap.
    await connect(
      ctx({ accountId, userId: secondAdminId }, fakeHttpClient({ kind: 'network_error', code: 'timeout', message: 'n' }), kek),
      { provider: 'ai_gateway', key: 'sk-d-never-validated' },
    );
    const mid = (
      await admin.query('SELECT status, key_fingerprint FROM model_connections WHERE account_id = $1', [accountId])
    ).rows[0];

    release();
    await aPromise;
    const finalRow = (
      await admin.query('SELECT status, key_fingerprint FROM model_connections WHERE account_id = $1', [accountId])
    ).rows[0];

    // The stored key is still the rotated one -- A's write never touched it.
    expect(finalRow.key_fingerprint).toBe(mid.key_fingerprint);
    expect(finalRow.key_fingerprint).not.toBe('sk-d-validated-good'); // sanity: not literally the plaintext
    // Critically: A's "ok" outcome was for the FIRST key, not this one --
    // it must never be recorded against the rotated row. B's own
    // recordInitialValidation (network_error) never sets status either,
    // so the row must not read "ok" here.
    expect(finalRow.status).not.toBe('ok');
  });

  it('control: a connect() with no concurrent rotation still records its own "ok" normally', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const kek = fakeKekSource();
    const status = await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), kek), {
      provider: 'ai_gateway',
      key: 'sk-control-no-race',
    });
    expect(status.status).toBe('ok');
    const row = await admin.query('SELECT status FROM model_connections WHERE account_id = $1', [accountId]);
    expect(row.rows[0].status).toBe('ok');
  });
});
