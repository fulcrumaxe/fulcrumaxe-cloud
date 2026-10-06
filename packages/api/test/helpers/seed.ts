import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * `@fx/api`'s own minimal fixture builders, parallel to
 * `packages/spend/test/helpers/seed.ts` -- this package's tests only ever
 * need an account, sometimes a user and a membership row to resolve a
 * session principal against (see `packages/core/src/tenancy/authorize.ts`'s
 * `getMemberRole`).
 *
 * D#69 (migration 0606, merged to main after this package's original
 * branch was cut): `accounts.status` is now DERIVED by a BEFORE INSERT
 * trigger from a set of marker columns, not a value this INSERT can set
 * directly -- an INSERT whose explicit `status` disagrees with what the
 * marker columns derive to is rejected (42501). `opts.status` is
 * translated into the marker column(s) that derive it instead, mirroring
 * `packages/billing/test/helpers/seed.ts`'s own fix for the same
 * migration: the INSERT always spells out `status` explicitly, set to
 * the SAME value the marker columns will derive. `stripeCustomerId`
 * defaults to a value unique per seeded account (0606 also adds a live
 * UNIQUE index on it), never a single shared literal.
 */
export interface SeedAccountOptions {
  plan?: 'starter' | 'team' | 'scale';
  status?: 'unsubscribed' | 'active' | 'past_due' | 'paused' | 'model_key_broken' | 'cancelled';
  stripeCustomerId?: string | null;
}

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export async function seedAccount(
  admin: PoolClient,
  accountId: string,
  opts: SeedAccountOptions = {},
): Promise<void> {
  const status = opts.status ?? 'active';
  const stripeCustomerId =
    opts.stripeCustomerId !== undefined
      ? opts.stripeCustomerId
      : status === 'unsubscribed'
        ? null
        : `cus_test_${accountId}`;
  const now = Date.now();
  const pastDueSince =
    status === 'past_due'
      ? new Date(now)
      : status === 'cancelled'
        ? new Date(now - GRACE_PERIOD_MS - 1000)
        : null;
  const ownerPausedAt = status === 'paused' ? new Date(now) : null;
  const keyBrokenAt = status === 'model_key_broken' ? new Date(now) : null;

  // `status` is spelled out explicitly and matches whichever marker
  // column above actually derives it: 0606's INSERT trigger check
  // rejects a row whose status (explicit or the column DEFAULT
  // 'unsubscribed') disagrees with the derived value.
  await admin.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, past_due_since, owner_paused_at, key_broken_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [accountId, opts.plan ?? 'starter', stripeCustomerId, pastDueSince, ownerPausedAt, keyBrokenAt, status],
  );
}

export async function seedUser(admin: PoolClient, userId: string, email?: string): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
    userId,
    email ?? `${userId}@example.test`,
  ]);
}

export interface SeedMemberResult {
  accountId: string;
  userId: string;
}

/** An account plus one user with `role` membership on it -- the shape every session-principal test needs. */
export async function seedAccountWithMember(
  admin: PoolClient,
  opts: SeedAccountOptions & { role?: 'owner' | 'admin' | 'member' } = {},
): Promise<SeedMemberResult> {
  const accountId = randomUUID();
  const userId = randomUUID();
  await seedAccount(admin, accountId, opts);
  await seedUser(admin, userId);
  await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
    accountId,
    userId,
    opts.role ?? 'member',
  ]);
  return { accountId, userId };
}
