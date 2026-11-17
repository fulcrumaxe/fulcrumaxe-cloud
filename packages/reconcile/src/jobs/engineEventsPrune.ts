import type { ReconcileJob } from '../runner.js';

export const ENGINE_EVENTS_PRUNE_JOB = 'engine_events_prune';
const DEFAULT_BATCH_SIZE = 5000;

/**
 * Engine bridge EB-4: deletes engine events received more than 30 days ago (the window is in the database function of migration 1027, which takes only a
 * batch size, so this login can make the prune run sooner and nothing else). EB-7 adds the same for plan snapshots and unfinished plan chunks, 14 days
 * (`engine_plan_prune`, migration 1032), in the same daily job. Rows go in batches so no statement holds locks for long; the job stops
 * between batches when its time budget is spent and the next tick carries on. It calls nothing outside the database.
 */
export function createEngineEventsPrune(opts: { batchSize?: number } = {}): ReconcileJob {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return {
    name: ENGINE_EVENTS_PRUNE_JOB,
    maxCalls: 0,
    async run(ctx) {
      for (const fn of ['engine_events_prune', 'engine_plan_prune'] as const) {
        for (;;) {
          if (ctx.msLeft() <= 0) return { cursor: null, wrapped: false };
          const { rows } = await ctx.pool.query<{ n: number }>(`SELECT ${fn}($1::int) AS n`, [batchSize]);
          if ((rows[0]?.n ?? 0) < batchSize) break;
        }
      }
      return { cursor: null, wrapped: true };
    },
  };
}

export const engineEventsPrune: ReconcileJob = createEngineEventsPrune();
