import type { Pool, PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`withTenant: ${label} must be a UUID, got: ${JSON.stringify(value)}`);
  }
}

/**
 * Runs `fn` inside a transaction with `app.account_id` (and, if given,
 * `app.user_id` and `app.token_id`) set via `SET LOCAL` (through
 * `set_config(..., true)`, parameterized). `app.user_id` exists for the
 * `users` policy and later partner policies (D#2607). `app.token_id`
 * (D#31 API-3b) exists for `api_tokens`'s own RLS policies and
 * `audit_write_api_tokens`, which need to know WHICH token when the
 * caller is a token principal acting on itself -- not derivable from
 * `app.user_id` alone, since a creator can hold several tokens.
 *
 * Three call shapes:
 *   withTenant(pool, accountId, fn)
 *   withTenant(pool, accountId, userId, fn)
 *   withTenant(pool, accountId, userId, tokenId, fn)
 *
 * `tokenId` may itself be `undefined` -- the implementation tells shape 2
 * from shape 3 by checking whether the 4th positional arg IS a function,
 * not by its presence alone, so `(pool, accountId, userId, undefined, fn)`
 * still lands on shape 3.
 *
 * `accountId` (and `userId`, when given) are validated as UUIDs up front,
 * before ever acquiring a connection or opening a transaction -- a bad
 * caller gets a clear, synchronous error instead of a confusing cast
 * failure surfaced from deep inside a policy (or, worse, a value that's
 * silently never applied).
 *
 * `SET LOCAL` is transaction-scoped by Postgres itself: it reverts at
 * COMMIT or ROLLBACK, so neither setting can leak to whatever the pool
 * hands this connection out for next -- for a value set that way. But
 * that scoping does NOT protect against `fn` (a bug, or a future change)
 * calling `set_config(..., false)` or plain `SET` INSIDE the transaction,
 * which sets the GUC at SESSION level and survives the COMMIT same as it
 * would outside any transaction at all. `finally` runs
 * `RESET app.account_id; RESET app.user_id` before releasing the
 * connection, on every path including error, specifically to close that
 * gap -- belt-and-suspenders against a caller misusing the client, not
 * against the ordinary SET LOCAL case (which the transaction scoping
 * already handles on its own). test/with-tenant.test.ts asserts both.
 *
 * IMPORTANT -- `userId` is validated as a UUID and nothing else. It is
 * NOT checked here for membership in `accountId` (this function has no
 * way to know the schema's membership shape, and shouldn't). Any RLS
 * policy that reads `app.user_id` (the D#2607 partner policies will) MUST
 * independently join account_members (or the equivalent) rather than
 * trusting the value on its own -- exactly like `member_visible`'s
 * EXISTS check on `users` in migrations/0001_core.sql. A caller passing a
 * userId that isn't actually a member of accountId is a caller bug, not
 * something withTenant can catch, and a policy that trusted app.user_id
 * blindly would turn that bug into a privilege escalation.
 *
 * IMPORTANT -- for any table whose SELECT policy is MORE restrictive than
 * its INSERT/WITH CHECK policy (as `users` now is: no INSERT grant to
 * app_user at all, and even platform_ops's own inserts would matter here
 * for any FUTURE table shaped this way), `INSERT ... RETURNING col`
 * through this client raises `new row violates row-level security
 * policy`, not a silent empty result -- Postgres checks the newly
 * inserted row against the table's SELECT policy to decide what
 * RETURNING can show, and errors (rolling back the whole INSERT) rather
 * than just omitting the row if it fails that check. Confirmed directly:
 * `INSERT ... RETURNING id` against a table with `WITH CHECK (true)` but
 * `USING (false)` for SELECT errors, and the row is not persisted.
 * H06 (auth/onboarding): don't reach for `RETURNING id` as a way to read
 * back a row your own SELECT policy wouldn't otherwise show you.
 */
export async function withTenant<T>(
  pool: Pool,
  accountId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>;
export async function withTenant<T>(
  pool: Pool,
  accountId: string,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>;
export async function withTenant<T>(
  pool: Pool,
  accountId: string,
  userId: string,
  tokenId: string | undefined,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>;
export async function withTenant<T>(
  pool: Pool,
  accountId: string,
  arg3: ((client: PoolClient) => Promise<T>) | string,
  arg4?: ((client: PoolClient) => Promise<T>) | string,
  arg5?: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let userId: string | undefined;
  let tokenId: string | undefined;
  let fn: (client: PoolClient) => Promise<T>;

  if (typeof arg3 === 'function') {
    fn = arg3;
  } else {
    userId = arg3;
    if (typeof arg4 === 'function') {
      fn = arg4;
    } else {
      tokenId = arg4;
      fn = arg5!;
    }
  }

  assertUuid('accountId', accountId);
  if (userId !== undefined) {
    assertUuid('userId', userId);
  }
  if (tokenId !== undefined) {
    assertUuid('tokenId', tokenId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
    if (userId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    }
    if (tokenId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.token_id', tokenId]);
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
    await client.query('RESET app.account_id; RESET app.user_id; RESET app.token_id').catch(() => {
      // Best-effort cleanup: if the connection is already broken there is
      // nothing left to reset, and the caller's real error (if any) has
      // already propagated above.
    });
    client.release();
  }
}
