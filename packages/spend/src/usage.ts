import type { Pool } from 'pg';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { NotFoundError } from '@fx/core/src/tenancy/errors.js';
import { utcMonthStart } from '@fx/core/src/time.js';
import { backgroundBudgetUsd, foregroundBudgetUsd } from './plans.js';
import type { Budget, PlanId } from './types.js';

/** `(ctx:{pool, principal}, input)`, mirroring the other read services. `pool` is the `app_user` pool. */
export interface UsageCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
}

/** D#31 API-7a: one budget's month so far. `spent + reserved` is the total committed; the two never overlap. */
export interface BudgetUsage {
  spent_usd: number;
  reserved_usd: number;
  limit_usd: number;
}

export interface Usage {
  period_start: string;
  model: BudgetUsage;
  foreground_compute: BudgetUsage;
  background_compute: BudgetUsage;
  /**
   * D#6 R2b-5a: what this month's runs on the person's own machine would have cost at API prices. INFORMATION, NEVER SPEND: it is not in
   * `model` or any other budget above, is not reserved, and no cap or refusal reads it.
   */
  own_plan_api_equivalent_usd: number;
}

export interface AccountBudgets {
  plan: PlanId;
  model_usd_month: number;
  foreground_compute_usd_month: number;
  background_compute_usd_month: number;
  compute_cap_usd_month: number;
}

/** The `ledger` column's scale (numeric(10,4)). */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * The account's budgets as stored and as the plan defines them. The model
 * budget and the compute cap are columns (0 is the default, "not set"); the
 * two compute budgets come from the plan data, the background one scaled by the
 * account's repo count.
 */
export async function getBudgets(ctx: UsageCtx): Promise<AccountBudgets> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ plan: PlanId; model: string; cap: string; repos: string }>(
      `SELECT plan, model_budget_usd_month::text AS model, compute_cap_usd_month::text AS cap,
              (SELECT count(*) FROM repos WHERE account_id = $1)::text AS repos
         FROM accounts WHERE id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`account ${accountId} not found`);
    return {
      plan: row.plan,
      model_usd_month: Number(row.model),
      foreground_compute_usd_month: foregroundBudgetUsd(row.plan),
      background_compute_usd_month: backgroundBudgetUsd(row.plan, Number(row.repos)),
      compute_cap_usd_month: Number(row.cap),
    };
  });
}

/**
 * This UTC month's usage per budget. `spent_usd` is the settled ledger sum
 * only and `reserved_usd` is the sum of OPEN reservations only, so settled
 * and released reservations never appear and nothing is counted twice.
 * (`monthToDateUsd` adds the two for spend-cap enforcement; this is the
 * display split of the same total.)
 */
export async function getUsage(ctx: UsageCtx, opts: { now?: Date } = {}): Promise<Usage> {
  const periodStart = utcMonthStart(opts.now ?? new Date());
  const budgets = await getBudgets(ctx);
  const { accountId, userId } = ctx.principal;
  const sums = await withTenant(ctx.pool, accountId, userId, async (client) => {
    const ledger = await client.query<{ budget: Budget; sum: string }>(
      `SELECT budget, SUM(usd)::text AS sum FROM ledger
        WHERE account_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY budget`,
      [accountId, periodStart, new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1))],
    );
    const open = await client.query<{ budget: Budget; sum: string }>(
      `SELECT budget, SUM(usd_reserved)::text AS sum FROM spend_reservations
        WHERE account_id = $1 AND state = 'open' GROUP BY budget`,
      [accountId],
    );
    const pick = (rows: { budget: Budget; sum: string }[], b: Budget): number =>
      Number(rows.find((r) => r.budget === b)?.sum ?? 0);
    const ownPlan = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(api_equivalent_usd), 0)::text AS sum FROM runner_run_usage
        WHERE account_id = $1 AND recorded_at >= $2 AND recorded_at < $3`,
      [accountId, periodStart, new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1))],
    );
    const ownPlanUsd = Number(ownPlan.rows[0]?.sum ?? 0);
    return { at: (b: Budget) => ({ spent: pick(ledger.rows, b), reserved: pick(open.rows, b) }), ownPlanUsd };
  });
  const usage = (b: Budget, limit: number): BudgetUsage => ({
    spent_usd: round4(sums.at(b).spent),
    reserved_usd: round4(sums.at(b).reserved),
    limit_usd: round4(limit),
  });
  return {
    period_start: periodStart.toISOString(),
    model: usage('model', budgets.model_usd_month),
    foreground_compute: usage('foreground_compute', budgets.foreground_compute_usd_month),
    background_compute: usage('background_compute', budgets.background_compute_usd_month),
    own_plan_api_equivalent_usd: round4(sums.ownPlanUsd),
  };
}
