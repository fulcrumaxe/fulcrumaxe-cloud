import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { ForbiddenError } from '../../src/tenancy/errors.js';
import {
  InvalidInvitationError,
  acceptInvitation,
  createInvitation,
  hashInvitationToken,
} from '../../src/auth/invitations.js';

/**
 * sec-criteria A1 + A2 (the H02 security review's added H06 criteria):
 *   A1. Verify the emailed single-use token BEFORE inserting a membership row.
 *   A2. Consume the invitation (accepted_at) in the SAME transaction as
 *       the membership insert.
 */
describe('invitation accept flow (sec-criteria A1, A2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;

  const pools = () => ({ platformOps: platformOpsPool, appUser: appUserPool });

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function newInvitee(email?: string): Promise<{ userId: string; email: string }> {
    const userId = randomUUID();
    const resolvedEmail = email ?? `invitee-${userId}@example.test`;
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, resolvedEmail]);
    return { userId, email: resolvedEmail };
  }

  it('A1: an accept with a WRONG token inserts no membership row', async () => {
    const invitee = await newInvitee();
    await createInvitation(appUserPool, refsA.accountId, refsA.userId, {
      email: invitee.email,
      role: 'member',
    });

    await expect(
      acceptInvitation(pools(), 'this-is-not-the-real-token', invitee),
    ).rejects.toThrow(InvalidInvitationError);

    const { rows } = await admin.query(
      'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
      [refsA.accountId, invitee.userId],
    );
    expect(rows).toEqual([]);
  });

  it('A1: an accept with an ABSENT token (no invitation ever created) inserts no membership row', async () => {
    const invitee = await newInvitee();
    await expect(acceptInvitation(pools(), 'never-issued-token', invitee)).rejects.toThrow(
      InvalidInvitationError,
    );
    const { rows } = await admin.query(
      'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
      [refsA.accountId, invitee.userId],
    );
    expect(rows).toEqual([]);
  });

  it('A1 + A2: a correct token succeeds, sets accepted_at, and inserts exactly one membership row', async () => {
    const invitee = await newInvitee();
    const { rawToken, id: invitationId } = await createInvitation(appUserPool, refsA.accountId, refsA.userId, {
      email: invitee.email,
      role: 'member',
    });

    const result = await acceptInvitation(pools(), rawToken, invitee);
    expect(result).toEqual({ accountId: refsA.accountId, role: 'member' });

    const { rows: memberRows } = await admin.query(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [refsA.accountId, invitee.userId],
    );
    expect(memberRows).toEqual([{ role: 'member' }]);

    const { rows: invRows } = await admin.query(
      'SELECT accepted_at IS NOT NULL AS consumed FROM invitations WHERE id = $1',
      [invitationId],
    );
    expect(invRows).toEqual([{ consumed: true }]);
  });

  it('A2: replaying a CONSUMED invitation fails (the same token cannot be used twice)', async () => {
    const invitee = await newInvitee();
    const { rawToken } = await createInvitation(appUserPool, refsA.accountId, refsA.userId, {
      email: invitee.email,
      role: 'member',
    });
    await acceptInvitation(pools(), rawToken, invitee);

    await expect(acceptInvitation(pools(), rawToken, invitee)).rejects.toThrow(InvalidInvitationError);
  });

  it(
    'A2: removing a member and replaying their original (now-consumed) invitation still fails ' +
      '-- consuming accepted_at closes the replay path the reviewer flagged',
    async () => {
      const invitee = await newInvitee();
      const { rawToken } = await createInvitation(appUserPool, refsA.accountId, refsA.userId, {
        email: invitee.email,
        role: 'member',
      });
      await acceptInvitation(pools(), rawToken, invitee);

      // Remove them (platform_ops's account_members grant is unconditional).
      await platformOpsPool.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [
        refsA.accountId,
        invitee.userId,
      ]);

      await expect(acceptInvitation(pools(), rawToken, invitee)).rejects.toThrow(InvalidInvitationError);

      const { rows } = await admin.query(
        'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
        [refsA.accountId, invitee.userId],
      );
      expect(rows).toEqual([]);
    },
  );

  it('an EXPIRED invitation is refused even with the correct token', async () => {
    const invitee = await newInvitee();
    const rawToken = 'expired-raw-token-fixture';
    await admin.query(
      `INSERT INTO invitations (account_id, email, role, token_hash, expires_at)
       VALUES ($1, $2, 'member', $3, now() - interval '1 hour')`,
      [refsA.accountId, invitee.email, hashInvitationToken(rawToken)],
    );

    await expect(acceptInvitation(pools(), rawToken, invitee)).rejects.toThrow(InvalidInvitationError);
  });

  it("an invitee whose email doesn't match the invitation is refused, even with the correct token", async () => {
    const invitee = await newInvitee();
    const { rawToken } = await createInvitation(appUserPool, refsA.accountId, refsA.userId, {
      email: `someone-else-${randomUUID()}@example.test`,
      role: 'member',
    });

    await expect(acceptInvitation(pools(), rawToken, invitee)).rejects.toThrow(InvalidInvitationError);
  });

  it(
    'a membership insert that rolls back leaves accepted_at unset ' +
      '(a pre-existing membership for the same account/user collides on account_members\' own UNIQUE constraint)',
    async () => {
      const invitee = await newInvitee();
      // Pre-seed a membership for this exact (account, user) pair via
      // platform_ops, so the accept flow's own INSERT collides on
      // account_members' UNIQUE(account_id, user_id) constraint instead
      // of running cleanly.
      await platformOpsPool.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
        [refsA.accountId, invitee.userId],
      );

      const { rawToken, id: invitationId } = await createInvitation(
        appUserPool,
        refsA.accountId,
        refsA.userId,
        { email: invitee.email, role: 'admin' },
      );

      await expect(acceptInvitation(pools(), rawToken, invitee)).rejects.toThrow(InvalidInvitationError);

      const { rows } = await admin.query('SELECT accepted_at FROM invitations WHERE id = $1', [
        invitationId,
      ]);
      expect(rows).toEqual([{ accepted_at: null }]);
    },
  );

  it('createInvitation refuses a non-owner/admin actor (a plain member cannot issue invitations)', async () => {
    const memberUser = await newInvitee();
    await platformOpsPool.query(
      `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
      [refsA.accountId, memberUser.userId],
    );

    await expect(
      createInvitation(appUserPool, refsA.accountId, memberUser.userId, {
        email: `target-${randomUUID()}@example.test`,
        role: 'member',
      }),
    ).rejects.toThrow(/owner or admin/);
  });

  /**
   * Second security review, finding 10 (CWE-269): requireOwnerOrAdmin alone
   * let an admin invite a controlled identity in as owner, who could then
   * accept and remove the original owner -- bypassing the owner-only rule
   * on granting the owner role that membership.ts's setMemberRole already
   * enforces. Each test here seeds its own fresh account, mirroring
   * membership.test.ts's "only an owner may grant, revoke, or remove the
   * owner role" sub-describe, so demoting an inviter in one test can't leak
   * into another.
   */
  describe('owner-role invites are owner-gated (second security review, finding 10)', () => {
    it('an admin inviting someone as owner gets ForbiddenError, and no invitation row is written', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      const adminUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        adminUserId,
        `${adminUserId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [acctRefs.accountId, adminUserId],
      );

      await expect(
        createInvitation(appUserPool, acctRefs.accountId, adminUserId, {
          email: `target-${randomUUID()}@example.test`,
          role: 'owner',
        }),
      ).rejects.toThrow(ForbiddenError);

      const { rows } = await admin.query(
        `SELECT 1 FROM invitations WHERE account_id = $1 AND role = 'owner'`,
        [acctRefs.accountId],
      );
      expect(rows).toEqual([]);
    });

    it('an admin can still invite someone as admin or member', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      const adminUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        adminUserId,
        `${adminUserId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [acctRefs.accountId, adminUserId],
      );

      const asAdmin = await createInvitation(appUserPool, acctRefs.accountId, adminUserId, {
        email: `admin-target-${randomUUID()}@example.test`,
        role: 'admin',
      });
      expect(asAdmin.id).toBeTruthy();

      const asMember = await createInvitation(appUserPool, acctRefs.accountId, adminUserId, {
        email: `member-target-${randomUUID()}@example.test`,
        role: 'member',
      });
      expect(asMember.id).toBeTruthy();
    });

    it('an owner can still invite someone as owner', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());

      const { id } = await createInvitation(appUserPool, acctRefs.accountId, acctRefs.userId, {
        email: `owner-target-${randomUUID()}@example.test`,
        role: 'owner',
      });
      expect(id).toBeTruthy();
    });

    it('an owner invitation whose inviter has since been demoted is refused on accept', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      // A second owner so demoting acctRefs.userId directly below doesn't
      // leave the account without one -- this test only cares about the
      // accept-time inviter-role recheck, not the last-owner rule.
      const secondOwnerId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        secondOwnerId,
        `${secondOwnerId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [acctRefs.accountId, secondOwnerId],
      );

      const invitee = await newInvitee();
      const { rawToken } = await createInvitation(appUserPool, acctRefs.accountId, acctRefs.userId, {
        email: invitee.email,
        role: 'owner',
      });

      // The inviter is demoted after issuing the invitation but before it's
      // accepted -- direct SQL, not setMemberRole, since this is test setup
      // for the accept-time check, not an exercise of the demote gate.
      await admin.query(
        `UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
        [acctRefs.accountId, acctRefs.userId],
      );

      await expect(acceptInvitation(pools(), rawToken, invitee)).rejects.toThrow(InvalidInvitationError);

      const { rows } = await admin.query(
        'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
        [acctRefs.accountId, invitee.userId],
      );
      expect(rows).toEqual([]);
    });
  });
});
