import type { Pool } from 'pg';

/**
 * D#598: the cross-account list of work items in a pull-request stage whose pull request has not been checked on GitHub lately (migration 0894,
 * `pr_slot_reconcile_list_due`). Call it on the RUN-WRITER pool (`agent_run_writer` holds EXECUTE; `app_user`, `platform_ops` and every other role
 * are refused) with no tenant set. It answers two ids per item and nothing else; the pull request is read afterwards, one item at a time, under its
 * own tenant.
 */

/** The most one call returns (the definer refuses more than 200). */
export const PR_SLOT_RECONCILE_LIST_LIMIT = 50;

export interface DuePrSlotReconcile {
  accountId: string;
  workItemId: string;
}

/** One statement; when nothing is due the answer is an empty list. */
export async function listDuePrSlotReconciles(pool: Pick<Pool, 'query'>, opts: { limit?: number } = {}): Promise<DuePrSlotReconcile[]> {
  const { rows } = await pool.query<{ account_id: string; work_item_id: string }>('SELECT account_id, work_item_id FROM pr_slot_reconcile_list_due($1::integer)', [
    opts.limit ?? PR_SLOT_RECONCILE_LIST_LIMIT,
  ]);
  return rows.map((r) => ({ accountId: r.account_id, workItemId: r.work_item_id }));
}
