import { Pool, type PoolClient } from 'pg';

/**
 * `packages/db` (H02) owns the canonical `createPool`/`withTenant` and
 * publishes no `main`/`exports` in its package.json, so "@fx/db" is not
 * resolvable as an import today -- and package.json is outside H05's
 * file scope (packages/spend/**, packages/db/migrations/0002_spend_fns.sql
 * only), so packages/spend does not modify it to add one. This file is
 * the same pattern, kept intentionally minimal, so packages/spend has no
 * runtime dependency on packages/db's internals -- if H02's own pool
 * helper changes shape later, H05's tests are unaffected.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/**
 * Runs `fn` inside a transaction with `app.account_id` set via `SET
 * LOCAL` (through `set_config(..., true)`, parameterized rather than
 * string-interpolated). Mirrors packages/db/src/withTenant.ts's
 * single-account-id call shape; packages/spend never needs the
 * `app.user_id` variant that helper also supports.
 */
export async function withTenant<T>(
  pool: Pool,
  accountId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Best-effort: the connection may already be unusable.
    });
    throw err;
  } finally {
    await client.query('RESET app.account_id').catch(() => {
      // Best-effort cleanup.
    });
    client.release();
  }
}
