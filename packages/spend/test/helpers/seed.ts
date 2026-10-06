import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Minimal fixture builders for packages/spend's own tests. Deliberately
 * small and separate from packages/db/test/helpers/seed.ts -- that file
 * seeds a full row per tenant TABLE (H02's own privilege-boundary
 * tests need that); H05's tests only ever need an account, and
 * sometimes one run and one work item to hang a cap check on.
 *
 * D#69 (migration 0606): `status` is derived, not a column this INSERT
 * can set directly -- `opts.status` is translated into the marker
 * column that derives it (a stripe_customer_id for 'active', or
 * owner_paused_at for 'paused' -- the only two this package's tests use).
 */
export interface SeedAccountOptions {
  plan?: 'starter' | 'team' | 'scale';
  status?: 'active' | 'past_due' | 'paused' | 'model_key_broken';
}

export async function seedAccount(
  admin: PoolClient,
  accountId: string,
  opts: SeedAccountOptions = {},
): Promise<void> {
  const status = opts.status ?? 'active';
  const stripeCustomerId = status === 'active' ? `cus_test_${accountId}` : null;
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
      opts.plan ?? 'starter',
      stripeCustomerId,
      status === 'past_due' ? now : null,
      status === 'paused' ? now : null,
      status === 'model_key_broken' ? now : null,
      status,
    ],
  );
}

/** A bare agent_runs row with no work_item -- enough for reserve()/
 * settle() calls that don't exercise the per-work-item cap. */
export async function seedRun(admin: PoolClient, accountId: string, runId: string): Promise<void> {
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`,
    [runId, accountId],
  );
}

/** A work_item plus a run attached to it, for the Feature/Small
 * per-work-item cap tests. */
export async function seedRunWithWorkItem(
  admin: PoolClient,
  accountId: string,
  runId: string,
  workItemId: string,
  kind: 'feature' | 'small' = 'feature',
): Promise<void> {
  await admin.query(
    `INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, $3, 'internal')`,
    [workItemId, accountId, kind],
  );
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
     VALUES ($1, $2, $3, 'executor', 'local', 'running')`,
    [runId, accountId, workItemId],
  );
}

/** A validated ('ok') model connection -- H05 pass/fail 5's preview
 * exception requires one to exist before a preview-purpose reserve()
 * call is admitted. */
export async function seedModelConnectionOk(admin: PoolClient, accountId: string): Promise<void> {
  await admin.query(
    `INSERT INTO model_connections
       (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
     VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, 'ok')`,
    [accountId, Buffer.from('ciphertext'), Buffer.from('nonce'), Buffer.from('wrapped'), `fp-${randomUUID()}`],
  );
}
