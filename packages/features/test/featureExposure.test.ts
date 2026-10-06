import { describe, expect, it } from "vitest";
import { FIXED_INVARIANT_KEYS } from "@fx/db/src/dialInventory.js";
import {
  classify,
  defineFeature,
  FEATURE_CATALOGUE,
  FEATURE_CATALOGUE_KEYS,
  getCatalogueEntry,
  resolveVersion,
  type ExposureClass,
  type FeatureCatalogueEntry,
} from "../src/featureExposure.js";
import {
  DECLARED_FEATURE_KEYS,
  findGatedSecurityInvariantCollisions,
  findUnclassifiedFeatures,
} from "../src/exposureInventory.js";
import { DECLARED_KEYS_WITH_UNCLASSIFIED_FEATURE } from "./fixtures/declared-feature-with-no-catalogue-entry.js";
import {
  CATALOGUE_WITH_GATED_INVARIANT_COLLISION,
  COLLIDING_INVARIANT_KEY,
} from "./fixtures/gated-security-invariant-collision.js";

const EXPECTED_ENTRY_KEYS = ["key", "class", "securityFloorVersion", "addedIn", "description"].sort();

const VALID_CLASSES: readonly ExposureClass[] = ["silent", "gated", "tier_gated"];

/** Frozen v1 catalogue (criterion 1). See featureExposure.ts's header for why it starts empty. */
const EXPECTED_V1_KEYS: readonly string[] = [];

describe("criterion 1: catalogue entry shape, frozen v1 list", () => {
  it("the v1 catalogue is exactly the frozen (empty) key list", () => {
    expect([...FEATURE_CATALOGUE_KEYS].sort()).toEqual([...EXPECTED_V1_KEYS].sort());
  });

  for (const entry of FEATURE_CATALOGUE) {
    it(`${entry.key}: has exactly the shape {key, class, securityFloorVersion, addedIn, description}`, () => {
      expect(Object.keys(entry).sort()).toEqual(EXPECTED_ENTRY_KEYS);
    });

    it(`${entry.key}: class is one of silent | gated | tier_gated`, () => {
      expect(VALID_CLASSES).toContain(entry.class);
    });
  }

  it("defineFeature produces exactly the required shape", () => {
    const entry = defineFeature({
      key: "sanity_check_feature",
      class: "silent",
      addedIn: 1,
      description: "shape sanity check, not part of the real catalogue",
    });
    expect(Object.keys(entry).sort()).toEqual(EXPECTED_ENTRY_KEYS);
    expect(VALID_CLASSES).toContain(entry.class);
  });
});

describe("criterion 2: findUnclassifiedFeatures()", () => {
  it("real tree: DECLARED_FEATURE_KEYS is empty today -- nothing in this repo declares a feature key yet", () => {
    // Explicit today-state assertion (same discipline as
    // declared-classes.test.ts's "carries zero decisionType declarations
    // today"), so the next test's [] is meaningful rather than an
    // accident of two unrelated empty lists.
    expect(DECLARED_FEATURE_KEYS).toEqual([]);
  });

  it("returns [] for the real declaration set against the real catalogue", () => {
    expect(findUnclassifiedFeatures(DECLARED_FEATURE_KEYS, FEATURE_CATALOGUE)).toEqual([]);
  });

  it("returns [] using both defaults (no arguments)", () => {
    expect(findUnclassifiedFeatures()).toEqual([]);
  });

  it("deliberate-failure fixture: a declared key absent from the catalogue is returned, proving the check is not vacuous (criterion 2)", () => {
    const result = findUnclassifiedFeatures(DECLARED_KEYS_WITH_UNCLASSIFIED_FEATURE, FEATURE_CATALOGUE);
    expect(result).toEqual(["an_unclassified_feature"]);
  });
});

describe("criterion 3: a key absent from the catalogue resolves to gated, fail closed", () => {
  const TABLE_CATALOGUE: readonly FeatureCatalogueEntry[] = [
    defineFeature({ key: "known_silent_feature", class: "silent", addedIn: 1, description: "x" }),
    defineFeature({ key: "known_gated_feature", class: "gated", addedIn: 1, description: "x" }),
    defineFeature({ key: "known_tier_gated_feature", class: "tier_gated", addedIn: 1, description: "x" }),
  ];

  it.each([
    ["known_silent_feature", "silent"],
    ["known_gated_feature", "gated"],
    ["known_tier_gated_feature", "tier_gated"],
    ["an_absent_feature_key", "gated"],
  ] as const)("classify(%s) against the table catalogue -> %s", (key, expected) => {
    expect(classify(key, TABLE_CATALOGUE)).toBe(expected);
  });

  it("getCatalogueEntry returns undefined for an absent key (the input classify() falls back on)", () => {
    expect(getCatalogueEntry("an_absent_feature_key", TABLE_CATALOGUE)).toBeUndefined();
  });

  it("does NOT default an absent key to silent", () => {
    expect(classify("an_absent_feature_key", TABLE_CATALOGUE)).not.toBe("silent");
  });

  it("real input: classify() against the real (today: empty) FEATURE_CATALOGUE, using its default parameter, fails closed to gated for any key", () => {
    expect(classify("totally_unknown_key")).toBe("gated");
  });
});

describe("criterion 4: securityFloorVersion and the floor path", () => {
  it("defineFeature defaults securityFloorVersion to addedIn when omitted", () => {
    const entry = defineFeature({ key: "floor_default_feature", class: "gated", addedIn: 3, description: "x" });
    expect(entry.securityFloorVersion).toBe(3);
  });

  it("defineFeature respects an explicit securityFloorVersion", () => {
    const entry = defineFeature({
      key: "floor_explicit_feature",
      class: "gated",
      addedIn: 1,
      securityFloorVersion: 4,
      description: "x",
    });
    expect(entry.securityFloorVersion).toBe(4);
  });

  const FLOOR_CATALOGUE: readonly FeatureCatalogueEntry[] = [
    defineFeature({ key: "pinnable_feature", class: "gated", addedIn: 1, securityFloorVersion: 1, description: "x" }),
  ];

  it("resolveVersion returns the pinned version when it is at or above the floor", () => {
    expect(resolveVersion("pinnable_feature", 1, FLOOR_CATALOGUE)).toBe(1);
    expect(resolveVersion("pinnable_feature", 5, FLOOR_CATALOGUE)).toBe(5);
  });

  it("raising the floor above a pinned version makes resolveVersion return the floor", () => {
    const raisedFloorCatalogue: readonly FeatureCatalogueEntry[] = [
      defineFeature({
        key: "pinnable_feature",
        class: "gated",
        addedIn: 1,
        securityFloorVersion: 7,
        description: "x",
      }),
    ];
    // A customer pinned at version 2, below the newly-raised floor of 7.
    expect(resolveVersion("pinnable_feature", 2, raisedFloorCatalogue)).toBe(7);
  });

  it("a key absent from the catalogue has no floor to apply -- pinnedVersion passes through unchanged", () => {
    expect(resolveVersion("no_such_feature", 2, FLOOR_CATALOGUE)).toBe(2);
  });
});

describe("criterion 5: findGatedSecurityInvariantCollisions()", () => {
  it("returns [] for the real (empty) catalogue against the real invariant list", () => {
    expect(findGatedSecurityInvariantCollisions(FEATURE_CATALOGUE, FIXED_INVARIANT_KEYS)).toEqual([]);
  });

  it("returns [] using both defaults (no arguments)", () => {
    expect(findGatedSecurityInvariantCollisions()).toEqual([]);
  });

  it("no fixed invariant key appears as a gated entry key in the real catalogue (the same check, stated directly)", () => {
    const gatedKeys = new Set(FEATURE_CATALOGUE.filter((e) => e.class === "gated").map((e) => e.key));
    for (const key of FIXED_INVARIANT_KEYS) {
      expect(gatedKeys.has(key)).toBe(false);
    }
  });

  it("deliberate-failure fixture: a gated entry colliding with a fixed invariant key is caught, proving the check is not vacuous (criterion 5)", () => {
    const collisions = findGatedSecurityInvariantCollisions(
      CATALOGUE_WITH_GATED_INVARIANT_COLLISION,
      FIXED_INVARIANT_KEYS,
    );
    expect(collisions).toEqual([COLLIDING_INVARIANT_KEY]);
  });

  it("a non-gated collision (silent/tier_gated) is not flagged -- only gated collides with an opt-out security control", () => {
    const silentCollision: readonly FeatureCatalogueEntry[] = [
      defineFeature({
        key: COLLIDING_INVARIANT_KEY,
        class: "silent",
        addedIn: 1,
        description: "fixture: same key, silent class -- must not be flagged",
      }),
    ];
    expect(findGatedSecurityInvariantCollisions(silentCollision, FIXED_INVARIANT_KEYS)).toEqual([]);
  });
});
