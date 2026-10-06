import { loadPlanData } from '@fx/plan-data';

/**
 * Model-spend defaults and the fix-round limit. The figures are private and
 * come from the plan data (`loadPlanData()`); each is a function so a missing
 * setting surfaces as PlanDataMissingError at the call, not at import.
 * A caller may still override a default per reserve() call.
 */
export function defaultPerSpawnCapUsd(): number {
  return loadPlanData().caps.perSpawnUsd;
}

export function defaultFeatureCapUsd(): number {
  return loadPlanData().caps.featureUsd;
}

export function defaultSmallCapUsd(): number {
  return loadPlanData().caps.smallUsd;
}

/** How many fix rounds an item gets before a further one is refused. */
export function maxFixRounds(): number {
  return loadPlanData().caps.maxFixRounds;
}

export type FixRoundDecision = 'allow' | 'escalate';

/** H05 pass/fail 4: a fix round past the limit is refused with escalate.
 * Rounds are 1-indexed (the first fix round is round 1). */
export function checkFixRound(roundNumber: number): FixRoundDecision {
  return roundNumber > maxFixRounds() ? 'escalate' : 'allow';
}
