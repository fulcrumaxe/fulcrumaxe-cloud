import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { getMemberRole } from '../../src/tenancy/authorize.js';
import { ForbiddenError, NotFoundError } from '../../src/tenancy/errors.js';
import { removeMember, setMemberRole } from '../../src/tenancy/membership.js';

/**
 * sec-criteria A7: "Role authorization and the at-least-one-owner rule
 * belong to the application (H06 for membership)... Tests: a member
 * cannot promote themselves; removing or demoting the last owner is
 * refused."
 */
describe('membership role authorization + at-least-one-owner (sec-criteria A7)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let secondOwnerId: string;
  let memberUserId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());

    secondOwnerId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      secondOwnerId,
      `${secondOwnerId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      refs.accountId,
      secondOwnerId,
    ]);

    memberUserId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      memberUserId,
      `${memberUserId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
      refs.accountId,
      memberUserId,
    ]);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('a member cannot promote themselves to admin', async () => {
    await expect(
      setMemberRole(appUserPool, refs.accountId, memberUserId, memberUserId, 'admin', { failRunnerLeases: null }),
    ).rejects.toThrow(ForbiddenError);

    const role = await getMemberRole(appUserPool, refs.accountId, memberUserId);
    expect(role).toBe('member');
  });

  it('a member cannot promote someone else either', async () => {
    await expect(
      setMemberRole(appUserPool, refs.accountId, memberUserId, refs.userId, 'admin', { failRunnerLeases: null }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('an owner CAN promote a member to admin', async () => {
    await setMemberRole(appUserPool, refs.accountId, refs.userId, memberUserId, 'admin', { failRunnerLeases: null });
    expect(await getMemberRole(appUserPool, refs.accountId, memberUserId)).toBe('admin');
    // restore for later tests
    await setMemberRole(appUserPool, refs.accountId, refs.userId, memberUserId, 'member', { failRunnerLeases: null });
  });

  it('demoting the last owner is refused', async () => {
    // refs.userId and secondOwnerId are both owners right now; demoting
    // EITHER one alone must succeed (two owners remain -> one), but
    // demoting the account down to zero owners must fail.
    await setMemberRole(appUserPool, refs.accountId, refs.userId, secondOwnerId, 'admin', { failRunnerLeases: null });
    expect(await getMemberRole(appUserPool, refs.accountId, secondOwnerId)).toBe('admin');

    // Now only refs.userId is an owner. Demoting them must be refused.
    await expect(
      setMemberRole(appUserPool, refs.accountId, refs.userId, refs.userId, 'admin', { failRunnerLeases: null }),
    ).rejects.toThrow(ForbiddenError);
    expect(await getMemberRole(appUserPool, refs.accountId, refs.userId)).toBe('owner');

    // restore
    await setMemberRole(appUserPool, refs.accountId, refs.userId, secondOwnerId, 'owner', { failRunnerLeases: null });
  });

  it('removing the last owner is refused', async () => {
    // Demote secondOwnerId to admin so refs.userId is the sole owner,
    // then attempt to remove refs.userId as themselves (an owner acting
    // on their own membership is still gated by the same rule).
    await setMemberRole(appUserPool, refs.accountId, refs.userId, secondOwnerId, 'admin', { failRunnerLeases: null });

    await expect(removeMember(appUserPool, refs.accountId, secondOwnerId, refs.userId, { failRunnerLeases: null })).rejects.toThrow(
      ForbiddenError,
    );

    const stillThere = await getMemberRole(appUserPool, refs.accountId, refs.userId);
    expect(stillThere).toBe('owner');

    // restore
    await setMemberRole(appUserPool, refs.accountId, refs.userId, secondOwnerId, 'owner', { failRunnerLeases: null });
  });

  it('removing a non-owner member succeeds for an owner/admin actor', async () => {
    const disposableId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      disposableId,
      `${disposableId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
      refs.accountId,
      disposableId,
    ]);

    await removeMember(appUserPool, refs.accountId, refs.userId, disposableId, { failRunnerLeases: null });
    expect(await getMemberRole(appUserPool, refs.accountId, disposableId)).toBeNull();
  });

  it('acting on a target with no membership at all raises NotFoundError, not a silent no-op', async () => {
    await expect(
      setMemberRole(appUserPool, refs.accountId, refs.userId, randomUUID(), 'admin', { failRunnerLeases: null }),
    ).rejects.toThrow(NotFoundError);
  });

  it('a member (not owner/admin) cannot remove anyone', async () => {
    await expect(removeMember(appUserPool, refs.accountId, memberUserId, secondOwnerId, { failRunnerLeases: null })).rejects.toThrow(
      ForbiddenError,
    );
  });

  /**
   * Security fix round item 5 (CWE-269): requireOwnerOrAdmin alone let an
   * admin promote themselves to owner, then demote or remove the
   * original owners. Only an owner may grant, revoke, or remove the
   * owner role now -- these tests use fresh, isolated accounts so they
   * don't depend on (or disturb) the shared `refs` state above.
   */
  describe('only an owner may grant, revoke, or remove the owner role', () => {
    it('an admin cannot promote themselves to owner', async () => {
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
        setMemberRole(appUserPool, acctRefs.accountId, adminUserId, adminUserId, 'owner', { failRunnerLeases: null }),
      ).rejects.toThrow(ForbiddenError);
      expect(await getMemberRole(appUserPool, acctRefs.accountId, adminUserId)).toBe('admin');
    });

    it('an admin cannot promote someone else to owner either', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      const adminUserId = randomUUID();
      const targetMemberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        adminUserId,
        `${adminUserId}@example.test`,
      ]);
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        targetMemberId,
        `${targetMemberId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [acctRefs.accountId, adminUserId],
      );
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
        [acctRefs.accountId, targetMemberId],
      );

      await expect(
        setMemberRole(appUserPool, acctRefs.accountId, adminUserId, targetMemberId, 'owner', { failRunnerLeases: null }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('an admin cannot demote an owner, even while other owners remain (not just the last-owner rule)', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      const secondOwner = randomUUID();
      const adminUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        secondOwner,
        `${secondOwner}@example.test`,
      ]);
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        adminUserId,
        `${adminUserId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [acctRefs.accountId, secondOwner],
      );
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [acctRefs.accountId, adminUserId],
      );

      // Two owners exist here, so the last-owner rule alone would permit
      // this demotion -- it must still be refused because the actor is
      // an admin, not an owner.
      await expect(
        setMemberRole(appUserPool, acctRefs.accountId, adminUserId, secondOwner, 'admin', { failRunnerLeases: null }),
      ).rejects.toThrow(ForbiddenError);
      expect(await getMemberRole(appUserPool, acctRefs.accountId, secondOwner)).toBe('owner');
    });

    it('an admin cannot remove an owner, even while other owners remain', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      const secondOwner = randomUUID();
      const adminUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        secondOwner,
        `${secondOwner}@example.test`,
      ]);
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        adminUserId,
        `${adminUserId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [acctRefs.accountId, secondOwner],
      );
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [acctRefs.accountId, adminUserId],
      );

      await expect(
        removeMember(appUserPool, acctRefs.accountId, adminUserId, secondOwner, { failRunnerLeases: null }),
      ).rejects.toThrow(ForbiddenError);
      expect(await getMemberRole(appUserPool, acctRefs.accountId, secondOwner)).toBe('owner');
    });

    it('an owner CAN promote a member to owner (the gate is owner-only, not "never")', async () => {
      const acctRefs = await seedAccount(admin, randomUUID());
      const targetMemberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        targetMemberId,
        `${targetMemberId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
        [acctRefs.accountId, targetMemberId],
      );

      await setMemberRole(appUserPool, acctRefs.accountId, acctRefs.userId, targetMemberId, 'owner', { failRunnerLeases: null });
      expect(await getMemberRole(appUserPool, acctRefs.accountId, targetMemberId)).toBe('owner');
    });
  });

  /**
   * Security fix round item 7 (CWE-362): the owner-count check used to be
   * a plain `count(*)`, so two concurrent demotes of two DIFFERENT owners
   * could each read "2 owners" and both proceed, leaving zero. Locking
   * the owner rows with SELECT ... FOR UPDATE before counting serializes
   * the two transactions -- this fires both at once and checks that at
   * most one succeeded and at least one owner survives either way.
   */
  it('two concurrent demotes of the last two owners leave at least one owner', async () => {
    const acctRefs = await seedAccount(admin, randomUUID());
    const secondOwner = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      secondOwner,
      `${secondOwner}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      acctRefs.accountId,
      secondOwner,
    ]);

    const results = await Promise.allSettled([
      setMemberRole(appUserPool, acctRefs.accountId, acctRefs.userId, secondOwner, 'admin', { failRunnerLeases: null }),
      setMemberRole(appUserPool, acctRefs.accountId, secondOwner, acctRefs.userId, 'admin', { failRunnerLeases: null }),
    ]);

    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBeLessThanOrEqual(1);

    const finalRoles = await Promise.all([
      getMemberRole(appUserPool, acctRefs.accountId, acctRefs.userId),
      getMemberRole(appUserPool, acctRefs.accountId, secondOwner),
    ]);
    expect(finalRoles.filter((role) => role === 'owner').length).toBeGreaterThanOrEqual(1);
  });
});
