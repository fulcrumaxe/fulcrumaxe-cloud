import type { Pool } from "pg";
import { enginePlanOffered } from "@fx/billing";
import { engineCoverageRefusal, readEngineCoverage, type EngineCoverage } from "@fx/core/src/onboarding/engineCoverage.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { ApiError } from "./errors.js";

/**
 * D#845 ON-22: the API shape of an engine the plan does not cover. 402 `plan_required` when there is no engine quantity at all (or the plan ended), 402 `engine_quantity` when every
 * unit is in use (with `data: { quantity, live }`), 503 `engine_plan_unavailable` when the plan would have to be bought and cannot be. Fixed copy; null when covered.
 */
export function engineCoverageError(coverage: EngineCoverage): ApiError | null {
  const refusal = engineCoverageRefusal(coverage);
  return refusal ? new ApiError(refusal.status, refusal.code, refusal.message, undefined, refusal.data) : null;
}

/**
 * Reads the account's coverage and throws the refusal when it does not cover one more engine. Placing a repo's engine (ON-7) calls this before it writes the placement, in the
 * request's own tenant connection. Returns the covered coverage otherwise.
 */
export async function requireEngineCoverage(ctx: { pool: Pool; principal: { accountId: string; userId: string } }): Promise<EngineCoverage> {
  const { accountId, userId } = ctx.principal;
  const coverage = await withTenant(ctx.pool, accountId, userId, (client) => readEngineCoverage(client, accountId, enginePlanOffered()));
  const error = engineCoverageError(coverage);
  if (error) throw error;
  return coverage;
}
