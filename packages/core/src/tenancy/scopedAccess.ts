import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withTenant } from './withTenant.js';
import { NotFoundError } from './errors.js';

/**
 * CWE-639 (H06 pass/fail item 3): the account-scoped tables a route
 * handler is most likely to fetch a single row from by id, given the
 * schema H02 already shipped. work_items/agent_runs/run_events belong to
 * H09/H11's routes and role_settings to H12's, but the generic "fetch my
 * account's own row or 404" shape is H06's to get right once, here, so
 * every later route reuses it rather than re-deriving the
 * not-403-because-that-would-leak-existence rule per table.
 *
 * Deliberately an allowlist, not a caller-supplied table name: string-
 * interpolating an arbitrary identifier into SQL is the wrong shape for
 * this even though these four names are never attacker input in
 * practice, and the allowlist is also what keeps this list honest as new
 * account-scoped tables show up later.
 */
const SCOPED_TABLES = {
  work_items: 'SELECT * FROM work_items WHERE id = $1',
  agent_runs: 'SELECT * FROM agent_runs WHERE id = $1',
  run_events: 'SELECT * FROM run_events WHERE id = $1',
  role_settings: 'SELECT * FROM role_settings WHERE id = $1',
} as const;

export type ScopedTable = keyof typeof SCOPED_TABLES;

/**
 * Security fix round item 1 (CWE-613/CWE-639): every RLS policy in
 * 0001_core.sql checks only `app.account_id`, never that `app.user_id`
 * is still a member of that account (withTenant.ts's own doc comment
 * says as much -- it has no way to know the schema's membership shape,
 * so it can't enforce this itself). The session cookie lasts 30 days and
 * cannot be revoked server-side, so without this check a removed member
 * keeps full read access to their old account for up to 30 days on their
 * still-valid cookie. Exported so later routes that need the same
 * "is this caller still a member" check reuse this rather than
 * re-deriving it -- see getTenantRowOrNotFound below for the one
 * currently-shipped caller.
 */
export async function assertActiveMembership(
  client: PoolClient,
  accountId: string,
  userId: string,
): Promise<void> {
  const { rows } = await client.query(
    'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
    [accountId, userId],
  );
  if (rows.length === 0) {
    throw new NotFoundError(`no account_members row for user ${userId} on account ${accountId}`);
  }
}

/**
 * Fetches one row from `table` by id, scoped to `accountId` via
 * withTenant/RLS. Returns the row, or throws NotFoundError -- for BOTH a
 * genuinely missing id and an id that belongs to a different account,
 * because RLS makes those two cases indistinguishable at the SQL level
 * (a filtered-out row and a missing row are both zero rows), and a route
 * handler must not turn that difference into a 403 that would confirm
 * the row exists. Also throws NotFoundError -- the same error, for the
 * same reason -- when `userId` is no longer a member of `accountId` at
 * all (security fix round item 1), checked inside the same withTenant
 * transaction so the membership check and the row fetch see a
 * consistent snapshot.
 */
export async function getTenantRowOrNotFound<T extends QueryResultRow>(
  pool: Pool,
  accountId: string,
  userId: string,
  table: ScopedTable,
  id: string,
): Promise<T> {
  return withTenant(pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<T>(SCOPED_TABLES[table], [id]);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError(`${table} ${id} not found`);
    }
    return row;
  });
}
