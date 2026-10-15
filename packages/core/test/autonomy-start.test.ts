import { describe, expect, it } from "vitest";
import { PRESETS } from "@fx/decisions";
import type { PresetName } from "@fx/decisions";
import { START_CATEGORIES, resolveStart } from "../src/autonomy/index.js";
import type { StartCategory, StartInput, StartOwnerProcess, StartProvenance, StartVerification } from "../src/autonomy/index.js";

/** D#483 S5-a (S5a-1, S5a-6): `resolveStart` over category x preset x the hard-rule inputs. */

const BASE: StartInput = {
  preset: "balanced",
  ownerProcess: "product",
  engineLoopRepo: false,
  provenance: "internal",
  verification: "verified",
  category: "small",
  freePreview: false,
  hasWriteInstall: true,
};
const start = (over: Partial<StartInput>) => resolveStart({ ...BASE, ...over });

const PRESET_NAMES = PRESETS.map((p) => p.name);
const OWNERS: StartOwnerProcess[] = ["product", "internal_loop"];
const ENGINE: boolean[] = [false, true];
const PROVENANCE: StartProvenance[] = ["internal", "external"];
const VERIFICATION: StartVerification[] = ["pending", "verified", "partly_verified", "refuted", "not_checked", "check_failed"];
const CATEGORIES: (StartCategory | null)[] = [null, ...START_CATEGORIES];
const BOOL: boolean[] = [false, true];

const DIAL: Record<string, Record<PresetName, string>> = {
  small: { cautious: "ask", balanced: "announce", autonomous: "act" },
  bug: { cautious: "ask", balanced: "announce", autonomous: "act" },
  doc: { cautious: "ask", balanced: "announce", autonomous: "act" },
};

/** The expected outcome, written out independently of the resolver: the rules as a table of cases. */
function expected(i: StartInput): { outcome: string; reason: string } {
  if (i.ownerProcess === "internal_loop") return { outcome: "refused", reason: "owned_by_internal_loop" };
  if (i.engineLoopRepo) return { outcome: "ask", reason: "engine_loop_repo" };
  if (i.provenance === "external") return { outcome: "ask", reason: "external_needs_approval" };
  if (i.verification !== "verified" && i.verification !== "partly_verified") return { outcome: "ask", reason: "not_checked" };
  if (i.category === null || i.category === "question") return { outcome: "ask", reason: "category_unknown" };
  if (i.freePreview) return { outcome: "refused", reason: "free_preview" };
  if (!i.hasWriteInstall) return { outcome: "refused", reason: "no_write_install" };
  if (i.category === "small" || i.category === "bug" || i.category === "doc") return { outcome: DIAL[i.category]![i.preset], reason: "dial" };
  return { outcome: "ask", reason: "parent_first_start" };
}

describe("resolveStart: every cell of category x preset x hard-rule inputs", () => {
  it("gives the expected outcome and reason in every cell", () => {
    let cells = 0;
    for (const preset of PRESET_NAMES) for (const ownerProcess of OWNERS) for (const engineLoopRepo of ENGINE) for (const provenance of PROVENANCE)
      for (const verification of VERIFICATION) for (const category of CATEGORIES) for (const freePreview of BOOL) for (const hasWriteInstall of BOOL) {
        const input: StartInput = { preset, ownerProcess, engineLoopRepo, provenance, verification, category, freePreview, hasWriteInstall };
        const got = resolveStart(input);
        expect({ outcome: got.outcome, reason: got.reason }, JSON.stringify(input)).toEqual(expected(input));
        cells += 1;
      }
    expect(cells).toBe(3 * 2 * 2 * 2 * 6 * 8 * 2 * 2);
  });

  it("no cell with external provenance, an engine-loop repo or an internal_loop owner ever acts or announces", () => {
    for (const preset of PRESET_NAMES) for (const verification of VERIFICATION) for (const category of CATEGORIES) {
      for (const bad of [{ provenance: "external" }, { engineLoopRepo: true }, { ownerProcess: "internal_loop" }] as Partial<StartInput>[]) {
        const got = start({ preset, verification, category, ...bad });
        expect(["act", "announce"], JSON.stringify({ preset, verification, category, bad })).not.toContain(got.outcome);
      }
    }
  });

  it("no feature, project or critical item ever acts or announces, under any preset", () => {
    for (const preset of PRESET_NAMES) for (const category of ["feature", "project", "critical"] as const) {
      const got = start({ preset, category });
      expect(got).toEqual({ outcome: "ask", reason: "parent_first_start", decisionType: "start_parent_item", decisionClass: "human_in_the_loop" });
    }
  });

  it("a small item under Balanced announces and names its catalogue entry and class for the receipt", () => {
    expect(start({ preset: "balanced", category: "small" })).toEqual({
      outcome: "announce",
      reason: "dial",
      decisionType: "start_work_small",
      decisionClass: "human_over_the_loop",
    });
    expect(start({ preset: "autonomous", category: "bug" }).decisionType).toBe("start_work_bug");
    expect(start({ preset: "autonomous", category: "doc" }).decisionType).toBe("start_work_doc");
  });

  it("a hard rule names no catalogue entry", () => {
    expect(start({ provenance: "external" })).toEqual({ outcome: "ask", reason: "external_needs_approval", decisionType: null, decisionClass: null });
  });

  it("is total: an out-of-set preset, provenance, verification or category asks and never throws", () => {
    const wild = (over: Record<string, unknown>) => resolveStart({ ...BASE, ...over } as StartInput);
    expect(wild({ preset: "reckless" }).outcome).toBe("ask");
    expect(wild({ provenance: "trusted-ish" })).toMatchObject({ outcome: "ask", reason: "external_needs_approval" });
    expect(wild({ verification: "looks fine" })).toMatchObject({ outcome: "ask", reason: "not_checked" });
    expect(wild({ category: "urgent" })).toMatchObject({ outcome: "ask", reason: "category_unknown" });
    expect(wild({ ownerProcess: "someone" })).toMatchObject({ outcome: "refused", reason: "owned_by_internal_loop" });
    expect(wild({ engineLoopRepo: undefined })).toMatchObject({ outcome: "ask", reason: "engine_loop_repo" });
    expect(wild({ freePreview: undefined })).toMatchObject({ outcome: "refused", reason: "free_preview" });
    expect(wild({ hasWriteInstall: undefined })).toMatchObject({ outcome: "refused", reason: "no_write_install" });
  });

  it("is pure: the same input gives the same answer and the input is not changed", () => {
    const input = Object.freeze({ ...BASE });
    expect(resolveStart(input)).toEqual(resolveStart(input));
  });
});
