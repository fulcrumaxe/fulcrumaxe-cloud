import type { ReconcileJob } from '../runner.js';

export const MEMORY_SWEEP_JOB = 'memory_sweep';
const DEFAULT_BATCH_SIZE = 500;

/**
 * The three sweeps, in the order they run. Each is a database function of migration 0900 that takes only a batch size: the time rules
 * (14-day proposal expiry, retirement after 90 days unused, purge 30 days after a delete) live in the database, not here, so this login can
 * make a sweep run sooner and nothing else.
 */
export const MEMORY_SWEEPS = ['memory_sweep_expire', 'memory_sweep_retire', 'memory_sweep_purge'] as const;
export type MemorySweep = (typeof MEMORY_SWEEPS)[number];

/**
 * D#601 MEM-4b1: moves memory entries on as time passes (proposals expire, unused entries retire, deleted entries are purged), each step
 * writing its audit row in the database. Seeded at a 24-hour interval and NOT one of the gated 15-minute jobs, so it never leaves a due time or
 * a marker behind: it runs on a reconcile tick that connects anyway, and an idle deployment stays asleep. Each sweep goes in batches so no
 * statement holds row locks for long; the job stops between batches when its time budget is spent and the next tick carries on (the cursor
 * names the sweep it was on). It calls nothing outside the database.
 */
export function createMemorySweep(opts: { batchSize?: number } = {}): ReconcileJob {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return {
    name: MEMORY_SWEEP_JOB,
    maxCalls: 0,
    async run(ctx) {
      const start = Math.max(0, MEMORY_SWEEPS.indexOf(ctx.cursor as MemorySweep));
      for (const sweep of MEMORY_SWEEPS.slice(start)) {
        ctx.checkpoint(sweep);
        for (;;) {
          if (ctx.msLeft() <= 0) return { cursor: sweep, wrapped: false };
          // The name comes from the fixed list above, never from the cursor's text.
          const { rows } = await ctx.pool.query<{ n: number }>(`SELECT ${sweep}($1::int) AS n`, [batchSize]);
          if ((rows[0]?.n ?? 0) < batchSize) break;
        }
      }
      return { cursor: null, wrapped: true };
    },
  };
}

export const memorySweep: ReconcileJob = createMemorySweep();
