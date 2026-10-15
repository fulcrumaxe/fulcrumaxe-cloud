import { describe, expect, it } from "vitest";
import {
  ASK_WINDOW_DEFAULT_MINUTES,
  ASK_WINDOW_MAX_MINUTES,
  ASK_WINDOW_MIN_MINUTES,
  AskPolicyNotAskedError,
  presetDefaultTimeoutOutcome,
  resolveAskPolicy,
  type AskSettingRow,
} from "../src/askPolicy.js";
import { CATALOGUE, getCatalogueEntry } from "../src/catalogue.js";
import type { CatalogueEntry, PresetName, TimeoutOutcome } from "../src/types.js";

const entry = (id: string): CatalogueEntry => {
  const e = getCatalogueEntry(id);
  if (!e) throw new Error(`fixture: ${id} is not in the catalogue`);
  return e;
};
const REFACTOR = entry("nonbreaking_refactor_approach"); // class 2, both outcomes
const DEPRECATION = entry("publish_deprecation_notice"); // class 2, stop only
const RELEASE = entry("publish_release_artifact"); // class 3, stop only
const REPO = "11111111-1111-4111-8111-111111111111";
const OTHER_REPO = "22222222-2222-4222-8222-222222222222";

const row = (r: Partial<AskSettingRow> & Pick<AskSettingRow, "decisionType">): AskSettingRow => ({
  repoId: null,
  answerWindowMinutes: null,
  timeoutOutcome: null,
  notify: null,
  ...r,
});

describe("resolveAskPolicy: preset defaults, clamped to the entry (R2)", () => {
  // preset x entry -> expected outcome with no settings at all
  const cases: [PresetName, CatalogueEntry, TimeoutOutcome][] = [
    ["cautious", REFACTOR, "stop_and_flag"],
    ["balanced", REFACTOR, "proceed_recommended"],
    ["autonomous", REFACTOR, "proceed_recommended"],
    // class 2 but stop-only: the clamp wins over the preset
    ["cautious", DEPRECATION, "stop_and_flag"],
    ["balanced", DEPRECATION, "stop_and_flag"],
    ["autonomous", DEPRECATION, "stop_and_flag"],
    // class 3 stop-only: Autonomous would go ahead "where the entry allows it", and it does not
    ["cautious", RELEASE, "stop_and_flag"],
    ["balanced", RELEASE, "stop_and_flag"],
    ["autonomous", RELEASE, "stop_and_flag"],
  ];
  it.each(cases.map(([preset, e, expected]) => [preset, e.id, e, expected] as const))("%s on %s", (preset, _id, e, expected) => {
    expect(resolveAskPolicy(e, preset, []).timeoutOutcome).toBe(expected);
  });

  it("an Autonomous class 3 entry that allows it goes ahead (the 'where the entry allows it' half of R2)", () => {
    const permissive: CatalogueEntry = {
      ...RELEASE,
      id: "fixture_class3_permissive",
      timeoutOutcomes: ["stop_and_flag", "proceed_recommended"],
    };
    expect(resolveAskPolicy(permissive, "autonomous", []).timeoutOutcome).toBe("proceed_recommended");
    expect(resolveAskPolicy(permissive, "balanced", []).timeoutOutcome).toBe("stop_and_flag");
    expect(resolveAskPolicy(permissive, "cautious", []).timeoutOutcome).toBe("stop_and_flag");
  });

  it("the default window is 24 hours and notify defaults to email", () => {
    expect(resolveAskPolicy(REFACTOR, "cautious", [])).toEqual({
      answerWindowMinutes: 1440,
      timeoutOutcome: "stop_and_flag",
      notify: "email",
    });
    expect(ASK_WINDOW_DEFAULT_MINUTES).toBe(1440);
  });

  it("presetDefaultTimeoutOutcome matches the R2 table", () => {
    expect(presetDefaultTimeoutOutcome("balanced", "human_over_the_loop")).toBe("proceed_recommended");
    expect(presetDefaultTimeoutOutcome("balanced", "human_in_the_loop")).toBe("stop_and_flag");
    expect(presetDefaultTimeoutOutcome("autonomous", "human_in_the_loop")).toBe("proceed_recommended");
    expect(presetDefaultTimeoutOutcome("cautious", "human_over_the_loop")).toBe("stop_and_flag");
  });
});

describe("resolveAskPolicy: resolution order", () => {
  const settings: AskSettingRow[] = [
    row({ repoId: REPO, decisionType: REFACTOR.id, answerWindowMinutes: 30 }),
    row({ repoId: REPO, decisionType: "*", answerWindowMinutes: 60, timeoutOutcome: "stop_and_flag", notify: "none" }),
    row({ decisionType: REFACTOR.id, answerWindowMinutes: 120, timeoutOutcome: "proceed_recommended" }),
    row({ decisionType: "*", answerWindowMinutes: 240, notify: "email" }),
  ];

  it("repo + type wins, then repo + '*', then account + type, then account + '*' (per field)", () => {
    const p = resolveAskPolicy(REFACTOR, "autonomous", settings, REPO);
    expect(p.answerWindowMinutes).toBe(30); // repo + type
    expect(p.timeoutOutcome).toBe("stop_and_flag"); // repo + type has none; repo + '*' says stop
    expect(p.notify).toBe("none"); // repo + '*'
  });

  it("without a repo, only the account levels apply", () => {
    const p = resolveAskPolicy(REFACTOR, "cautious", settings, null);
    expect(p).toEqual({ answerWindowMinutes: 120, timeoutOutcome: "proceed_recommended", notify: "email" });
  });

  it("another repo's rows never apply", () => {
    const p = resolveAskPolicy(REFACTOR, "cautious", settings, OTHER_REPO);
    expect(p.answerWindowMinutes).toBe(120);
  });

  it("account + '*' is the last stop before the preset default", () => {
    const p = resolveAskPolicy(DEPRECATION, "balanced", settings, null);
    expect(p.answerWindowMinutes).toBe(240);
    expect(p.timeoutOutcome).toBe("stop_and_flag");
  });

  it("a row with every field null (a removed override) falls through to the next level", () => {
    const removed = [row({ repoId: REPO, decisionType: REFACTOR.id }), row({ decisionType: "*", answerWindowMinutes: 90 })];
    expect(resolveAskPolicy(REFACTOR, "cautious", removed, REPO).answerWindowMinutes).toBe(90);
    expect(resolveAskPolicy(REFACTOR, "cautious", [removed[0]!], REPO).answerWindowMinutes).toBe(1440);
  });
});

describe("resolveAskPolicy: clamps", () => {
  it("a stored proceed_recommended is clamped to stop_and_flag on a stop-only entry, at every level", () => {
    const wanted = "proceed_recommended" as const;
    for (const settings of [
      [row({ repoId: REPO, decisionType: RELEASE.id, timeoutOutcome: wanted })],
      [row({ repoId: REPO, decisionType: DEPRECATION.id, timeoutOutcome: wanted })],
      [row({ repoId: REPO, decisionType: "*", timeoutOutcome: wanted })],
      [row({ decisionType: RELEASE.id, timeoutOutcome: wanted })],
      [row({ decisionType: DEPRECATION.id, timeoutOutcome: wanted })],
      [row({ decisionType: "*", timeoutOutcome: wanted })],
    ]) {
      for (const e of [RELEASE, DEPRECATION]) {
        expect(resolveAskPolicy(e, "autonomous", settings, REPO).timeoutOutcome).toBe("stop_and_flag");
      }
    }
  });

  it("a window outside 15 minutes .. 14 days is clamped to the bound", () => {
    expect(resolveAskPolicy(REFACTOR, "cautious", [row({ decisionType: "*", answerWindowMinutes: 1 })]).answerWindowMinutes).toBe(15);
    expect(resolveAskPolicy(REFACTOR, "cautious", [row({ decisionType: "*", answerWindowMinutes: 10_000_000 })]).answerWindowMinutes).toBe(20160);
    expect(ASK_WINDOW_MIN_MINUTES).toBe(15);
    expect(ASK_WINDOW_MAX_MINUTES).toBe(20160);
  });

  it("the bounds themselves pass through", () => {
    expect(resolveAskPolicy(REFACTOR, "cautious", [row({ decisionType: "*", answerWindowMinutes: 15 })]).answerWindowMinutes).toBe(15);
    expect(resolveAskPolicy(REFACTOR, "cautious", [row({ decisionType: "*", answerWindowMinutes: 20160 })]).answerWindowMinutes).toBe(20160);
  });

  it("a class 1 entry is never asked: no policy", () => {
    const class1 = CATALOGUE.find((e) => e.class === "automated_with_monitoring")!;
    expect(() => resolveAskPolicy(class1, "autonomous", [])).toThrow(AskPolicyNotAskedError);
  });

  it("for every asked catalogue entry, preset and stored outcome, the result is one the entry permits", () => {
    for (const e of CATALOGUE.filter((c) => c.class !== "automated_with_monitoring")) {
      for (const preset of ["cautious", "balanced", "autonomous"] as const) {
        for (const wanted of [null, "stop_and_flag", "proceed_recommended"] as const) {
          const p = resolveAskPolicy(e, preset, [row({ decisionType: "*", timeoutOutcome: wanted })]);
          expect(e.timeoutOutcomes).toContain(p.timeoutOutcome);
        }
      }
    }
  });

  it("is pure: the same inputs give the same answer and the inputs are not changed", () => {
    const settings = [row({ decisionType: "*", answerWindowMinutes: 45 })];
    const snapshot = JSON.stringify(settings);
    expect(resolveAskPolicy(REFACTOR, "balanced", settings)).toEqual(resolveAskPolicy(REFACTOR, "balanced", settings));
    expect(JSON.stringify(settings)).toBe(snapshot);
  });
});
