import type { PoolClient } from 'pg';

/**
 * D#749 V3a: the cloud's side of a deploy order (table verify_deploy_orders, migration 1004). THE CLOUD CAN ONLY SAY "DEPLOY SHA X OF REPOSITORY R": an order carries the
 * merge commit and a deadline, and the command that deploys it is in the runner's own local configuration. A tenant session (no runner in it) may place an order and end
 * one that was never run (`expired`, `cancelled`); a runner claims and reports. The table's trigger holds the same line, so a mistake here cannot widen what a runner may do.
 */
export type DeployOrderState = 'pending' | 'claimed' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export const OPEN_ORDER_STATES: readonly DeployOrderState[] = ['pending', 'claimed'];
/** How long an order waits to be taken by a runner before the cloud lets it lapse (it is then claimable no more). */
export const ORDER_CLAIM_WINDOW_MINUTES = 15;

export interface DeployOrder {
  id: string;
  verify_row_id: string;
  merge_sha: string;
  state: DeployOrderState;
  failure_code: string | null;
  exit_code: number | null;
  output_tail: string | null;
  deadline_at: Date;
  lease_expires_at: Date | null;
  finished_at: Date | null;
  /** The database's own now(), so a caller never judges a deadline against its own clock. */
  db_now: Date;
}
const COLUMNS = `id, verify_row_id, merge_sha, state, failure_code, exit_code, output_tail, deadline_at, lease_expires_at, finished_at, now() AS db_now`;

/**
 * Places the one order of a verify row. A replay finds the order the row already has (`placed: false`): the row is the key, and the table allows at most one open order
 * per repository and commit besides. The caller moves the row `pending -> deploying` in the same transaction, so a row never has an order without having started deploying.
 */
export async function placeDeployOrder(client: PoolClient, accountId: string, input: { rowId: string; repoId: string; mergeSha: string }): Promise<{ placed: boolean; orderId: string }> {
  const existing = await client.query<{ id: string }>(`SELECT id FROM verify_deploy_orders WHERE account_id = $1 AND verify_row_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [accountId, input.rowId]);
  if (existing.rows[0] !== undefined) return { placed: false, orderId: existing.rows[0].id };
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int)) RETURNING id`,
    [accountId, input.repoId, input.rowId, input.mergeSha, ORDER_CLAIM_WINDOW_MINUTES],
  );
  return { placed: true, orderId: rows[0]!.id };
}

/** The row's newest order, or null when none was placed. */
export async function readOrderOfRow(client: PoolClient, accountId: string, rowId: string): Promise<DeployOrder | null> {
  const { rows } = await client.query<DeployOrder>(`SELECT ${COLUMNS} FROM verify_deploy_orders WHERE account_id = $1 AND verify_row_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [accountId, rowId]);
  return rows[0] ?? null;
}

/**
 * Lets an order lapse that no runner ran in time: still open past its deadline, and (when claimed) with a lease that has ended, so a runner that is deploying right
 * now is never cut off. Returns true when this call ended it. The table refuses the move for anything else.
 */
export async function expireOrder(client: PoolClient, accountId: string, orderId: string): Promise<boolean> {
  const r = await client.query(
    `UPDATE verify_deploy_orders SET state = 'expired', finished_at = now()
      WHERE account_id = $1 AND id = $2 AND deadline_at <= now() AND (state = 'pending' OR (state = 'claimed' AND lease_expires_at <= now()))`,
    [accountId, orderId],
  );
  return r.rowCount === 1;
}

/** The undo of an order: ends the open orders of these rows as cancelled (a row that ended `unverified`, or a repository switched off). Returns the ids ended. */
export async function cancelOpenOrders(client: PoolClient, accountId: string, rowIds: readonly string[]): Promise<string[]> {
  if (rowIds.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    `UPDATE verify_deploy_orders SET state = 'cancelled', finished_at = now() WHERE account_id = $1 AND verify_row_id = ANY($2::uuid[]) AND state IN ('pending', 'claimed') RETURNING id`,
    [accountId, rowIds],
  );
  return rows.map((r) => r.id);
}
