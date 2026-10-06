import type { Pool, PoolClient } from 'pg';
import { withTenant } from './withTenant.js';
import { requireOwner, requireOwnerOrAdmin, type MembershipRole } from './authorize.js';
import { ForbiddenError, NotFoundError } from './errors.js';
import { ROLE_RANK, revokeTokensForCreatorChange } from '../tokens/service.js';

/**
 * D#6 R2a (C11 section 4): a demotion or removal revokes the member's runners in its own transaction (migration 0712's
 * trigger sets `revoked_at` on the rows the member registered), and the runs those runners hold are failed afterwards,
 * by the worker, after the commit. The worker is passed in (this package imports no worker), and the ids are read
 * BEFORE the change because once `revoked_at` is set the runners are no longer "active".
 */
export type RunnerLeaseFailer = (input: { accountId: string; runnerId: string; reason: 'runner_revoked' }) => Promise<{ complete: boolean }>;

export interface MembershipChangeOptions {
  failRunnerLeases?: RunnerLeaseFailer;
}

/** The change is committed and the runners are revoked, but their leases could not all be failed. A caller may repeat the revoke from the runners list. */
export class RunnerLeasesNotFailedError extends Error {
  constructor(readonly runnerIds: string[]) {
    super(`membership change committed; the leases of ${runnerIds.length} revoked runner(s) were not all failed`);
    this.name = 'RunnerLeasesNotFailedError';
  }
}

const MAX_FAIL_CALLS = 10;

async function activeRunnerIds(client: PoolClient, accountId: string, userId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM runners WHERE account_id = $1 AND registered_by = $2 AND revoked_at IS NULL ORDER BY id',
    [accountId, userId],
  );
  return rows.map((r) => r.id);
}

/** Runs after the membership transaction has committed. Each runner is tried even if another fails. */
async function failLeasesAfterCommit(accountId: string, runnerIds: string[], fail: RunnerLeaseFailer | undefined): Promise<void> {
  if (runnerIds.length === 0) return;
  const failed: string[] = [];
  for (const runnerId of runnerIds) {
    try {
      if (!fail) throw new Error('no lease failer');
      for (let call = 0; call < MAX_FAIL_CALLS; call++) {
        if ((await fail({ accountId, runnerId, reason: 'runner_revoked' })).complete) break;
      }
    } catch {
      // fx-swallow-ok: collected and rethrown below as RunnerLeasesNotFailedError, after every runner has been tried
      failed.push(runnerId);
    }
  }
  if (failed.length > 0) throw new RunnerLeasesNotFailedError(failed);
}

async function roleInTx(
  client: PoolClient,
  accountId: string,
  userId: string,
): Promise<MembershipRole | null> {
  const { rows } = await client.query<{ role: MembershipRole }>(
    'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
    [accountId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Security fix round item 7 (CWE-362): locks every 'owner' row for
 * `accountId` with `SELECT ... FOR UPDATE` and returns the count of rows
 * locked. Two concurrent demotes/removals of two DIFFERENT owners used to
 * both read "2 owners" from a plain `count(*)` and both proceed, leaving
 * zero. Locking the rows (not just counting them) forces the second
 * transaction's own SELECT ... FOR UPDATE to block until the first
 * transaction commits or rolls back, so the second transaction's count
 * reflects the FIRST transaction's outcome rather than a stale snapshot
 * taken before it. `count(*) ... FOR UPDATE` is itself rejected by
 * Postgres (row locking cannot be combined with an aggregate), hence
 * selecting the rows and counting them in JS.
 */
async function lockOwnerRows(client: PoolClient, accountId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT id FROM account_members WHERE account_id = $1 AND role = 'owner' FOR UPDATE`,
    [accountId],
  );
  return rows.length;
}

/**
 * Changes `targetUserId`'s role on `accountId`. Application-owned rules
 * (sec-criteria A7), checked here BEFORE any row is touched so a rejected
 * call never reaches the database at all:
 *
 *   1. The actor must already be an owner or admin. This alone is what
 *      stops "a member cannot promote themselves" -- a member calling
 *      this at all, targeting themselves or anyone else, is rejected by
 *      requireOwnerOrAdmin before any row is touched.
 *   2. Security fix round item 5 (CWE-269): granting the owner role, or
 *      taking it away from someone who already has it, additionally
 *      requires the ACTOR to already be an owner -- an admin may promote
 *      or demote other admins/members, but may not make themselves (or
 *      anyone) owner, and may not demote an existing owner even while
 *      other owners remain.
 *   3. The account must always keep at least one owner: demoting the
 *      last remaining owner away from 'owner' is refused. The owner rows
 *      are locked (item 7) before counting so two concurrent demotes of
 *      two different owners can't both observe "2 owners" and both
 *      proceed.
 *
 * D#64: all three rules are now ALSO enforced at the database layer as a
 * floor (migrations/0005_account_members_role_gate.sql) -- rules 1 and 2
 * by role-gated RLS policies, rule 3 by a trigger with its own per-account
 * lock (a raw-SQL equivalent of item 7's lockOwnerRows, for statement
 * paths that never go through this function at all). The checks in THIS
 * function still run first and are what a normal caller actually hits --
 * the database-level 23514 that rule 3's trigger can raise is not
 * normally reachable through setMemberRole, since lockOwnerRows' own count
 * already refuses the same case beforehand (see the trigger's own
 * "Accepted residual" note for the one narrow case where both could see a
 * caller as a valid owner).
 */
export async function setMemberRole(
  pool: Pool,
  accountId: string,
  actorUserId: string,
  targetUserId: string,
  newRole: MembershipRole,
  options: MembershipChangeOptions = {},
): Promise<void> {
  const runnerIds = await withTenant(pool, accountId, actorUserId, async (client) => {
    const actorRole = await roleInTx(client, accountId, actorUserId);
    requireOwnerOrAdmin(actorRole);

    const targetRole = await roleInTx(client, accountId, targetUserId);
    if (targetRole === null) {
      throw new NotFoundError(`account_members ${targetUserId} not found on ${accountId}`);
    }

    if (newRole === 'owner' || targetRole === 'owner') {
      requireOwner(actorRole);
    }

    if (targetRole === 'owner' && newRole !== 'owner') {
      const owners = await lockOwnerRows(client, accountId);
      if (owners <= 1) {
        throw new ForbiddenError('cannot demote the last owner');
      }
    }

    // Read before the change: the trigger revokes these runners in the same transaction as the UPDATE below.
    const losesRunners = targetRole !== newRole && newRole !== 'owner' && newRole !== 'admin';
    const toFail = losesRunners ? await activeRunnerIds(client, accountId, targetUserId) : [];

    await client.query(
      'UPDATE account_members SET role = $1 WHERE account_id = $2 AND user_id = $3',
      [newRole, accountId, targetUserId],
    );

    // D#31 C13d criterion 1/2 (API-3e): "demoted" is any decrease in
    // ROLE_RANK -- a promotion or a same-rank change revokes nothing.
    // Same `client`/transaction as the role change above, so an injected
    // failure before COMMIT rolls both back together.
    if (ROLE_RANK[newRole] < ROLE_RANK[targetRole]) {
      await revokeTokensForCreatorChange(client, accountId, targetUserId, 'creator_demoted');
    }
    return toFail;
  });
  await failLeasesAfterCommit(accountId, runnerIds, options.failRunnerLeases);
}

/** Removes `targetUserId` from `accountId`, subject to the same rules as setMemberRole (an owner target additionally requires an owner actor, per security fix round item 5). */
export async function removeMember(
  pool: Pool,
  accountId: string,
  actorUserId: string,
  targetUserId: string,
  options: MembershipChangeOptions = {},
): Promise<void> {
  const runnerIds = await withTenant(pool, accountId, actorUserId, async (client) => {
    const actorRole = await roleInTx(client, accountId, actorUserId);
    requireOwnerOrAdmin(actorRole);

    const targetRole = await roleInTx(client, accountId, targetUserId);
    if (targetRole === null) {
      throw new NotFoundError(`account_members ${targetUserId} not found on ${accountId}`);
    }

    if (targetRole === 'owner') {
      requireOwner(actorRole);
      const owners = await lockOwnerRows(client, accountId);
      if (owners <= 1) {
        throw new ForbiddenError('cannot remove the last owner');
      }
    }

    // D#31 C13d criterion 4 (API-3e): revoked BEFORE the DELETE below,
    // still in the same transaction/`client`. audit_write_api_tokens's
    // actor lookup (current_member_user_id()) needs the ACTING user's own
    // account_members row to still exist -- doing this first keeps that
    // true even for a self-removal (actor === targetUserId, legal above
    // when another owner remains), where the DELETE would otherwise
    // remove the actor's own row before the audit write runs.
    await revokeTokensForCreatorChange(client, accountId, targetUserId, 'creator_removed');

    const toFail = await activeRunnerIds(client, accountId, targetUserId);
    await client.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [
      accountId,
      targetUserId,
    ]);
    return toFail;
  });
  await failLeasesAfterCommit(accountId, runnerIds, options.failRunnerLeases);
}
