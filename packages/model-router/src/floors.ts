import type { ModelId } from './types.js';
import { tierRank } from './types.js';
import { FLOORED_PIN, isAllowlisted, type BackendRef } from './backendAllowlist.js';

/**
 * Roles that never run below Sonnet 5, whatever the table, a customer
 * override, or de-escalation says (Spec H22: "security-reviewer and
 * security-expert never run below Sonnet 5").
 */
export const ROLE_FLOORS: Readonly<Record<string, ModelId>> = {
  'security-reviewer': 'sonnet-5',
  'security-expert': 'sonnet-5',
};

export function floorFor(role: string): ModelId | undefined {
  return ROLE_FLOORS[role];
}

/**
 * A floored role passes only with a ranked Claude tier at or above its floor
 * AND an allowlist entry for (backend, provider, model); an unranked or
 * unlisted model is always false, never undefined (D#221 S4). `target`
 * defaults to the pin (claude-code + anthropic).
 */
export function meetsFloor(role: string, model: string, target: BackendRef = FLOORED_PIN): boolean {
  const floor = floorFor(role);
  if (floor === undefined) return true;
  const rank = tierRank(model as ModelId);
  if (rank < 0 || rank < tierRank(floor)) return false;
  return isAllowlisted({ ...target, model });
}

/**
 * Validates one routing_rows row against its role's floor. Called
 * directly by `saveProposedTable` (proposal.ts) and by the eval bootstrap
 * script (eval/bootstrap.ts), and transitively -- via `validateRoutingRows`
 * in tableSchema.ts -- by `loadLiveRoutingTable` (route.ts) and the zod
 * schema validation of default-table/v1.json. Between them, a
 * floor-violating table can no longer be saved, bootstrapped, or loaded;
 * previously this function was only ever called from test files, so the
 * only thing actually enforcing a floor at runtime was route()'s own
 * clamp (fixed as part of this security review round -- see escalate.ts
 * for the path that used to bypass it entirely).
 */
export function assertRowMeetsFloor(role: string, model: string): void {
  if (!meetsFloor(role, model)) {
    throw new Error(
      `routing table row violates floor: role "${role}" is set to "${model}", but its floor is "${floorFor(role)}"`,
    );
  }
}

export type OverrideResult = { accepted: true; model: ModelId } | { accepted: false; reason: string };

/**
 * A customer can raise any role's model (role_settings.model, H12) but
 * cannot set it below that role's floor. H12's future API route wraps
 * this and turns a rejection into a 422 -- this package has no HTTP
 * surface (H22's file scope), so it returns a plain discriminated result
 * instead of throwing or building a response.
 */
export function applyCustomerOverride(role: string, override: string, target: BackendRef = FLOORED_PIN): OverrideResult {
  const floor = floorFor(role);
  const rank = tierRank(override as ModelId);
  if (floor !== undefined && rank >= 0 && rank < tierRank(floor)) {
    return {
      accepted: false,
      reason: `"${override}" is below the floor ("${floor}") for role "${role}"`,
    };
  }
  if (!meetsFloor(role, override, target)) {
    return {
      accepted: false,
      reason: `"${override}" on ${target.backend}/${target.provider} is not on the allowlist for floored role "${role}"`,
    };
  }
  return { accepted: true, model: override as ModelId };
}
