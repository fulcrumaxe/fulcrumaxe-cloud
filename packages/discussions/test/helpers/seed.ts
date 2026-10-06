import type { PoolClient } from "pg";

/**
 * Minimal fixture builders for this package's own [pg] tests -- mirrors
 * packages/pipeline/test/build/helpers/seed.ts's precedent ("small and
 * separate from packages/db/test/helpers/seed.ts").
 */

export async function seedAccount(
  admin: PoolClient,
  accountId: string,
  opts: { plan?: "starter" | "team" | "scale" } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, status)
     VALUES ($1, $2, $3, 'active')`,
    [accountId, opts.plan ?? "starter", `cus_test_${accountId}`],
  );
}

export async function seedUser(admin: PoolClient, userId: string, email?: string): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, email ?? `${userId}@example.test`]);
}

export async function seedMember(
  admin: PoolClient,
  accountId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<void> {
  await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
    accountId,
    userId,
    role,
  ]);
}

export async function seedWorkItem(
  admin: PoolClient,
  accountId: string,
  workItemId: string,
  opts: { provenance?: "internal" | "external"; title?: string | null } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO work_items (id, account_id, kind, provenance, title)
     VALUES ($1, $2, 'feature', $3, $4)`,
    [workItemId, accountId, opts.provenance ?? "internal", opts.title ?? null],
  );
}

export async function seedAgentRun(
  admin: PoolClient,
  accountId: string,
  runId: string,
  opts: { workItemId?: string | null; role?: string } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
     VALUES ($1, $2, $3, $4, 'production', 'running')`,
    [runId, accountId, opts.workItemId ?? null, opts.role ?? "executor"],
  );
}
