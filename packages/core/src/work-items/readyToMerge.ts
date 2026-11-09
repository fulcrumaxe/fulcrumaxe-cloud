import type { Pool } from 'pg';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';
import { TERMINAL_WORK_ITEM_STAGES } from './stages.js';
import { isQueuedSql, PERSON_MERGES_REASONS } from './mergeReadiness.js';
import { cleanWorkItemTitle } from './title.js';

/**
 * D#598 P8c-2b: the work items whose merge gate ended with "ready, a person merges". Nothing is stored for this list: an item is on it while its
 * newest merge-gate event says `ready_human_merges` (a later gate outcome, such as a new head, replaces it) and its stage is not terminal. GitHub's
 * pull request webhook moves the stage to `merged` or `closed_unmerged`, so the item leaves the list by itself when its pull request is merged or closed.
 * An answer is "ready" only when its reasons are empty or all mean "a person presses merge" (mergeReadiness.ts). An answer with any other reason (a draft pull
 * request, checks not green, the public copy not open, a refused public change, a review that did not pass) is not ready: the gate ended before it could pass.
 * That item is on the stalled list instead (stalled.ts), with the button that asks the gate again.
 * D#694 B6-3: an item waiting in GitHub's merge queue (mergeReadiness.ts `isQueuedSql`) is not on this list, whatever its older gate answer says: nothing is left for a person to press.
 */
export interface ReadyToMergeItem {
  workItemId: string;
  title: string | null;
  prNumber: number;
  /** The repository's owner and name, or null when the item has no repository on record. */
  repo: { owner: string; name: string } | null;
  /** The gate's reason codes, closed vocabulary. */
  reasons: string[];
  since: Date;
}

export interface ReadyToMergeCtx {
  pool: Pool;
  principal: { accountId: string; userId: string; tokenId?: string };
}

interface Row {
  work_item_id: string;
  title: string | null;
  pr_number: number;
  gh_owner: string | null;
  gh_name: string | null;
  public_pr: number | null;
  code_repo: string | null;
  reasons: string[];
  created_at: Date;
  total: string;
}

/** The code repository of a paired item's open public pull request, or null (unpaired, none open, or a record that does not read as owner/name). */
function publicRepo(r: Row): { owner: string; name: string } | null {
  if (r.public_pr === null || r.code_repo === null) return null;
  const [owner, name, extra] = r.code_repo.split('/');
  return owner && name && extra === undefined ? { owner, name } : null;
}

/** Newest first. `total` counts every item on the list, shown or not. */
export async function listReadyToMerge(ctx: ReadyToMergeCtx, opts: { limit: number }): Promise<{ items: ReadyToMergeItem[]; total: number }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500) throw new RangeError('listReadyToMerge: limit must be 1..500');
  const { accountId, userId, tokenId } = ctx.principal;
  const rows = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const res = await client.query<Row>(
      `SELECT w.id AS work_item_id, w.title, e.pr_number, r.gh_owner, r.gh_name, pub.pr_number AS public_pr, pub.code_repo, e.reasons, e.created_at, count(*) OVER () AS total
         FROM work_items w
         JOIN LATERAL (SELECT d.code, d.pr_number, d.reasons, d.created_at
                         FROM work_item_driver_events d
                        WHERE d.account_id = w.account_id AND d.work_item_id = w.id AND d.kind = 'merge_gate'
                        ORDER BY d.seq DESC LIMIT 1) e ON e.code = 'ready_human_merges' AND e.pr_number IS NOT NULL
         LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
         -- A paired item is judged, and merged, on its PUBLIC pull request: derived from the platform's push record, never stamped on the gate fact.
         LEFT JOIN LATERAL (SELECT p.pr_number, p.code_repo FROM plane_pushes p
                             WHERE p.account_id = w.account_id AND p.work_item_id = w.id AND p.pr_number IS NOT NULL
                               AND p.state NOT IN ('pr_closed', 'pr_merged', 'scope_refused')
                             ORDER BY p.created_at DESC, p.id DESC LIMIT 1) pub ON true
        WHERE w.account_id = $1::uuid AND NOT (w.stage = ANY($3::text[])) AND e.reasons <@ $4::text[]
          AND NOT ${isQueuedSql('w.account_id', 'w.id', 'e.pr_number')}
        ORDER BY e.created_at DESC, w.id
        LIMIT $2::integer`,
      [accountId, opts.limit, [...TERMINAL_WORK_ITEM_STAGES], [...PERSON_MERGES_REASONS]],
    );
    return res.rows;
  });
  return {
    items: rows.map((r) => {
      const code = publicRepo(r);
      return {
        workItemId: r.work_item_id,
        title: cleanWorkItemTitle(r.title),
        // The pull request the gate judged: the public one for a paired item (the private draft cannot be merged), else the item's own.
        prNumber: code !== null && r.public_pr !== null ? r.public_pr : r.pr_number,
        repo: code ?? (r.gh_owner && r.gh_name ? { owner: r.gh_owner, name: r.gh_name } : null),
        reasons: r.reasons,
        since: r.created_at,
      };
    }),
    total: rows[0] === undefined ? 0 : Number(rows[0].total),
  };
}
