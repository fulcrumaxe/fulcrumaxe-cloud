import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { withPlatformOps } from '../tenancy/withPlatformOps.js';
import { requireOwner, requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';

/** Thrown for every way an invitation-accept attempt is invalid: wrong/absent/used token, expired, or an email mismatch. Deliberately one error type -- the caller (a route handler) should return the same generic rejection either way, never distinguishing "wrong token" from "right token, wrong account" for an attacker probing it. */
export class InvalidInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvitationError';
  }
}

/** The raw, single-use token goes out in the email; only its hash is ever stored (invitations.token_hash). */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Creates an invitation for `email`/`role` on `accountId`. Ordinary
 * tenant operation at the database level (H02: "creating and managing
 * invitations is an ordinary tenant operation"), but H06 additionally
 * requires the actor to be owner|admin -- inviting someone in with a
 * chosen role is itself a role-affecting action, so it goes through the
 * same gate as changing one (requireOwnerOrAdmin).
 *
 * Second security review, finding 10 (CWE-269, same class as membership.ts's
 * setMemberRole/removeMember fix): requireOwnerOrAdmin alone let an admin
 * invite a controlled identity as owner, who could then accept and remove
 * the original owner -- bypassing the owner-only rule on granting the
 * owner role. Inviting someone as owner now additionally requires the
 * actor to already be an owner, exactly like changing an existing member's
 * role to owner does.
 */
export async function createInvitation(
  appUserPool: Pool,
  accountId: string,
  actorUserId: string,
  invitee: { email: string; role: MembershipRole },
): Promise<{ id: string; rawToken: string; expiresAt: Date }> {
  return withTenant(appUserPool, accountId, actorUserId, async (client) => {
    const { rows: actorRows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, actorUserId],
    );
    const actorRole = actorRows[0]?.role ?? null;
    requireOwnerOrAdmin(actorRole);
    if (invitee.role === 'owner') {
      requireOwner(actorRole);
    }

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [accountId, invitee.email, invitee.role, tokenHash, actorUserId, expiresAt],
    );
    return { id: rows[0]!.id, rawToken, expiresAt };
  });
}

interface InvitationCandidate {
  id: string;
  accountId: string;
  email: string;
  role: MembershipRole;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
}

/**
 * Looks up an invitation by the RAW token (never by id, account, or
 * email -- those aren't what the invitee holds). Cross-account by
 * necessity: the accepting account isn't known yet, so this has to run
 * as platform_ops (read-only; platform_ops's own grant on `invitations`
 * is SELECT only). Returns null for a wrong, absent, or fabricated token
 * without distinguishing why -- the caller (acceptInvitation) treats
 * "not found" the same as every other rejection.
 */
async function lookupInvitationByToken(
  platformOpsPool: Pool,
  rawToken: string,
): Promise<InvitationCandidate | null> {
  const tokenHash = hashInvitationToken(rawToken);
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      account_id: string;
      email: string;
      role: MembershipRole;
      invited_by: string | null;
      expires_at: string;
      accepted_at: string | null;
    }>(
      'SELECT id, account_id, email, role, invited_by, expires_at, accepted_at FROM invitations WHERE token_hash = $1',
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      role: row.role,
      invitedBy: row.invited_by,
      expiresAt: new Date(row.expires_at),
      acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
    };
  });
}

export interface AcceptInvitationResult {
  accountId: string;
  role: MembershipRole;
}

/**
 * sec-criteria A1 + A2, in full:
 *
 *   A1. The raw token is verified -- matched, unexpired, unaccepted, and
 *       for the signed-in identity's OWN email -- BEFORE any membership
 *       row is inserted. `has_open_invitation()` (the database's own
 *       gate on the account_members INSERT below) proves only that SOME
 *       matching open invitation exists; it has no way to check that the
 *       caller actually holds the emailed token, which is the real
 *       security boundary here.
 *   A2. The membership INSERT and consuming the invitation (accepted_at)
 *       happen in the SAME transaction, via withTenant/app_user so the
 *       INSERT still goes through has_open_invitation() as a second,
 *       defense-in-depth check (not bypassed by running as platform_ops).
 *       The INSERT runs BEFORE the UPDATE: has_open_invitation() checks
 *       accepted_at IS NULL, so consuming it first would make the
 *       INSERT it's meant to gate fail instead.
 *
 * Second security review, finding 10: an owner-role invitation is honored
 * on accept only if whoever created it is STILL an owner of the account at
 * accept time -- createInvitation's requireOwner gate proves the inviter
 * was an owner at invite time, but an open invitation can sit unaccepted
 * for days, long enough for that owner to be demoted or removed. Without
 * this recheck, an already-issued owner invitation would still mint a new
 * owner even after the account no longer trusts its issuer to do that.
 * Checked inside the SAME transaction as the membership INSERT, against
 * the SAME tenant-scoped client, so it can't be raced by a concurrent
 * demote any more than has_open_invitation() itself can.
 */
export async function acceptInvitation(
  pools: { platformOps: Pool; appUser: Pool },
  rawToken: string,
  invitee: { userId: string; email: string },
): Promise<AcceptInvitationResult> {
  const invitation = await lookupInvitationByToken(pools.platformOps, rawToken);
  if (!invitation) {
    throw new InvalidInvitationError('no invitation matches this token');
  }
  if (invitation.acceptedAt !== null) {
    throw new InvalidInvitationError('invitation already accepted');
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new InvalidInvitationError('invitation expired');
  }
  if (invitation.email.toLowerCase() !== invitee.email.toLowerCase()) {
    throw new InvalidInvitationError('invitation email does not match the signed-in identity');
  }

  return withTenant(pools.appUser, invitation.accountId, invitee.userId, async (client) => {
    if (invitation.role === 'owner') {
      const { rows: inviterRows } = await client.query<{ role: MembershipRole }>(
        'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
        [invitation.accountId, invitation.invitedBy],
      );
      if ((inviterRows[0]?.role ?? null) !== 'owner') {
        throw new InvalidInvitationError(
          'invitation grants the owner role but the inviter is no longer an owner',
        );
      }
    }

    try {
      await client.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`,
        [invitation.accountId, invitee.userId, invitation.role],
      );
    } catch {
      // has_open_invitation() rejected the INSERT -- most likely the
      // invitation was consumed concurrently between our lookup above and
      // this INSERT. Surface it as the same InvalidInvitationError the
      // caller already handles, not a raw Postgres error.
      throw new InvalidInvitationError('invitation is no longer open');
    }

    const consumed = await client.query(
      'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL',
      [invitation.id],
    );
    if (consumed.rowCount !== 1) {
      throw new InvalidInvitationError('invitation was accepted concurrently');
    }

    return { accountId: invitation.accountId, role: invitation.role };
  });
}
