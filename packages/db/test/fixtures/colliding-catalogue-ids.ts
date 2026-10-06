/**
 * Deliberate-failure fixture (D#7 DP5 criterion 4): a set of catalogue ids
 * that includes one colliding with a fixed invariant key
 * ("role_permission_grant", enforced by gh-policy's static
 * ROLE_PERMISSIONS table -- see ../../src/dialInventory.ts). Used only by
 * test/dial-inventory.test.ts to prove that findDialInvariantCollisions()
 * actually catches a collision -- never part of the real catalogue. Same
 * shape as fixtures/missing-rls.sql: a fixture data file the enforcement
 * test loads, not inline data duplicated across cases.
 */
export const COLLIDING_CATALOGUE_IDS: readonly string[] = [
  "dependency_patch_bump",
  "retry_transient_step_failure",
  "role_permission_grant",
];
