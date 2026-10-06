import type { PoolClient } from "pg";

/**
 * The one provenance-chain query (D#31 API-6b-3, moved out of
 * `@fx/discussions`' `effectiveProvenance`). It walks a work item's
 * `parent_id` chain to the root and returns every row it can see, with the
 * GitHub coordinates of the item's repo. Two callers read it: the effective
 * provenance rule (D#71 C7 R2) and the retry author check.
 *
 * The walk is one recursive query. It uses UNION (not UNION ALL) so a cycle
 * terminates. Run it on the caller's transaction client: RLS scopes
 * `work_items` and `repos` to the tenant, and the composite FK keeps a chain
 * inside one account. A parent row that cannot be seen is simply absent, so
 * the walk stops short of a root.
 */
export interface ProvenanceChainItem {
  id: string;
  parentId: string | null;
  provenance: string;
  kind: string | null;
  repoId: string | null;
  /** Null when the item has no GitHub number, or it is not a safe positive integer. */
  ghNumber: number | null;
  ghOwner: string | null;
  ghName: string | null;
}

interface Row {
  id: string;
  parent_id: string | null;
  provenance: string;
  kind: string | null;
  repo_id: string | null;
  gh_number: string | null;
  gh_owner: string | null;
  gh_name: string | null;
}

export async function readProvenanceChain(client: PoolClient, workItemId: string): Promise<ProvenanceChainItem[]> {
  const { rows } = await client.query<Row>(
    `WITH RECURSIVE chain(id, account_id, parent_id, provenance, kind, repo_id, gh_number) AS (
       SELECT w.id, w.account_id, w.parent_id, w.provenance, w.kind, w.repo_id, w.gh_number FROM work_items w WHERE w.id = $1
       UNION
       SELECT w.id, w.account_id, w.parent_id, w.provenance, w.kind, w.repo_id, w.gh_number
         FROM chain c JOIN work_items w ON w.id = c.parent_id
     )
     SELECT c.id, c.parent_id, c.provenance, c.kind, c.repo_id, c.gh_number::text AS gh_number, r.gh_owner, r.gh_name
       FROM chain c LEFT JOIN repos r ON r.account_id = c.account_id AND r.id = c.repo_id`,
    [workItemId],
  );
  return rows.map((r) => {
    const n = r.gh_number === null ? null : Number(r.gh_number);
    return {
      id: r.id,
      parentId: r.parent_id,
      provenance: r.provenance,
      kind: r.kind,
      repoId: r.repo_id,
      ghNumber: n !== null && Number.isSafeInteger(n) && n > 0 ? n : null,
      ghOwner: r.gh_owner,
      ghName: r.gh_name,
    };
  });
}

/** True when the walk reached a real root: false for a cycle, a missing parent row, or an empty chain. */
export function reachesRoot(chain: readonly ProvenanceChainItem[]): boolean {
  return chain.some((i) => i.parentId === null);
}

/** A chain is effectively internal only when it is non-empty, every row is exactly `'internal'`, and the walk reached a real root. */
export function isEffectivelyInternal(chain: readonly ProvenanceChainItem[]): boolean {
  return chain.length > 0 && chain.every((i) => i.provenance === "internal") && reachesRoot(chain);
}
