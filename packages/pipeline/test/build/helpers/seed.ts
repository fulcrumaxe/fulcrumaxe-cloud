import type { PoolClient } from "pg";

/**
 * Minimal fixture builders for this package's own [pg] tests -- mirrors
 * packages/runner/test/helpers/seed.ts's precedent (its own header:
 * "small and separate from packages/db/test/helpers/seed.ts").
 */

export async function seedAccount(admin: PoolClient, accountId: string): Promise<void> {
  await admin.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, status)
     VALUES ($1, 'starter', $2, 'active')`,
    [accountId, `cus_test_${accountId}`],
  );
}

export async function seedRepo(admin: PoolClient, accountId: string, repoId: string): Promise<void> {
  await admin.query(
    `INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode)
     VALUES ($1, $2, $3, 'team', 'sandbox')`,
    [repoId, accountId, Math.floor(Math.random() * 1_000_000_000)],
  );
}

export async function seedWorkItem(
  admin: PoolClient,
  accountId: string,
  workItemId: string,
  repoId: string,
  opts: { ghNumber?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number)
     VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4)`,
    [workItemId, accountId, repoId, opts.ghNumber ?? null],
  );
}
