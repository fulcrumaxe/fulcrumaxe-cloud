import type { Pool } from 'pg';
import { withTenant } from './withTenant.js';
import { ForbiddenError } from './errors.js';

export type MembershipRole = 'owner' | 'admin' | 'member';

/**
 * The one gate every "owner|admin only" mutation calls (H06 pass/fail
 * item 4: caps, role settings, auto-merge and billing may only be
 * changed by an owner or admin). H05 (caps), H10 (billing) and H12 (role
 * settings, auto-merge) each own their own mutation route, but every one
 * of them calls this exact function rather than re-deriving the rule --
 * see test/unit/authorize.test.ts, which exercises it directly against
 * all four named mutation kinds.
 *
 * D#64: for account_members itself (and invitations), the database now
 * enforces this same owner/admin rule as a floor --
 * migrations/0005_account_members_role_gate.sql's role-gated policies
 * refuse the equivalent raw SQL regardless of this function ever running.
 * This function is still the only enforcement for every OTHER mutation
 * kind listed above (caps, role settings, auto-merge, billing), which
 * have no table-level role gate of their own.
 */
export function requireOwnerOrAdmin(role: MembershipRole | null): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new ForbiddenError(
      `requires account role owner or admin, got: ${role === null ? 'no membership' : role}`,
    );
  }
}

/**
 * Security fix round item 5 (CWE-269): granting the owner role, or
 * taking it away from someone who already has it, is more sensitive than
 * an ordinary owner|admin mutation -- requireOwnerOrAdmin alone let an
 * admin promote themselves to owner, then demote or remove the original
 * owners. membership.ts's setMemberRole/removeMember call this
 * ADDITIONALLY, on top of requireOwnerOrAdmin, exactly when the mutation
 * grants, revokes, or removes the owner role.
 */
export function requireOwner(role: MembershipRole | null): void {
  if (role !== 'owner') {
    throw new ForbiddenError(
      `requires account role owner, got: ${role === null ? 'no membership' : role}`,
    );
  }
}

/** The caller's own role on `accountId`, or null if they aren't a member (or the account is soft-deleted). */
export async function getMemberRole(
  pool: Pool,
  accountId: string,
  userId: string,
): Promise<MembershipRole | null> {
  return withTenant(pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    return rows[0]?.role ?? null;
  });
}
