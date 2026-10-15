import { describe, expect, it } from "vitest";
import { PRESETS } from "@fx/decisions";
import type { PresetName } from "@fx/decisions";
import { resolveSubItemLaunch } from "../src/autonomy/index.js";
import type { SubItemInput } from "../src/autonomy/index.js";

/** D#483 S5-a (S5a-6, S5a-7): `resolveSubItemLaunch`, the guardrails first and then the `launch_sub_item` dial. */

const BASE: SubItemInput = {
  preset: "balanced",
  parent: {
    ownerProcess: "product",
    engineLoopRepo: false,
    provenance: "internal",
    hasPersonApproval: true,
    approvedSpecVersion: 2,
    currentSpecVersion: 2,
    envelopeRemainingUsd: 5,
  },
  sub: { kind: "planned_pr", key: "pr-1", category: null },
  approvedSpecKeys: ["pr-1", "pr-2"],
  firstRunReservationUsd: 1,
  asNewItem: { verification: "verified", freePreview: false, hasWriteInstall: true },
};
const PRESET_NAMES = PRESETS.map((p) => p.name);
const make = (over: {
  preset?: PresetName;
  parent?: Partial<SubItemInput["parent"]>;
  sub?: Partial<SubItemInput["sub"]>;
  firstRunReservationUsd?: number;
  approvedSpecKeys?: string[];
}): SubItemInput => ({
  ...BASE,
  preset: over.preset ?? BASE.preset,
  parent: { ...BASE.parent, ...over.parent },
  sub: { ...BASE.sub, ...over.sub },
  approvedSpecKeys: over.approvedSpecKeys ?? BASE.approvedSpecKeys,
  firstRunReservationUsd: over.firstRunReservationUsd ?? BASE.firstRunReservationUsd,
});
const LAUNCHES = ["act", "announce"];

describe("resolveSubItemLaunch: the dial", () => {
  it("an approved parent's planned PR asks under Cautious, announces under Balanced and acts under Autonomous", () => {
    expect(PRESET_NAMES.map((preset) => resolveSubItemLaunch(make({ preset })).outcome)).toEqual(["ask", "announce", "act"]);
  });

  it("names the catalogue entry and class so the caller can write the receipt", () => {
    expect(resolveSubItemLaunch(make({}))).toEqual({
      outcome: "announce",
      reason: "dial",
      decisionType: "launch_sub_item",
      decisionClass: "human_over_the_loop",
      asNewItem: null,
    });
  });

  it("a fix round, a task in the Spec and a small follow-up child launch under the same dial", () => {
    expect(resolveSubItemLaunch(make({ preset: "autonomous", sub: { kind: "fix_round", key: null } })).outcome).toBe("act");
    expect(resolveSubItemLaunch(make({ preset: "autonomous", sub: { kind: "task", key: "pr-2" } })).outcome).toBe("act");
    for (const category of ["small", "bug", "doc"] as const) {
      expect(resolveSubItemLaunch(make({ preset: "autonomous", sub: { kind: "follow_up_child", key: null, category } })).outcome).toBe("act");
    }
  });

  it("an envelope that exactly covers the first run's reservation still launches", () => {
    expect(resolveSubItemLaunch(make({ parent: { envelopeRemainingUsd: 1 } })).outcome).toBe("announce");
  });
});

describe("resolveSubItemLaunch: each guardrail gives its own outcome under every preset, never a launch", () => {
  const cases: { name: string; input: Partial<Parameters<typeof make>[0]>; outcome: string; reason: string }[] = [
    { name: "no person approval", input: { parent: { hasPersonApproval: false } }, outcome: "ask", reason: "parent_not_approved" },
    { name: "Spec version mismatch (re-spec)", input: { parent: { approvedSpecVersion: 1, currentSpecVersion: 2 } }, outcome: "ask", reason: "respec_needs_approval" },
    { name: "approval names no Spec version", input: { parent: { approvedSpecVersion: null } }, outcome: "ask", reason: "spec_version_unknown" },
    { name: "parent has no current Spec", input: { parent: { currentSpecVersion: null } }, outcome: "ask", reason: "spec_version_unknown" },
    { name: "widened scope: a feature follow-up child", input: { sub: { kind: "follow_up_child", key: null, category: "feature" } }, outcome: "new_item", reason: "sub_item_widens_scope" },
    { name: "widened scope: a project follow-up child", input: { sub: { kind: "follow_up_child", key: null, category: "project" } }, outcome: "new_item", reason: "sub_item_widens_scope" },
    { name: "widened scope: a critical follow-up child", input: { sub: { kind: "follow_up_child", key: null, category: "critical" } }, outcome: "new_item", reason: "sub_item_widens_scope" },
    { name: "widened scope: a follow-up child triage has not classified", input: { sub: { kind: "follow_up_child", key: null, category: null } }, outcome: "new_item", reason: "sub_item_widens_scope" },
    { name: "widened scope: a key absent from the approved Spec", input: { sub: { kind: "planned_pr", key: "pr-9" } }, outcome: "new_item", reason: "sub_item_widens_scope" },
    { name: "widened scope: a task with no key", input: { sub: { kind: "task", key: null } }, outcome: "new_item", reason: "sub_item_widens_scope" },
    { name: "envelope shortfall", input: { parent: { envelopeRemainingUsd: 0.5 } }, outcome: "wait", reason: "parent_envelope_reached" },
    { name: "envelope is not a number", input: { parent: { envelopeRemainingUsd: Number.NaN } }, outcome: "wait", reason: "parent_envelope_reached" },
    { name: "reservation is negative", input: { firstRunReservationUsd: -1 }, outcome: "wait", reason: "parent_envelope_reached" },
    { name: "parent owned by the internal loop", input: { parent: { ownerProcess: "internal_loop" } }, outcome: "refused", reason: "owned_by_internal_loop" },
    { name: "parent on an engine-loop repo", input: { parent: { engineLoopRepo: true } }, outcome: "ask", reason: "engine_loop_repo" },
    { name: "external parent", input: { parent: { provenance: "external" } }, outcome: "ask", reason: "external_needs_approval" },
  ];
  for (const c of cases) {
    it(`${c.name} -> ${c.outcome} (${c.reason}) under every preset`, () => {
      for (const preset of PRESET_NAMES) {
        const got = resolveSubItemLaunch(make({ ...c.input, preset }));
        expect({ outcome: got.outcome, reason: got.reason }, preset).toEqual({ outcome: c.outcome, reason: c.reason });
        expect(LAUNCHES).not.toContain(got.outcome);
        expect(got.decisionType).toBeNull();
      }
    });
  }

  it("guardrail order: a missing approval beats a widened scope, which beats an envelope shortfall, which beats a hard rule", () => {
    const widened = { sub: { kind: "follow_up_child" as const, key: null, category: "feature" as const } };
    expect(resolveSubItemLaunch(make({ ...widened, parent: { hasPersonApproval: false } })).reason).toBe("parent_not_approved");
    expect(resolveSubItemLaunch(make({ ...widened, parent: { envelopeRemainingUsd: 0 } })).reason).toBe("sub_item_widens_scope");
    expect(resolveSubItemLaunch(make({ parent: { envelopeRemainingUsd: 0, provenance: "external" } })).reason).toBe("parent_envelope_reached");
  });

  it("a widened sub-item is handled as a new item: a feature child asks (start_parent_item), a small child follows its own start dial", () => {
    const feature = resolveSubItemLaunch(make({ preset: "autonomous", sub: { kind: "follow_up_child", key: null, category: "feature" } }));
    expect(feature.asNewItem).toMatchObject({ outcome: "ask", reason: "parent_first_start", decisionType: "start_parent_item" });
    const small = resolveSubItemLaunch(make({ preset: "autonomous", sub: { kind: "planned_pr", key: "pr-9", category: "small" } }));
    expect(small.outcome).toBe("new_item");
    expect(small.asNewItem).toMatchObject({ outcome: "act", decisionType: "start_work_small" });
  });

  it("a new item from an external parent never starts on its own, whatever its category", () => {
    for (const preset of PRESET_NAMES) {
      const got = resolveSubItemLaunch(make({ preset, parent: { provenance: "external" }, sub: { kind: "planned_pr", key: "pr-9", category: "small" } }));
      expect(got.asNewItem?.outcome).toBe("ask");
    }
  });

  it("a missing approvedSpecKeys asks instead of throwing, for every kind and preset", () => {
    for (const preset of PRESET_NAMES) for (const kind of ["planned_pr", "task", "fix_round", "follow_up_child"] as const) {
      const input = { ...make({ preset, sub: { kind, key: "pr-1", category: "small" } }), approvedSpecKeys: undefined } as unknown as SubItemInput;
      expect(resolveSubItemLaunch(input), `${preset} ${kind}`).toMatchObject({ outcome: "ask", reason: "spec_keys_unknown", decisionType: null });
    }
  });

  it("an unknown sub.kind asks, even with a key that is in the approved Spec", () => {
    for (const preset of PRESET_NAMES) {
      for (const kind of ["hotfix", "", undefined, 3]) {
        const input = make({ preset, sub: { kind: kind as never, key: "pr-1" } });
        expect(resolveSubItemLaunch(input), `${preset} ${String(kind)}`).toMatchObject({ outcome: "ask", reason: "sub_item_kind_unknown", decisionType: null });
      }
    }
    expect(resolveSubItemLaunch({ ...make({}), sub: undefined } as unknown as SubItemInput).outcome).toBe("ask");
  });

  it("is total: an out-of-set preset asks and never throws", () => {
    expect(resolveSubItemLaunch({ ...make({}), preset: "reckless" as PresetName }).outcome).toBe("ask");
  });
});
