import type { PoolClient } from 'pg';

/**
 * D#483 S4-e3: the one named reader of where a work item came from, for learning.
 *
 * Two facts look alike and are not. A proposal keeps the provenance it was imported with (`external` for something a
 * stranger opened) for good, approval included. The work item an approval creates is `internal`, because the owner's
 * click is what made it ours to build. So "did this item start as outside input?" is answered by the proposal, never by
 * the work item's own provenance column, which says who may act on the item now, not where it began.
 *
 * This runs on the caller's tenant client (the caller owns the transaction and the tenant context), so a work item of
 * another account joins to nothing and reads as "no proposal".
 *
 * Root only: the answer is for the item the proposal points at. A retired item (closed, superseded by a triaged root) has
 * no proposal pointing at it, so it reads as no origin; the learning consumer asks about the root.
 *
 * The D#7 C14 learning row calls this function. Nothing else in the packages joins proposals to work items to read a
 * provenance for learning (a test in core pins that).
 */
export interface WorkItemOrigin {
  /** The proposal linked to the item through `proposals.work_item_id`, or null when none is. */
  proposalId: string | null;
  /** True exactly when there is a proposal and its provenance is `external`. */
  externalSource: boolean;
}

export async function workItemOrigin(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<WorkItemOrigin> {
  const { rows } = await client.query<{ id: string; provenance: string }>(
    `SELECT p.id, p.provenance FROM proposals p WHERE p.work_item_id = $1`,
    [workItemId],
  );
  const row = rows[0];
  if (!row) return { proposalId: null, externalSource: false };
  return { proposalId: row.id, externalSource: row.provenance === 'external' };
}
