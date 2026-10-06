import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { MembershipRole } from '@fx/core/src/tenancy/authorize.js';

/**
 * Minimal fixture builder for packages/billing's own tests. Deliberately
 * small and separate from packages/db/test/helpers/seed.ts and
 * packages/spend/test/helpers/seed.ts, same reasoning as those two
 * files' own headers: this package only ever needs an `accounts` row to
 * drive a status/plan transition against.
 *
 * D#69 (migration 0606): `status` is derived, not a column this INSERT
 * can set directly -- `opts.status` is translated into the marker
 * column(s) that derive it instead (migration 0606's own priority-order
 * comment), and the INSERT never names `status` at all. `stripeCustomerId`
 * defaults to a value unique per seeded account (`cus_test_<accountId>`)
 * rather than one shared literal, since migration 0606 also adds a live
 * UNIQUE index on it -- a shared default across the many call sites in
 * this package's tests would collide on the second seed.
 */
export interface SeedAccountOptions {
  plan?: 'starter' | 'team' | 'scale';
  status?: 'unsubscribed' | 'active' | 'past_due' | 'paused' | 'model_key_broken' | 'cancelled';
  stripeCustomerId?: string | null;
  /** D#69 B2: the subscription on file, and the clock of the last applied sync (a future value makes any event stale). */
  stripeSubscriptionId?: string | null;
  stripeSyncedAt?: Date | null;
}

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export async function seedAccount(
  admin: PoolClient,
  accountId: string,
  opts: SeedAccountOptions = {},
): Promise<void> {
  const status = opts.status ?? 'active';
  const stripeCustomerId =
    opts.stripeCustomerId !== undefined ? opts.stripeCustomerId : status === 'unsubscribed' ? null : `cus_test_${accountId}`;
  const now = Date.now();
  const pastDueSince =
    status === 'past_due' ? new Date(now) : status === 'cancelled' ? new Date(now - GRACE_PERIOD_MS - 1000) : null;
  const ownerPausedAt = status === 'paused' ? new Date(now) : null;
  const keyBrokenAt = status === 'model_key_broken' ? new Date(now) : null;

  // `status` is spelled out explicitly and matches whichever marker
  // column above actually derives it: 0606's INSERT trigger check
  // rejects a row whose status (explicit or the column DEFAULT
  // 'unsubscribed') disagrees with the derived value (security review
  // MUST-fix 4, Spec A5).
  await admin.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, past_due_since, owner_paused_at, key_broken_at, status,
                           stripe_subscription_id, stripe_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      accountId,
      opts.plan ?? 'starter',
      stripeCustomerId,
      pastDueSince,
      ownerPausedAt,
      keyBrokenAt,
      status,
      opts.stripeSubscriptionId ?? null,
      opts.stripeSyncedAt ?? null,
    ],
  );
}

export interface SeededTenant {
  accountId: string;
  userId: string;
}

/**
 * C7 (D#2 comment 18494573): the ctx/input authorization tests need a
 * real `account_members` row to check a role against -- an `accounts`
 * row alone (plain `seedAccount`) has no principal that could ever pass
 * `authorizeAccountWrite`/`authorizeAccountRead`. Mirrors
 * packages/model-connection/test/helpers/seed.ts's `seedAccountWithMember`
 * exactly (same three tables, same reasoning): `accounts` + a global
 * `users` row + one `account_members` row at `role`. `admin` must be a
 * superuser/admin connection -- RLS does not apply to it, so no
 * `app.account_id` needs to be set here.
 */
export async function seedAccountWithMember(
  admin: PoolClient,
  role: MembershipRole = 'owner',
  opts: SeedAccountOptions = {},
): Promise<SeededTenant> {
  const accountId = randomUUID();
  const userId = randomUUID();
  await seedAccount(admin, accountId, opts);
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
  await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
    accountId,
    userId,
    role,
  ]);
  return { accountId, userId };
}
