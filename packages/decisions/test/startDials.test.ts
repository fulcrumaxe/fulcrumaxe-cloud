import { describe, expect, it } from "vitest";
import { getCatalogueEntry } from "../src/catalogue.js";
import { decide } from "../src/decide.js";
import type { PresetName } from "../src/types.js";

// D#483 S5-a (S5a-6): the starting-work entries resolve per preset through decide().
const request = (type: string) => ({ type, options: ["start", "wait"], proposed: "start", rationale: "r" });
const PRESET_NAMES: readonly PresetName[] = ["cautious", "balanced", "autonomous"];

describe("starting-work catalogue entries", () => {
  it.each(["start_work_small", "start_work_bug", "start_work_doc"])("%s is class 2, reversible before build, and moves with the preset", (id) => {
    const entry = getCatalogueEntry(id);
    expect(entry?.class).toBe("human_over_the_loop");
    expect(entry?.reversal.availability).toBe("reversible_before_build");
    expect(PRESET_NAMES.map((preset) => decide(entry, { preset }, request(id)).disposition)).toEqual(["ask", "announce", "act"]);
  });

  it.each(["start_work_small", "start_work_bug", "start_work_doc", "launch_sub_item"])("%s has no default beyond ask: with no dial row the person approves", (id) => {
    const entry = getCatalogueEntry(id);
    expect(entry?.defaultDisposition).toBe("ask");
    expect(entry?.allowedDispositions).toEqual(["act", "announce", "ask"]);
  });

  it("launch_sub_item asks under Cautious, announces under Balanced and acts under Autonomous", () => {
    const entry = getCatalogueEntry("launch_sub_item");
    expect(entry?.class).toBe("human_over_the_loop");
    expect(PRESET_NAMES.map((preset) => decide(entry, { preset }, request("launch_sub_item")))).toEqual([
      { class: "human_over_the_loop", disposition: "ask" },
      { class: "human_over_the_loop", disposition: "announce" },
      { class: "human_over_the_loop", disposition: "act" },
    ]);
  });

  it.each(["start_parent_item", "spend_past_envelope", "start_after_reclassify"])("%s is class 3 and asks under every preset", (id) => {
    const entry = getCatalogueEntry(id);
    expect(entry?.class).toBe("human_in_the_loop");
    expect(entry?.allowedDispositions).toEqual(["ask"]);
    for (const preset of PRESET_NAMES) {
      expect(decide(entry, { preset }, request(id))).toEqual({ class: "human_in_the_loop", disposition: "ask" });
    }
  });

  it("spend_past_envelope declares why it cannot be reversed", () => {
    const entry = getCatalogueEntry("spend_past_envelope");
    expect(entry?.reversal).toEqual({ availability: "not_reversible", reason: "money already spent cannot be unspent" });
  });
});
