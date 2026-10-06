import { describe, expect, it } from "vitest";
import { ProvenanceError, parseProvenance } from "../src/provenance.js";

describe("parseProvenance (D#103, README rule 4)", () => {
  it("returns 'internal' for the literal 'internal'", () => {
    expect(parseProvenance("internal")).toBe("internal");
  });

  it("returns 'external' for the literal 'external'", () => {
    expect(parseProvenance("external")).toBe("external");
  });

  const invalid: unknown[] = [
    "trusted",
    "INTERNAL",
    "Internal",
    " internal",
    "",
    null,
    undefined,
    1,
    {},
  ];

  for (const value of invalid) {
    it(`throws ProvenanceError for ${JSON.stringify(value)}`, () => {
      expect(() => parseProvenance(value)).toThrow(ProvenanceError);
    });

    it(`never returns 'internal' for ${JSON.stringify(value)}`, () => {
      let result: string | undefined;
      try {
        result = parseProvenance(value);
      } catch {
        result = undefined;
      }
      expect(result).not.toBe("internal");
    });
  }
});
