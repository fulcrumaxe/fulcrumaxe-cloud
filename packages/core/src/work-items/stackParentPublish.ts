import type { PoolClient } from 'pg';
import { readStackParentPull, type StackParentPull } from './stackParentPull.js';
import { readPlanePush } from '../repos/planePushRecord.js';

/**
 * Whether a stacked child's parent has a public change that was refused: the parent's newest push row says `refused` AND its repository is still paired.
 * Derived from the current rows on every start, never stamped on the child: a parent whose push is retried (the row leaves `refused`) or whose repository
 * is no longer paired clears it with no step on the child. A parent with no push row (never published, or an unpaired repository) is not refused.
 * Run it on a tenant-scoped client (`withTenant`); the parent id comes from our own rows (`readStackParentPull`), so another account's parent is never read.
 */
export async function parentPublishRefused(client: PoolClient, accountId: string, parentId: string): Promise<boolean> {
  const push = await readPlanePush(client, accountId, parentId);
  if (push === null || push.state !== 'refused') return false;
  const paired = await client.query('SELECT 1 FROM repo_pairing WHERE repo_id = $1 AND account_id = $2', [push.repoId, accountId]);
  return paired.rows.length > 0;
}

/**
 * D#6 STACK-THREE-DEEP: the parent as `readStackParentPull` has it, plus the PUBLIC pull request its push row names (null when it has none). A paired parent's public copy is the one that merges, so how the parent ENDED is asked of it;
 * its private copy is closed unmerged by the sweep, or stays open until the sweep runs. This only chooses which pull request is asked about; it never turns stacking on or off.
 */
export async function readStackParentForRead(client: PoolClient, accountId: string, workItemId: string): Promise<(StackParentPull & { publicPr: { codeRepo: string; number: number } | null }) | null> {
  const parent = await readStackParentPull(client, workItemId);
  if (parent === null) return null;
  const push = await readPlanePush(client, accountId, parent.parentId);
  return { ...parent, publicPr: push !== null && push.prNumber !== null ? { codeRepo: push.codeRepo, number: push.prNumber } : null };
}
