import type { PoolClient } from "pg";
import { recordRunStatusMove, type FailureReason } from "@fx/runner";

/** Where an item's runs go. `null` is "follow the repository"; the runner flavour (local or verified) always comes from the repo. */
export type Placement = "cloud" | "runner";
export const PLACEMENTS: readonly Placement[] = ["cloud", "runner"];

/** The failure reason on a queued run that was cancelled because its item's placement moved off the run's side. */
const CANCEL_REASON: FailureReason = "placement_changed";

/**
 * D#599 PL-1. Ends the item's PENDING runs on the side it just left, in the caller's tenant transaction.
 *
 * The caller (owner or admin; the definer checks it again) has already stored the new placement in this same transaction: the
 * definer refuses with 55000 while the item still runs on `leaving`. The definer moves the runs (the web tier's login cannot
 * write a run's status) and answers their ids; the `run.status_changed` event and the domain event are written here, by the same
 * code every status move uses. Running runs are not touched, and neither is any run of another item.
 *
 * Returns the cancelled run ids, for the audit row's count.
 */
export async function cancelPendingRunsOnLeftSide(client: PoolClient, params: { accountId: string; itemId: string; leaving: Placement }): Promise<string[]> {
  const { rows } = await client.query<{ run_id: string }>("SELECT run_id FROM work_item_cancel_pending_runs($1, $2)", [params.itemId, params.leaving]);
  for (const row of rows) {
    await recordRunStatusMove(client, { accountId: params.accountId, runId: row.run_id, from: "pending", to: "cancelled", failureReason: CANCEL_REASON });
  }
  return rows.map((row) => row.run_id);
}

/** D#599 PL-1. Writes the one audit row of a placement change: who (the caller), from, to, and how many runs it cancelled. The stored placement must already be `to`. */
export async function auditPlacementChange(client: PoolClient, params: { itemId: string; from: Placement | null; to: Placement | null; cancelledRuns: number }): Promise<void> {
  await client.query("SELECT work_item_placement_audit($1, $2, $3, $4)", [params.itemId, params.from, params.to, params.cancelledRuns]);
}
