import type { ReconcileJob } from '../runner.js';

export const MACHINE_PRUNE_JOB = 'machine_prune';
const DEFAULT_BATCH_SIZE = 1000;
/** The three retention functions of migration 1035, each taking only a batch size. A fixed list: nothing here is built from input. */
const PRUNES = ['machine_login_requests_prune', 'machine_usage_prune', 'machine_servers_prune'] as const;

/**
 * MC-1a: clears expired Claude sign-in values, and deletes usage rows older than 400 days and servers deleted more than 400 days ago. Each function runs in
 * batches so no statement holds locks for long; the job stops between batches when its time budget is spent and the next tick carries on. It calls nothing
 * outside the database.
 */
export function createMachinePrune(opts: { batchSize?: number } = {}): ReconcileJob {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return {
    name: MACHINE_PRUNE_JOB,
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

export const machinePrune: ReconcileJob = createMachinePrune();
