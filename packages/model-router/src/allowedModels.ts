import { applyCustomerOverride, floorFor } from './floors.js';
import { backendForRole, type BackendRef } from './backendAllowlist.js';

/**
 * The models a customer may set on one role, in the order of `universe`
 * (weakest first). It asks `applyCustomerOverride` about each id, the same
 * call the role-model PATCH makes, so the floor and the allowlist live in one
 * place. `universe` is the ids the service accepts at all (core's
 * ROLE_MODEL_IDS); it is a parameter because this package cannot import core.
 * `accountContext` is the account's default backend; a floored role ignores it
 * (it is pinned), as the PATCH does.
 */
export function allowedModelsFor(
  role: string,
  accountContext: BackendRef | undefined,
  universe: readonly string[],
): string[] {
  const target = backendForRole(floorFor(role) !== undefined, accountContext);
  return universe.filter((id) => applyCustomerOverride(role, id, target).accepted);
}
