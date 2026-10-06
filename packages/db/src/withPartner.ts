import type { Pool, PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`withPartner: ${label} must be a UUID, got: ${JSON.stringify(value)}`);
  }
}

/**
 * Runs `fn` inside a transaction with `app.partner_id` (and, if given,
 * `app.user_id`) set via `SET LOCAL` (through `set_config(..., true)`, same
 * as `withTenant`). Every `partner_user`-scoped policy in
 * migrations/0200_partners.sql reads `app.partner_id`; `app.user_id` exists
 * for the one policy that needs to know WHICH partner member is asking
 * (support_access_log's partner-side INSERT) and for recording an actor on
 * partner_audit_log rows -- see the X-user-id note in that migration file
 * for why availability here is not the same as trust: no policy may read
 * app.user_id without its own join to partner_members.
 *
 * Two call shapes, mirroring withTenant:
 *   withPartner(pool, partnerId, fn)
 *   withPartner(pool, partnerId, userId, fn)
 *
 * Same leak-prevention discipline as withTenant: SET LOCAL reverts at
 * COMMIT/ROLLBACK on its own, and `finally` runs
 * `RESET app.partner_id; RESET app.user_id` before releasing the
 * connection, on every path including error, as a second line of defense
 * against `fn` (mis)using `set_config(..., false)` or a plain `SET` inside
 * the transaction. test/partners.test.ts asserts both, the same way
 * test/with-tenant.test.ts does for withTenant.
 *
 * Right after `BEGIN`, this also asserts `current_user = 'partner_user'`
 * (D#2607 P01 fix-round finding 9). `createPool` (src/pool.ts) lets a
 * caller construct as many pools as it wants against any role -- nothing
 * stops a caller from accidentally handing this function the
 * `platform_ops` pool (or a plain admin one) instead of the `partner_user`
 * one. Every RLS policy this function's caller relies on is scoped to
 * `partner_user`; connected as `platform_ops` (whose policies are all
 * `USING (true)`), the SAME app.partner_id-scoped queries would silently
 * return every partner's data instead of failing. Asserting the role turns
 * that mistake into an immediate, loud error instead of a silent full-access
 * session.
 */
export async function withPartner<T>(
  pool: Pool,
  partnerId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>;
export async function withPartner<T>(
  pool: Pool,
  partnerId: string,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>;
export async function withPartner<T>(
  pool: Pool,
  partnerId: string,
  fnOrUserId: ((client: PoolClient) => Promise<T>) | string,
  maybeFn?: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const userId = typeof fnOrUserId === 'string' ? fnOrUserId : undefined;
  const fn = typeof fnOrUserId === 'string' ? maybeFn! : fnOrUserId;

  assertUuid('partnerId', partnerId);
  if (userId !== undefined) {
    assertUuid('userId', userId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ current_user: string }>('SELECT current_user');
    if (rows[0]?.current_user !== 'partner_user') {
      throw new Error(
        `withPartner: expected to be connected as 'partner_user', got: ${JSON.stringify(rows[0]?.current_user)}`,
      );
    }
    await client.query('SELECT set_config($1, $2, true)', ['app.partner_id', partnerId]);
    if (userId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    }
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
    await client.query('RESET app.partner_id; RESET app.user_id').catch(() => {
      // Best-effort cleanup: if the connection is already broken there is
      // nothing left to reset, and the caller's real error (if any) has
      // already propagated above.
    });
    client.release();
  }
}
