import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export type MemberRole = 'owner' | 'admin' | 'member';

/**
 * The Spec's **F2** fixture: two owners, two admins, two members, and one
 * open `member` invitation for a non-member. Every matrix in
 * account-members-role-gate.test.ts and invitations-role-gate.test.ts
 * runs against a FRESH F2 (no order dependence between cases -- each
 * `it.each` case calls `seedF2` itself rather than sharing one across the
 * file).
 */
export interface F2Fixture {
  accountId: string;
  o1: string;
  o2: string;
  a1: string;
  a2: string;
  m1: string;
  m2: string;
  /** An open `member` invitation for a non-member, seeded alongside F2. */
  openInvitationId: string;
  openInvitationEmail: string;
}

/** The Spec's **F1** fixture: the same shape as F2, but a single owner -- for the last-owner cases. */
export interface F1Fixture {
  accountId: string;
  o1: string;
  a1: string;
  m1: string;
}

/** `X`: the owner of a DIFFERENT account, `B` -- for the mismatched-settings probe (criterion 4c). */
export interface OutsiderFixture {
  accountId: string;
  userId: string;
}

async function makeAccount(admin: PoolClient): Promise<string> {
  const accountId = randomUUID();
  // D#69 (migration 0606): status is derived from stripe_customer_id; see
  // packages/db/test/helpers/seed.ts's own comment on this same pattern,
  // including why `status = 'active'` is now spelled out explicitly.
  await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
    accountId,
    `cus_test_${accountId}`,
  ]);
  return accountId;
}

async function makeUser(admin: PoolClient, email?: string): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
    id,
    email ?? `${id}@example.test`,
  ]);
  return id;
}

async function addMember(
  admin: PoolClient,
  accountId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [
    accountId,
    userId,
    role,
  ]);
}

/**
 * Builds a fresh F2 account via the admin/superuser connection (bypasses
 * RLS entirely) -- this is fixture setup, never the thing under test. Every
 * matrix cell that touches F2 gets its OWN call to this function, per the
 * Spec's "each matrix cell runs on a fresh account" rule.
 */
export async function seedF2(admin: PoolClient): Promise<F2Fixture> {
  const accountId = await makeAccount(admin);

  const o1 = await makeUser(admin);
  const o2 = await makeUser(admin);
  const a1 = await makeUser(admin);
  const a2 = await makeUser(admin);
  const m1 = await makeUser(admin);
  const m2 = await makeUser(admin);

  await addMember(admin, accountId, o1, 'owner');
  await addMember(admin, accountId, o2, 'owner');
  await addMember(admin, accountId, a1, 'admin');
  await addMember(admin, accountId, a2, 'admin');
  await addMember(admin, accountId, m1, 'member');
  await addMember(admin, accountId, m2, 'member');

  const openInvitationEmail = `f2-open-${randomUUID()}@example.test`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, 'member', $3, $4, now() + interval '7 days')
     RETURNING id`,
    [accountId, openInvitationEmail, `hash-${randomUUID()}`, o1],
  );

  return {
    accountId,
    o1,
    o2,
    a1,
    a2,
    m1,
    m2,
    openInvitationId: rows[0]!.id,
    openInvitationEmail,
  };
}

/** Builds a fresh F1 account (single owner, one admin, one member). */
export async function seedF1(admin: PoolClient): Promise<F1Fixture> {
  const accountId = await makeAccount(admin);
  const o1 = await makeUser(admin);
  const a1 = await makeUser(admin);
  const m1 = await makeUser(admin);
  await addMember(admin, accountId, o1, 'owner');
  await addMember(admin, accountId, a1, 'admin');
  await addMember(admin, accountId, m1, 'member');
  return { accountId, o1, a1, m1 };
}

/** Builds a fresh account `B` with a single owner `X` -- the outsider for criterion 4c. */
export async function seedOutsideOwner(admin: PoolClient): Promise<OutsiderFixture> {
  const accountId = await makeAccount(admin);
  const userId = await makeUser(admin);
  await addMember(admin, accountId, userId, 'owner');
  return { accountId, userId };
}

/** Adds one more user, as `role`, to an already-seeded account -- for cases that need an identity beyond F1/F2's fixed six. */
export async function addExtraMember(
  admin: PoolClient,
  accountId: string,
  role: MemberRole,
  email?: string,
): Promise<string> {
  const userId = await makeUser(admin, email);
  await addMember(admin, accountId, userId, role);
  return userId;
}

export interface MemberRow {
  id: string;
  account_id: string;
  user_id: string;
  role: MemberRole;
  created_at: Date;
}

/**
 * Reads back one account_members row via the admin/superuser connection --
 * the "R = refused" outcome code (Spec, criteria 2-3) requires proving the
 * TARGET row is identical in every column afterwards, not just that the
 * mutating statement itself failed or affected 0 rows.
 */
export async function readMemberRow(
  admin: PoolClient,
  accountId: string,
  userId: string,
): Promise<MemberRow | null> {
  const { rows } = await admin.query<MemberRow>(
    'SELECT id, account_id, user_id, role, created_at FROM account_members WHERE account_id = $1 AND user_id = $2',
    [accountId, userId],
  );
  return rows[0] ?? null;
}

/** Counts current owner rows for `accountId` via the admin connection. */
export async function countOwners(admin: PoolClient, accountId: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM account_members WHERE account_id = $1 AND role = 'owner'`,
    [accountId],
  );
  return Number(rows[0]!.count);
}
