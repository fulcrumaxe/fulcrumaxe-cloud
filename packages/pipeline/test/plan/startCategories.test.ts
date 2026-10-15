import { describe, expect, it } from "vitest";
import { START_CATEGORIES } from "@fx/core/src/autonomy/index.js";
import { TRIAGE_CATEGORIES } from "../../src/plan/categories.js";

// D#483 S5-a: the start resolver (in @fx/core, which cannot import this package) lists the classifier's categories itself.
// This pins the two lists together so a new triage category cannot reach the resolver as an unknown one by accident.
describe("the start resolver's categories are the classifier's categories", () => {
  it("are the same seven values", () => {
    expect([...START_CATEGORIES].sort()).toEqual([...TRIAGE_CATEGORIES].sort());
  });
});
