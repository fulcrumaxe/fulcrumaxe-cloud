import type { PoolClient } from "pg";
import { isEffectivelyInternal, readProvenanceChain } from "@fx/core/src/work-items/provenanceChain.js";

/**
 * Effective provenance (D#71 C7 R2). A work item is `internal` only when
 * its own `provenance` AND the `provenance` of every item up its
 * `parent_id` chain is exactly `'internal'`, and the walk ends at a real
 * root (a row whose `parent_id` is null). Anything else is `external`:
 * that fails closed for an unknown vocabulary value, for a `parent_id`
 * cycle (the walk never reaches a root) and for a parent row that cannot
 * be found (the walk stops short of a root).
 *
 * The walk is the one recursive query in `@fx/core`'s `provenanceChain.ts`,
 * shared with the retry author check. It uses UNION (not UNION ALL) so a
 * cycle terminates. Run it on the caller's transaction client.
 */
export type EffectiveProvenance = "internal" | "external";

export async function effectiveProvenance(client: PoolClient, workItemId: string): Promise<EffectiveProvenance> {
  return isEffectivelyInternal(await readProvenanceChain(client, workItemId)) ? "internal" : "external";
}
