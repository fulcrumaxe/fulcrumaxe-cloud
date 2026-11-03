import type { Pool } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { NotFoundError } from '../tenancy/errors.js';

/** What a delegation token may be: the scopes and the life the database CHECK also holds it to (0971). */
export const DELEGATION_SCOPES = ['read', 'corrections:write'] as const;
export const DELEGATION_TTL_MS = 60 * 60 * 1000;

/**
 * D#597 CC-4: is the work item (or the item a correction belongs to) in the repo a delegation token is bound to? The answer is read
 * under the token's own tenant, so another account's item is simply absent. Absent and other-repo are one answer (false), so a
 * caller cannot tell which it hit; the route turns it into the same 404 an unknown id gets.
 */
export async function itemInRepo(
  pool: Pool,
  ctx: { accountId: string; userId: string },
  ref: { workItemId: string } | { correctionId: string } | { runId: string },
  repoId: string,
): Promise<boolean> {
  return withTenant(pool, ctx.accountId, ctx.userId, async (client) => {
    const { rows } =
      'workItemId' in ref
        ? await client.query<{ repo_id: string | null }>('SELECT repo_id FROM work_items WHERE id = $1', [ref.workItemId])
        : 'runId' in ref
          ? // A run belongs to the repo of its work item; a run with no work item belongs to no repo, so a bound token cannot reach it.
            await client.query<{ repo_id: string | null }>(
              'SELECT w.repo_id FROM agent_runs r JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1',
              [ref.runId],
            )
          : await client.query<{ repo_id: string | null }>(
            'SELECT w.repo_id FROM work_item_corrections c JOIN work_items w ON w.id = c.work_item_id WHERE c.id = $1',
            [ref.correctionId],
          );
    return rows[0]?.repo_id === repoId;
  });
}

/**
 * Approve a device code: the signed-in person binds a live code to one repo of their account. Returns the client id the code was asked
 * by, or null when the code is unknown, past its 10 minutes or already approved. A repo that is not this account's is "not found".
 */
export async function approveLink(
  pool: Pool,
  ctx: { accountId: string; userId: string },
  userCode: string,
  repoId: string,
): Promise<string | null> {
  return withTenant(pool, ctx.accountId, ctx.userId, async (client) => {
    try {
      const { rows } = await client.query<{ c: string | null }>('SELECT assistant_link_approve($1, $2::uuid) AS c', [userCode, repoId]);
      return rows[0]?.c ?? null;
    } catch (err) {
      if ((err as { code?: string }).code === '42501') throw new NotFoundError(`repo ${repoId} not found`);
      throw err;
    }
  });
}
