import type { Pool } from 'pg';
import { backgroundBudgetUsd, foregroundBudgetUsd } from './plans.js';
import { defaultFeatureCapUsd, defaultPerSpawnCapUsd, defaultSmallCapUsd } from './caps.js';
import { creditsExhausted, monthToDateUsd, workItemCommittedUsd, type ReserveParams } from './reserve.js';
import { envelopeAdmits, envelopeRunUsd, itemEnvelopeId } from './envelope.js';
import type { Budget, ReserveResult } from './types.js';

/**
 * D#483 S5-k1b: "would this reservation be admitted right now?", asked WITHOUT reserving anything.
 *
 * The parked-stage sweep asks this for each item whose start a spending limit denied, so that a run row (a keyed `refused_spend` run) is written only
 * when the start is going to succeed. It takes the same parameters as `reserve()` (less the run id, which a read has no use for), makes the same
 * checks in the same order against the same totals, and answers the same `ReserveResult` shape, with `admit` carrying no reservations because none is made.
 *
 * What makes it read-only, and what it leaves out on purpose:
 *  - The transaction is opened READ ONLY, so the database itself refuses any write the body might one day make by accident.
 *  - It takes no advisory lock: it is a picture, not a promise. The start that follows is still decided by `reserve()` under its lock, so an answer that
 *    is stale by the time the start runs costs one more refused attempt and no money.
 *  - It never emits `budget.exhausted` (that is a record of a real reservation being denied); the sweep asking again every 15 minutes must not write one.
 *
 * `reserve()` and this function must stay on one arithmetic: reserve.ts's own checks are the source, this one repeats them without its writes, and
 * packages/spend/test/headroom.test.ts holds the two to the same answer over a matrix of limits (and fails if reserve() gains a check this one lacks,
 * for the checks it can see). Whoever adds a check to `reserveWith` adds it here in the same change (the envelope check, S5-d, is the same function in both).
 */
export type HeadroomParams = Omit<ReserveParams, 'runId'> & { runId?: string | null };

export async function checkHeadroom(pool: Pool, params: HeadroomParams): Promise<ReserveResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', ['app.account_id', params.accountId]);

    const purpose = params.purpose ?? 'run';
    const estimateModelUsd = params.estimateModelUsd ?? 0;
    const estimateComputeUsd = params.estimateComputeUsd ?? 0;
    const repoCount = params.repoCount ?? 1;
    const perSpawnCapUsd = params.perSpawnCapUsd ?? defaultPerSpawnCapUsd();
    const now = params.now ?? new Date();

    if (estimateComputeUsd > 0 && !params.trigger) throw new Error('checkHeadroom: trigger is required when estimateComputeUsd > 0');
    if (estimateModelUsd > 0 && params.monthlyModelBudgetUsd === undefined) throw new Error('checkHeadroom: monthlyModelBudgetUsd is required when estimateModelUsd > 0');

    const computeBudget: Extract<Budget, 'foreground_compute' | 'background_compute'> | null =
      estimateComputeUsd > 0 ? (params.trigger === 'foreground' ? 'foreground_compute' : 'background_compute') : null;

    // 1. The account's status (reserve.ts step 1, with its seven day grace for a past_due account).
    const accountRows = await client.query<{ status: string; past_due_since: Date | null }>('SELECT status, past_due_since FROM accounts WHERE id = $1', [params.accountId]);
    const status = accountRows.rows[0]?.status;
    const pastDueSince = accountRows.rows[0]?.past_due_since ?? null;
    const withinGracePeriod = status === 'past_due' && pastDueSince !== null && pastDueSince.getTime() > now.getTime() - 7 * 24 * 60 * 60 * 1000;
    if (purpose !== 'preview' && status !== 'active' && !withinGracePeriod) return { decision: 'deny', reason: 'account_not_active' };
    if (purpose === 'preview' && params.modelBrokeredBy !== 'operator_subscription') {
      const conn = await client.query(`SELECT 1 FROM model_connections WHERE account_id = $1 AND status = 'ok' LIMIT 1`, [params.accountId]);
      if (conn.rows.length === 0) return { decision: 'deny', reason: 'model_connection_not_ok' };
    }
    // D#483 S5-k2: the same credits check reserve() makes, right after the account check.
    if (purpose !== 'preview' && estimateModelUsd > 0 && (await creditsExhausted(client, params.accountId))) return { decision: 'deny', reason: 'model_credits_exhausted' };

    // 2. The per-run limit.
    if (estimateModelUsd > perSpawnCapUsd) return { decision: 'deny', reason: 'per_spawn_cap_exceeded' };

    // 3. The item's spend envelope (D#483 S5-d), the same check reserve() makes under the envelope's lock; it replaces the work item's own cap.
    const envelopeId = params.workItemId ? await itemEnvelopeId(client, params.accountId, params.workItemId) : null;
    if (envelopeId !== null) {
      // reserve() also refuses a no-model run that has no run id to carry its charge; a read is asked without one, so that corner is reserve()'s alone.
      if (!(await envelopeAdmits(client, params.accountId, envelopeId, envelopeRunUsd(params)))) return { decision: 'deny', reason: 'envelope_exceeded' };
    }

    // 3. The work item's own cap.
    if (envelopeId === null && estimateModelUsd > 0 && params.workItemId && params.workItemKind) {
      const cap = params.workItemKind === 'feature' ? params.featureCapUsd ?? defaultFeatureCapUsd() : params.smallCapUsd ?? defaultSmallCapUsd();
      const committed = await workItemCommittedUsd(client, params.accountId, params.workItemId);
      if (committed + estimateModelUsd > cap) return { decision: 'deny', reason: 'work_item_cap_exceeded' };
    }

    // 4. The monthly model budget.
    if (estimateModelUsd > 0) {
      const committed = await monthToDateUsd(client, params.accountId, 'model', now);
      if (committed + estimateModelUsd > params.monthlyModelBudgetUsd!) return { decision: 'deny', reason: 'model_budget_exceeded' };
    }

    // 5. The monthly compute cap, for the one budget this start draws on.
    if (computeBudget) {
      const capUsd = computeBudget === 'foreground_compute' ? foregroundBudgetUsd(params.plan) : backgroundBudgetUsd(params.plan, repoCount);
      const committed = await monthToDateUsd(client, params.accountId, computeBudget, now);
      if (committed + estimateComputeUsd > capUsd) return { decision: 'deny', reason: 'compute_cap_exceeded' };
    }

    return { decision: 'admit', reservations: [] };
  } finally {
    await client.query('ROLLBACK').catch(() => {
      // Best-effort: nothing was written, and the connection may already be unusable.
    });
    await client.query('RESET app.account_id').catch(() => {
      // Best-effort cleanup.
    });
    client.release();
  }
}
