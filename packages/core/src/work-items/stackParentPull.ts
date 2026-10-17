import type { PoolClient } from 'pg';
import { RUNNER_VERDICT_PR_SQL } from './activity.js';

/**
 * D#598 P3b: what a stacked item's parent has, read from our own rows: the parent's id (the item's `stack_parent_id`) and the number of the
 * pull request the parent's runs recorded, or null when no run of the parent has named one. This is a pointer, never a fact about the pull
 * request: whether it is open, merged or at which commit is asked of GitHub when it matters. The same rule the activity view uses for an
 * item's pull request number (a reviewer's dispatch target, a runner's recorded number, then the number an executor's envelope reports),
 * because that is the number a person sees.
 *
 * Run it on a tenant-scoped client (`withTenant`).
 */
export interface StackParentPull {
  parentId: string;
  /** The parent's repository, as the parent's own row says. */
  parentRepoId: string | null;
  prNumber: number | null;
}

export async function readStackParentPull(client: PoolClient, workItemId: string): Promise<StackParentPull | null> {
  const parent = await client.query<{ id: string; repo_id: string | null }>(
    `SELECT p.id, p.repo_id FROM work_items w JOIN work_items p ON p.id = w.stack_parent_id AND p.account_id = w.account_id WHERE w.id = $1`,
    [workItemId],
  );
  if (parent.rows.length === 0) return null;
  const p = parent.rows[0]!;
  const runs = await client.query<{ pr_number: string | null }>(
    `SELECT COALESCE(CASE WHEN role <> 'executor' THEN dispatch_pr_number::text END,
                     ${RUNNER_VERDICT_PR_SQL},
                     CASE WHEN envelope->>'pr_number' ~ '^[0-9]{1,9}$' THEN envelope->>'pr_number' END) AS pr_number
       FROM agent_runs WHERE work_item_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 100`,
    [p.id],
  );
  const hit = runs.rows.find((r) => r.pr_number !== null && Number(r.pr_number) > 0);
  return { parentId: p.id, parentRepoId: p.repo_id, prNumber: hit ? Number(hit.pr_number) : null };
}
