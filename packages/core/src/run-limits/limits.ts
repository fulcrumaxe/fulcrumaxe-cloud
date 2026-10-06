import { loadPlanData } from '@fx/plan-data';

/**
 * D#2 C48 section 2: the ONE place the run-limit defaults, floors and
 * ceilings live. Migration 0651's CHECKs mirror these numbers, and
 * test/unit/run-limits.test.ts fails if the two drift. The per-run USD default is the
 * per-spawn cap, which is private plan data: it is read when asked for (a getter), so
 * with the plan data unavailable reading it throws PlanDataMissingError.
 */
export const RUN_LIMIT_BOUNDS = {
  max_run_minutes: { default: 60, floor: 5, ceiling: 240 },
  max_model_calls: { default: 300, floor: 20, ceiling: 1500 },
  per_run_usd: {
    get default(): number {
      return loadPlanData().caps.perSpawnUsd;
    },
    floor: 1,
    ceiling: 200,
  },
  max_turns: { default: 100, floor: 10, ceiling: 500 },
  // 11 = the CLI's Bash tool can legitimately wait up to 10 minutes.
  silence_minutes: { default: 15, floor: 11, ceiling: 30 },
  max_extensions: { default: 2, floor: 0, ceiling: 4 },
  max_resumes: { default: 2, floor: 0, ceiling: 5 },
} as const;

export type RunLimitKey = keyof typeof RUN_LIMIT_BOUNDS;
export const RUN_LIMIT_KEYS = Object.keys(RUN_LIMIT_BOUNDS) as RunLimitKey[];

/** Every limit but per_run_usd is a whole number. */
export const RUN_LIMIT_INTEGER_KEYS: readonly RunLimitKey[] = RUN_LIMIT_KEYS.filter((k) => k !== 'per_run_usd');

export const AUTO_RESUME_DEFAULT = true;

/** C49: at most this many continuations of one work item, automatic and manual together (H14c-5d). */
export const MAX_CONTINUATIONS_PER_WORK_ITEM = 10;
