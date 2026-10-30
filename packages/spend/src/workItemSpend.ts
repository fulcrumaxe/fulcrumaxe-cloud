import type { Pool } from 'pg';
import { withTenant } from './pg.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * D#7 DP7-2c: what a work item's build has cost so far, in USD: the sum of `ledger.usd` for model spend on the item's executor runs (the build and
 * every fix round are executor runs). Compute rows are not counted; a reversal's estimate is model money on the customer's own key. Read under
 * `withTenant`, so another account's rows are invisible, and another item's are excluded by the join. It reads only; nothing here settles or reserves.
 *
 * Rejects an account or item id that is not a UUID rather than sending it to the database.
 */
export async function workItemBuildSpendUsd(pool: Pool, accountId: string, workItemId: string): Promise<number> {
  if (!UUID.test(accountId)) throw new TypeError('accountId is not a UUID');
  if (!UUID.test(workItemId)) throw new TypeError('workItemId is not a UUID');
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(l.usd), 0)::text AS sum
         FROM ledger l
         JOIN agent_runs r ON r.account_id = l.account_id AND r.id = l.run_id
        WHERE l.account_id = $1 AND r.work_item_id = $2 AND r.role = 'executor' AND l.kind = 'model'`,
      [accountId, workItemId],
    );
    return Number(rows[0]!.sum);
  });
}
