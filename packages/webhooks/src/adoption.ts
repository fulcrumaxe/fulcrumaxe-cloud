import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';

/**
 * D#31 API-4a criterion 13: `pnpm --filter @fx/webhooks adoption` prints
 * `{accounts_with_active_token_30d, webhook_success_rate_7d}`, read as
 * `platform_ops` -- an operator CLI, never a `/v1` route.
 *
 * Definitions (the Spec names the two fields, not their exact SQL):
 *   - accounts_with_active_token_30d: distinct accounts holding an
 *     unrevoked, unexpired token used in the last 30 days.
 *   - webhook_success_rate_7d: of deliveries that reached a terminal
 *     outcome (succeeded or dead) in the last 7 days, the fraction that
 *     succeeded. `null`, not a misleading 0 or 1, when there were none.
 */
export interface AdoptionStats {
  accounts_with_active_token_30d: number;
  webhook_success_rate_7d: number | null;
}

export async function computeAdoptionStats(pool: Pool, now: Date = new Date()): Promise<AdoptionStats> {
  const client = await pool.connect();
  try {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Both queries bound the window on BOTH ends -- `now` is an
    // injectable fake clock for tests, and a bare lower bound (`>=
    // cutoff`) would also match a row created after `now` (real
    // wall-clock data from an unrelated concurrently-running test, or
    // simply "the future" relative to a fake past `now`), which is never
    // what "in the last N days as of `now`" means.
    const tokenRows = await client.query<{ count: string }>(
      `SELECT count(DISTINCT account_id)::text AS count
       FROM api_tokens
       WHERE revoked_at IS NULL AND expires_at > $1 AND last_used_at BETWEEN $2 AND $1`,
      [now, thirtyDaysAgo],
    );

    const deliveryRows = await client.query<{ succeeded: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
         count(*)::text AS total
       FROM webhook_deliveries
       WHERE status IN ('succeeded', 'dead') AND created_at BETWEEN $1 AND $2`,
      [sevenDaysAgo, now],
    );

    const total = Number(deliveryRows.rows[0]!.total);
    const succeeded = Number(deliveryRows.rows[0]!.succeeded);

    return {
      accounts_with_active_token_30d: Number(tokenRows.rows[0]!.count),
      webhook_success_rate_7d: total > 0 ? succeeded / total : null,
    };
  } finally {
    client.release();
  }
}

/* c8 ignore start -- CLI entry point, exercised by test/adoption.test.ts
 * calling computeAdoptionStats directly, not by invoking this file as a
 * subprocess. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_PLATFORM_OPS;
  if (!url) {
    throw new Error('adoption: DATABASE_URL_PLATFORM_OPS must be set');
  }
  const pool = createPool(url);
  try {
    const stats = await computeAdoptionStats(pool);
    process.stdout.write(`${JSON.stringify(stats)}\n`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
