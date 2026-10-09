import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOGUE, CATALOGUE_VERSION } from "../src/catalogue.js";
import { PRESETS } from "../src/presets.js";
import type { CatalogueEntry, Preset } from "../src/types.js";

/** JSON with object keys sorted, so the hash does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(catalogue: readonly CatalogueEntry[], presets: readonly Preset[]): string {
  return createHash("sha256").update(canonicalJson({ catalogue, presets })).digest("hex");
}

/**
 * The pin. Changing CATALOGUE or a preset changes the hash; the fix is to
 * bump CATALOGUE_VERSION and update BOTH values here in the same change, so
 * "we shipped a new dial" is never indistinguishable from "nothing happened".
 */
const PINNED = {
  version: 2,
  sha256: "35d35d3ffa7a3bd9ee6b441cf3d56596497221013ce6c9d725c08a6452f2c0d1",
};

describe("DP3b-7: CATALOGUE_VERSION is pinned to the catalogue and presets", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(CATALOGUE_VERSION)).toBe(true);
    expect(CATALOGUE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("the pinned hash and version match the current catalogue and presets", () => {
    expect({ version: CATALOGUE_VERSION, sha256: fingerprint(CATALOGUE, PRESETS) }).toEqual(PINNED);
  });

  it("non-vacuity: a one-field catalogue change changes the hash", () => {
    const changed = CATALOGUE.map((e, i) =>
      i === 0 ? { ...e, allowedDispositions: [...e.allowedDispositions, "ask" as const] } : e,
    );
    expect(fingerprint(changed, PRESETS)).not.toBe(fingerprint(CATALOGUE, PRESETS));
  });

  it("non-vacuity: a one-field preset change changes the hash", () => {
    const changed = PRESETS.map((p, i) =>
      i === 0 ? { ...p, dispositions: { ...p.dispositions, human_over_the_loop: "act" as const } } : p,
    );
    expect(fingerprint(CATALOGUE, changed)).not.toBe(fingerprint(CATALOGUE, PRESETS));
  });

  it("key order does not change the hash", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});
