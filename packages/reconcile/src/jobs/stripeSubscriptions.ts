import { RECONCILE_ROUTE, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';

export const STRIPE_SUBSCRIPTIONS_JOB = 'stripe_subscriptions';
/** Customers looked at per run (the spec's budget); also the number of Stripe list calls a run may make. */
export const STRIPE_CUSTOMERS_PER_RUN = 50;
const PAGE_LIMIT = 100;
const CALL_TIMEOUT_MS = 20_000;

/** The fields of a Stripe subscription this job reads itself; the apply step reads the rest. */
export interface FetchedSubscription {
  id: string;
  status: string;
  ended_at: number | null;
}

/**
 * The one Stripe call the job makes. The real `stripe.subscriptions` satisfies it, so tests run the real SDK against
 * a local server. There is no write method here: the job holds a read-only key and cannot ask for one.
 */
export interface SubscriptionsReader<S extends FetchedSubscription> {
  list(
    params: { customer: string; status: 'all'; limit: number; starting_after?: string },
    options?: { timeout?: number },
  ): Promise<{ data: S[]; has_more: boolean }>;
}

export interface ApplyOutcome {
  applied: boolean;
  reason?: string;
  duplicate?: boolean;
}

export interface StripeSubscriptionsDeps<S extends FetchedSubscription> {
  /** Null when STRIPE_RECONCILE_KEY is absent (or not a restricted key): the job records `not_configured` and does nothing. */
  stripe: { subscriptions: SubscriptionsReader<S> } | null;
  /** The apply step exported by @fx/billing's subscriptionSync (the webhook's write path, minus the event dedupe). */
  apply(subscription: S, clock: string): Promise<ApplyOutcome>;
  reportError: ReportError;
  customersPerRun?: number;
}

interface AccountRow {
  id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
}

/** Subscriptions that no longer bill. `canceled` is the only one this job acts on, and only with `ended_at`. */
const ENDED = new Set(['canceled', 'incomplete_expired', 'unpaid']);

type Failure = 'missing' | 'skip' | 'stop';

/** What a failed Stripe call means. Only a positive 404 is "the customer is not there"; anything unsure stops the run. */
function classify(err: unknown): Failure {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (status === 404) return 'missing';
  if (typeof status !== 'number') return 'stop'; // a network error, a timeout
  if (status === 401 || status === 403 || status === 429 || status >= 500) return 'stop';
  return 'skip';
}

/**
 * Stripe subscriptions to account status, every 6 hours (D#454 H2d). For each account with a stripe_customer_id, in
 * account-id order, 50 per run with a cursor:
 *  - read Postgres `now()` BEFORE the fetch and hand it to the apply step as its clock, so a webhook that lands while
 *    the fetch is in flight is never overwritten by this older read (the stale-fetch guard);
 *  - list the customer's subscriptions (`status=all`, following `has_more`) and apply the one on file through the
 *    webhook's own apply step. A customer whose list does not finish inside the call budget is not applied at all:
 *    a half-read list proves nothing;
 *  - change nothing it cannot positively confirm. A missing customer (404), a subscription on file that Stripe does
 *    not list, a `canceled` subscription without `ended_at`, and an unpaid or expired one are reported, not applied.
 *    A network error, a 5xx, a 429 or an auth failure stops the run with its progress saved.
 */
export function createStripeSubscriptionsJob<S extends FetchedSubscription>(deps: StripeSubscriptionsDeps<S>): ReconcileJob {
  const stage = `reconcile.${STRIPE_SUBSCRIPTIONS_JOB}`;
  const cap = deps.customersPerRun ?? STRIPE_CUSTOMERS_PER_RUN;
  const report = (err: unknown, code?: string): void => deps.reportError(err, { stage, route: RECONCILE_ROUTE, ...(code ? { code } : {}) });

  return {
    name: STRIPE_SUBSCRIPTIONS_JOB,
    maxCalls: cap,
    async run(ctx: JobContext): Promise<JobResult> {
      const stripe = deps.stripe;
      if (!stripe) return { cursor: null, wrapped: false, code: 'not_configured' };

      let done: string | null = ctx.cursor;
      const stopped = (): JobResult => ({ cursor: done, wrapped: false, code: 'error' });
      const budget = (): JobResult => ({ cursor: done, wrapped: false });

      const { rows } = await ctx.pool.query<AccountRow>(
        `SELECT id, stripe_customer_id, stripe_subscription_id
           FROM accounts
          WHERE stripe_customer_id IS NOT NULL AND deleted_at IS NULL
            AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2::int`,
        [ctx.cursor, cap],
      );

      for (const row of rows) {
        if (ctx.signal.aborted || ctx.msLeft() <= 0 || !ctx.calls.take(1)) return budget();

        let clock: string;
        const subs: S[] = [];
        try {
          clock = (await ctx.pool.query<{ t: string }>('SELECT now()::text AS t')).rows[0]!.t;
          let after: string | undefined;
          for (;;) {
            const page = await stripe.subscriptions.list(
              { customer: row.stripe_customer_id, status: 'all', limit: PAGE_LIMIT, ...(after ? { starting_after: after } : {}) },
              { timeout: Math.min(CALL_TIMEOUT_MS, Math.max(1, ctx.msLeft())) },
            );
            subs.push(...page.data);
            if (!page.has_more) break;
            if (page.data.length === 0) throw new Error('stripe list claimed more pages and returned none');
            after = page.data[page.data.length - 1]!.id;
            // The next page needs another call. Out of budget: this customer's list is incomplete, so nothing is applied.
            if (!ctx.calls.take(1)) return budget();
          }
        } catch (err) {
          deps.reportError(err, { stage, route: RECONCILE_ROUTE });
          const kind = classify(err);
          if (kind === 'stop') return stopped();
          // 'missing' and 'skip': this customer is left as it is, the next one is still worth reading.
          done = row.id;
          ctx.checkpoint(done);
          continue;
        }

        try {
          const target = pick(row, subs, report);
          if (target) {
            const result = await deps.apply(target, clock);
            if (result.duplicate) report(new Error('a second live subscription sits next to the one on file'));
            else if (!result.applied && result.reason !== 'stale_fetch') report(new Error(`subscription not applied: ${result.reason ?? 'unknown'}`));
          }
        } catch (err) {
          // The database is the likely cause, so more of the same would follow: stop with the progress made.
          deps.reportError(err, { stage, route: RECONCILE_ROUTE });
          return stopped();
        }
        done = row.id;
        ctx.checkpoint(done);
      }

      // A short batch means the estate ran out: the cursor wrapped.
      return rows.length < cap ? { cursor: null, wrapped: true } : { cursor: done, wrapped: false };
    },
  };
}

/** The subscription to apply for an account, or undefined when nothing can be positively confirmed (already reported). */
function pick<S extends FetchedSubscription>(row: AccountRow, subs: S[], report: (err: unknown, code?: string) => void): S | undefined {
  let target: S | undefined;
  if (row.stripe_subscription_id) {
    target = subs.find((s) => s.id === row.stripe_subscription_id);
    if (!target) {
      report(new Error('the subscription on file is not in the customer list'), 'not_found');
      return undefined;
    }
  } else {
    // Nothing on file: only a single live subscription is unambiguous.
    const live = subs.filter((s) => !ENDED.has(s.status));
    if (live.length === 0) return undefined;
    if (live.length > 1) {
      report(new Error('several live subscriptions and none on file'));
      return undefined;
    }
    target = live[0];
  }
  if (target!.status === 'canceled' && (target!.ended_at === null || target!.ended_at === undefined)) {
    report(new Error('canceled without ended_at: not a positive cancellation'));
    return undefined;
  }
  if (target!.status === 'unpaid' || target!.status === 'incomplete_expired') {
    report(new Error(`${target!.status} is not a positive cancellation`));
    return undefined;
  }
  return target;
}
