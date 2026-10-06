import type { ReconcileJob } from '../runner.js';

/** Error classes are kept 30 days. */
export const ERROR_EVENTS_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 5000;

/**
 * Deletes error_events rows whose last occurrence is more than the retention window ago, and nothing newer. Rows go in
 * batches so one statement never holds a lock for long; the job stops between batches when its time budget is spent
 * and the next tick carries on. It calls nothing outside the database, so it has no call budget.
 *
 * The table itself (and the platform_ops DELETE grant) comes from the error-visibility migration, not from here.
 */
export function createErrorEventsPrune(opts: { retentionDays?: number; batchSize?: number } = {}): ReconcileJob {
  const retentionDays = opts.retentionDays ?? ERROR_EVENTS_RETENTION_DAYS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return {
    name: 'error_events_prune',
    maxCalls: 0,
    async run(ctx) {
      for (;;) {
        if (ctx.msLeft() <= 0) return { cursor: null, wrapped: false };
        const deleted = await ctx.pool.query(
          `DELETE FROM error_events
            WHERE ctid IN (SELECT ctid FROM error_events
                            WHERE last_seen_at < now() - make_interval(days => $1::int)
                            LIMIT $2::int)`,
          [retentionDays, batchSize],
        );
        if ((deleted.rowCount ?? 0) < batchSize) return { cursor: null, wrapped: true };
      }
    },
  };
}

export const errorEventsPrune: ReconcileJob = createErrorEventsPrune();
