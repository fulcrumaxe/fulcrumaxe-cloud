import { describe, expect, it } from "vitest";
import { CATALOGUE, CATALOGUE_VERSION, PRESETS, getCatalogueEntry } from "@fx/decisions";
import {
  buildDecisionSnapshot,
  declaredDecisionTypes,
  declaredTypesOfCard,
  dispositionForDial,
  parseDecisionSnapshot,
  type SnapshotDial,
} from "../src/decisionSnapshot.js";

/** D#7 DP4b-1 criterion 3 (R-7-DP4b-1): the snapshot builder is pure and offers exactly the role's declared types, under opaque keys. */

const dial = (version: number, disposition: string, preset: string | null = null): SnapshotDial => ({ version, disposition, preset });
const NO_DIALS = new Map<string, SnapshotDial>();
const entry = (id: string) => getCatalogueEntry(id)!;

describe("declared types of a role", () => {
  it("the executor card declares exactly the two class-2 types DP4a gave it, in card order", () => {
    expect(declaredDecisionTypes("executor")).toEqual(["nonbreaking_refactor_approach", "test_strategy_choice"]);
  });

  it("a role with no declaration, a role outside the manifest and no card at all declare none", () => {
    expect(declaredDecisionTypes("code-reviewer")).toEqual([]);
    expect(declaredDecisionTypes("not-a-role")).toEqual([]);
    expect(declaredTypesOfCard(undefined)).toEqual([]);
  });

  it("reads the frontmatter line only: a body that mentions decision_types is not a declaration", () => {
    expect(declaredTypesOfCard("---\nname: x\n---\n\ndecision_types: [a, b]\n")).toEqual([]);
    expect(declaredTypesOfCard('---\nname: x\ndecision_types: ["a", \'b\' , c]\n---\n')).toEqual(["a", "b", "c"]);
    expect(declaredTypesOfCard("---\nname: x\ndecision_types: []\n---\n")).toEqual([]);
  });
});

describe("buildDecisionSnapshot", () => {
  it("offers exactly the declared types as d1..dN in declaration order, stamped with the catalogue version", () => {
    const snap = buildDecisionSnapshot({ role: "executor", dials: NO_DIALS });
    expect(snap.catalogue_version).toBe(CATALOGUE_VERSION);
    expect(snap.entries.map((e) => [e.key, e.decision_type])).toEqual([
      ["d1", "nonbreaking_refactor_approach"],
      ["d2", "test_strategy_choice"],
    ]);
    // No dial row: version 0 and the catalogue default.
    expect(snap.entries.map((e) => [e.dial_version, e.disposition])).toEqual([
      [0, entry("nonbreaking_refactor_approach").defaultDisposition],
      [0, entry("test_strategy_choice").defaultDisposition],
    ]);
  });

  it("a role with no declarations gets an empty snapshot", () => {
    expect(buildDecisionSnapshot({ role: "code-reviewer", dials: NO_DIALS })).toEqual({ catalogue_version: CATALOGUE_VERSION, entries: [] });
    expect(buildDecisionSnapshot({ role: "executor", dials: NO_DIALS, declared: [] }).entries).toEqual([]);
  });

  it("is pure: the same input gives the same output, and the inputs are not changed", () => {
    const dials = new Map([["test_strategy_choice", dial(3, "act", "autonomous")]]);
    const declared = ["test_strategy_choice", "nonbreaking_refactor_approach"];
    const a = buildDecisionSnapshot({ role: "executor", dials, declared });
    const b = buildDecisionSnapshot({ role: "executor", dials, declared });
    expect(a).toEqual(b);
    expect(declared).toEqual(["test_strategy_choice", "nonbreaking_refactor_approach"]);
    expect(dials.size).toBe(1);
  });

  it("takes each entry's disposition and dial version from its own dial row", () => {
    const dials = new Map([
      ["nonbreaking_refactor_approach", dial(4, "announce", null)],
      ["test_strategy_choice", dial(2, "ask", "cautious")],
    ]);
    const snap = buildDecisionSnapshot({ role: "executor", dials });
    expect(snap.entries.map((e) => [e.decision_type, e.disposition, e.dial_version])).toEqual([
      ["nonbreaking_refactor_approach", "announce", 4],
      ["test_strategy_choice", "ask", 2],
    ]);
  });

  it("a type declared twice is offered once, and a declaration that is not in the catalogue is dropped with a fixed-code line, never guessed at", () => {
    const warns: string[] = [];
    const snap = buildDecisionSnapshot({ role: "x", dials: NO_DIALS, declared: ["test_strategy_choice", "test_strategy_choice", "no_such_type"], warn: (l) => warns.push(l) });
    expect(snap.entries.map((e) => e.decision_type)).toEqual(["test_strategy_choice"]);
    expect(warns.map((l) => JSON.parse(l))).toEqual([{ event: "decision.snapshot_dropped", reason: "not_in_catalogue", decision_type: "no_such_type" }]);
  });

  it("an invariant key is never offered: a declaration of one is not in the catalogue, so it is dropped", () => {
    const snap = buildDecisionSnapshot({ role: "x", dials: NO_DIALS, declared: ["cross_tenant_row_access", "merge_or_protection_change", "test_strategy_choice"] });
    expect(snap.entries.map((e) => [e.key, e.decision_type])).toEqual([["d1", "test_strategy_choice"]]);
  });

  it("defence in depth, not vacuous: a catalogue type that collides with an invariant key is dropped, with a line, and the keys stay contiguous", () => {
    const warns: string[] = [];
    // The fixture: pretend the catalogue's `nonbreaking_refactor_approach` had been named as a fixed invariant.
    const colliding = buildDecisionSnapshot({
      role: "executor",
      dials: NO_DIALS,
      invariantKeys: ["nonbreaking_refactor_approach"],
      warn: (l) => warns.push(l),
    });
    expect(colliding.entries.map((e) => [e.key, e.decision_type])).toEqual([["d1", "test_strategy_choice"]]);
    expect(warns.map((l) => JSON.parse(l))).toEqual([{ event: "decision.snapshot_dropped", reason: "invariant_collision", decision_type: "nonbreaking_refactor_approach" }]);
    // Without the collision the same input offers both: the drop above is the guard's doing, not an accident of the input.
    expect(buildDecisionSnapshot({ role: "executor", dials: NO_DIALS }).entries).toHaveLength(2);
  });

  it("never offers more than 99 keys", () => {
    const many = CATALOGUE.map((e) => e.id);
    expect(buildDecisionSnapshot({ role: "x", dials: NO_DIALS, declared: many }).entries.length).toBeLessThanOrEqual(99);
  });
});

describe("dispositionForDial", () => {
  const classTwo = entry("test_strategy_choice");
  const classOne = entry("dependency_patch_bump");
  const classThree = CATALOGUE.find((e) => e.class === "human_in_the_loop")!;

  it("no row is the catalogue default", () => {
    for (const e of CATALOGUE) expect(dispositionForDial(e, null), e.id).toBe(e.defaultDisposition);
  });

  it("a row that adopted a preset is what decide() says under that preset, for every entry and preset", () => {
    for (const e of CATALOGUE) {
      for (const p of PRESETS) {
        const wanted = e.allowedDispositions.includes(p.dispositions[e.class]) ? p.dispositions[e.class] : undefined;
        const got = dispositionForDial(e, dial(1, "ask", p.name));
        if (wanted !== undefined) expect(got, `${e.id}/${p.name}`).toBe(wanted);
        expect(e.allowedDispositions, `${e.id}/${p.name}`).toContain(got);
      }
    }
  });

  it("class 1 always acts and class 3 always asks, whatever the row says", () => {
    for (const p of PRESETS) {
      expect(dispositionForDial(classOne, dial(1, "ask", p.name))).toBe("act");
      expect(dispositionForDial(classThree, dial(1, "act", p.name))).toBe("ask");
    }
  });

  it("an override row (no preset) is its stored disposition if the entry allows it, else ask", () => {
    expect(dispositionForDial(classTwo, dial(2, "announce"))).toBe("announce");
    expect(dispositionForDial(classThree, dial(2, "act"))).toBe("ask");
    expect(dispositionForDial(classTwo, dial(2, "banana"))).toBe("ask");
    expect(dispositionForDial(classTwo, dial(2, "act", "not_a_preset"))).toBe("act");
  });
});

describe("parseDecisionSnapshot (the schema a stored row must pass)", () => {
  const good = { catalogue_version: 3, entries: [{ key: "d1", decision_type: "test_strategy_choice", disposition: "ask", dial_version: 0 }] };

  it("accepts a built snapshot, and the empty one", () => {
    expect(parseDecisionSnapshot(good)).toEqual(good);
    expect(parseDecisionSnapshot({ catalogue_version: 1, entries: [] })).toEqual({ catalogue_version: 1, entries: [] });
    expect(parseDecisionSnapshot(buildDecisionSnapshot({ role: "executor", dials: NO_DIALS }))).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["a string", "snapshot"],
    ["an unknown top-level key", { ...good, extra: 1 }],
    ["a missing entries", { catalogue_version: 3 }],
    ["a zero catalogue version", { ...good, catalogue_version: 0 }],
    ["a fractional catalogue version", { ...good, catalogue_version: 1.5 }],
    ["entries that are not an array", { ...good, entries: {} }],
    ["more than 99 entries", { ...good, entries: Array.from({ length: 100 }, (_, i) => ({ ...good.entries[0], key: `d${(i % 99) + 1}` })) }],
    ["a key that is not dN", { ...good, entries: [{ ...good.entries[0], key: "x1" }] }],
    ["the key d0", { ...good, entries: [{ ...good.entries[0], key: "d0" }] }],
    ["the key d100", { ...good, entries: [{ ...good.entries[0], key: "d100" }] }],
    ["a duplicate key", { ...good, entries: [good.entries[0], { ...good.entries[0], decision_type: "other" }] }],
    ["an empty decision type", { ...good, entries: [{ ...good.entries[0], decision_type: "" }] }],
    ["an unknown disposition", { ...good, entries: [{ ...good.entries[0], disposition: "maybe" }] }],
    ["a negative dial version", { ...good, entries: [{ ...good.entries[0], dial_version: -1 }] }],
    ["a dial version above int4", { ...good, entries: [{ ...good.entries[0], dial_version: 2147483648 }] }],
    ["an extra entry field (a class, say)", { ...good, entries: [{ ...good.entries[0], class: "human_over_the_loop" }] }],
    ["a missing entry field", { ...good, entries: [{ key: "d1", decision_type: "x", disposition: "ask" }] }],
    ["an entry that is not an object", { ...good, entries: ["d1"] }],
  ])("refuses %s", (_label, payload) => {
    expect(parseDecisionSnapshot(payload)).toBeNull();
  });
});
