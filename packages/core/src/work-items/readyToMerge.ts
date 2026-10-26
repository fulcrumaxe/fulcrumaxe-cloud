import type { Pool } from 'pg';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';
import { TERMINAL_WORK_ITEM_STAGES } from './stages.js';
import { TRANSIENT_GATE_REASONS } from './stalled.js';
import { cleanWorkItemTitle } from './title.js';

/**
 * D#598 P8c-2b: the work items whose merge gate ended with "ready, a person merges". Nothing is stored for this list: an item is on it while its
 * newest merge-gate event says `ready_human_merges` (a later gate outcome, such as a new head, replaces it) and its stage is not terminal. GitHub's
 * pull request webhook moves the stage to `merged` or `closed_unmerged`, so the item leaves the list by itself when its pull request is merged or closed.
 * An answer whose reasons include one that time can clear (a draft pull request, checks not green yet, the public copy not open yet) is not "ready": the gate
 * ended before it could pass. That item is on the stalled list instead (stalled.ts), with the button that asks the gate again.
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
  reasons: string[];
  created_at: Date;
  total: string;
}

/** Newest first. `total` counts every item on the list, shown or not. */
export async function listReadyToMerge(ctx: ReadyToMergeCtx, opts: { limit: number }): Promise<{ items: ReadyToMergeItem[]; total: number }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500) throw new RangeError('listReadyToMerge: limit must be 1..500');
  const { accountId, userId, tokenId } = ctx.principal;
  const rows = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const res = await client.query<Row>(
      `SELECT w.id AS work_item_id, w.title, e.pr_number, r.gh_owner, r.gh_name, e.reasons, e.created_at, count(*) OVER () AS total
         FROM work_items w
         JOIN LATERAL (SELECT d.code, d.pr_number, d.reasons, d.created_at
                         FROM work_item_driver_events d
                        WHERE d.account_id = w.account_id AND d.work_item_id = w.id AND d.kind = 'merge_gate'
                        ORDER BY d.seq DESC LIMIT 1) e ON e.code = 'ready_human_merges' AND e.pr_number IS NOT NULL
         LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
        WHERE w.account_id = $1::uuid AND NOT (w.stage = ANY($3::text[])) AND NOT (e.reasons && $4::text[])
        ORDER BY e.created_at DESC, w.id
        LIMIT $2::integer`,
      [accountId, opts.limit, [...TERMINAL_WORK_ITEM_STAGES], [...TRANSIENT_GATE_REASONS]],
    );
    return res.rows;
  });
  return {
    items: rows.map((r) => ({
      workItemId: r.work_item_id,
      title: cleanWorkItemTitle(r.title),
      prNumber: r.pr_number,
      repo: r.gh_owner && r.gh_name ? { owner: r.gh_owner, name: r.gh_name } : null,
      reasons: r.reasons,
      since: r.created_at,
    })),
    total: rows[0] === undefined ? 0 : Number(rows[0].total),
  };
}
