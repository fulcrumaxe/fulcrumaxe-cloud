import type { PoolClient } from 'pg';

/**
 * D#7 DP7-1 (migration 0931): how many reversals stand on one work item of the session's account. Derived from the receipts on every call
 * (receipts that point at another receipt, refused ones not counted), never stored. `client` is a `withTenant` client on the RECEIPT pool, the
 * login that may call the definer; any other login is refused by the database.
 */
export async function reversalCount(client: PoolClient, workItemId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>('SELECT reversal_count($1::uuid) AS n', [workItemId]);
  return rows[0]!.n;
}
