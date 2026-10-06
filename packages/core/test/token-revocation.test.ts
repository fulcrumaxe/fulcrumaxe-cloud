import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { insertApiToken, type Scope } from '../src/tokens/service.js';
import { removeMember, setMemberRole } from '../src/tenancy/membership.js';

/**
 * D#31 Correction C13d: creator demotion/removal revoke tokens (task
 * API-3e). Criteria numbered per C13d's "old criterion 5, made exact".
 * Criterion 3's/4's "next request -> 401" HTTP behavior is verified live
 * through the real dispatcher in packages/api/test/tokens.test.ts (this
 * task's other acceptance file) -- this file covers the transactional,
 * ROLE_RANK and audit side directly against real Postgres.
 */
describe('D#31 C13d: creator demotion/removal revoke tokens (API-3e)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  async function addMember(accountId: string, userId: string, role: 'owner' | 'admin' | 'member'): Promise<void> {
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [
      accountId,
      userId,
      role,
    ]);
  }

  /** Mints directly through the real insertApiToken service -- no HTTP round trip needed for these assertions. */
  async function mintToken(
    accountId: string,
    createdBy: string,
    scopes: Scope[] = ['read'],
  ): Promise<{ id: string }> {
    const inserted = await insertApiToken(appUserPool, {
      accountId,
      createdBy,
      tokenHash: `hash-${randomUUID()}`,
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return { id: inserted.id };
  }

  async function tokenRow(id: string): Promise<{ revoked_at: Date | null; revoked_reason: string | null }> {
    const { rows } = await admin.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      'SELECT revoked_at, revoked_reason FROM api_tokens WHERE id = $1',
      [id],
    );
    return rows[0]!;
  }

  async function latestRevocationAudit(
    accountId: string,
    tokenId: string,
  ): Promise<{ actor: string; payload: { token_id: string; reason: string } } | undefined> {
    const { rows } = await admin.query<{ actor: string; payload: { token_id: string; reason: string } }>(
      `SELECT actor, payload FROM audit_log
        WHERE account_id = $1 AND action = 'api_token.revoked' AND payload->>'token_id' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [accountId, tokenId],
    );
    return rows[0];
  }

  /**
   * A Pool whose `connect()` hands back a client wired to reject any query
   * whose SQL text contains `matchSubstring` -- used to simulate a
   * mid-transaction failure. Matching on withTenant.ts's own literal
   * `'COMMIT'` text fires strictly after every write the transaction made
   * (the role change/removal AND the token revocation, regardless of
   * which runs first) and strictly before the commit can succeed, so the
   * ONLY possible outcome is a rollback of everything -- exactly criteria
   * 1 and 4's "injects a failure after the revocation and before commit,
   * and both changes roll back". `basePool` should be a throwaway,
   * single-purpose Pool (see `withFailureInjectedPool` below) so a
   * patched client is never released back into the shared `appUserPool`
   * other tests in this file depend on.
   */
  function wrapPoolFailingOn(basePool: Pool, matchSubstring: string): Pool {
    const wrapped: Pick<Pool, 'connect'> = {
      connect: async () => {
        const client = await basePool.connect();
        const original = client.query.bind(client);
        client.query = ((...args: Parameters<typeof client.query>) => {
          const first = args[0] as unknown;
          const sql = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
          if (typeof sql === 'string' && sql.includes(matchSubstring)) {
            return Promise.reject(new Error(`injected failure: ${matchSubstring}`));
          }
          return (original as (...a: unknown[]) => unknown)(...args);
        }) as typeof client.query;
        return client;
      },
    };
    return wrapped as Pool;
  }

  /** Runs `fn` against a dedicated (max: 1), disposable pool whose commits always fail -- disposed unconditionally so the failing patch never leaks into a shared pool. */
  async function withCommitFailureInjected<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
    const dedicated = createPool(process.env.DATABASE_URL_APP_USER!, { max: 1 });
    try {
      return await fn(wrapPoolFailingOn(dedicated, 'COMMIT'));
    } finally {
      await dedicated.end();
    }
  }

  /**
   * D#31 C15(a): a Pool whose `connect()` hands back a client that runs
   * every query normally, then -- ONLY for a query whose SQL text
   * contains `matchSubstring` -- awaits `delayMs` before returning control
   * to the caller. The delayed query has ALREADY executed against real
   * Postgres by that point (the `await original(...)` above the delay),
   * so a row lock it took (e.g. `FOR SHARE`) is genuinely held for the
   * whole delay window, on the same session/transaction, giving a test a
   * real, controllable "the lock is held, and now the transaction is
   * still in flight" window without a mid-test guess at timing.
   * `onMatch` fires the instant the delay starts (lock already taken),
   * so a test can synchronize on a promise instead of a fixed sleep.
   */
  function wrapPoolDelayingOn(basePool: Pool, matchSubstring: string, delayMs: number, onMatch?: () => void): Pool {
    const wrapped: Pick<Pool, 'connect'> = {
      connect: async () => {
        const client = await basePool.connect();
        const original = client.query.bind(client);
        client.query = (async (...args: Parameters<typeof client.query>) => {
          const first = args[0] as unknown;
          const sql = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
          const result = await (original as (...a: unknown[]) => unknown)(...args);
          if (typeof sql === 'string' && sql.includes(matchSubstring)) {
            onMatch?.();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return result;
        }) as typeof client.query;
        return client;
      },
    };
    return wrapped as Pool;
  }

  describe('criterion 1: demotion revokes in the same transaction, with rollback', () => {
    it('an owner demoted to member -- their audit:read token is revoked with creator_demoted, same transaction as the role change', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, targetId, ['audit:read']);

      await setMemberRole(appUserPool, refs.accountId, refs.userId, targetId, 'member');

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_demoted');

      // Criterion 5: audit_log row, actor session:<acting user id>, payload has token id + reason.
      const audit = await latestRevocationAudit(refs.accountId, tokenId);
      expect(audit?.actor).toBe(`session:${refs.userId}`);
      expect(audit?.payload.token_id).toBe(tokenId);
      expect(audit?.payload.reason).toBe('creator_demoted');
    });

    it('an injected failure after the revocation and before commit rolls back BOTH the role change and the token revocation', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, targetId, ['audit:read']);

      await expect(
        withCommitFailureInjected((failingPool) =>
          setMemberRole(failingPool, refs.accountId, refs.userId, targetId, 'member'),
        ),
      ).rejects.toThrow();

      const { rows: roleRows } = await admin.query<{ role: string }>(
        'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
        [refs.accountId, targetId],
      );
      expect(roleRows[0]!.role).toBe('owner');

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).toBeNull();
      expect(row.revoked_reason).toBeNull();
    });
  });

  describe('criterion 2: "demoted" is any decrease in ROLE_RANK; only the affected account is touched', () => {
    it('owner -> admin and admin -> member both revoke every unrevoked token the target created in that account', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const tokenA = await mintToken(refs.accountId, targetId, ['read']);
      const tokenB = await mintToken(refs.accountId, targetId, ['read']);

      await setMemberRole(appUserPool, refs.accountId, refs.userId, targetId, 'admin');
      expect((await tokenRow(tokenA.id)).revoked_reason).toBe('creator_demoted');
      expect((await tokenRow(tokenB.id)).revoked_reason).toBe('creator_demoted');

      const tokenC = await mintToken(refs.accountId, targetId, ['read']);
      await setMemberRole(appUserPool, refs.accountId, refs.userId, targetId, 'member');
      expect((await tokenRow(tokenC.id)).revoked_reason).toBe('creator_demoted');
    });

    it('a promotion, or a change to the same rank, revokes nothing', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const memberId = randomUUID();
      await addMember(refs.accountId, memberId, 'member');
      const { id: tokenId } = await mintToken(refs.accountId, memberId, ['read']);

      // promotion: member -> admin
      await setMemberRole(appUserPool, refs.accountId, refs.userId, memberId, 'admin');
      expect((await tokenRow(tokenId)).revoked_at).toBeNull();

      // same rank: admin -> admin (a no-op role write, still goes through setMemberRole)
      await setMemberRole(appUserPool, refs.accountId, refs.userId, memberId, 'admin');
      expect((await tokenRow(tokenId)).revoked_at).toBeNull();
    });

    it("a demoted user's tokens in a DIFFERENT account are untouched, and another member's token in the SAME account is untouched", async () => {
      const refsA: SeedRefs = await seedAccount(admin, randomUUID());
      const refsB: SeedRefs = await seedAccount(admin, randomUUID());
      const sharedUserId = randomUUID();
      await addMember(refsA.accountId, sharedUserId, 'owner');
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [
        refsB.accountId,
        sharedUserId,
        'owner',
      ]);

      const tokenInA = await mintToken(refsA.accountId, sharedUserId, ['read']);
      const tokenInB = await mintToken(refsB.accountId, sharedUserId, ['read']);
      const otherMembersTokenInA = await mintToken(refsA.accountId, refsA.userId, ['read']);

      await setMemberRole(appUserPool, refsA.accountId, refsA.userId, sharedUserId, 'member');

      expect((await tokenRow(tokenInA.id)).revoked_at).not.toBeNull();
      expect((await tokenRow(tokenInB.id)).revoked_at).toBeNull();
      expect((await tokenRow(otherMembersTokenInA.id)).revoked_at).toBeNull();
    });
  });

  describe('criterion 3: re-promoting the user leaves the token revoked', () => {
    it('revoked_at/revoked_reason stay set after the creator is promoted back to owner', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, targetId, ['read']);

      await setMemberRole(appUserPool, refs.accountId, refs.userId, targetId, 'member');
      expect((await tokenRow(tokenId)).revoked_at).not.toBeNull();

      await setMemberRole(appUserPool, refs.accountId, refs.userId, targetId, 'owner');
      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_demoted');
    });
  });

  describe('criterion 4: removal revokes in the same transaction, with rollback; re-adding leaves the token revoked', () => {
    it('removing the member revokes their token with creator_removed, same transaction as the removal', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, targetId, ['read']);

      await removeMember(appUserPool, refs.accountId, refs.userId, targetId);

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_removed');

      const audit = await latestRevocationAudit(refs.accountId, tokenId);
      expect(audit?.actor).toBe(`session:${refs.userId}`);
      expect(audit?.payload.reason).toBe('creator_removed');
    });

    it('an injected failure after the revocation and before commit rolls back BOTH the removal and the token revocation', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, targetId, ['read']);

      await expect(
        withCommitFailureInjected((failingPool) => removeMember(failingPool, refs.accountId, refs.userId, targetId)),
      ).rejects.toThrow();

      const { rows: memberRows } = await admin.query(
        'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
        [refs.accountId, targetId],
      );
      expect(memberRows).toHaveLength(1);

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).toBeNull();
      expect(row.revoked_reason).toBeNull();
    });

    it('re-adding the removed user leaves their token revoked', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, targetId, ['read']);

      await removeMember(appUserPool, refs.accountId, refs.userId, targetId);
      expect((await tokenRow(tokenId)).revoked_at).not.toBeNull();

      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [
        refs.accountId,
        targetId,
        'member',
      ]);

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_removed');
    });

    it('an owner removing THEMSELVES (self-removal, another owner remains) still writes a valid audit row', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const secondOwnerId = randomUUID();
      await addMember(refs.accountId, secondOwnerId, 'owner');
      const { id: tokenId } = await mintToken(refs.accountId, refs.userId, ['read']);

      await removeMember(appUserPool, refs.accountId, refs.userId, refs.userId);

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_removed');

      const audit = await latestRevocationAudit(refs.accountId, tokenId);
      expect(audit?.actor).toBe(`session:${refs.userId}`);
    });
  });

  /**
   * D#31 C15(a): the token-mint TOCTOU raised in the #158 review
   * (PR 158 review comment).
   * "A mint request whose session principal was resolved as owner before a
   * concurrent demotion commits still inserts its token afterwards" --
   * `insertApiToken` did not re-read the creator's role inside its own
   * transaction, so a demotion/removal racing an in-flight mint could
   * complete its own revocation pass BEFORE the mint's INSERT ever
   * happened, leaving that fresh token live for a now-unprivileged (or
   * fully removed) creator. FAILS ON MAIN (the other three
   * tests in this block): before this fix, `insertApiToken` takes no lock on
   * `account_members` at all, so `setMemberRole`/`removeMember` never
   * block on it -- the demotion/removal below returns almost immediately
   * (not after `LOCK_HOLD_MS`) and the token these tests mint is never
   * revoked. The one exception is "a mint for a creator already removed
   * ...": it passes unmodified on main too, because `api_tokens`'s
   * pre-existing `tenant_isolation_insert` policy already requires an
   * `account_members` row on INSERT. It is a regression guard, not
   * evidence for this fix.
   */
  describe('C15(a): insertApiToken locks the creator\'s account_members row FOR SHARE, serialising with a concurrent demotion/removal', () => {
    const LOCK_HOLD_MS = 300;

    /** Mints via insertApiToken directly, on a pool that holds up the transaction for `LOCK_HOLD_MS` right after its `FOR SHARE` read fires -- long enough to prove a concurrent demote/remove call in this window actually blocks, rather than racing ahead of it. */
    function mintWithHeldLock(
      accountId: string,
      createdBy: string,
      scopes: Scope[],
      onLockAcquired: () => void,
    ): Promise<{ id: string }> {
      const delayedPool = wrapPoolDelayingOn(appUserPool, 'lock_own_member_role_for_mint', LOCK_HOLD_MS, onLockAcquired);
      return insertApiToken(delayedPool, {
        accountId,
        createdBy,
        tokenHash: `hash-${randomUUID()}`,
        displayHint: 'fxat_...test',
        scopes,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      }).then((inserted) => ({ id: inserted.id }));
    }

    it('a demotion started while a mint is in flight cannot leave a live token for the now-demoted creator', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');

      let lockAcquired!: () => void;
      const lockAcquiredPromise = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });

      const mintPromise = mintWithHeldLock(refs.accountId, targetId, ['audit:read'], lockAcquired);

      // The mint holds a real Postgres FOR SHARE lock on targetId's
      // account_members row from here until it commits.
      await lockAcquiredPromise;

      const demoteStart = Date.now();
      await setMemberRole(appUserPool, refs.accountId, refs.userId, targetId, 'member');
      const demoteElapsedMs = Date.now() - demoteStart;

      const { id: tokenId } = await mintPromise;

      // The demotion's own UPDATE on this row cannot have completed before
      // the mint's lock was released at commit -- it must have waited at
      // least (allowing scheduler slack) for the mint's held-open window.
      expect(demoteElapsedMs).toBeGreaterThanOrEqual(LOCK_HOLD_MS - 50);

      // Because the demotion could only run AFTER the mint committed, its
      // own revokeTokensForCreatorChange pass sees -- and revokes -- the
      // token the mint just inserted. No live audit:read token survives
      // for the now-demoted creator.
      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_demoted');
    });

    it('a removal started while a mint is in flight cannot leave a live token for the now-removed creator', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'owner');

      let lockAcquired!: () => void;
      const lockAcquiredPromise = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });

      const mintPromise = mintWithHeldLock(refs.accountId, targetId, ['read'], lockAcquired);

      await lockAcquiredPromise;

      const removeStart = Date.now();
      await removeMember(appUserPool, refs.accountId, refs.userId, targetId);
      const removeElapsedMs = Date.now() - removeStart;

      const { id: tokenId } = await mintPromise;

      expect(removeElapsedMs).toBeGreaterThanOrEqual(LOCK_HOLD_MS - 50);

      const row = await tokenRow(tokenId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('creator_removed');
    });

    it('a mint for a creator already demoted below the requested scope is rejected inside the same transaction, not silently downgraded', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const targetId = randomUUID();
      await addMember(refs.accountId, targetId, 'member');

      await expect(mintToken(refs.accountId, targetId, ['audit:read'])).rejects.toThrow();

      const { rows } = await admin.query('SELECT 1 FROM api_tokens WHERE account_id = $1 AND created_by = $2', [
        refs.accountId,
        targetId,
      ]);
      expect(rows).toHaveLength(0);
    });

    // Pre-existing regression guard, not evidence for the C15(a) fix: passes on main too (api_tokens's tenant_isolation_insert policy already requires a membership row).
    it('a mint for a creator already removed from the account is rejected, not inserted for a phantom membership', async () => {
      const refs: SeedRefs = await seedAccount(admin, randomUUID());
      const removedUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        removedUserId,
        `${removedUserId}@example.test`,
      ]);
      // Never added to account_members: same shape as "already removed"
      // by the time this mint transaction runs.

      await expect(mintToken(refs.accountId, removedUserId, ['read'])).rejects.toThrow();
    });
  });
});
