import { computeComputeUsd, computeModelUsd } from './pricing.js';
import type { Budget, MeterDecision, ModelId, UsageTokens } from './types.js';

/**
 * D#2605 H05 pass/fail 3: "meter(run, usageEvent) converts response usage
 * to USD from a pricing table and returns continue | kill. kill when the
 * run's model spend reaches its per-spawn cap or the customer's budget."
 *
 * Pure and synchronous by design -- this runs once per model-usage event
 * on a run's hot path, and the Spec calls for "unit tests on fixture
 * event streams", not a Postgres round trip per token. The caller (H09's
 * startAgentRun, not built yet) is responsible for tracking
 * `cumulativeUsdSoFar` across a run's events and for fetching
 * `monthToDateUsd` (this account's committed model spend so far this
 * month, from ledger + open reservations, excluding this run's own
 * estimate) before the run starts.
 */
export interface MeterModelParams {
  model: ModelId;
  usage: UsageTokens;
  /** This run's running total before this event. */
  cumulativeUsdSoFar: number;
  perSpawnCapUsd: number;
  /** Account's model spend committed elsewhere this month (not this run). */
  monthToDateUsd: number;
  monthlyBudgetUsd: number;
}

export interface MeterResult {
  usd: number;
  cumulativeUsd: number;
  decision: MeterDecision;
}

export function meter(params: MeterModelParams): MeterResult {
  const usd = computeModelUsd(params.model, params.usage);
  const cumulativeUsd = params.cumulativeUsdSoFar + usd;
  const decision: MeterDecision =
    cumulativeUsd > params.perSpawnCapUsd ||
    params.monthToDateUsd + cumulativeUsd > params.monthlyBudgetUsd
      ? 'kill'
      : 'continue';
  return { usd, cumulativeUsd, decision };
}

/**
 * H05 pass/fail 3: "meterCompute(run, seconds, vcpu, memGb) does the same
 * for the compute cap." `budget` picks which of the two independent
 * compute budgets (foreground/background) this run draws on -- see
 * types.ts's file header. `capUsd` is that specific budget's cap (from
 * plans.ts's backgroundBudgetUsd/foregroundBudgetUsd), never the other
 * one -- mixing them here would silently undo the independence H05's
 * amendment requires.
 */
export interface MeterComputeParams {
  seconds: number;
  vcpu: number;
  memGb: number;
  cumulativeUsdSoFar: number;
  budget: Budget;
  monthToDateUsd: number;
  capUsd: number;
}

export function meterCompute(params: MeterComputeParams): MeterResult {
  const usd = computeComputeUsd(params.seconds, params.vcpu, params.memGb);
  const cumulativeUsd = params.cumulativeUsdSoFar + usd;
  const decision: MeterDecision =
    params.monthToDateUsd + cumulativeUsd > params.capUsd ? 'kill' : 'continue';
  return { usd, cumulativeUsd, decision };
}
