import { FIXED_INVARIANT_KEYS } from "@fx/db/src/dialInventory.js";
import { FEATURE_CATALOGUE, type FeatureCatalogueEntry } from "./featureExposure.js";

/**
 * The declaration set for criterion 2: every feature key some real part
 * of this codebase actually uses. `@fx/db/src/exposure.ts` (D#8 R1)
 * defines the typed reads/writes over `account_features` but names no
 * concrete `feature_key` itself -- a grep for `featureKey`/`feature_key`
 * across `packages/**\/*.ts` and `apps/**\/*.ts` outside `packages/db`
 * and this package's own tests returns nothing, because R3's resolver
 * and the first call site that would actually use a feature key (D#2
 * H04/H09, per D#8's cross-Spec amendment request 5) have not landed.
 * So, honestly, v1's declaration set is empty -- the same "nothing
 * declares yet" state D#7 DP5's `declared.ts` documents for
 * `packages/roles/src/tools.ts`. When a real consumer exists, it adds
 * its own key here (or this list grows a real scan, the way
 * `packages/roles/test/declared-classes.test.ts` scans `tools.ts` and
 * `cards/*.md` for D#7's declared classes).
 */
export const DECLARED_FEATURE_KEYS: readonly string[] = [];

/**
 * Every declared feature key absent from the catalogue -- shaped like
 * `findRlsViolations()` (`packages/db/src/rlsInventory.ts`) and
 * `findDialInvariantCollisions()` (`packages/db/src/dialInventory.ts`):
 * a pure check function that returns a violation list, never a boolean.
 * Empty is passing. Criterion 2's non-vacuity proof lives in
 * `test/fixtures/declared-feature-with-no-catalogue-entry.ts`, in the
 * same shape as `packages/db/test/fixtures/missing-rls.sql`.
 */
export function findUnclassifiedFeatures(
  declaredKeys: readonly string[] = DECLARED_FEATURE_KEYS,
  catalogue: readonly FeatureCatalogueEntry[] = FEATURE_CATALOGUE,
): string[] {
  const catalogued = new Set(catalogue.map((entry) => entry.key));
  return declaredKeys.filter((key) => !catalogued.has(key));
}

/**
 * Criterion 5: no catalogue entry marked `gated` may name a security
 * invariant. Security controls are opt-*out*, on for everyone by default
 * (D#8 Spec Policy point 2) -- a different code path from `gated`, which
 * is off by default -- and this check is what keeps the two from being
 * confused. Imports `FIXED_INVARIANT_KEYS` from
 * `@fx/db/src/dialInventory.js` (D#7 DP5) rather than copying it: DP10
 * criterion 4 requires a single source of truth, the same discipline
 * `findDialInvariantCollisions` itself follows for the decision
 * catalogue. `@fx/db` has no dependency on `@fx/features` (it depends
 * only on `@fx/decisions` and `pg`), so this import is one-directional
 * and introduces no cycle.
 */
export function findGatedSecurityInvariantCollisions(
  catalogue: readonly FeatureCatalogueEntry[] = FEATURE_CATALOGUE,
  invariantKeys: readonly string[] = FIXED_INVARIANT_KEYS,
): string[] {
  const invariants = new Set(invariantKeys);
  return catalogue.filter((entry) => entry.class === "gated" && invariants.has(entry.key)).map((entry) => entry.key);
}
