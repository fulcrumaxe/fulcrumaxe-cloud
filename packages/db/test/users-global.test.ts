import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 H02 security fix round 3 (ERROR: identity takeover through
 * membership). Round 2 made `users` global with membership-gated SELECT,
 * but left INSERT open and gave app_user UPDATE/DELETE on any user row it
 * shared an account with. Combined with account_members' INSERT policy
 * only checking account_id (not who's being added), the reviewer found a
 * full chain: a tenant that knew or guessed ANY real user uuid could
 *   1. attach that stranger to its own account via account_members,
 *   2. read their PII (email, name, github_user_id) once "co-members",
 *   3. UPDATE that PII,
 *   4. DELETE their user row outright, which
 *   5. cascade-deleted the VICTIM's OWN account_members row in their real
 *      account, locking them out of it.
 *
 * This file proves the chain is closed at every step (this used to be
 * `users-global.test.ts`'s "a tenant may add a member row naming another
 * tenant's real user id" test, which asserted step 1 SUCCEEDING as
 * intentional -- round 2's own design was the bug the reviewer found), and
 * that the legitimate replacement -- invite by email, then join -- works.
 *
 * Round 5 ERROR: round 3's fix introduced its OWN leak. The gate function
 * (then `invitation_target_email()`) RETURNED the target user's email to
 * app_user for any user uuid -- so a tenant could resolve a victim's email
 * itself, write a matching invitation into its own account using that
 * resolved email, then run step 1 as if a real invitation had always
 * existed. `has_open_invitation()` replaces it: boolean-only, the
 * invitations-to-users join happens INSIDE the function, so nothing about
 * the target crosses back to the caller. See the second describe block
 * below.
 */
describe('users RLS + identity-takeover fix (invitations gate account_members INSERT)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);

    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  it('tenant A sees only users who are members of account A', async () => {
    await withTenant(appUserPool, refsA.accountId, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM users');
      expect(rows.map((r) => r.id)).toEqual([refsA.userId]);
    });
  });

  it('SELECT on users with app.account_id unset returns zero rows (fail closed)', async () => {
    const client = await appUserPool.connect();
    try {
      const { rows } = await client.query('SELECT * FROM users');
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it(
    'users.github_user_id is UNIQUE (security fix round 3 warning 1 -- defense in ' +
      'depth now that identity creation is platform_ops, not app_user)',
    async () => {
      const first = randomUUID();
      const second = randomUUID();
      await admin.query('INSERT INTO users (id, email, github_user_id) VALUES ($1, $2, 4242)', [
        first,
        `${first}@example.test`,
      ]);
      await expect(
        admin.query('INSERT INTO users (id, email, github_user_id) VALUES ($1, $2, 4242)', [
          second,
          `${second}@example.test`,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    },
  );

  describe("the round-3 reviewer's chain, closed at every step", () => {
    it('step 1 (attach): adding a foreign user id to account_members WITHOUT a matching invitation is rejected', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
            [refsA.accountId, refsB.userId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it("step 2 (read PII): tenant A cannot see tenant B's user row without a shared membership", async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query('SELECT * FROM users WHERE id = $1', [
          refsB.userId,
        ]);
        expect(rows).toEqual([]);
      });
    });

    it('step 3 (update): app_user cannot UPDATE any user row -- identity lifecycle is platform_ops now', async () => {
      // Even a REAL co-member of A's own account (refsA.userId, legitimately
      // visible) can't be updated: the grant is gone entirely, not just
      // re-gated by membership.
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`UPDATE users SET name = 'pwned' WHERE id = $1`, [refsA.userId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it("step 4 (delete) + step 5 (cascade): app_user cannot DELETE any user row, so the victim's own membership can never cascade away", async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query('DELETE FROM users WHERE id = $1', [refsA.userId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened -- refsA's own
      // membership in their own (real) account is untouched.
      const { rows } = await admin.query(
        'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
        [refsA.accountId, refsA.userId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("the round-5 reviewer's chain (leaking the gate function's return value), closed", () => {
    it('the old exploit path (a value-returning gate function) no longer exists at all', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query('SELECT invitation_target_email($1)', [refsB.userId]);
        }),
      ).rejects.toMatchObject({ code: '42883' }); // undefined_function
    });

    it('has_open_invitation() itself never returns anything but a boolean, even to a caller who can call it directly', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query<{ result: boolean }>(
          'SELECT has_open_invitation($1, $2, $3) AS result',
          [refsA.accountId, refsB.userId, 'member'],
        );
        expect(rows).toEqual([{ result: false }]);
      });
    });

    it(
      'security fix round 6: a cross-account probe (target_account_id belonging to ' +
        'ANOTHER account than the session) returns false, even for a real open invitation',
      async () => {
        // A genuine, real invitation on account B -- not a guess. Before
        // round 6, calling has_open_invitation(B, ..., ...) as session A
        // returned the truthful answer for B regardless of session,
        // leaking one bit ("does B have an open invite for this user and
        // role") that account_members' own policy never needed exposed,
        // since it always calls this with account_id = the session's own.
        const inviteeEmail = `probe-${randomUUID()}@example.test`;
        const inviteeId = randomUUID();
        await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
          inviteeId,
          inviteeEmail,
        ]);
        await admin.query(
          `INSERT INTO invitations (account_id, email, role, token_hash, expires_at)
           VALUES ($1, $2, 'member', $3, now() + interval '7 days')`,
          [refsB.accountId, inviteeEmail, `hash-${randomUUID()}`],
        );

        // As session A, asking about B's invitation must come back false.
        await withTenant(appUserPool, refsA.accountId, async (client) => {
          const { rows } = await client.query<{ result: boolean }>(
            'SELECT has_open_invitation($1, $2, $3) AS result',
            [refsB.accountId, inviteeId, 'member'],
          );
          expect(rows).toEqual([{ result: false }]);
        });

        // Sanity: the SAME call, as session B (the account the invitation
        // actually belongs to), still returns true -- proves the false
        // above is specifically about the session/account_id mismatch,
        // not a broken invitation or a broken function.
        await withTenant(appUserPool, refsB.accountId, async (client) => {
          const { rows } = await client.query<{ result: boolean }>(
            'SELECT has_open_invitation($1, $2, $3) AS result',
            [refsB.accountId, inviteeId, 'member'],
          );
          expect(rows).toEqual([{ result: true }]);
        });
      },
    );

    it(
      'the full round-5 chain fails: tenant A cannot resolve a real email for B\'s user id ' +
        'from ANY function it can call, so it can only ever write an invitation against a ' +
        'GUESSED email -- which has_open_invitation correctly refuses to match',
      async () => {
        // Without invitation_target_email, A has no function that hands it
        // B's real email -- member_visible (users' own SELECT policy)
        // already denies A direct visibility into B's row (proven above).
        // The only thing left for an attacker to try is GUESSING the
        // email and writing an invitation against the guess.
        const guessedEmail = `${randomUUID()}@example.test`;

        await expect(
          withTenant(appUserPool, refsA.accountId, async (client) => {
            await client.query(
              `INSERT INTO invitations (account_id, email, role, token_hash, expires_at)
               VALUES ($1, $2, 'member', $3, now() + interval '7 days')`,
              [refsA.accountId, guessedEmail, `hash-${randomUUID()}`],
            );
            await client.query(
              `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
              [refsA.accountId, refsB.userId],
            );
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      },
    );
  });

  it('app_user cannot INSERT a new identity at all (identity creation is platform_ops -- H06)', async () => {
    const newUserId = randomUUID();
    await expect(
      withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
          newUserId,
          `${newUserId}@example.test`,
        ]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('platform_ops CAN create, update and delete identities freely', async () => {
    const newUserId = randomUUID();
    await platformOpsPool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      newUserId,
      `${newUserId}@example.test`,
    ]);
    await platformOpsPool.query(`UPDATE users SET name = 'Updated' WHERE id = $1`, [newUserId]);
    await platformOpsPool.query('DELETE FROM users WHERE id = $1', [newUserId]);
    const { rows } = await platformOpsPool.query('SELECT 1 FROM users WHERE id = $1', [
      newUserId,
    ]);
    expect(rows).toEqual([]);
  });

  describe('the legitimate path: invite by email, then join', () => {
    it('happy path: an invited user (matched by email, never by guessing a uuid) can be added and becomes visible', async () => {
      const inviteeEmail = `invitee-${randomUUID()}@example.test`;
      const inviteeId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        inviteeId,
        inviteeEmail,
      ]);

      // D#64 setup-only change: invitations' INSERT is now role-gated and
      // requires invited_by to be the caller's own membership id -- the
      // session needs an owner/admin identity (refsA.userId, the account's
      // seeded owner) to issue this invitation at all. The invitation
      // itself, and what it gates, are unchanged.
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        // Tenant A invites by EMAIL -- it has no way to know inviteeId.
        await client.query(
          `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, 'member', $3, $4, now() + interval '7 days')`,
          [refsA.accountId, inviteeEmail, `hash-${randomUUID()}`, refsA.userId],
        );

        // The join now succeeds: a matching unexpired, unaccepted
        // invitation exists for that user's email, on this account, for
        // this role.
        await client.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
          [refsA.accountId, inviteeId],
        );

        const { rows } = await client.query('SELECT id FROM users WHERE id = $1', [inviteeId]);
        expect(rows).toHaveLength(1);
      });
    });

    it(
      'security fix round 7 suggestion 2: an invitation to a differently-cased email ' +
        "still admits the user whose stored email differs only by case",
      async () => {
        // Two different flows populate these two columns (H06 sign-in vs.
        // however a tenant types an address into the invite UI), with no
        // guarantee either one normalizes casing -- has_open_invitation()
        // must not silently block a legitimate accept just because they
        // differ by case.
        const inviteeId = randomUUID();
        await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
          inviteeId,
          'alice@example.com',
        ]);

        // D#64 setup-only change: same reason as the happy-path test above
        // -- issuing an invitation now requires an owner/admin session.
        await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
          await client.query(
            `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'member', $3, $4, now() + interval '7 days')`,
            [refsA.accountId, 'Alice@Example.com', `hash-${randomUUID()}`, refsA.userId],
          );

          await expect(
            client.query(
              `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
              [refsA.accountId, inviteeId],
            ),
          ).resolves.toBeDefined();
        });
      },
    );

    it('an EXPIRED invitation does not let the join through', async () => {
      const inviteeEmail = `expired-${randomUUID()}@example.test`;
      const inviteeId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        inviteeId,
        inviteeEmail,
      ]);
      await admin.query(
        `INSERT INTO invitations (account_id, email, role, token_hash, expires_at)
         VALUES ($1, $2, 'member', $3, now() - interval '1 hour')`,
        [refsA.accountId, inviteeEmail, `hash-${randomUUID()}`],
      );

      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
            [refsA.accountId, inviteeId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('an already-ACCEPTED invitation cannot be reused', async () => {
      const inviteeEmail = `used-${randomUUID()}@example.test`;
      const inviteeId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        inviteeId,
        inviteeEmail,
      ]);
      await admin.query(
        `INSERT INTO invitations (account_id, email, role, token_hash, expires_at, accepted_at)
         VALUES ($1, $2, 'member', $3, now() + interval '7 days', now())`,
        [refsA.accountId, inviteeEmail, `hash-${randomUUID()}`],
      );

      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
            [refsA.accountId, inviteeId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it("an invitation for a DIFFERENT account doesn't let the join through (invitations are account-scoped)", async () => {
      const inviteeEmail = `cross-${randomUUID()}@example.test`;
      const inviteeId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        inviteeId,
        inviteeEmail,
      ]);
      // Invitation exists for account B, not account A.
      await admin.query(
        `INSERT INTO invitations (account_id, email, role, token_hash, expires_at)
         VALUES ($1, $2, 'member', $3, now() + interval '7 days')`,
        [refsB.accountId, inviteeEmail, `hash-${randomUUID()}`],
      );

      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
            [refsA.accountId, inviteeId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it(
      'security fix round 5 suggestion 3: a MEMBER invitation does not admit an OWNER row ' +
        '(the invitation role and the inserted row role must match)',
      async () => {
        const inviteeEmail = `role-mismatch-${randomUUID()}@example.test`;
        const inviteeId = randomUUID();
        await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
          inviteeId,
          inviteeEmail,
        ]);
        await admin.query(
          `INSERT INTO invitations (account_id, email, role, token_hash, expires_at)
           VALUES ($1, $2, 'member', $3, now() + interval '7 days')`,
          [refsA.accountId, inviteeEmail, `hash-${randomUUID()}`],
        );

        await expect(
          withTenant(appUserPool, refsA.accountId, async (client) => {
            await client.query(
              `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
              [refsA.accountId, inviteeId],
            );
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

        // Sanity: the SAME invitation, joined with the role it actually
        // grants, succeeds -- proves the rejection above is about the role
        // mismatch specifically, not a broken invitation.
        await withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
            [refsA.accountId, inviteeId],
          );
          const { rows } = await client.query(
            'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
            [refsA.accountId, inviteeId],
          );
          expect(rows).toEqual([{ role: 'member' }]);
        });
      },
    );
  });
});
