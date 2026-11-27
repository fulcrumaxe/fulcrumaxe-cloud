import type { PoolClient } from 'pg';

/**
 * D#845 ON-27d1: which private twins a push to a default branch concerns. The pushed repository is either side of a twin: its private repo (found by the delivery's repos row) or its public repo (found by its repos row or its
 * `owner/name`, case-insensitively). Only a twin that is `ready` or in `conflict` has anything to compare: a conflict is cleared by a push to either side, and a paused, refused, failed, seeding or removed twin is not compared.
 * Every table is read by `account_id` on top of row security, so a repo of another account with the same name never matches, and a second twin of the SAME account (its own two repos) is not marked by a push to the first one's.
 * Read-only: the webhook makes no GitHub call. Where the due time is kept belongs to the reconcile row (ON-27d4).
 */
export const TWIN_PARITY_STATES: readonly string[] = ['ready', 'conflict'];

export async function findTwinsForPush(client: PoolClient, input: { accountId: string; repoId: string | null; fullName: string }): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT t.id FROM repo_twins t
       JOIN repos pub ON pub.account_id = t.account_id AND pub.id = t.public_repo_id
       LEFT JOIN repos prv ON prv.account_id = t.account_id AND prv.id = t.private_repo_id
      WHERE t.account_id = $1::uuid AND t.state = ANY($4::text[]) AND t.private_repo_id IS NOT NULL
        AND (t.public_repo_id = $2::uuid OR t.private_repo_id = $2::uuid OR lower(pub.gh_owner || '/' || pub.gh_name) = lower($3) OR lower(prv.gh_owner || '/' || prv.gh_name) = lower($3))
      ORDER BY t.id`,
    [input.accountId, input.repoId || null, input.fullName, TWIN_PARITY_STATES],
  );
  return rows.map((r) => r.id);
}
