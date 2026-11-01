import type { Pool } from "pg";
import type { PlanePushState } from "@fx/core/src/repos/planePushRecord.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

/** A paired item's public pull request: where it lives and what the platform stamped for it. */
export interface PublicPullRequest {
  owner: string;
  name: string;
  number: number;
  /** The public branch (`fx/p-<push id>`, a generated column of our own row): what a `runner_local` repo's list read is keyed by. */
  branch: string;
  /** The public branch head the platform last pushed, or null when none is stamped. */
  stampedHead: string | null;
  /** The push record's state: `updating` and `waiting_person_pushed` mean a republish is in flight, so the stamp may be about to change. */
  pushState: PlanePushState;
  /** The private head that public head was built from (null for a row written before it was recorded). */
  sourceHead: string | null;
  /** The pairing's overlay list: the paths kept out of the public repository. */
  overlayGlobs: string[];
  /** A person took the public branch over, so the platform's stamp no longer says what the branch holds. */
  managedByPerson: boolean;
}

/**
 * What the lookup answers. `null`: the item's repository has no pairing (a single-plane item). `{ paired: true, pr: null }`: it is paired and no
 * public pull request is open (nothing opened yet, closed, merged, or a push record naming another code repository). The difference matters: a paired
 * item with no open public pull request must never fall through to its private copy as if that copy could merge.
 */
export type PublicPullRequestReading = { paired: true; pr: PublicPullRequest | null };

/** Finds an item's public pull request; the CI wait takes this as a port so it stays free of any plane. */
export type PublicPullRequestLookup = (accountId: string, workItemId: string) => Promise<PublicPullRequestReading | null>;

/**
 * The item's public pull request, when its repository is paired and the platform recorded the pull request it opened there (`plane_pushes`, read as
 * `prSlotReconcile` reads it: the push record is of the item's own repository, and the pairing must still exist and still name the same code
 * repository). `pr` is null (the item is still `paired`) when nothing was opened yet, the public pull request is already closed or merged, or the pairing now
 * names another code repository. The whole answer is null only for an item whose repository has no pairing: that item reads its own pull request, as a
 * single-plane repository always does.
 */
export const readPublicPullRequest: (pool: Pool) => PublicPullRequestLookup = (pool) => async (accountId, workItemId) => {
  const found = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ code_repo: string; branch: string; pr_number: number | null; head_sha: string | null; state: PlanePushState; source_head: string | null; overlay_globs: string[]; managed: boolean }>(
      `SELECT p.code_repo, p.branch, p.pr_number, p.head_sha, p.state,
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
    const row = rows[0] ?? null;
    if (row !== null) return { row, paired: true };
    // No open public pull request: is the item's repository paired at all?
    const pairing = await client.query<{ one: number }>(
      `SELECT 1 AS one FROM work_items w JOIN repo_pairing rp ON rp.account_id = w.account_id AND rp.repo_id = w.repo_id WHERE w.account_id = $1 AND w.id = $2 LIMIT 1`,
      [accountId, workItemId],
    );
    return { row: null, paired: pairing.rows.length > 0 };
  });
  if (!found.paired) return null;
  const row = found.row;
  if (row === null || row.pr_number === null) return { paired: true, pr: null };
  const [owner, name, extra] = row.code_repo.split("/");
  if (!owner || !name || extra !== undefined) return { paired: true, pr: null };
  return { paired: true, pr: { owner, name, number: row.pr_number, branch: row.branch, stampedHead: row.head_sha, pushState: row.state, sourceHead: row.source_head, overlayGlobs: row.overlay_globs, managedByPerson: row.managed } };
};
