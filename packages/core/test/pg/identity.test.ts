import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { PG_ERROR } from '@fx/db/test/helpers/pgErrors.js';
import {
  createAccountForNewOwner,
  findOrCreateUserByGithub,
  getSessionEpochAndRevocation,
  getUserProfile,
  listMemberships,
  revokeSession,
  signUpOrSignIn,
} from '../../src/auth/identity.js';
import { onAccountCreated, type AccountCreatedContext } from '../../src/auth/onAccountCreated.js';

/**
 * sec-criteria A5: "Identity lifecycle is platform_ops-only... H06
 * generates user UUIDs itself... Test: sign-up as app_user is refused,
 * and the platform_ops path returns the id it generated."
 */
describe('identity lifecycle (sec-criteria A5)', () => {
  let platformOpsPool: Pool;
  let appUserPool: Pool;

  beforeAll(() => {
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    await platformOpsPool.end();
    await appUserPool.end();
  });

  it('sign-up as app_user is refused', async () => {
    const id = randomUUID();
    await expect(
      appUserPool.query('INSERT INTO users (id, github_user_id, email) VALUES ($1, $2, $3)', [
        id,
        123456,
        `${id}@example.test`,
      ]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('the platform_ops path returns the id it generated, never one read back through RETURNING', async () => {
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const identity = { githubUserId, email: `gh-${githubUserId}@example.test`, name: 'Ada', githubLogin: 'ada' };

    const created = await findOrCreateUserByGithub(platformOpsPool, identity);
    expect(created.email).toBe(identity.email);

    // The id returned is real and durable: a second lookup by the same
    // github_user_id resolves to the SAME id, proving it was actually
    // persisted (not just echoed back).
    const again = await findOrCreateUserByGithub(platformOpsPool, identity);
    expect(again.id).toBe(created.id);

    const { rows } = await platformOpsPool.query('SELECT id FROM users WHERE github_user_id = $1', [
      githubUserId,
    ]);
    expect(rows).toEqual([{ id: created.id }]);
  });

  it('findOrCreateUserByGithub is idempotent for a repeat sign-in (no duplicate user row)', async () => {
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const identity = { githubUserId, email: `gh-${githubUserId}@example.test`, name: 'Bea', githubLogin: 'bea' };

    await findOrCreateUserByGithub(platformOpsPool, identity);
    await findOrCreateUserByGithub(platformOpsPool, identity);

    const { rows } = await platformOpsPool.query('SELECT count(*)::int AS n FROM users WHERE github_user_id = $1', [
      githubUserId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  /**
   * D#37 WS-C1 criterion 3 (correction C8): "capture the GitHub login at
   * sign-in, store it." Written on EVERY sign-in (not only the first),
   * so a real GitHub username rename is picked up rather than going
   * stale -- proved here against a real Postgres row, not just the fake
   * pool's in-memory shape.
   */
  it('stores github_login on first sign-in and updates it on a repeat sign-in with a changed login', async () => {
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const first = { githubUserId, email: `login-${githubUserId}@example.test`, name: 'Foo', githubLogin: 'foo-old' };

    const created = await findOrCreateUserByGithub(platformOpsPool, first);
    const afterFirst = await getUserProfile(platformOpsPool, created.id);
    expect(afterFirst?.githubLogin).toBe('foo-old');

    const renamed = { ...first, githubLogin: 'foo-new' };
    await findOrCreateUserByGithub(platformOpsPool, renamed);
    const afterSecond = await getUserProfile(platformOpsPool, created.id);
    expect(afterSecond?.githubLogin).toBe('foo-new');
  });
});

describe('sign-up creates the founding account; sign-in reuses an existing one', () => {
  let platformOpsPool: Pool;

  beforeAll(() => {
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    await platformOpsPool.end();
  });

  it('a brand-new identity gets a new account with themselves as owner', async () => {
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const identity = { githubUserId, email: `new-${githubUserId}@example.test`, name: 'Cleo', githubLogin: 'cleo' };

    const session = await signUpOrSignIn(platformOpsPool, identity);
    expect(session.userId).toBeTruthy();
    expect(session.accountId).toBeTruthy();

    const { rows } = await platformOpsPool.query(
      "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
      [session.accountId, session.userId],
    );
    expect(rows).toEqual([{ role: 'owner' }]);
  });

  it('a returning identity signs back into their existing account rather than getting a new one', async () => {
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const identity = { githubUserId, email: `return-${githubUserId}@example.test`, name: 'Dex', githubLogin: 'dex' };

    const first = await signUpOrSignIn(platformOpsPool, identity);
    const second = await signUpOrSignIn(platformOpsPool, identity);

    expect(second.userId).toBe(first.userId);
    expect(second.accountId).toBe(first.accountId);

    const memberships = await listMemberships(platformOpsPool, first.userId);
    expect(memberships).toHaveLength(1);
  });

  it('runs every onAccountCreated hook, inside the account-creating transaction (D#2607 X3.2)', async () => {
    const seen: AccountCreatedContext[] = [];
    onAccountCreated.push((ctx) => {
      seen.push(ctx);
    });
    try {
      const userId = randomUUID();
      await platformOpsPool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        userId,
        `${userId}@example.test`,
      ]);
      const { accountId } = await createAccountForNewOwner(platformOpsPool, userId);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ accountId, ownerUserId: userId });
      expect(seen[0]!.client).toBeDefined();
    } finally {
      onAccountCreated.length = 0;
    }
  });
});

/**
 * D#37 WS-C2 fix round item 1 (E1, CWE-613, correction C15a):
 * migrations/0609_revoked_sessions.sql's `revoked_sessions` table, and
 * identity.ts's `revokeSession` / `getSessionEpochAndRevocation` --
 * against a REAL Postgres, not a fake pool (that's testFakes.ts's job,
 * exercised by the route-level tests in apps/web). This describe block
 * keeps only the FUNCTIONAL revoke/read-back behaviour, per C15a's own
 * acceptance_files split ("a real-Postgres test in
 * packages/core/test/pg/identity.test.ts: revoke, then the read reports
 * the sid as revoked ... a privileges test in packages/db/test/").
 *
 * Fix round 1 (W2, CWE-732): the app_user AND platform_ops privilege
 * checks that used to live here moved to
 * packages/db/test/revoked-sessions-privileges.test.ts -- including the
 * "platform_ops cannot UPDATE or DELETE" test, which C15a's fix round
 * removes outright (it asserted the exact deviation E1 flags; the new
 * file's "platform_ops CAN DELETE, and app_user still can't" test
 * replaces it).
 */
describe('per-session revocation (revoked_sessions, D#37 WS-C2 correction C15a)', () => {
  let platformOpsPool: Pool;
  let userId: string;

  /** This session's own absolute deadline, the shape revokeSession expects for `expiresAt` -- see identity.ts's own doc comment. */
  function future(): Date {
    return new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  }

  beforeAll(async () => {
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const created = await findOrCreateUserByGithub(platformOpsPool, {
      githubUserId,
      email: `revoke-${githubUserId}@example.test`,
      name: 'Revoke Me',
      githubLogin: 'revoke-me',
    });
    userId = created.id;
  });

  afterAll(async () => {
    await platformOpsPool.end();
  });

  it('a session is not revoked until revokeSession is called for its exact sid', async () => {
    const sid = randomUUID();
    const before = await getSessionEpochAndRevocation(platformOpsPool, userId, sid);
    expect(before).toEqual({ epoch: 0, revoked: false });

    await revokeSession(platformOpsPool, sid, userId, future());

    const after = await getSessionEpochAndRevocation(platformOpsPool, userId, sid);
    expect(after).toEqual({ epoch: 0, revoked: true });
  });

  it('revoking one sid never marks a different sid of the same user revoked', async () => {
    const sidA = randomUUID();
    const sidB = randomUUID();
    await revokeSession(platformOpsPool, sidA, userId, future());

    const a = await getSessionEpochAndRevocation(platformOpsPool, userId, sidA);
    const b = await getSessionEpochAndRevocation(platformOpsPool, userId, sidB);
    expect(a?.revoked).toBe(true);
    expect(b?.revoked).toBe(false);
  });

  it('revokeSession is idempotent -- revoking the same sid twice does not error', async () => {
    const sid = randomUUID();
    await revokeSession(platformOpsPool, sid, userId, future());
    await expect(revokeSession(platformOpsPool, sid, userId, future())).resolves.toBeUndefined();
    const result = await getSessionEpochAndRevocation(platformOpsPool, userId, sid);
    expect(result?.revoked).toBe(true);
  });

  it('getSessionEpochAndRevocation returns null for a user id that does not exist', async () => {
    const result = await getSessionEpochAndRevocation(platformOpsPool, randomUUID(), randomUUID());
    expect(result).toBeNull();
  });

  /**
   * Fix round 1 (E1, CWE-770/400, correction C15a): `expires_at` is a
   * real, required column, not dropped from the table as it was at head
   * 1714660624b15ac0c7c92c6f4a8b6477dd31a747 -- that head has no such
   * column at all, so both assertions below fail to even run against it
   * (`revokeSession` there takes only 3 args, and the column doesn't
   * exist for information_schema to report).
   */
  it("revokeSession records expires_at as the session's own absolute deadline, and the column is NOT NULL", async () => {
    const sid = randomUUID();
    const expiresAt = future();
    await revokeSession(platformOpsPool, sid, userId, expiresAt);

    const { rows } = await platformOpsPool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM revoked_sessions WHERE session_id = $1',
      [sid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at.getTime()).toBe(expiresAt.getTime());

    const { rows: columnRows } = await platformOpsPool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'revoked_sessions' AND column_name = 'expires_at'`,
    );
    expect(columnRows).toHaveLength(1);
    expect(columnRows[0]!.is_nullable).toBe('NO');
  });

  /**
   * Fix round 1 (E1, CWE-770/400): revokeSession purges rows whose
   * `expires_at` has already passed, in the SAME transaction as the
   * insert that records the new revocation -- see identity.ts's own doc
   * comment. This is the failing-first proof that platform_ops's new
   * DELETE grant is actually exercised, not just present: at head
   * 1714660, `platform_ops` has no DELETE grant on this table at all
   * (the append-only design), so this row would stay forever.
   */
  it('revokeSession deletes already-expired rows -- the table does not grow without bound', async () => {
    const staleSid = randomUUID();
    await revokeSession(platformOpsPool, staleSid, userId, new Date(Date.now() - 1000));

    const { rows } = await platformOpsPool.query('SELECT session_id FROM revoked_sessions WHERE session_id = $1', [
      staleSid,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('the purge never removes a revocation that has not expired yet', async () => {
    const sid = randomUUID();
    await revokeSession(platformOpsPool, sid, userId, future());

    const result = await getSessionEpochAndRevocation(platformOpsPool, userId, sid);
    expect(result?.revoked).toBe(true);
  });

  /**
   * Regression test for the security re-review of D#37 WS-C2 correction
   * C15a (PR#119 review comment):
   * the purge in `revokeSession` (`DELETE FROM revoked_sessions WHERE
   * expires_at < now()`) is unconditional on `session_id` -- it must
   * only ever remove rows by EXPIRY, never scope itself to the sid being
   * revoked in the current call. Revoking a SECOND session (sidB) must
   * not touch a FIRST session's (sidA) still-unexpired revocation row.
   *
   * Mutation check: change the purge to
   * `DELETE FROM revoked_sessions WHERE expires_at < now() OR session_id <> $1`
   * (bound to the sid being revoked in that call, i.e. sidB on the
   * second `revokeSession` call below). That deletes every OTHER
   * session's row outright, regardless of expiry -- sidA's still-future
   * `expires_at` no longer protects it, `getSessionEpochAndRevocation`
   * reports it unrevoked, and this test's final assertion fails.
   */
  it('revoking a second session does not purge a different, still-unexpired session revocation', async () => {
    const sidA = randomUUID();
    const sidB = randomUUID();

    await revokeSession(platformOpsPool, sidA, userId, future());
    await revokeSession(platformOpsPool, sidB, userId, future());

    const a = await getSessionEpochAndRevocation(platformOpsPool, userId, sidA);
    expect(a?.revoked).toBe(true);
  });
});

/** Staging lock: FX_SIGNIN_ALLOWLIST also ends existing sessions of a login that is no longer listed. */
describe('sign-in allowlist on live sessions (FX_SIGNIN_ALLOWLIST)', () => {
  let platformOpsPool: Pool;
  let userId: string;
  const sid = randomUUID();

  beforeAll(async () => {
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const githubUserId = Math.floor(Math.random() * 1_000_000_000);
    const created = await findOrCreateUserByGithub(platformOpsPool, {
      githubUserId,
      email: `allow-${githubUserId}@example.test`,
      name: 'Ada',
      githubLogin: 'Ada-Lovelace',
    });
    userId = created.id;
  });

  afterAll(async () => {
    delete process.env.FX_SIGNIN_ALLOWLIST;
    await platformOpsPool.end();
  });

  it('a listed login keeps its session (any case), an unlisted one is refused, and unset or blank restricts nothing', async () => {
    delete process.env.FX_SIGNIN_ALLOWLIST;
    expect(await getSessionEpochAndRevocation(platformOpsPool, userId, sid)).not.toBeNull();

    process.env.FX_SIGNIN_ALLOWLIST = ' someone-else , ADA-LOVELACE ';
    expect(await getSessionEpochAndRevocation(platformOpsPool, userId, sid)).not.toBeNull();

    process.env.FX_SIGNIN_ALLOWLIST = 'someone-else';
    expect(await getSessionEpochAndRevocation(platformOpsPool, userId, sid)).toBeNull();

    process.env.FX_SIGNIN_ALLOWLIST = ' , ';
    expect(await getSessionEpochAndRevocation(platformOpsPool, userId, sid)).not.toBeNull();
  });
});
