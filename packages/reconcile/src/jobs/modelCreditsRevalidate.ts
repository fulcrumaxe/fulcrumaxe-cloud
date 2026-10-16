import { RECONCILE_ROUTE, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';

export const MODEL_CREDITS_REVALIDATE_JOB = 'model_credits_revalidate';
/** Connections re-checked per run (also the number of provider calls a run may make). */
export const MODEL_CREDITS_PER_RUN = 50;

/** Re-checks one connection that is broken for credits; the job needs no answer, because the check writes what it changes itself. The real one is `revalidateCreditsExhausted` from @fx/model-connection. */
export type RevalidateCredits = (accountId: string, connectionId: string) => Promise<unknown>;

export interface ModelCreditsRevalidateDeps {
  /** Null when the job cannot run in this environment (no app_user database or no key-encryption key): it records `not_configured`. */
  revalidate: RevalidateCredits | null;
  reportError: ReportError;
  connectionsPerRun?: number;
}

interface ConnectionRow {
  id: string;
  account_id: string;
}

/**
 * D#483 S5-k2: every 15 minutes, re-validate each model connection that is broken for out-of-credit (`status = 'broken'`, `last_error_code =
 * 'credits_exhausted'`). When the validation call reads `ok` the connection is `ok` again and the items paused as `model_credits_exhausted` start on
 * their own at their next reservation; nobody has to press anything. This is the customer's own model credit: nothing about our platform spend is
 * checked or paused here.
 *
 *  - the listing reads only `(account_id, id)` through platform_ops, never a key column, and only rows broken for credits (a key rejected for any
 *    other reason is the daily health job's and a person's to fix);
 *  - each connection is re-checked strictly after the one before it, ONE validation call each (a read endpoint that names no model and uses no tokens),
 *    so at most one plaintext key is open at a time, and a pass costs no model spend;
 *  - before each connection the job asks its call budget and its deadline, and on either it stops and saves the cursor without an error;
 *  - one connection that cannot be checked is reported with a fixed stage and the run carries on with the next.
 * Cost: nothing when nothing is broken (the listing is one indexed read); otherwise one validation call per broken connection per pass.
 */
export function createModelCreditsRevalidateJob(deps: ModelCreditsRevalidateDeps): ReconcileJob {
  const stage = `reconcile.${MODEL_CREDITS_REVALIDATE_JOB}`;
  const cap = deps.connectionsPerRun ?? MODEL_CREDITS_PER_RUN;

  return {
    name: MODEL_CREDITS_REVALIDATE_JOB,
    maxCalls: cap,
    async run(ctx: JobContext): Promise<JobResult> {
      const revalidate = deps.revalidate;
      if (!revalidate) return { cursor: null, wrapped: false, code: 'not_configured' };

      const { rows } = await ctx.pool.query<ConnectionRow>(
        `SELECT account_id, id
           FROM model_connections
          WHERE status = 'broken' AND last_error_code = 'credits_exhausted'
            AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2::int`,
        [ctx.cursor, cap],
      );

      let done: string | null = ctx.cursor;
      for (const row of rows) {
        if (ctx.signal.aborted || ctx.msLeft() <= 0 || !ctx.calls.take(1)) return { cursor: done, wrapped: false };
        try {
          await revalidate(row.account_id, row.id);
        } catch (err) {
          deps.reportError(err, { stage, route: RECONCILE_ROUTE });
        }
        done = row.id;
        ctx.checkpoint(done);
      }

      return rows.length < cap ? { cursor: null, wrapped: true } : { cursor: done, wrapped: false };
    },
  };
}
