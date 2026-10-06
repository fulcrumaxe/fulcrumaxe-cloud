import type { RoleManifestEntry, RoleMode } from '@fx/roles';
import { loadPlanData } from '@fx/plan-data';
import { ROLE_MODEL_IDS, type RoleModelId } from './types.js';

/**
 * Seed data for the role-settings cost estimate. The figures are private:
 * the median cost of one run by model tier and each plan's assumed monthly
 * workload come from the plan data (`loadPlanData()`, the FX_PLAN_DATA
 * setting), never from this file. They only make the formula produce a
 * plausible number before a tenant's own ledger medians replace them (see
 * list.ts), so they are not exact. Each reader is a function, so a missing
 * setting is the "unavailable" state (PlanDataMissingError) at the call
 * rather than a crash at import (D#536).
 */
export const MEDIAN_COST_SEED_USD_PROVISIONAL = true;

export type SeedTier = 'haiku' | 'sonnet' | 'opus';

/** The seed median cost of one run, by model tier. */
export function medianCostSeedUsd(defaultModel: RoleManifestEntry['defaultModel']): number {
  return loadPlanData().medianCostPerRunSeedUsd[defaultModel];
}

/** The manifest's seed tier for each of the three model ids a role can run on. */
const SEED_TIER_BY_MODEL_ID: Record<RoleModelId, SeedTier> = {
  'haiku-4.5': 'haiku',
  'sonnet-5': 'sonnet',
  'opus-5': 'opus',
};

export function seedTierForModelId(model: RoleModelId): SeedTier {
  return SEED_TIER_BY_MODEL_ID[model];
}

export function modelIdForSeedTier(tier: RoleManifestEntry['defaultModel']): RoleModelId {
  return ROLE_MODEL_IDS.find((id) => SEED_TIER_BY_MODEL_ID[id] === tier)!;
}

/**
 * The model a role really runs on: its stored override, else what the
 * routing table gives it (`routed`), and never below its floor. A stored
 * value that is not one of the three ids (the column is a CHECK-guarded
 * text, but is returned as stored) counts as no override.
 */
export function effectiveModelId(
  override: string | null | undefined,
  routed: RoleModelId,
  floor: RoleModelId | undefined,
): RoleModelId {
  let model: RoleModelId = (ROLE_MODEL_IDS as readonly string[]).includes(override ?? '') ? (override as RoleModelId) : routed;
  if (floor !== undefined && ROLE_MODEL_IDS.indexOf(model) < ROLE_MODEL_IDS.indexOf(floor)) model = floor;
  return model;
}

export type PlanTier = 'starter' | 'team' | 'scale';

/**
 * A plan's assumed monthly Feature and Small counts, from the plan data.
 * Only these counts are used here; the background-compute budget is the
 * spend package's territory, not this cost line, and role_settings is
 * scoped to a single repo_id regardless of how many repos the account has.
 */
export function tierMonthlyWorkload(plan: PlanTier): { features: number; smalls: number } {
  return loadPlanData().plans[plan].monthlyWorkload;
}

/** `accounts.plan` is unconstrained text (sec-criteria A8: H10 owns that vocabulary). An unrecognized value falls back to 'starter' rather than throwing -- this is a display estimate, not an authorization decision. */
export function normalizePlanTier(rawPlan: string | null | undefined): PlanTier {
  return rawPlan === 'team' || rawPlan === 'scale' ? rawPlan : 'starter';
}

/** One H16 tick per repo per week, independent of tier -- schedule-driven, not usage-driven. */
export const WEEKLY_RUNS_PER_MONTH = 30 / 7;

/**
 * H12 criterion 2's "runs per month for the chosen mode." `off` is
 * always 0 (criterion 4: a role in `off` never starts, so it never
 * spends). `weekly` is the fixed schedule rate above. `feature_critical`
 * only fires on Feature/Critical work, so it uses the tier's Features
 * count; `always` fires on every qualifying work item, Features and
 * Smalls both.
 */
export function runsPerMonthSeed(mode: RoleMode, plan: PlanTier): number {
  switch (mode) {
    case 'off':
      return 0;
    case 'weekly':
      return WEEKLY_RUNS_PER_MONTH;
    case 'feature_critical':
      return tierMonthlyWorkload(plan).features;
    case 'always': {
      const workload = tierMonthlyWorkload(plan);
      return workload.features + workload.smalls;
    }
    default:
      return 0;
  }
}

/** H12 criterion 2's exact required wire format. */
export function formatCostLine(monthlyUsd: number): string {
  return `expected spend on your model bill: $${monthlyUsd.toFixed(2)}/month`;
}

/**
 * H12 criterion 2: the line carries a token-coverage caveat as a tooltip.
 * Delivered as data (D#31 re-brief: the UI that renders a tooltip is
 * WS-F4, not this service). The text states no run statistics.
 */
export const TOKEN_COVERAGE_CAVEAT =
  'This is an estimate based on the selected model. Not every run carried full token counts when it was seeded, so it may read low.';

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
