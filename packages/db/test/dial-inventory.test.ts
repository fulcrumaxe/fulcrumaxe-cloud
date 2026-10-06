import { describe, expect, it } from "vitest";
import { CATALOGUE_IDS } from "@fx/decisions";
import {
  FIXED_INVARIANTS,
  FIXED_INVARIANT_KEYS,
  findDialInvariantCollisions,
} from "../src/dialInventory.js";
import { COLLIDING_CATALOGUE_IDS } from "./fixtures/colliding-catalogue-ids.js";

describe("findDialInvariantCollisions (D#7 DP5 criteria 3-4), shaped like findRlsViolations()", () => {
  it("returns [] for the real catalogue against the real invariant list", () => {
    expect(findDialInvariantCollisions(CATALOGUE_IDS, FIXED_INVARIANT_KEYS)).toEqual([]);
  });

  it("returns [] using both defaults (no arguments)", () => {
    expect(findDialInvariantCollisions()).toEqual([]);
  });

  it("the fixed invariant keys never appear in the real catalogue (the same check, stated directly)", () => {
    for (const key of FIXED_INVARIANT_KEYS) {
      expect(CATALOGUE_IDS).not.toContain(key);
    }
  });

  it("every fixed invariant names a non-empty enforcing layer", () => {
    expect(FIXED_INVARIANTS.length).toBeGreaterThan(0);
    for (const invariant of FIXED_INVARIANTS) {
      expect(invariant.key.length).toBeGreaterThan(0);
      expect(invariant.layer.length).toBeGreaterThan(0);
    }
  });

  it("deliberate-failure fixture: a fixture catalogue containing a colliding key returns that key, proving the check is not vacuous (C3)", () => {
    const collisions = findDialInvariantCollisions(COLLIDING_CATALOGUE_IDS, FIXED_INVARIANT_KEYS);
    expect(collisions).toEqual(["role_permission_grant"]);
  });

  it("deliberate-failure fixture: a catalogue with no invariant keys still returns []", () => {
    expect(findDialInvariantCollisions(["dependency_patch_bump"], FIXED_INVARIANT_KEYS)).toEqual([]);
  });
});
