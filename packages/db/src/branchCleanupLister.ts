import type { Pool } from 'pg';

/**
 * D#598 P1f-5d: the cross-account list of closed or merged paired items whose branches have not been cleaned up yet (migration 0886,
 * `branch_cleanup_list_due`). Call it on the RUN-WRITER pool (`agent_run_writer` holds EXECUTE; `app_user`, `platform_ops` and every other role
 * are refused) with no tenant set. It answers two ids per item and nothing else; the item's branches are read afterwards, one item at a time,
 * under its own tenant.
 */

/** The most one call returns (the definer refuses more than 200). */
export const BRANCH_CLEANUP_LIST_LIMIT = 50;

export interface DueBranchCleanup {
  accountId: string;
  workItemId: string;
}

/** One statement; when nothing is waiting the answer is an empty list. */
export async function listDueBranchCleanups(pool: Pick<Pool, 'query'>, opts: { limit?: number } = {}): Promise<DueBranchCleanup[]> {
  const { rows } = await pool.query<{ account_id: string; work_item_id: string }>('SELECT account_id, work_item_id FROM branch_cleanup_list_due($1::integer)', [
    opts.limit ?? BRANCH_CLEANUP_LIST_LIMIT,
  ]);
  return rows.map((r) => ({ accountId: r.account_id, workItemId: r.work_item_id }));
}
