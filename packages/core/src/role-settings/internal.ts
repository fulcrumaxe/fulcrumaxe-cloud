import type { PoolClient } from 'pg';
import { NotFoundError } from './errors.js';

/**
 * Fetches `repos.settings` for `repoId`, scoped to `accountId` via RLS
 * (must run inside a `withTenant` transaction). Throws NotFoundError --
 * never a permission error -- for both a genuinely missing repo and one
 * that belongs to a different account, matching every other lookup in
 * this codebase (scopedAccess.ts's own doc comment: RLS makes those two
 * cases indistinguishable at the SQL level, and a caller must not turn
 * that into a 403 that would confirm the row exists).
 */
export async function getRepoSettingsOrNotFound(
  client: PoolClient,
  repoId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ settings: Record<string, unknown> | null }>(
    'SELECT settings FROM repos WHERE id = $1',
    [repoId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(`repos ${repoId} not found`);
  }
  return row.settings ?? {};
}

/** Same existence/tenant check, for callers that only need to confirm the repo exists (not its settings). */
export async function assertRepoExists(client: PoolClient, repoId: string): Promise<void> {
  const { rows } = await client.query('SELECT 1 FROM repos WHERE id = $1', [repoId]);
  if (rows.length === 0) {
    throw new NotFoundError(`repos ${repoId} not found`);
  }
}
