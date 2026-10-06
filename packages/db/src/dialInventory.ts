import { CATALOGUE_IDS } from "@fx/decisions";

/**
 * `findDialInvariantCollisions()` -- the "empty intersection" guard (D#7
 * DP5, criterion 3), shaped like `findRlsViolations()` in
 * `./rlsInventory.ts`: a pure check function that returns a violation list,
 * never a boolean.
 *
 * Owner decision 2: "'Never a dial' means absence from the catalogue, not a
 * flag on an entry. A flag has a write path." The decision-type catalogue
 * (`@fx/decisions`) and the fixed invariants below must never share a key.
 * A fixed invariant is enforced by a layer the policy engine cannot
 * parameterise -- so if a catalogue key ever named one of these, "never a
 * dial" would stop being true while the prose kept claiming it (D#7
 * security-expert, Round 1: "the test for 'never a dial' is two-part:
 * enforced at a layer the policy cannot parameterise, and no key in the
 * decision catalogue names it").
 *
 * `FIXED_INVARIANTS` is exported as the single source of truth DP10
 * criterion 4 requires: the settings page renders its "this is not a
 * setting" list from this same array, so the page cannot drift from what
 * this guard enforces.
 */

export interface FixedInvariant {
  /** The identifier that must never appear as a catalogue decision-type id. */
  readonly key: string;
  /** Which layer enforces it -- named so a collision's report says why. */
  readonly layer: string;
}

export const FIXED_INVARIANTS: readonly FixedInvariant[] = [
  {
    key: "cross_tenant_row_access",
    layer:
      "packages/db/migrations/0001_core.sql: FORCE ROW LEVEL SECURITY plus composite " +
      "account-scoped foreign keys on every tenant table",
  },
  {
    key: "role_permission_grant",
    layer: "packages/gh-policy/src/rolePermissions.ts: the static ROLE_PERMISSIONS table",
  },
  {
    key: "merge_or_protection_change",
    layer: "packages/gh-policy/src/mergeProtection.ts: isMergeOrProtectionPath (H03 criterion 4)",
  },
  {
    key: "untrusted_work_creation",
    layer: "packages/trust/src/work-gate.ts: canCreateWork",
  },
] as const;

export const FIXED_INVARIANT_KEYS: readonly string[] = FIXED_INVARIANTS.map((invariant) => invariant.key);

/**
 * Returns the catalogue keys that collide with a fixed invariant -- empty
 * for the real catalogue against the real invariant list (criterion 3).
 * Pure: no I/O, no database client, unlike `findRlsViolations()` which
 * needs a live connection -- this only ever compares two in-memory string
 * lists.
 */
export function findDialInvariantCollisions(
  catalogueIds: readonly string[] = CATALOGUE_IDS,
  invariantKeys: readonly string[] = FIXED_INVARIANT_KEYS,
): string[] {
  const invariants = new Set(invariantKeys);
  return catalogueIds.filter((id) => invariants.has(id));
}
