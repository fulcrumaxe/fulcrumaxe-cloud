import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { MembershipRole } from '@fx/core/src/tenancy/authorize.js';

export interface SeededTenant {
  accountId: string;
  userId: string;
}

/**
 * A minimal tenant: `accounts` + a global `users` row + one
 * `account_members` row at `role`. Deliberately NOT `@fx/db/test/helpers/
 * seed.ts`'s `seedAccount` -- that helper seeds all twelve tenant tables,
 * including a placeholder `model_connections` row, which would leave
 * every test in this package starting from an already-connected account
 * instead of the empty state most of these tests actually want to
 * exercise (first connect, "nothing stored" on rejection, etc). `admin`
 * must be a superuser/admin connection: RLS does not apply to it, so no
 * `app.account_id` needs to be set here.
 */
export async function seedAccountWithMember(
  admin: PoolClient,
  role: MembershipRole = 'owner',
): Promise<SeededTenant> {
  const accountId = randomUUID();
  const userId = randomUUID();
  // D#69 (migration 0606): status is derived from stripe_customer_id
  // (plus marker columns this package's own tests set directly when they
  // need a non-'active' starting status -- see tenant-and-broken.test.ts).
  // `status = 'active'` is spelled out explicitly: 0606's INSERT trigger
  // check rejects a row whose status disagrees with what stripe_customer_id
  // derives to (security review MUST-fix 4, Spec A5).
  await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
    accountId,
    `cus_test_${accountId}`,
  ]);
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
  await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
    accountId,
    userId,
    role,
  ]);
  return { accountId, userId };
}
