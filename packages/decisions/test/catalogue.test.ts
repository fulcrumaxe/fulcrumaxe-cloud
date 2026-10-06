import { describe, expect, it } from "vitest";
import { CATALOGUE, CATALOGUE_IDS, getCatalogueEntry } from "../src/catalogue.js";
import type { DecisionClass } from "../src/types.js";

// The "no never-a-dial write-path flag" half of criterion 7 lives entirely
// in test/noNeverDialledFlag.test.ts, so that banned identifier appears as
// a literal string in exactly one file in this package (see that file's
// header comment for why).

const EXPECTED_ENTRY_KEYS = [
  "id",
  "class",
  "defaultDisposition",
  "allowedDispositions",
  "reversal",
  "customerProximity",
  "dataSensitivity",
].sort();

const VALID_CLASSES: readonly DecisionClass[] = [
  "automated_with_monitoring",
  "human_over_the_loop",
  "human_in_the_loop",
];

/** Frozen v1 catalogue (DP1 criterion 1). A change here is deliberate. */
const EXPECTED_V1_IDS = [
  "dependency_patch_bump",
  "external_paid_api_call",
  "nonbreaking_refactor_approach",
  "publish_deprecation_notice",
  "publish_release_artifact",
  "retry_transient_step_failure",
  "test_strategy_choice",
].sort();

describe("criterion 1: catalogue entry shape, frozen v1 list", () => {
  it("found at least one catalogue entry (sanity)", () => {
    expect(CATALOGUE.length).toBeGreaterThan(0);
  });

  it("the v1 catalogue is exactly the frozen id list", () => {
    expect([...CATALOGUE_IDS].sort()).toEqual(EXPECTED_V1_IDS);
  });

  for (const entry of CATALOGUE) {
    it(`${entry.id}: has exactly the shape {id, class, defaultDisposition, allowedDispositions, reversal, customerProximity, dataSensitivity}`, () => {
      expect(Object.keys(entry).sort()).toEqual(EXPECTED_ENTRY_KEYS);
    });

    it(`${entry.id}: class is one of the three DP-OD2 values`, () => {
      expect(VALID_CLASSES).toContain(entry.class);
    });

    it(`${entry.id}: defaultDisposition is one of its own allowedDispositions`, () => {
      expect(entry.allowedDispositions).toContain(entry.defaultDisposition);
    });

    it(`${entry.id}: a not_reversible reversal declaration carries a reason`, () => {
      if (entry.reversal.availability === "not_reversible") {
        expect(typeof entry.reversal.reason).toBe("string");
        expect(entry.reversal.reason.length).toBeGreaterThan(0);
      }
    });
  }

  it("ids are unique", () => {
    const ids = CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getCatalogueEntry", () => {
  it("finds a real entry by id", () => {
    expect(getCatalogueEntry("dependency_patch_bump")?.class).toBe("automated_with_monitoring");
  });

  it("returns undefined for a type absent from the catalogue", () => {
    expect(getCatalogueEntry("not_a_real_decision_type")).toBeUndefined();
  });
});
