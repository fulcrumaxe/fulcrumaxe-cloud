import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { ImportRunningError } from './persist.js';
import type { PlanReadCtx } from './read.js';

/**
 * D#483 S3-L2a: "Remove imported plan" (the undo of an import).
 *
 * Calls the remove_repo_plan definer (0832), which, in one transaction, deletes the repo's plan_tasks, plan_milestones and
 * plan_imports rows and the proposals that are still `new` or `withdrawn`. Approved and rejected proposals are decisions
 * and stay (their links into the removed plan are cleared), and work items are never touched. The definer takes the same
 * lock as an import start and refuses (`import_running`) while an import is running.
 */
export interface PlanRemoval {
  proposals_removed: number;
  tasks_removed: number;
  milestones_removed: number;
  imports_removed: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function removeRepoPlan(ctx: PlanReadCtx, repoId: string): Promise<PlanRemoval> {
  if (!UUID_RE.test(repoId)) throw new NotFoundError(`repos ${repoId} not found`);
  try {
    return await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
      const { rows } = await client.query<PlanRemoval>('SELECT * FROM remove_repo_plan($1::uuid)', [repoId]);
      return rows[0]!;
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === '55000' && e.message === 'import_running') throw new ImportRunningError();
    if (e.code === '42501') throw new ForbiddenError('not permitted');
    if (e.code === 'P0002') throw new NotFoundError('repo not found');
    throw err;
  }
}
