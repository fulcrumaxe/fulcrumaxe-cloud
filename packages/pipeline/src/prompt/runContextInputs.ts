import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { RenderedMemory } from "./assemblePrompt.js";

/**
 * D#600 CX-8b: what a hosted build run's prompt was given, written once beside the run so the context panel can say it (migration 0833).
 * The memory entries the prompt held (ids and versions, in prompt order; names are derived when the panel is read) and the repository
 * map it carried (its format version and the sha256 of the RAW map text, the identity R-600-CX3b-1 fixed across both sides).
 *
 * The write fails closed (see `recordRunContextInputs`). A run with nothing to say (no memory, no map) gets no row.
 */

const REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@v([0-9]{1,6})$/;
/** The most entries the table holds for a run (its CHECK, and the panel's limit). */
export const RUN_INPUTS_MAX_ENTRIES = 50;

export interface RunContextInputs {
  entries: ReadonlyArray<{ id: string; version: number }>;
  map: { version: string; sha256: string } | null;
  /** D#601 MEM-RECALL-RESCAN: how many candidates the recall's secret re-check left out, and whether the check could not be made (then nothing was recalled). Counts only. */
  rescan?: { skipped: number; unavailable: boolean };
}

/** The raw map text's identity: the sha256 of its UTF-8 bytes (the same value `repo_context_maps.body_sha256` holds). */
export const mapIdentityOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The entries both memory slots recalled, stable part first (the prompt's order); a ref that is not an entry's `id@vN` is skipped. */
export function recalledEntriesOf(...slots: ReadonlyArray<Pick<RenderedMemory, "recalled"> | undefined>): Array<{ id: string; version: number }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; version: number }> = [];
  for (const slot of slots) {
    for (const r of slot?.recalled ?? []) {
      const m = REF.exec(r.ref);
      if (m === null || seen.has(m[1]!) || Number(m[2]) < 1) continue;
      seen.add(m[1]!);
      out.push({ id: m[1]!, version: Number(m[2]) });
    }
  }
  return out.slice(0, RUN_INPUTS_MAX_ENTRIES);
}

/**
 * Writes the run's inputs on the slot transaction's client. Resolves to whether a row was written. FAILS CLOSED (D#601 C2): an insert that fails
 * throws, so the transaction that takes the build slot rolls back and the caller cancels the run it just started; a run is never left running
 * with a recall the panel and the "used in N runs" count cannot see.
 */
export async function recordRunContextInputs(client: PoolClient, accountId: string, runId: string, inputs: RunContextInputs): Promise<boolean> {
  const rescan = inputs.rescan ?? { skipped: 0, unavailable: false };
  if (inputs.entries.length === 0 && inputs.map === null && rescan.skipped === 0 && !rescan.unavailable) return false;
  await client.query(
    `INSERT INTO run_context_inputs (account_id, run_id, recalled_entry_ids, recalled_entry_versions, map_version, map_sha256, rescan_skipped, rescan_unavailable)
     VALUES ($1::uuid, $2::uuid, $3::uuid[], $4::integer[], $5, $6, $7::integer, $8::boolean) ON CONFLICT (account_id, run_id) DO NOTHING`,
    [accountId, runId, inputs.entries.map((e) => e.id), inputs.entries.map((e) => e.version), inputs.map?.version ?? null, inputs.map?.sha256 ?? null, Math.min(rescan.skipped, 100000), rescan.unavailable],
  );
  return true;
}

/** One of the item's own records a prompt carried (D#601 MEM-8b): an applied correction note or a completed handoff note. Ids and a hash only; no text. */
export interface ItemSourceRecord {
  kind: "correction" | "handoff";
  /** The correction's id, or the `run_events` id of the handoff note. */
  id: string;
  /** The sha256 of the text as it was rendered (cut and marker included). */
  sha256: string;
  cut: boolean;
}

/**
 * Writes what `recordRunContextInputs` does not hold: the item's own records the prompt carried, into `run_context_item_sources` (migration 0880), on the same
 * slot-transaction client and failing closed the same way. Resolves to the number of rows written. The table holds at most 6 rows a run (5 notes and 1 handoff note).
 */
export async function recordRunItemSources(client: PoolClient, accountId: string, runId: string, sources: readonly ItemSourceRecord[]): Promise<number> {
  for (const s of sources) {
    await client.query(
      `INSERT INTO run_context_item_sources (account_id, run_id, source_kind, source_id, content_sha256, cut)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6) ON CONFLICT (account_id, run_id, source_kind, source_id) DO NOTHING`,
      [accountId, runId, s.kind, s.id, s.sha256, s.cut],
    );
  }
  return sources.length;
}
