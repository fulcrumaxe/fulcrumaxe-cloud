import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#845 ON-22: how many engines are live for the account now. A live engine is a placement (one engine per machine and one per repo); the parked state of a later row is subtracted
 * here, in this one place. Derived from rows on every call, never from a stored count. Names the account itself, on top of row security.
 */
export async function countLiveEnginesInTx(client: PoolClient, accountId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM project_placements WHERE account_id = $1', [accountId]);
  return rows[0]?.n ?? 0;
}

/** The same count in its own tenant transaction, for a caller that holds only the pool and the principal. */
export function countLiveEngines(ctx: { pool: Pool; principal: { accountId: string; userId: string } }): Promise<number> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, (client) => countLiveEnginesInTx(client, accountId));
}
