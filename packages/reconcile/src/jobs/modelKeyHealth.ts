import { RECONCILE_ROUTE, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';

export const MODEL_KEY_HEALTH_JOB = 'model_key_health';
/** Connections checked per run (the spec's budget); also the number of provider calls a run may make. */
export const MODEL_KEYS_PER_RUN = 50;

/**
 * Checks one connection and says nothing about it: the job needs no answer, because what the check changes it writes
 * itself (strike, broken, cleared). The real one is `healthCheck` from @fx/model-connection, bound to its pools, its
 * key-encryption source and its validation client.
 */
export type CheckConnection = (accountId: string, connectionId: string) => Promise<unknown>;

export interface ModelKeyHealthDeps {
  /** Null when the job cannot run in this environment (no app_user database or no key-encryption key): it records `not_configured`. */
  check: CheckConnection | null;
  reportError: ReportError;
  connectionsPerRun?: number;
}

interface ConnectionRow {
  id: string;
  account_id: string;
}

/**
 * Model-key health, every 24 hours (D#454 H2e). Every connection, in id order, 50 per run with a cursor:
 *  - the listing reads only `(account_id, id)` through platform_ops, never a key column;
 *  - each connection is checked strictly after the one before it: its key is opened, ONE validation call is made, and
 *    the answer is written, before the next key is opened. Nothing is prefetched, so at most one plaintext key exists
 *    at a time;
 *  - before each connection the job asks its call budget and its deadline, and on either it stops and saves the
 *    cursor without an error (H2a's rule);
 *  - one connection that cannot be checked (a database error, an unreadable key) is reported with a fixed stage and the
 *    run carries on with the next, so a single bad row never stops the pass from ever getting past it.
 * The strike and broken rules live in `healthCheck`, in the package that owns the table.
 */
export function createModelKeyHealthJob(deps: ModelKeyHealthDeps): ReconcileJob {
  const stage = `reconcile.${MODEL_KEY_HEALTH_JOB}`;
  const cap = deps.connectionsPerRun ?? MODEL_KEYS_PER_RUN;

  return {
    name: MODEL_KEY_HEALTH_JOB,
    maxCalls: cap,
    async run(ctx: JobContext): Promise<JobResult> {
      const check = deps.check;
      if (!check) return { cursor: null, wrapped: false, code: 'not_configured' };

      const { rows } = await ctx.pool.query<ConnectionRow>(
        `SELECT account_id, id
           FROM model_connections
          WHERE ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2::int`,
        [ctx.cursor, cap],
      );

      let done: string | null = ctx.cursor;
      for (const row of rows) {
        if (ctx.signal.aborted || ctx.msLeft() <= 0 || !ctx.calls.take(1)) return { cursor: done, wrapped: false };
        try {
          await check(row.account_id, row.id);
        } catch (err) {
          deps.reportError(err, { stage, route: RECONCILE_ROUTE });
        }
        done = row.id;
        ctx.checkpoint(done);
      }

      // A short batch means the estate ran out: the cursor wrapped.
      return rows.length < cap ? { cursor: null, wrapped: true } : { cursor: done, wrapped: false };
    },
  };
}
