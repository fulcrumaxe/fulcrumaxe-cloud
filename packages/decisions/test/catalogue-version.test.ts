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
  version: 7,
  sha256: "6192cc695e2128cb2a2df62ebb44d96b86277f9afa64e9d2636db7863b5e5244",
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

  it("non-vacuity: changing or dropping a starting-work entry changes the hash (S5a-5)", () => {
    const base = fingerprint(CATALOGUE, PRESETS);
    for (const id of ["start_work_small", "start_parent_item", "launch_sub_item", "spend_past_envelope", "start_after_reclassify", "run_extension"]) {
      expect(CATALOGUE.some((e) => e.id === id), id).toBe(true);
      expect(fingerprint(CATALOGUE.filter((e) => e.id !== id), PRESETS), id).not.toBe(base);
      expect(fingerprint(CATALOGUE.map((e) => (e.id === id ? { ...e, defaultDisposition: "act" as const } : e)), PRESETS), id).not.toBe(base);
    }
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
