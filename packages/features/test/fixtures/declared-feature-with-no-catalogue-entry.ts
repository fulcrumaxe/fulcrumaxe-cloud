/**
 * Deliberate-failure fixture (D#8 R2 criterion 2): a declared-keys set
 * that includes one feature key absent from any real catalogue. Used
 * only by test/featureExposure.test.ts to prove
 * findUnclassifiedFeatures() actually catches an unclassified feature --
 * never part of the real declaration set. Same shape as
 * packages/db/test/fixtures/missing-rls.sql and
 * packages/db/test/fixtures/colliding-catalogue-ids.ts: a fixture data
 * file the enforcement test loads, not inline data duplicated across
 * cases.
 */
export const DECLARED_KEYS_WITH_UNCLASSIFIED_FEATURE: readonly string[] = [
  "an_unclassified_feature",
];
