import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

/** A paired item's public pull request: where it lives and what the platform stamped for it. */
export interface PublicPullRequest {
  owner: string;
  name: string;
  number: number;
  /** The public branch head the platform last pushed, or null when none is stamped. */
  stampedHead: string | null;
  /** A person took the public branch over, so the platform's stamp no longer says what the branch holds. */
  managedByPerson: boolean;
}

/** Finds an item's public pull request; the CI wait takes this as a port so it stays free of any plane. */
export type PublicPullRequestLookup = (accountId: string, workItemId: string) => Promise<PublicPullRequest | null>;

/**
 * The item's public pull request, when its repository is paired and the platform recorded the pull request it opened there (`plane_pushes`, read as
 * `prSlotReconcile` reads it: the push record is of the item's own repository, and the pairing must still exist and still name the same code
 * repository). Null: no pairing, a stale pairing naming another code repository, nothing opened yet, or the public pull request is already closed or
 * merged. The caller then reads the item's own pull request, as a single-plane repository always does.
 */
export const readPublicPullRequest: (pool: Pool) => PublicPullRequestLookup = (pool) => async (accountId, workItemId) => {
  const row = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ code_repo: string; pr_number: number | null; head_sha: string | null; managed: boolean }>(
      `SELECT p.code_repo, p.pr_number, p.head_sha, (p.managed_by_person_at IS NOT NULL) AS managed
         FROM plane_pushes p
         JOIN work_items w ON w.account_id = p.account_id AND w.id = p.work_item_id AND w.repo_id = p.repo_id
         JOIN repo_pairing rp ON rp.account_id = p.account_id AND rp.repo_id = p.repo_id AND lower(rp.code_repo) = lower(p.code_repo)
        WHERE p.account_id = $1 AND p.work_item_id = $2 AND p.pr_number IS NOT NULL AND p.state NOT IN ('pr_closed', 'pr_merged')
        ORDER BY p.created_at DESC, p.id DESC LIMIT 1`,
      [accountId, workItemId],
    );
    return rows[0] ?? null;
  });
  if (row === null || row.pr_number === null) return null;
  const [owner, name, extra] = row.code_repo.split("/");
  if (!owner || !name || extra !== undefined) return null;
  return { owner, name, number: row.pr_number, stampedHead: row.head_sha, managedByPerson: row.managed };
};
