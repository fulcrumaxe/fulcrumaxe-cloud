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

/**
 * D#845 ON-27d4b: the webhook's mark, one `twin_parity_mark_due` per twin found (migration 1112: it re-checks that the pushed repository is one of the twin's two sides and that the twin is ready or in conflict). The twin's due time is then
 * 60 seconds on and the push counts in `mark_seq`, so a check that began before it cannot clear it. Returns how many twins were marked.
 */
export async function markTwinParityDue(client: PoolClient, input: { accountId: string; twinIds: string[]; repoId: string | null; fullName: string }): Promise<number> {
  let marked = 0;
  for (const twinId of input.twinIds) {
    const { rows } = await client.query<{ o_result: string }>('SELECT o_result FROM twin_parity_mark_due($1::uuid, $2::uuid, $3)', [twinId, input.repoId || null, input.fullName]);
    if (rows[0]?.o_result === 'ok') marked += 1;
  }
  return marked;
}
