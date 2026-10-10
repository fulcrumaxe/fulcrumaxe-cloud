import { PlanDataMissingError, loadPlanData } from '@fx/plan-data';
import type { PlanId } from './types.js';

/**
 * The compute split and packaging of each plan. The figures are private and
 * come from the plan data (`loadPlanData()`); only the shapes live here.
 * Starter and Team have flat budgets; Scale's background budget scales with
 * the repo count (`base + per_repo * repos`, capped at a ceiling).
 */
export interface FlatComputeBudget {
  kind: 'flat';
  usdPerMonth: number;
}

export interface ScalingComputeBudget {
  kind: 'scaling';
  baseUsdPerMonth: number;
  perRepoUsdPerMonth: number;
  ceilingUsdPerMonth: number;
}

export type ComputeBudget = FlatComputeBudget | ScalingComputeBudget;

/** The token and tenant per-minute request caps enforced by the API rate limiter. */
export interface ApiRateLimits {
  /** Requests per minute from a single token. */
  perTokenPerMinute: number;
  /** Requests per minute across every token of one account, combined. */
  perTenantPerMinute: number;
}

export interface Plan {
  id: PlanId;
  foreground: FlatComputeBudget;
  background: ComputeBudget;
  /** Repo cap for the plan; `null` means unlimited. */
  repoLimit: number | null;
  alwaysOnSecurityReviewer: boolean;
  /** Queue priority for scheduled/background work. */
  priorityQueue: boolean;
  /** Platform subscription price. */
  priceUsdPerMonth: number;
  /** `accounts.compute_cap_usd_month` value this plan sets on activation. */
  computeCapUsdPerMonth: number;
  apiLimits: ApiRateLimits;
  /** Webhook endpoints an account may hold on this plan. */
  webhookEndpointLimit: number;
  /** Concurrent token-authenticated event streams one account may hold. */
  tokenStreamsPerTenant: number;
  /** Assumed monthly volume for the role-settings cost estimate. */
  monthlyWorkload: { features: number; smalls: number };
}

/** The plan ids the plan data defines, in its order. Throws PlanDataMissingError when the data is unavailable. */
export function planIds(): PlanId[] {
  return Object.keys(loadPlanData().plans) as PlanId[];
}

/** True for a plan id the plan data defines (own-property check). */
export function isPlanId(value: string): value is PlanId {
  return Object.hasOwn(loadPlanData().plans, value);
}

/** The plan with this id. Throws on an id the plan data does not define (never a partial plan). */
export function planFor(plan: PlanId): Plan {
  const data = loadPlanData().plans;
  if (!Object.hasOwn(data, plan)) throw new Error(`unknown plan id: ${String(plan)}`);
  return { id: plan, ...data[plan] };
}

/** Every plan, in the plan data's order. */
export function listPlans(): Plan[] {
  return planIds().map(planFor);
}

/** The one place the API rate limiter reads a plan's request caps from. */
export function apiLimitsFor(plan: PlanId): ApiRateLimits {
  return loadPlanData().plans[plan].apiLimits;
}

/** The one place the webhook-endpoint route reads the per-plan cap from. */
export function webhookEndpointLimitFor(plan: PlanId): number {
  return loadPlanData().plans[plan].webhookEndpointLimit;
}

/**
 * H05 pass/fail 4d: the background budget is `base + per-repo x repos`,
 * capped at the ceiling, recomputed when a repo is added or removed. For a
 * flat plan repoCount has no effect -- this is the one place both shapes
 * are read, so a caller never branches on the budget kind itself.
 */
export function backgroundBudgetUsd(plan: PlanId, repoCount: number): number {
  const budget = loadPlanData().plans[plan].background;
  if (budget.kind === 'flat') {
    return budget.usdPerMonth;
  }
  return Math.min(budget.baseUsdPerMonth + budget.perRepoUsdPerMonth * repoCount, budget.ceilingUsdPerMonth);
}

export function foregroundBudgetUsd(plan: PlanId): number {
  return loadPlanData().plans[plan].foreground.usdPerMonth;
}

/**
 * D#6 R2b criterion 12: the runner tier's limits. The tier is for customers whose agent runs on their own machine; it
 * holds no model spend of ours (their own plan pays for the model), so these cap runners and work, not money.
 */
export interface RunnerLimits {
  maxRunners: number;
  maxConcurrentRunnerJobs: number;
  /** D#6 C43-2b: of those, how many may be heavy. Absent in data that predates it; the claim then allows 1. */
  maxConcurrentHeavyRunnerJobs?: number;
  runsPerDay: number;
  maxRunWallClockMs: number;
  fullClonesPerRepoPerDay: number;
  previews: boolean;
}

export interface RunnerPlan {
  id: 'runner';
  /** Compute for cloud-verified review in our sandbox. */
  foreground: FlatComputeBudget;
  background: FlatComputeBudget;
  limits: RunnerLimits;
  provisional: boolean;
  source: string;
}

/** The value of `accounts.plan` for a runner-tier account (0711 added it to the column's CHECK). */
export const RUNNER_PLAN_ID = 'runner' as const;

/**
 * The runner tier. Throws PlanDataMissingError when the plan data is unavailable or predates the runner tier: a caller
 * answers "unavailable", never a default figure, so a missing figure cannot quietly become a limit of zero or of infinity.
 */
export function runnerPlanFor(): RunnerPlan {
  const runnerPlan = loadPlanData().runnerPlan;
  if (runnerPlan === undefined) throw new PlanDataMissingError('the plan data has no runner plan');
  return { id: RUNNER_PLAN_ID, ...runnerPlan };
}

/** The one place the runner routes and the runner target read their limits from. */
export function runnerLimitsFor(): RunnerLimits {
  return runnerPlanFor().limits;
}
