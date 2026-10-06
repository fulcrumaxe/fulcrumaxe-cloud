import type { Pool, PoolClient } from 'pg';
import { withTenant } from './pg.js';
import { backgroundBudgetUsd, foregroundBudgetUsd } from './plans.js';
import { defaultFeatureCapUsd, defaultPerSpawnCapUsd, defaultSmallCapUsd } from './caps.js';
import type { Budget, PlanId, Purpose, ReserveResult, Trigger, WorkItemKind } from './types.js';
import { emitBudgetExhaustedOnce } from '@fx/core/src/domain-events/emit.js';
import { utcMonthStart } from '@fx/core/src/time.js';

type ComputeBudget = Extract<Budget, 'foreground_compute' | 'background_compute'>;

export interface ReserveParams {
  accountId: string;
  runId: string;
  workItemId?: string | null;
  workItemKind?: WorkItemKind;
  /** Default 'run'. 'preview' skips the accounts.status gate (H05
   * pass/fail 5) and instead requires an ok model_connections row. */
  purpose?: Purpose;
  /** Which compute budget an estimateComputeUsd > 0 draws on. Required
   * whenever estimateComputeUsd > 0; ignored otherwise. */
  trigger?: Trigger;
  estimateModelUsd?: number;
  estimateComputeUsd?: number;
  plan: PlanId;
  /** Repo count, for Scale's per-repo background shape. Ignored by flat
   * plans and by a foreground-only call. Default 1. */
  repoCount?: number;
  /** The customer's own monthly model budget (set at onboarding, H10/H17).
   * Required whenever estimateModelUsd > 0. */
  monthlyModelBudgetUsd?: number;
  perSpawnCapUsd?: number;
  featureCapUsd?: number;
  smallCapUsd?: number;
  /** Injectable clock for "month-to-date" tests. Defaults to real now(). */
  now?: Date;
}

/** Exported for settle.ts and for tests that want to assert the running
 * total directly, without re-deriving the query. */
export async function monthToDateUsd(
  client: PoolClient,
  accountId: string,
  budget: Budget,
  now: Date = new Date(),
): Promise<number> {
  const ledgerSum = await client.query<{ sum: string }>(
    `SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger
     WHERE account_id = $1 AND budget = $2 AND created_at >= $3`,
    [accountId, budget, utcMonthStart(now)],
  );
  const openSum = await client.query<{ sum: string }>(
    `SELECT COALESCE(SUM(usd_reserved), 0)::text AS sum FROM spend_reservations
     WHERE account_id = $1 AND budget = $2 AND state = 'open'`,
    [accountId, budget],
  );
  // Both queries are COALESCE(SUM(...), 0) aggregates with no GROUP BY,
  // so each always returns exactly one row -- the `!` reflects that, not
  // an assumption. (Non-null assertions added here so this file
  // typechecks cleanly under a stricter noUncheckedIndexedAccess config
  // reached transitively via apps/web -> @fx/billing -> @fx/spend, D#2605
  // H10; no behavior change.)
  return Number(ledgerSum.rows[0]!.sum) + Number(openSum.rows[0]!.sum);
}

/** Model spend already committed (settled ledger, no month filter -- a
 * Feature/Small's cap applies for the item's whole lifetime, not per
 * calendar month) or reserved (open) against one work item. */
export async function workItemCommittedUsd(
  client: PoolClient,
  accountId: string,
  workItemId: string,
): Promise<number> {
  const ledgerSum = await client.query<{ sum: string }>(
    `SELECT COALESCE(SUM(l.usd), 0)::text AS sum
     FROM ledger l JOIN agent_runs r ON r.account_id = l.account_id AND r.id = l.run_id
     WHERE l.account_id = $1 AND l.budget = 'model' AND r.work_item_id = $2`,
    [accountId, workItemId],
  );
  const openSum = await client.query<{ sum: string }>(
    `SELECT COALESCE(SUM(s.usd_reserved), 0)::text AS sum
     FROM spend_reservations s JOIN agent_runs r ON r.account_id = s.account_id AND r.id = s.run_id
     WHERE s.account_id = $1 AND s.budget = 'model' AND s.state = 'open' AND r.work_item_id = $2`,
    [accountId, workItemId],
  );
  // Same reasoning as monthToDateUsd above: both are single-row aggregates.
  return Number(ledgerSum.rows[0]!.sum) + Number(openSum.rows[0]!.sum);
}

/**
 * D#2605 H05 pass/fail 1, 2, 4c, 4d, 5: admits or denies a reservation
 * against every applicable cap in one atomic pass, and if admitted,
 * inserts one `spend_reservations` row per budget the call draws on (up
 * to two: 'model' and whichever single compute budget `trigger` selects
 * -- never both compute budgets, and never a compute reservation without
 * a `trigger`).
 *
 * Concurrency (pass/fail 2): before reading any aggregate this function
 * takes a transaction-scoped Postgres advisory lock
 * (`pg_advisory_xact_lock`) keyed on `(accountId, budget)`, for every
 * budget this call touches, in a fixed (alphabetical) order. That
 * serializes concurrent reserve() calls for the SAME account+budget pair
 * -- exactly the race the Spec's 50-parallel-calls test targets -- while
 * leaving calls against a DIFFERENT account, or a DIFFERENT budget on the
 * same account (pass/fail 4c's independence), free to run concurrently.
 * The lock is released automatically at COMMIT/ROLLBACK; there is no
 * separate unlock call.
 *
 * This is plain TypeScript plus ordinary SQL rather than a stored
 * PL/pgSQL function -- packages/db/migrations/0002_spend_fns.sql adds
 * only schema and a state-machine trigger (A8), not this logic. See that
 * migration's file header and this task's PR/commit history for why.
 */
/**
 * Thrown by `reserveWith` when `client` does not meet the transaction
 * contract documented on `reserveWith` itself -- see that function's own
 * doc comment for exactly what's required and why. Named separately from
 * a plain `Error` so a caller (or a test) can distinguish "this client
 * cannot safely call reserveWith" from any other failure with
 * `instanceof`, rather than matching on message text.
 */
export class ReserveTransactionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReserveTransactionContractError';
  }
}

/**
 * D#31 API-1 criterion 8: the same admission logic as `reserve` (below),
 * but against an already-open `client` rather than opening its own
 * `withTenant` transaction -- so a caller that needs the idempotency
 * key, the reservation and (e.g.) an `agent_runs` insert to commit or
 * roll back together (packages/api/src/idempotency.ts's claim, this
 * call, and the caller's own insert) can run all three on one
 * transaction. `reserve` becomes a thin `withTenant` wrapper around this.
 *
 * Transaction and isolation contract (D#31 fix round 2, CWE-362/667):
 * `client` MUST already be inside an open transaction, at READ COMMITTED
 * isolation -- READ UNCOMMITTED is also accepted, because Postgres runs
 * it as READ COMMITTED (there is no weaker level to worry about). Every
 * other isolation level, including SERIALIZABLE, is refused. All of this
 * is checked, and every failure throws `ReserveTransactionContractError`,
 * before the advisory lock below is ever taken:
 *
 *   - An autocommit `client` (no open transaction) lets the advisory
 *     lock's own implicit transaction release the lock immediately, so
 *     it serializes nothing: every concurrent caller proceeds straight
 *     through to the aggregate read and insert. Detected by taking and
 *     releasing a SAVEPOINT, which Postgres refuses outside a
 *     transaction block.
 *   - REPEATABLE READ takes its snapshot at the transaction's FIRST
 *     statement -- before this call ever acquires the advisory lock --
 *     so every caller the lock unblocks still reads that same, stale,
 *     pre-lock snapshot of the month-to-date total and admits against
 *     it. Detected by reading `current_setting('transaction_isolation')`.
 *   - SERIALIZABLE is refused, not allowed: round 1 of this fix assumed
 *     Postgres's serializable-snapshot checks (SSI) would fail closed on
 *     their own. They don't -- SSI only flags a conflict between two
 *     SERIALIZABLE transactions, so a SERIALIZABLE reserveWith racing
 *     READ COMMITTED reserve() callers is invisible to it. The guard
 *     SELECT that reads the month-to-date total also runs before the
 *     advisory lock is taken, so the SERIALIZABLE side can read a stale
 *     total and admit past the cap concurrently with READ COMMITTED
 *     callers doing the same. Measured: 25 reserve() (READ COMMITTED)
 *     racing 25 SERIALIZABLE reserveWith against a $100 cap committed
 *     $110 in 8 of 8 runs.
 *
 * None of this makes an admission final on its own: passing this guard
 * only means the call is *eligible* to admit. The admission is valid
 * only if the enclosing (sub)transaction that `client` belongs to goes
 * on to actually COMMIT -- a caller (or an outer transaction someone
 * else later rolls back) that never commits discards the reservation
 * row along with everything else in that transaction, and this function
 * has no way to observe that in advance.
 *
 * `reserve` (below) always calls through `withTenant`, which opens a
 * plain `BEGIN` (READ COMMITTED, Postgres's default) -- so it always
 * satisfies this contract and never throws here.
 */
export async function reserveWith(client: PoolClient, params: ReserveParams): Promise<ReserveResult> {
  try {
    await client.query('SAVEPOINT reserve_with_txn_guard');
    await client.query('RELEASE SAVEPOINT reserve_with_txn_guard');
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === '25P02') {
      throw new ReserveTransactionContractError(
        'reserveWith requires client to already be inside an open, non-aborted transaction, but the current ' +
          'transaction is aborted (SAVEPOINT failed with SQLSTATE 25P02 -- a prior statement on this client ' +
          'already failed). Roll back and open a fresh transaction with BEGIN before calling reserveWith, or ' +
          'call reserve() instead.',
      );
    }
    throw new ReserveTransactionContractError(
      'reserveWith requires client to already be inside an open transaction (SAVEPOINT failed -- ' +
        'this client looks autocommit). Open one with BEGIN before calling reserveWith, or call reserve() instead.',
    );
  }
  const isolationResult = await client.query<{ level: string }>(
    "SELECT current_setting('transaction_isolation') AS level",
  );
  // current_setting() with no FROM clause always yields exactly one row.
  const isolationLevel = isolationResult.rows[0]!.level;
  if (isolationLevel !== 'read committed' && isolationLevel !== 'read uncommitted') {
    throw new ReserveTransactionContractError(
      'reserveWith requires READ COMMITTED (or READ UNCOMMITTED, which Postgres runs as READ COMMITTED) ' +
        `isolation; the current transaction is ${isolationLevel.toUpperCase()}. REPEATABLE READ is refused ` +
        'because its snapshot predates the advisory lock below and can read a stale month-to-date total. ' +
        "SERIALIZABLE is refused because Postgres's serializable-snapshot checks do not flag a conflict with " +
        'a concurrent non-serializable writer, so a SERIALIZABLE caller can overcommit past the cap alongside ' +
        'READ COMMITTED reserve() callers.',
    );
  }

  const purpose: Purpose = params.purpose ?? 'run';
  const estimateModelUsd = params.estimateModelUsd ?? 0;
  const estimateComputeUsd = params.estimateComputeUsd ?? 0;
  const repoCount = params.repoCount ?? 1;
  const perSpawnCapUsd = params.perSpawnCapUsd ?? defaultPerSpawnCapUsd();
  const now = params.now ?? new Date();

  if (estimateComputeUsd > 0 && !params.trigger) {
    throw new Error('reserve: trigger is required when estimateComputeUsd > 0');
  }
  if (estimateModelUsd > 0 && params.monthlyModelBudgetUsd === undefined) {
    throw new Error('reserve: monthlyModelBudgetUsd is required when estimateModelUsd > 0');
  }

  const computeBudget: ComputeBudget | null =
    estimateComputeUsd > 0 ? (params.trigger === 'foreground' ? 'foreground_compute' : 'background_compute') : null;

  // 1. accounts.status gate (pass/fail 5). `accounts` RLS already hides
  // a soft-deleted row entirely, so an absent row denies the same as an
  // explicitly inactive status.
  //
  // D#69 owner decision (7-day payment-failure grace, discussioncomment
  // 18504921): a `past_due` account stays runnable for 7 days from its
  // FIRST failed charge, not zero. Migration 0606's trigger only
  // re-derives `status` on a WRITE to `accounts` -- a row that has sat in
  // `past_due` for over a week keeps reading back as `past_due` until
  // something else writes it, it never ages into `cancelled` on its own
  // (see that migration's own header note). Trusting the stored `status`
  // string alone here would therefore let an eight-day-stale `past_due`
  // account keep spending forever. This reads `past_due_since` alongside
  // `status` and re-checks the 7-day window AT READ TIME, on every call,
  // against the same boundary migration 0606's `compute_account_status`
  // uses (`past_due_since > now() - interval '7 days'`) -- so this cap
  // check is correct whether or not the stored `status` has been
  // refreshed since the grace window closed. Deliberately the smaller of
  // the two options the review offered: re-deriving a whole "runnable"
  // status column would duplicate migration 0606's own derivation logic
  // in a second place; re-checking the one column this function already
  // reads is a two-line change with the same correctness property.
  //
  // Security review fix round 2 (MUST-fix 1, CWE-841/863): this function
  // does NOT separately check owner_paused_at / key_broken_at /
  // platform_hold_at / partner_suspended_at, and it doesn't need to.
  // Migration 0606's derivation priority ranks all four of those markers
  // ABOVE past_due_since, so `status` can only ever read back as
  // 'past_due' when none of them is set -- computed once, in SQL, by
  // accounts_derive_status, so every reader (this function included)
  // agrees without re-deriving it. Before that reorder, a stored
  // 'past_due' said nothing about whether the account was also paused or
  // key-broken, and `withinGracePeriod` alone would have silently
  // admitted through a real pause or a broken key for up to 7 days.
  const accountRows = await client.query<{ status: string; past_due_since: Date | null }>(
    'SELECT status, past_due_since FROM accounts WHERE id = $1',
    [params.accountId],
  );
  const status = accountRows.rows[0]?.status;
  const pastDueSince = accountRows.rows[0]?.past_due_since ?? null;
  const withinGracePeriod =
    status === 'past_due' &&
    pastDueSince !== null &&
    pastDueSince.getTime() > now.getTime() - 7 * 24 * 60 * 60 * 1000;
  if (purpose !== 'preview' && status !== 'active' && !withinGracePeriod) {
    return { decision: 'deny', reason: 'account_not_active' };
  }
  if (purpose === 'preview' && params.modelBrokeredBy !== 'operator_subscription') {
    const conn = await client.query(
      `SELECT 1 FROM model_connections WHERE account_id = $1 AND status = 'ok' LIMIT 1`,
      [params.accountId],
    );
    if (conn.rows.length === 0) {
      return { decision: 'deny', reason: 'model_connection_not_ok' };
    }
  }

  // 2. per-spawn cap -- a plain estimate comparison, no aggregate needed.
  if (estimateModelUsd > perSpawnCapUsd) {
    return { decision: 'deny', reason: 'per_spawn_cap_exceeded' };
  }

  // Lock every budget this call touches, in a fixed order, before
  // reading any aggregate below.
  const budgetsToLock: Budget[] = [];
  if (estimateModelUsd > 0) budgetsToLock.push('model');
  if (computeBudget) budgetsToLock.push(computeBudget);
  for (const budget of [...budgetsToLock].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${params.accountId}:${budget}`,
    ]);
  }

  // 3. work-item (Feature/Small) cap.
  if (estimateModelUsd > 0 && params.workItemId && params.workItemKind) {
    const cap =
      params.workItemKind === 'feature'
        ? params.featureCapUsd ?? defaultFeatureCapUsd()
        : params.smallCapUsd ?? defaultSmallCapUsd();
    const committed = await workItemCommittedUsd(client, params.accountId, params.workItemId);
    if (committed + estimateModelUsd > cap) {
      return { decision: 'deny', reason: 'work_item_cap_exceeded' };
    }
  }

  // 4. monthly model budget.
  if (estimateModelUsd > 0) {
    const committed = await monthToDateUsd(client, params.accountId, 'model', now);
    if (committed + estimateModelUsd > params.monthlyModelBudgetUsd!) {
      // D#31 API-4a criterion 5: at most one `budget.exhausted` event per
      // (account, budget) per calendar month -- see emitBudgetExhaustedOnce's
      // own doc comment for why this needs no extra locking here: the
      // advisory lock above already serializes concurrent denials for this
      // exact (accountId, budget) pair.
      await emitBudgetExhaustedOnce(client, params.accountId, 'model', now);
      return { decision: 'deny', reason: 'model_budget_exceeded' };
    }
  }

  // 5. monthly compute cap -- ONLY the one budget this call draws on
  // (pass/fail 4c's independence: a background call never checks or
  // touches the foreground total, and vice versa).
  if (computeBudget) {
    const capUsd =
      computeBudget === 'foreground_compute'
        ? foregroundBudgetUsd(params.plan)
        : backgroundBudgetUsd(params.plan, repoCount);
    const committed = await monthToDateUsd(client, params.accountId, computeBudget, now);
    if (committed + estimateComputeUsd > capUsd) {
      await emitBudgetExhaustedOnce(client, params.accountId, computeBudget, now);
      return { decision: 'deny', reason: 'compute_cap_exceeded' };
    }
  }

  // All applicable checks passed -- admit, and insert one row per
  // budget drawn on.
  const admitted: { id: string; budget: Budget; usdReserved: number }[] = [];
  if (estimateModelUsd > 0) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
       VALUES ($1, $2, $3, 'open', 'model', $4) RETURNING id`,
      [params.accountId, params.runId, estimateModelUsd, purpose],
    );
    // RETURNING id on a single-row INSERT always yields exactly one row.
    admitted.push({ id: rows[0]!.id, budget: 'model', usdReserved: estimateModelUsd });
  }
  if (computeBudget) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
       VALUES ($1, $2, $3, 'open', $4, $5) RETURNING id`,
      [params.accountId, params.runId, estimateComputeUsd, computeBudget, purpose],
    );
    admitted.push({ id: rows[0]!.id, budget: computeBudget, usdReserved: estimateComputeUsd });
  }

  return { decision: 'admit', reservations: admitted };
}

/** Opens its own `withTenant` transaction, then delegates every decision to `reserveWith`. */
export async function reserve(pool: Pool, params: ReserveParams): Promise<ReserveResult> {
  return withTenant(pool, params.accountId, (client) => reserveWith(client, params));
}

// Declaration-merged here, at the end of the file, so no line above moves (the marketing site cites lines of this file).
export interface ReserveParams {
  /**
   * Set ONLY by the runner for a run on the operator's own subscription (decided there from the operator
   * allow-list, never from a request): the model is not the account's, so a preview needs no ok
   * model_connections row. Callers pass no model estimate with it.
   */
  modelBrokeredBy?: 'operator_subscription';
}
