import { describe, expect, it } from "vitest";
import { gateCategory } from "../src/autoStartSweep.js";

/** D#483 S5-b1a-3: which category the auto-start gate reads. The verifier's counts only for an internal proposal that names a verified run. */
const row = (o: Partial<Parameters<typeof gateCategory>[0]> = {}) => ({ provenance: "internal", verified_run_id: "run", verifier_category: "small", category_hint: null, ...o });

describe("gateCategory", () => {
  it("reads the verifier's category for an internal, verified proposal, ahead of the hint", () => {
    expect(gateCategory(row())).toBe("small");
    expect(gateCategory(row({ verifier_category: "feature", category_hint: "small" }))).toBe("feature");
  });
  it("never reads it for an external proposal", () => {
    expect(gateCategory(row({ provenance: "external" }))).toBeNull();
    expect(gateCategory(row({ provenance: "external", category_hint: "doc" }))).toBe("doc");
  });
  it("never reads it without a named run", () => {
    expect(gateCategory(row({ verified_run_id: null }))).toBeNull();
  });
  it("falls back to the hint when the verifier gave none", () => {
    expect(gateCategory(row({ verifier_category: null, category_hint: "bug" }))).toBe("bug");
    expect(gateCategory(row({ verifier_category: null }))).toBeNull();
  });
});
