import { randomUUID } from "node:crypto";
import { createPool } from "@fx/spend";

/** Fixture builders for the [pg] tests: an admin pool (seeds, bypasses RLS) and an app-user pool (what the real adapters run on). */
export type Pool = ReturnType<typeof createPool>;

export function pools(): { admin: Pool; app: Pool } {
  const admin = createPool(process.env.RECEIPTS_DATABASE_URL!);
  const app = createPool(process.env.RECEIPTS_DATABASE_URL_APP_USER!);
  return { admin, app };
}

export async function seedAccount(admin: Pool): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_test_${id}`]);
  return id;
}

export async function seedItem(admin: Pool, accountId: string, stage: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, stage) VALUES ($1, $2, 'feature', 'internal', $3)`, [id, accountId, stage]);
  return id;
}

export async function seedRun(admin: Pool, accountId: string, workItemId: string, o: { role?: string; envelope?: unknown; ageMinutes?: number } = {}): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, created_at)
     VALUES ($1, $2, $3, $4, 'local', 'succeeded', $5::jsonb, now() - ($6::int * interval '1 minute'))`,
    [id, accountId, workItemId, o.role ?? "executor", o.envelope === undefined ? null : JSON.stringify(o.envelope), o.ageMinutes ?? 0],
  );
  return id;
}

export async function seedLedger(admin: Pool, accountId: string, runId: string | null, usd: number, kind: "model" | "compute" = "model"): Promise<void> {
  await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, $2, 'workflow', $3, $4, $5)`, [
    accountId,
    kind,
    usd,
    runId,
    kind === "model" ? "model" : "foreground_compute",
  ]);
}
