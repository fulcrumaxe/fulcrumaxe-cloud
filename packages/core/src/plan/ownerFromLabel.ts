import type { PoolClient } from 'pg';
import type { RepoPermission } from '@fx/trust';

/** D#483: moving a proposal's owner because of the product label. The caller has established that the person holds maintain or admin; 0992's definer is the one write. */
export type LabelPermission = 'maintain' | 'admin';

export function isLabelPermission(p: RepoPermission | null | undefined): p is LabelPermission {
  return p === 'maintain' || p === 'admin';
}

/** Moves the issue's proposal to `to` and, for `product`, sends it back to be checked. Answers whether it moved (a missing, decided, started or already-owned proposal changes nothing). Runs as the tenant's own role, not the import role. */
export async function setProposalOwnerFromLabel(client: PoolClient, repoId: string, ghNumber: number, to: 'product' | 'internal_loop', permission: LabelPermission): Promise<boolean> {
  // The same per-issue lock the work item intake takes, so a work item being created cannot slip in between the definer's check and its write.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`work_item_intake:${repoId}:${ghNumber}`]);
  const { rows } = await client.query<{ id: string | null }>('SELECT proposal_owner_from_label($1::uuid, $2::int, $3::text, $4::text) AS id', [repoId, ghNumber, to, permission]);
  const id = rows[0]?.id ?? null;
  if (id === null) return false;
  if (to === 'product') await client.query('SELECT proposal_requeue_verification($1::uuid)', [id]);
  return true;
}
