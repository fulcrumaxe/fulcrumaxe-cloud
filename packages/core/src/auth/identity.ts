import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withPlatformOps } from '../tenancy/withPlatformOps.js';
import { onAccountCreated } from './onAccountCreated.js';
import type { ExternalIdentity } from './provider.js';
import { isSigninAllowed, signinAllowlist } from './signinAllowlist.js';

export interface IdentityRecord {
  id: string;
  email: string;
  name: string | null;
  /** D#37 WS-C1 criterion 8: the live "sign out everywhere" epoch, read from `users.session_epoch` (migrations/0604_session_epoch.sql). A brand-new row starts at the column's DEFAULT 0. */
  sessionEpoch: number;
  /** D#37 WS-C1 criterion 3 (correction C8): the GitHub login handle, from `users.github_login`. Null only for a row that existed before this migration and hasn't signed in again since -- see findOrCreateUserByGithub's own note on why every sign-in (not only the first) writes this column. */
  githubLogin: string | null;
}

/**
 * sec-criteria A5: identity lifecycle is platform_ops-only, so sign-in
 * and sign-up run there, and H06 generates the user's UUID itself rather
 * than reaching for `INSERT ... RETURNING id` -- see
 * packages/db/src/withTenant.ts's own note on why RETURNING is the wrong
 * tool against a table whose SELECT policy can differ from its INSERT
 * policy. Generating the id here means the id this function returns is
 * always the same id it just wrote, never one read back through a
 * SELECT policy that might not show it.
 */
export async function findOrCreateUserByGithub(
  platformOpsPool: Pool,
  identity: ExternalIdentity,
): Promise<IdentityRecord> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<{ id: string; email: string; name: string | null; session_epoch: number }>(
      'SELECT id, email, name, session_epoch FROM users WHERE github_user_id = $1',
      [identity.githubUserId],
    );
    const existing = rows[0];
    if (existing) {
      // D#37 WS-C1 criterion 3 (correction C8): "capture the GitHub login
      // at sign-in" -- written on EVERY sign-in, not only the first, so
      // (a) a row from before this column existed gets backfilled on its
      // next sign-in rather than staying null forever, and (b) a real
      // GitHub username rename is picked up rather than going stale.
      await client.query('UPDATE users SET github_login = $1 WHERE id = $2', [identity.githubLogin, existing.id]);
      return {
        id: existing.id,
        email: existing.email,
        name: existing.name,
        sessionEpoch: existing.session_epoch,
        githubLogin: identity.githubLogin,
      };
    }

    const id = randomUUID();
    await client.query('INSERT INTO users (id, github_user_id, email, name, github_login) VALUES ($1, $2, $3, $4, $5)', [
      id,
      identity.githubUserId,
      identity.email,
      identity.name,
      identity.githubLogin,
    ]);
    return { id, email: identity.email, name: identity.name, sessionEpoch: 0, githubLogin: identity.githubLogin };
  });
}

/** The signed-in user's own email, looked up by id (platform_ops -- users' own SELECT policy for app_user requires shared membership, which isn't guaranteed at this point). Used to confirm an invitation-accept request's email matches the invitee's real identity (sec-criteria A1). */
export async function getUserEmail(platformOpsPool: Pool, userId: string): Promise<string | null> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      userId,
    ]);
    return rows[0]?.email ?? null;
  });
}

/**
 * D#37 WS-C1 criterion 3 (correction C8): what `/api/cloud/auth/me` and
 * `/api/profile` need in one round trip -- email plus the GitHub login.
 * Returns null when the user row doesn't exist (same "never a default
 * row" rule as `getUserEmail`; the caller answers 401, not a fabricated
 * identity).
 */
export async function getUserProfile(
  platformOpsPool: Pool,
  userId: string,
): Promise<{ email: string; githubLogin: string | null } | null> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<{ email: string; github_login: string | null }>(
      'SELECT email, github_login FROM users WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    return row ? { email: row.email, githubLogin: row.github_login } : null;
  });
}

export interface Membership {
  accountId: string;
  role: 'owner' | 'admin' | 'member';
}

/** Every account `userId` belongs to. platform_ops's account_members policy is unconditional, so this legitimately spans accounts -- the caller already knows userId from an authenticated session, not from guessing. */
export async function listMemberships(platformOpsPool: Pool, userId: string): Promise<Membership[]> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<Membership>(
      'SELECT account_id AS "accountId", role FROM account_members WHERE user_id = $1',
      [userId],
    );
    return rows;
  });
}

/**
 * Creates a brand-new account with `ownerUserId` as its sole owner, in
 * one transaction, then runs every D#2607 onAccountCreated hook (still
 * inside that same transaction, via the shared client) before committing.
 * Both INSERTs use platform_ops: `accounts` INSERT is platform_ops-only
 * by grant, and account_members' `invited_only_insert` policy (app_user
 * only) would otherwise require an invitation that can't exist yet for a
 * founding owner -- platform_ops's own account_members policy has no such
 * requirement.
 */
export async function createAccountForNewOwner(
  platformOpsPool: Pool,
  ownerUserId: string,
): Promise<{ accountId: string }> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const accountId = randomUUID();
    // D#69 (migration 0606): no stripe_customer_id exists yet for a brand
    // new signup, so `status` is left unwritten here -- accounts_derive_status
    // computes it as 'unsubscribed' (the column default, and what the
    // trigger derives regardless of the default).
    await client.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [accountId]);
    await client.query(
      `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [accountId, ownerUserId],
    );
    for (const hook of onAccountCreated) {
      await hook({ accountId, ownerUserId, client });
    }
    return { accountId };
  });
}

export interface SignedInSession {
  userId: string;
  accountId: string;
  /** D#37 WS-C1 criterion 8: the epoch to embed in the session JWT (`signSession`'s `options.epoch`). */
  epoch: number;
}

/**
 * Sign-up: find-or-create the identity, then (only for a brand-new
 * identity with no existing membership anywhere) create their first
 * account as its owner. A returning identity signs in against their
 * first existing membership instead of minting a second account --
 * sign-up and sign-in converge on the same GitHub identity by design, so
 * this function covers "sign in with GitHub, creating an account on
 * first use" rather than requiring two separate entry points.
 */
export async function signUpOrSignIn(
  platformOpsPool: Pool,
  identity: ExternalIdentity,
): Promise<SignedInSession> {
  const user = await findOrCreateUserByGithub(platformOpsPool, identity);
  const memberships = await listMemberships(platformOpsPool, user.id);
  if (memberships.length > 0) {
    return { userId: user.id, accountId: memberships[0]!.accountId, epoch: user.sessionEpoch };
  }
  const { accountId } = await createAccountForNewOwner(platformOpsPool, user.id);
  return { userId: user.id, accountId, epoch: user.sessionEpoch };
}

/**
 * D#37 WS-C1 criterion 8: "a 'sign out everywhere' action invalidates
 * every session of the user server-side (e.g. a per-user session
 * epoch)." Atomically increments `users.session_epoch` and returns the
 * new value; every session JWT embeds the epoch it was signed under
 * (`signSession`'s `options.epoch`), so a caller that re-checks a
 * session's embedded epoch against this live value (`getSessionEpochAndRevocation`)
 * can detect and reject one signed before the bump, even though the JWT
 * itself is still cryptographically valid and not yet time-expired.
 */
export async function bumpSessionEpoch(
  platformOpsPool: Pool,
  userId: string,
  options: { emitSessionRevoked?: boolean } = {},
): Promise<number> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<{ session_epoch: number }>(
      'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1 RETURNING session_epoch',
      [userId],
    );
    if (rows.length === 0) {
      throw new Error(`bumpSessionEpoch: no user row for id ${userId}`);
    }
    if (options.emitSessionRevoked) {
      // API-5c: one internal `session.revoked` outbox row per account the user belongs to, in the SAME
      // transaction as the bump (platform_ops holds INSERT on domain_events; no new grant). It carries no
      // secret and never reaches a wire: the account streams use it to re-check the user's other devices at
      // once. Last statement before COMMIT (case-A guard).
      await client.query(
        `INSERT INTO domain_events (account_id, type, subject_id, payload)
         SELECT account_id, 'session.revoked', user_id::text, '{"reason":"signed_out_everywhere"}'::jsonb
           FROM account_members WHERE user_id = $1`,
        [userId],
      );
    }
    return rows[0]!.session_epoch;
  });
}

export interface SessionEpochAndRevocation {
  /** The live `users.session_epoch` -- see `bumpSessionEpoch`'s doc comment. */
  epoch: number;
  /** True if `sessionId` has a row in `revoked_sessions` (migrations/0609_revoked_sessions.sql). */
  revoked: boolean;
}

/**
 * D#37 WS-C2 fix round item 1 (E1, CWE-613, correction C15a): the live
 * epoch AND the per-session revoked flag, in ONE round trip -- the
 * caller (`resolveActiveSession`, lib/shell/session-guard.ts) needs
 * both on every request that carries a session cookie, and a second
 * query per request is exactly the DB round trip this fix round's own
 * instruction says to avoid. Returns null if the user doesn't exist (a
 * caller should then reject the session, same as any other lookup
 * failure -- this replaces the old `currentSessionEpoch`, which had the
 * same null-on-missing-user contract).
 */
export async function getSessionEpochAndRevocation(
  platformOpsPool: Pool,
  userId: string,
  sessionId: string,
): Promise<SessionEpochAndRevocation | null> {
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<{ session_epoch: number; revoked: boolean }>(
      'SELECT session_epoch, EXISTS (SELECT 1 FROM revoked_sessions WHERE session_id = $2) AS revoked FROM users WHERE id = $1',
      [userId, sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    // Staging lock (FX_SIGNIN_ALLOWLIST): every session-honouring handler
    // (resolveActiveSession, the API principal, the event stream) reaches
    // this function, so a login taken off the list is refused on its next
    // request. With the lock off nothing extra is queried. A row whose login
    // was never recorded is refused while the lock is on.
    if (signinAllowlist() !== null) {
      const login = await client.query<{ github_login: string | null }>('SELECT github_login FROM users WHERE id = $1', [userId]);
      if (!isSigninAllowed(login.rows[0]?.github_login)) return null;
    }
    return { epoch: row.session_epoch, revoked: row.revoked };
  });
}

/**
 * D#37 WS-C2 fix round item 1 (E1, CWE-613, correction C15a): records
 * that `sessionId` (the session JWT's `sid` claim -- session.ts) is
 * revoked, so a later `getSessionEpochAndRevocation` re-check rejects
 * it even though it is still cryptographically valid and not yet
 * time-expired. `ON CONFLICT ... DO NOTHING` because signout/handler.ts
 * calls this for every sign-out with an accepted cookie -- a second
 * sign-out request replaying (or racing) the same still-valid cookie
 * before the client wipes it must not error, just stay revoked.
 *
 * Fix round 1 (E1, CWE-770/400, correction C15a): `expiresAt` is the
 * revoked session's own absolute deadline (the caller passes
 * `sessionStart + absoluteLimitSeconds() * 1000` -- see
 * signout/handler.ts). Once that time passes the token could never have
 * authenticated again anyway (session.ts's verifySession fails it on
 * time alone), so this also deletes every row -- across every user, not
 * just this one -- whose `expires_at` has already passed, in the SAME
 * transaction as the insert. This is the purge C15a describes ("the row
 * can go" / "may delete expired rows in the same transaction"): opportunistic
 * and tied to the one write path that already touches this table, not a
 * separate scheduled job. 0609_revoked_sessions.sql's `platform_ops`
 * DELETE grant exists for exactly this query.
 */
export async function revokeSession(
  platformOpsPool: Pool,
  sessionId: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  return withPlatformOps(platformOpsPool, async (client) => {
    await client.query(
      'INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (session_id) DO NOTHING',
      [sessionId, userId, expiresAt],
    );
    await client.query('DELETE FROM revoked_sessions WHERE expires_at < now()');
  });
}
