import type { PoolClient } from "pg";

/**
 * Minimal fixture builders for packages/runner's own [pg] tests --
 * small and separate from packages/db/test/helpers/seed.ts (which seeds
 * a full row per tenant table for H02's privilege tests), mirroring
 * packages/spend/test/helpers/seed.ts's own precedent.
 *
 * D#69 (migration 0606): `status` is derived, not a column this INSERT
 * can set directly -- `opts.status` is translated into the marker
 * column that derives it (a stripe_customer_id for 'active', or
 * past_due_since/owner_paused_at/key_broken_at for the others -- the
 * same shape packages/spend/test/helpers/seed.ts already uses).
 */

export interface SeedAccountOptions {
  plan?: "starter" | "team" | "scale";
  status?: "active" | "past_due" | "paused" | "model_key_broken";
}

export async function seedAccount(
  admin: PoolClient,
  accountId: string,
  opts: SeedAccountOptions = {},
): Promise<void> {
  const status = opts.status ?? "active";
  const stripeCustomerId = status === "active" ? `cus_test_${accountId}` : null;
  const now = new Date();
  // `status` is spelled out explicitly and matches whichever marker
  // column below actually derives it: 0606's INSERT trigger check
  // rejects a row whose status (explicit or the column DEFAULT
  // 'unsubscribed') disagrees with the derived value (security review
  // MUST-fix 4, Spec A5).
  await admin.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, past_due_since, owner_paused_at, key_broken_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      accountId,
      opts.plan ?? "starter",
      stripeCustomerId,
      status === "past_due" ? now : null,
      status === "paused" ? now : null,
      status === "model_key_broken" ? now : null,
      status,
    ],
  );
}

export interface SeedUserOptions {
  role?: "owner" | "admin" | "member";
}

/** A `users` row plus an `account_members` row for it -- needed by
 * `cancelRun`'s `assertActiveMembership` check. */
export async function seedMember(
  admin: PoolClient,
  accountId: string,
  userId: string,
  opts: SeedUserOptions = {},
): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    userId,
    `${userId}@fixture.test`,
  ]);
  await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
    accountId,
    userId,
    opts.role ?? "member",
  ]);
}

export interface SeedRepoOptions {
  product?: "team" | "sitekit";
  executionMode?: string;
}

/** C10's routing input: `repos.execution_mode`, defaulting to `'sandbox'`
 * (the only value `0605_execution_mode.sql`'s CHECK allows -- see
 * targetRegistry.test.ts's [pg] case for that refusal). */
export async function seedRepo(
  admin: PoolClient,
  accountId: string,
  repoId: string,
  opts: SeedRepoOptions = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode)
     VALUES ($1, $2, $3, $4, $5)`,
    [repoId, accountId, Math.floor(Math.random() * 1_000_000_000), opts.product ?? "team", opts.executionMode ?? "sandbox"],
  );
}

export interface SeedWorkItemOptions {
  ghNumber?: number;
}

export async function seedWorkItem(
  admin: PoolClient,
  accountId: string,
  workItemId: string,
  repoId: string,
  opts: SeedWorkItemOptions = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number)
     VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4)`,
    [workItemId, accountId, repoId, opts.ghNumber ?? null],
  );
}
