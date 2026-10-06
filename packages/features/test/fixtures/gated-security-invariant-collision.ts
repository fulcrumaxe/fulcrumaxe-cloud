/**
 * Deliberate-failure fixture (D#8 R2 criterion 5): a catalogue containing
 * one `gated` entry whose key collides with a real fixed invariant key
 * (`@fx/db/src/dialInventory.js`'s `FIXED_INVARIANT_KEYS` -- D#7 DP5).
 * Used only by test/featureExposure.test.ts to prove
 * findGatedSecurityInvariantCollisions() actually catches a collision --
 * never part of the real catalogue. Reads the colliding key from
 * FIXED_INVARIANT_KEYS itself, rather than a hand-copied string, so this
 * fixture cannot drift from the real invariant list it is testing
 * against. Same shape as
 * packages/db/test/fixtures/colliding-catalogue-ids.ts.
 */
import { FIXED_INVARIANT_KEYS } from "@fx/db/src/dialInventory.js";
import { defineFeature, type FeatureCatalogueEntry } from "../../src/featureExposure.js";

const COLLIDING_INVARIANT_KEY = FIXED_INVARIANT_KEYS[0]!;

export { COLLIDING_INVARIANT_KEY };

export const CATALOGUE_WITH_GATED_INVARIANT_COLLISION: readonly FeatureCatalogueEntry[] = [
  defineFeature({
    key: COLLIDING_INVARIANT_KEY,
    class: "gated",
    addedIn: 1,
    description: "fixture entry: a gated feature that illegally names a fixed security invariant",
  }),
  defineFeature({
    key: "an_unrelated_gated_feature",
    class: "gated",
    addedIn: 1,
    description: "fixture entry: an ordinary gated feature that does not collide",
  }),
];
