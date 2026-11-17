import type { ReconcileJob } from '../runner.js';

export const ONBOARDING_PRUNE_JOB = 'onboarding_prune';
const DEFAULT_BATCH_SIZE = 1000;
/** The two retention functions of migration 1036, each taking only a batch size. A fixed list: nothing here is built from input. */
const PRUNES = ['runner_device_codes_prune', 'project_drafts_prune'] as const;

/**
 * MC-1b: deletes device codes 24 hours after they expired and plan drafts 30 days after they became final. Each function runs in batches so no statement
 * holds locks for long; the job stops between batches when its time budget is spent and the next tick carries on. It calls nothing outside the database.
 */
export function createOnboardingPrune(opts: { batchSize?: number } = {}): ReconcileJob {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return {
    name: ONBOARDING_PRUNE_JOB,
    maxCalls: 0,
    async run(ctx) {
      for (const fn of PRUNES) {
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

export const onboardingPrune: ReconcileJob = createOnboardingPrune();
