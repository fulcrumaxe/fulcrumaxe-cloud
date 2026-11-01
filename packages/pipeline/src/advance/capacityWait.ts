import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { CAPACITY_SKIP_SENTENCES, capacityWaitSentence } from "./capacitySentences.js";

/**
 * D#483 S5-k3b-2a: what the card shows while an item waits for room. Derived on read from the item's own queue entry (`capacity_queue_place`, migration 0943, on
 * the item's tenant session); nothing is stamped on the item. `computeNotice` picks it only when `readReservationPause` gives null.
 */

export interface CapacityWait {
  /** The fixed sentence the card shows. */
  sentence: string;
  /** The place in line, or null when the entry is skipped (only the repo-gone sentence then shows). */
  place: number | null;
  skip: "repo_not_connected" | null;
}

interface PlaceRow {
  o_place: number | null;
  o_skip: string | null;
  o_recent_starts: number | null;
  o_median_wait_seconds: number | null;
}

/** The raw place read for one item: null when the item has no open entry in its own account. Another account's item is the same null. */
export async function readCapacityPlace(pool: Pool, accountId: string, workItemId: string): Promise<PlaceRow | null> {
  return withTenant(pool, accountId, async (c) => {
    const { rows } = await c.query<PlaceRow>(`SELECT o_place, o_skip, o_recent_starts, o_median_wait_seconds FROM capacity_queue_place($1)`, [workItemId]);
    return rows[0] ?? null;
  });
}

/** The sentence for the item, or null when there is none to show (no entry; an account that is not active shows what it shows today; an entry skipped because its item stopped asking). */
export async function readCapacityWait(pool: Pool, accountId: string, workItemId: string): Promise<CapacityWait | null> {
  const row = await readCapacityPlace(pool, accountId, workItemId);
  if (row === null) return null;
  if (row.o_skip === "repo_not_connected") return { sentence: CAPACITY_SKIP_SENTENCES.repo_not_connected, place: null, skip: "repo_not_connected" };
  if (row.o_skip !== null || row.o_place === null) return null;
  const sentence = capacityWaitSentence({ place: Number(row.o_place), recentStarts: row.o_recent_starts === null ? null : Number(row.o_recent_starts), medianWaitSeconds: row.o_median_wait_seconds });
  return sentence === null ? null : { sentence, place: Number(row.o_place), skip: null };
}
