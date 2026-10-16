import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';
import { MemoryInputError, type MemoryCtx } from './index.js';

/**
 * D#601 MEM-3r: "Used in N runs" for memory entries, read from `run_context_inputs` (D#600 CX-8b, migration 0833), the one record of what a
 * run's prompt recalled. Display data, never a gate: retrieval reads `memory_entries`, not this table.
 *
 * An entry's lineage is every row connected through `supersedes_id`, so an edit does not reset the number. The count is the number of runs in
 * the caller's account whose recorded entry ids overlap the lineage's ids (`&&`, which the GIN index of 0833 serves). One row per run, so rows
 * are runs. After the 30 day purge (D#601 C3) the count is recomputed over the surviving rows still connected by a non-null `supersedes_id`; a run
 * that recalled only purged rows drops out, so a count can fall at the purge, never rise, and is never null. A purged or foreign id counts 0.
 */
export const MEMORY_RUN_COUNT_MAX_IDS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A number for every requested id (0 when none, never null), keyed by the id as asked. At most 200 ids per call; more, or a malformed id,
 * is refused as `invalid_message`. Runs in the caller's session: another account's runs and entries are invisible, and an id from another
 * account simply counts 0.
 */
export async function memoryRunCounts(ctx: Pick<MemoryCtx, 'pool' | 'principal'>, entryIds: readonly string[]): Promise<Record<string, number>> {
  if (entryIds.length > MEMORY_RUN_COUNT_MAX_IDS) throw new MemoryInputError('invalid_message', `at most ${MEMORY_RUN_COUNT_MAX_IDS} entries can be counted at once`);
  for (const id of entryIds) if (typeof id !== 'string' || !UUID_RE.test(id)) throw new MemoryInputError('invalid_message', 'unknown memory entry id');
  const asked = [...new Set(entryIds.map((id) => id.toLowerCase()))];
  const out: Record<string, number> = {};
  for (const id of entryIds) out[id] = 0;
  if (asked.length === 0) return out;
  const { accountId, userId } = ctx.principal;
  const rows = await withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    // UNION (not UNION ALL) in both walks: a chain cannot loop, and if a bad row ever made it, the walk still ends.
    return (
      await client.query<{ root: string; n: number }>(
        `WITH RECURSIVE req AS (SELECT DISTINCT unnest($2::uuid[]) AS root),
           up(root, id, sup) AS (
             SELECT r.root, m.id, m.supersedes_id FROM req r JOIN memory_entries m ON m.id = r.root AND m.account_id = $1::uuid
             UNION
             SELECT u.root, m.id, m.supersedes_id FROM up u JOIN memory_entries m ON m.id = u.sup AND m.account_id = $1::uuid
           ),
           down(root, id) AS (
             SELECT r.root, m.id FROM req r JOIN memory_entries m ON m.id = r.root AND m.account_id = $1::uuid
             UNION
             SELECT d.root, m.id FROM down d JOIN memory_entries m ON m.supersedes_id = d.id AND m.account_id = $1::uuid
           ),
           lineage AS (SELECT root, id FROM up UNION SELECT root, id FROM down),
           ids AS (SELECT root, array_agg(DISTINCT id) AS ids FROM lineage GROUP BY root)
         SELECT i.root::text AS root,
                (SELECT count(*) FROM run_context_inputs c WHERE c.account_id = $1::uuid AND c.recalled_entry_ids && i.ids)::int AS n
           FROM ids i`,
        [accountId, asked],
      )
    ).rows;
  });
  const byRoot = new Map(rows.map((r) => [r.root, r.n]));
  for (const id of entryIds) out[id] = byRoot.get(id.toLowerCase()) ?? 0;
  return out;
}
