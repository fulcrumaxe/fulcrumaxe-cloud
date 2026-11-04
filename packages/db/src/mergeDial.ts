import type { PoolClient } from 'pg';
import { getCatalogueEntry } from '@fx/decisions';
import { DIAL_DEFAULT_MARKER } from './decisions.js';

/**
 * The dial for `merge_after_reviews` (D#7 DW-R4): whether the merge gate may merge a pull request whose reviews passed. `act` and `announce` let it
 * (the repository's auto-merge role setting must allow too); `ask` leaves the merge to a person. One row per (repo, decision type) in `decision_settings`;
 * no row, or a "use the default" version, is the catalogue's default (`act`), so a repository that never set it behaves exactly as before.
 * Version 0 stands for "no row": the receipt names it.
 */
export const MERGE_DIAL_TYPE = 'merge_after_reviews';

export interface MergeDial {
  disposition: 'act' | 'announce' | 'ask';
  /** The version the receipt names; 0 when the repository has no row and the catalogue default applied. */
  version: number;
}

/**
 * The repo's merge dial, now (`at` absent) or as it stood at `at`: the newest version written at or before that time. A merge that happened by policy
 * is receipted with the dial that decided it, whatever was changed since. A stored value the entry does not allow fails closed to `ask`.
 * `at` may be the database's own timestamp text, which keeps its microseconds (a JS Date does not). `client` must come from `withTenant`.
 */
export async function readMergeDial(client: PoolClient, repoId: string, at?: Date | string | null): Promise<MergeDial> {
  const entry = getCatalogueEntry(MERGE_DIAL_TYPE);
  if (!entry) throw new Error('merge_after_reviews is not in the catalogue');
  const { rows } = await client.query<{ disposition: string; preset: string | null; version: number }>(
    `SELECT disposition, preset, version FROM decision_settings
      WHERE repo_id = $1 AND decision_type = $2 AND ($3::timestamptz IS NULL OR created_at <= $3)
      ORDER BY version DESC LIMIT 1`,
    [repoId, MERGE_DIAL_TYPE, at ?? null],
  );
  const row = rows[0];
  if (row === undefined) return { disposition: entry.defaultDisposition, version: 0 };
  if (row.preset === DIAL_DEFAULT_MARKER) return { disposition: entry.defaultDisposition, version: row.version };
  const stored = row.disposition as MergeDial['disposition'];
  return { disposition: entry.allowedDispositions.includes(stored) ? stored : 'ask', version: row.version };
}
