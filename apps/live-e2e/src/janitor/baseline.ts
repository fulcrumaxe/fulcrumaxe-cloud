/**
 * The declared baseline of the machine accounts (4d, CA2) as plain data, so `plan` can list it without loading the
 * janitor. Starting values, tuned to measured cost. Every figure only LOWERS spend; the janitor never raises a value.
 */
import { CHEAPEST_MODEL, FLOOR_MODEL, FLOORED_ROLES, MONTHLY_MODEL_CEILING_USD } from "../needs-network.js";

/** The run-limit baseline, each value clamped up to the product's own floor when it is written. */
export const BASELINE_LIMITS = { per_run_usd: 3, max_model_calls: 60, max_run_minutes: 20, max_extensions: 0, max_resumes: 0 } as const;
export type LimitKey = keyof typeof BASELINE_LIMITS;
export const LIMIT_KEYS = Object.keys(BASELINE_LIMITS) as LimitKey[];
/** The monthly model budget the janitor writes; it is the same figure `caps-set` accepts as the ceiling. */
export const BASELINE_MONTHLY_USD = MONTHLY_MODEL_CEILING_USD;

export interface AccountBaseline {
  limits: Record<LimitKey, number>;
  model_usd_month: number;
  role_model: string;
  floored_roles: string[];
  floor_model: string;
}

export function accountBaseline(): AccountBaseline {
  return { limits: { ...BASELINE_LIMITS }, model_usd_month: BASELINE_MONTHLY_USD, role_model: CHEAPEST_MODEL, floored_roles: [...FLOORED_ROLES], floor_model: FLOOR_MODEL };
}
