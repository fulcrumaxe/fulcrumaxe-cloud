import type { PoolClient } from "pg";

/**
 * D#483 S5-p: how long an item holds a build slot, as the account's own history shows it.
 *
 * The median, over the account's last `SLOT_HOLD_SAMPLE` items that left a slot, of the time from an item's first transition into
 * `in_progress` to its first transition out of the four slot stages (`work_item_transitions`). With fewer than `SLOT_HOLD_MIN_ITEMS`
 * such items it is the product constant `SLOT_HOLD_SEED_MINUTES`. The seed is a price for a preview, never a limit.
 *
 * The four stages are repeated here on purpose: this module must not import `advance/buildSlots.ts` (the slot code stays free of the
 * estimate and the estimate of the slot code). A test holds the two lists equal.
 */

export const SLOT_HOLD_SEED_MINUTES = 60;
export const SLOT_HOLD_SAMPLE = 50;
export const SLOT_HOLD_MIN_ITEMS = 10;

/** The stages in which an item holds a build slot. Equal to `BUILD_SLOT_STAGES` (a test checks it). */
export const SLOT_HOLD_STAGES: readonly string[] = Object.freeze(["in_progress", "pr_opened", "changes_requested", "review_passed"]);

export interface SlotHold {
  minutes: number;
  basis: "history" | "seed";
}

/** The median of a list of numbers (the mean of the middle two when the count is even). */
export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Must run inside a `withTenant` transaction for `accountId` (RLS scopes the read; the WHERE names the account too). */
export async function slotHoldMinutes(client: PoolClient, accountId: string): Promise<SlotHold> {
  const { rows } = await client.query<{ minutes: string }>(
    `WITH entered AS (
       SELECT work_item_id, min(at) AS entered_at
         FROM work_item_transitions
        WHERE account_id = $1 AND to_stage = 'in_progress'
        GROUP BY work_item_id
     ), left_slot AS (
       SELECT t.work_item_id, min(t.at) AS left_at
         FROM work_item_transitions t
         JOIN entered e ON e.work_item_id = t.work_item_id
        WHERE t.account_id = $1
          AND t.from_stage = ANY($2::text[])
          AND NOT (t.to_stage = ANY($2::text[]))
          AND t.at >= e.entered_at
        GROUP BY t.work_item_id
     )
     SELECT (extract(epoch FROM (l.left_at - e.entered_at)) / 60)::text AS minutes
       FROM entered e
       JOIN left_slot l ON l.work_item_id = e.work_item_id
      ORDER BY l.left_at DESC
      LIMIT $3`,
    [accountId, [...SLOT_HOLD_STAGES], SLOT_HOLD_SAMPLE],
  );
  const minutes = rows.map((r) => Number(r.minutes)).filter((m) => Number.isFinite(m) && m >= 0);
  if (minutes.length < SLOT_HOLD_MIN_ITEMS) return { minutes: SLOT_HOLD_SEED_MINUTES, basis: "seed" };
  return { minutes: medianOf(minutes), basis: "history" };
}
