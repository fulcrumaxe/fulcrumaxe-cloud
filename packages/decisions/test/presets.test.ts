import { describe, expect, it } from "vitest";
import { getCatalogueEntry } from "../src/catalogue.js";
import { decide } from "../src/decide.js";
import {
  AUTONOMOUS_PRESET,
  BALANCED_PRESET,
  CAUTIOUS_PRESET,
  PRESETS,
  UnknownPresetError,
  getPreset,
} from "../src/presets.js";
import type { DecisionClass, Preset } from "../src/types.js";

const CLASSES: readonly DecisionClass[] = [
  "automated_with_monitoring",
  "human_over_the_loop",
  "human_in_the_loop",
];

describe("criterion 4: a preset is a named point in the matrix, not a code path", () => {
  it("there are exactly the three owner-named presets (DP-OD1)", () => {
    expect(PRESETS.map((p) => p.name).sort()).toEqual(["autonomous", "balanced", "cautious"]);
  });

  it("class 1 (automated_with_monitoring) is always 'act', on every preset", () => {
    for (const preset of PRESETS) {
      expect(preset.dispositions.automated_with_monitoring).toBe("act");
    }
  });

  it("class 3 (human_in_the_loop) is always 'ask', on every preset", () => {
    for (const preset of PRESETS) {
      expect(preset.dispositions.human_in_the_loop).toBe("ask");
    }
  });

  it("every pair of distinct presets differs in the class-2 disposition and is identical in classes 1 and 3 (DP-C1)", () => {
    for (const a of PRESETS) {
      for (const b of PRESETS) {
        if (a.name === b.name) continue;
        for (const cls of CLASSES) {
          if (cls === "human_over_the_loop") {
            expect(a.dispositions[cls]).not.toBe(b.dispositions[cls]);
          } else {
            expect(a.dispositions[cls]).toBe(b.dispositions[cls]);
          }
        }
      }
    }
  });

  it("Cautious asks on class 2 ('you approve')", () => {
    expect(CAUTIOUS_PRESET.dispositions.human_over_the_loop).toBe("ask");
  });

  it("Balanced announces on class 2 ('you oversee, and can reverse')", () => {
    expect(BALANCED_PRESET.dispositions.human_over_the_loop).toBe("announce");
  });

  it("Autonomous acts on class 2 ('you observe')", () => {
    expect(AUTONOMOUS_PRESET.dispositions.human_over_the_loop).toBe("act");
  });
});

describe("criterion 5: each preset carries a distinct one-line customer-role string (DP-OD1)", () => {
  it("all three strings are present (non-empty)", () => {
    for (const preset of PRESETS) {
      expect(typeof preset.customerRoleDescription).toBe("string");
      expect(preset.customerRoleDescription.length).toBeGreaterThan(0);
    }
  });

  it("all three strings are distinct", () => {
    const descriptions = PRESETS.map((p) => p.customerRoleDescription);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("matches DP-OD1's verbatim strings", () => {
    expect(CAUTIOUS_PRESET.customerRoleDescription).toBe("you approve");
    expect(BALANCED_PRESET.customerRoleDescription).toBe("you oversee, and can reverse");
    expect(AUTONOMOUS_PRESET.customerRoleDescription).toBe("you observe");
  });
});

describe("getPreset", () => {
  it.each<[Preset["name"], Preset]>([
    ["cautious", CAUTIOUS_PRESET],
    ["balanced", BALANCED_PRESET],
    ["autonomous", AUTONOMOUS_PRESET],
  ])("resolves %s to the matching exported preset", (name, expected) => {
    expect(getPreset(name)).toBe(expected);
  });

  it("throws UnknownPresetError for a name outside the three", () => {
    expect(() => getPreset("moderate" as Preset["name"])).toThrow(UnknownPresetError);
  });
});

// D#6 R2b-4a (C31 acceptance 9): the runner-run decision is class 2, so the three presets move it, and its default is announce.
describe("runner_run_on_member_plan resolves per preset through decide()", () => {
  const entry = getCatalogueEntry("runner_run_on_member_plan");
  const request = { type: "runner_run_on_member_plan", options: ["approve", "ask"], proposed: "approve", rationale: "r" };

  it("is class 2 with the default announce", () => {
    expect(entry?.class).toBe("human_over_the_loop");
    expect(entry?.defaultDisposition).toBe("announce");
  });

  it.each([
    ["cautious", "ask"],
    ["balanced", "announce"],
    ["autonomous", "act"],
  ] as const)("%s resolves to %s", (preset, disposition) => {
    expect(decide(entry, { preset }, request)).toEqual({ class: "human_over_the_loop", disposition });
  });
});
