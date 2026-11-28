import type { PoolClient } from 'pg';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { assertRepoIdShape } from './read.js';
import type { AdoptTwinDraftResult } from './twinPaths.js';
import type { RepoTwinCtx } from './twins.js';

/**
 * D#845 ON-27e: "Use my approved plan", refused unless the twin is `ready` or `paused`. The twin's state is read in the same transaction as the copy, so the
 * answer and the write agree; the owner/admin check is the definer's own. A plan is never carried into a twin that is still being made, is held back, or is gone.
 */
export type AdoptTwinPlanResult = AdoptTwinDraftResult | { ok: false; reason: 'twin_not_ready' };

export async function adoptTwinPlanWhenReady(ctx: RepoTwinCtx, twinId: string, setupId: string): Promise<AdoptTwinPlanResult> {
  assertRepoIdShape(twinId);
  assertRepoIdShape(setupId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client: PoolClient) => {
    await assertActiveMembership(client, accountId, userId);
    const own = await client.query<{ state: string }>('SELECT state FROM repo_twins WHERE account_id = $1 AND id = $2', [accountId, twinId]);
    if (!own.rows[0]) throw new NotFoundError(`twins ${twinId} not found`);
    if (own.rows[0].state !== 'ready' && own.rows[0].state !== 'paused') return { ok: false, reason: 'twin_not_ready' };
    const { rows } = await client.query<{ o_result: 'ok' | 'not_found' | 'bad_state' | 'no_draft'; o_draft: string | null }>('SELECT o_result, o_draft FROM twin_adopt_draft($1, $2)', [twinId, setupId]);
    const r = rows[0];
    if (!r || r.o_result === 'not_found') throw new NotFoundError(`twins ${twinId} not found`);
    return r.o_result === 'ok' ? { ok: true, draftId: r.o_draft! } : { ok: false, reason: r.o_result };
  });
}
