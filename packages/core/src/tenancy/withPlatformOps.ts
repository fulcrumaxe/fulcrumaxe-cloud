import type { Pool, PoolClient } from 'pg';

/**
 * The `platform_ops`-role sibling of @fx/db's `withTenant`, for the
 * handful of identity/account operations that are platform_ops-only by
 * grant (D#2605 H02 security fix round 3; sec-criteria A5) and that don't
 * have an `account_id` to scope by yet -- most notably looking up an
 * invitation by its token hash BEFORE the accepting account is known, and
 * finding-or-creating a `users` row during sign-in/sign-up.
 *
 * Unlike `withTenant`, this never sets `app.account_id` / `app.user_id`:
 * platform_ops's own RLS policies in migrations/0001_core.sql are all
 * unconditional (`USING (true)`), so there is nothing for those GUCs to
 * gate for this role. What this DOES still guarantee is transactional
 * atomicity (BEGIN/COMMIT/ROLLBACK around `fn`) and that the connection is
 * always released -- the same two properties withTenant provides, minus
 * the session-variable plumbing that only app_user's policies read.
 *
 * Every caller MUST pass a pool connected as `platform_ops`
 * (DATABASE_URL_PLATFORM_OPS) -- this function does not check the role
 * itself; the database's own grants are the actual enforcement (an
 * app_user connection handed to this would simply get "permission denied"
 * from whatever `fn` tries to do).
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
      // Best-effort: the connection may already be unusable after the
      // original error. The original error is what the caller needs.
    });
    throw err;
  } finally {
    client.release();
  }
}
