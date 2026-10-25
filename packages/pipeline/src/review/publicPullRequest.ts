import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

/** A paired item's public pull request: where it lives and what the platform stamped for it. */
export interface PublicPullRequest {
  owner: string;
  name: string;
  number: number;
  /** The public branch head the platform last pushed, or null when none is stamped. */
  stampedHead: string | null;
  /** The private head that public head was built from (null for a row written before it was recorded). */
  sourceHead: string | null;
  /** The pairing's overlay list: the paths kept out of the public repository. */
  overlayGlobs: string[];
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
    const { rows } = await client.query<{ code_repo: string; pr_number: number | null; head_sha: string | null; source_head: string | null; overlay_globs: string[]; managed: boolean }>(
      `SELECT p.code_repo, p.pr_number, p.head_sha,
              -- A sandbox-built stamp carries the private head the platform read when it published. A runner-built stamp carries none (nothing a runner reports is
              -- stored as one); its source head is the branch head the CLOUD read from GitHub when the run that pushed it finished (the \`done\` event), found
              -- through the newest finished runner attempt whose outcome moved the stamp.
              -- The attempt is chosen FIRST (the newest that moved the stamp); only then is that run's done event looked at. A newest run with no succeeded
              -- done event answers NULL: an older run's head is never used in its place.
              COALESCE(p.source_head, (
                SELECT (SELECT e.payload->>'headOid'
                          FROM run_events e
                         WHERE e.account_id = a.account_id AND e.run_id = a.run_id AND e.kind = 'run.status_changed'
                           AND e.payload->>'viaRunnerDone' = 'true' AND e.payload->>'to' = 'succeeded' AND e.payload->>'headOid' IS NOT NULL
                         ORDER BY e.created_at DESC, e.seq DESC LIMIT 1)
                  FROM plane_push_attempts a
                 WHERE a.account_id = p.account_id AND a.plane_push_id = p.id AND a.runtime = 'runner'
                   AND a.finished_at IS NOT NULL AND a.outcome IN ('pr_opened', 'updated', 'pushed', 'pr_failed')
                 ORDER BY a.finished_at DESC, a.id DESC LIMIT 1
              )) AS source_head,
              rp.overlay_globs,
              (p.managed_by_person_at IS NOT NULL) AS managed
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
  return { owner, name, number: row.pr_number, stampedHead: row.head_sha, sourceHead: row.source_head, overlayGlobs: row.overlay_globs, managedByPerson: row.managed };
};
