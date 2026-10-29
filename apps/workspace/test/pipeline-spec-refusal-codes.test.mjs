// D#483: every code the short-Spec step (packages/pipeline/src/advance/lightSpec.ts) can refuse with has a fixed card sentence AND a telemetry allowlist entry.
// The codes are read from that source (its own literals plus the reasons of the body assembler it calls), so a new code added there without both fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_REFUSED_SENTENCES } from "../apps/pipeline/pipeline-insight.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "pipeline", "src");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
// The other two lists are read as text too: apps/workspace declares no dependency on @fx/core or @fx/telemetry.
const PACKAGES = join(SRC, "..", "..");
const quoted = (file, start) => {
  const text = readFileSync(join(PACKAGES, file), "utf8");
  const at = text.indexOf(start);
  const body = text.slice(at, text.indexOf("\n]", at));
  return at === -1 ? [] : [...body.matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((m) => m[1]);
};
const LIGHT_SPEC_REFUSAL_CODES = quoted("core/src/work-items/activity.ts", "export const LIGHT_SPEC_REFUSAL_CODES");
const OWN_ERROR_CODES = quoted("telemetry/src/errorCodes.ts", "export const OWN_ERROR_CODES");

function refusalCodesInSource() {
  const own = [...read("advance/lightSpec.ts").matchAll(/status: "refused", reason: "([a-z_]+)"/g)].map((m) => m[1]);
  const assemblerType = /export type SpecBody = [^\n]*/.exec(read("plan/spec.ts"))?.[0] ?? "";
  const assembler = [...(/ok: false; reason: ([^}]*)\}/.exec(assemblerType)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  return [...new Set([...own, ...assembler])].sort();
}

describe("short-Spec refusal codes: a new code needs a card sentence and a telemetry entry", () => {
  const found = refusalCodesInSource();

  it("reads both lists it checks against (so a moved list cannot make the checks vacuous)", () => {
    expect(LIGHT_SPEC_REFUSAL_CODES.length).toBeGreaterThanOrEqual(9);
    expect(OWN_ERROR_CODES.length).toBeGreaterThan(50);
  });
  it("finds the codes it should, so the scan itself cannot go quiet", () => {
    expect(found).toEqual(expect.arrayContaining(["invalid_spec_output", "invalid_file_scope", "invalid_planned_prs", "planned_prs_too_large", "planned_split_missing", "planned_split_unflagged", "item_halted", "spec_too_large"]));
  });
  it("every code in the source is in the shared list, has a card sentence and is an OWN_ERROR_CODES entry", () => {
    for (const code of found) {
      expect(LIGHT_SPEC_REFUSAL_CODES, `${code} missing from LIGHT_SPEC_REFUSAL_CODES`).toContain(code);
      expect(Object.hasOwn(SPEC_REFUSED_SENTENCES, code), `${code} has no card sentence`).toBe(true);
      expect(OWN_ERROR_CODES, `${code} missing from OWN_ERROR_CODES`).toContain(code);
    }
  });
  it("every listed code (including the publish_failed fallback) has a sentence and a telemetry entry, and nothing extra has a sentence", () => {
    for (const code of LIGHT_SPEC_REFUSAL_CODES) {
      expect(Object.hasOwn(SPEC_REFUSED_SENTENCES, code), code).toBe(true);
      expect(OWN_ERROR_CODES, code).toContain(code);
    }
    expect(Object.keys(SPEC_REFUSED_SENTENCES).sort()).toEqual([...LIGHT_SPEC_REFUSAL_CODES].sort());
    expect(read("advance/lightSpec.ts")).toContain('"publish_failed"');
  });
});
