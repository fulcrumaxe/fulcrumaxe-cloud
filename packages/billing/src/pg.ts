import { Pool, type PoolClient } from 'pg';

/**
 * Same pattern as packages/spend/src/pg.ts: kept self-contained rather
 * than importing @fx/db's own createPool/withPlatformOps, since @fx/db
 * publishes no main/exports and H10's file scope is packages/billing/**
 * plus the webhook route, not packages/db/package.json.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/**
 * Every write H10 makes -- accounts.status, accounts.plan,
 * accounts.compute_cap_usd_month, accounts.deleted_at, and the audit_log
 * idempotency marker -- goes through `platform_ops` (sec-criteria A3:
 * "app_user has no INSERT or UPDATE on accounts at all, so every cap
 * check and status transition runs as platform_ops"). Unlike withTenant,
 * this never sets `app.account_id`: platform_ops's own RLS policies are
 * unconditional (`USING (true)`), so there is nothing for that GUC to
 * gate. Every caller MUST pass a pool connected as `platform_ops` -- this
 * function does not check the role itself; the database's own grants are
 * the actual enforcement.
 */
export async function withPlatformOps<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Best-effort: the connection may already be unusable.
    });
    throw err;
  } finally {
    client.release();
  }
}
