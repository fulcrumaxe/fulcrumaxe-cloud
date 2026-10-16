import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isBuildableKind } from "@fx/discussions";
import { priceRunPlan, type RolePrice } from "../../src/estimate/estimateItem.js";
import { runPlanFor } from "../../src/estimate/runPlan.js";
import { SLOT_HOLD_STAGES, SLOT_HOLD_SEED_MINUTES, medianOf } from "../../src/estimate/slotHold.js";
import { BUILD_SLOT_STAGES } from "../../src/advance/buildSlots.js";
import { TRIAGE_CATEGORIES, runsPanel } from "../../src/plan/categories.js";
import { selectPanel } from "../../src/plan/panelRoles.js";

/** D#483 S5-p [unit]: the run plan per category, the sums over fixture prices, and the guards the C1 ruling asks for. */

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Fixture prices: every role costs a distinct round figure, so a wrong count shows in the sum. */
const FIXTURE: Record<string, number> = {
  "project-manager": 1,
  "technical-architect": 2,
  "security-expert": 3,
  "cost-analyst": 4,
  "product-owner": 5,
  "performance-expert": 6,
  researcher: 7,
  "ux-designer": 8,
  executor: 10,
  "code-reviewer": 20,
  "acceptance-tester": 30,
  "security-reviewer": 40,
  debater: 50,
};
const priceOf = (role: string): RolePrice | undefined => (role in FIXTURE ? { usd: FIXTURE[role]!, history: true } : undefined);

describe("S5p-1: the run plan and its sums", () => {
  const cases: Array<{ name: string; category: string; debater?: boolean; total: number; slot: number }> = [
    // pm x2 = 2, executor 10, code 20, acceptance 30
    { name: "small", category: "small", total: 2 + 10 + 20 + 30, slot: 60 },
    { name: "bug", category: "bug", total: 62, slot: 60 },
    { name: "doc", category: "doc", total: 62, slot: 60 },
    // a debater setting never adds a debater to a small item
    { name: "small with the debater on", category: "small", debater: true, total: 62, slot: 60 },
    // pm x2 = 2, panel (2 + 5 + 6) x 2 = 26, then 60
    { name: "feature", category: "feature", total: 2 + 26 + 60, slot: 60 },
    { name: "feature with the debater on", category: "feature", debater: true, total: 2 + 26 + 60 + 50, slot: 110 },
    // pm 2, panel (2 + 3 + 4) x 2 = 18, executor 10, code 20, acceptance 30, security 40
    { name: "critical", category: "critical", total: 2 + 18 + 100, slot: 100 },
    { name: "critical with the debater on", category: "critical", debater: true, total: 2 + 18 + 100 + 50, slot: 150 },
  ];
  it.each(cases)("$name", ({ category, debater, total, slot }) => {
    const plan = runPlanFor({ category, debaterEnabled: debater === true });
    if (!plan.ok) throw new Error("expected a plan");
    expect(priceRunPlan(plan.runs, priceOf)).toEqual({ total_usd: total, slot_phase_usd: slot, basis: "history" });
  });

  it("a panel seat the title or summary adds is counted twice too", () => {
    const plan = runPlanFor({ category: "feature", title: "New overlay button", summary: "uses the npm library" });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.runs.filter((r) => r.role === "researcher" || r.role === "ux-designer").map((r) => [r.role, r.count])).toEqual([
      ["researcher", 2],
      ["ux-designer", 2],
    ]);
  });

  it("every panel seat is the pure selector's, in its order, each x 2", () => {
    const seats = selectPanel("critical", "t", "b");
    const plan = runPlanFor({ category: "critical", title: "t", summary: "b" });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.runs.filter((r) => !r.slotPhase && r.role !== "project-manager")).toEqual(seats.map((role) => ({ role, count: 2, slotPhase: false })));
  });

  it("question, project and no category have no estimate, with a reason", () => {
    expect(runPlanFor({ category: "question" })).toEqual({ ok: false, reason: "question_not_built" });
    expect(runPlanFor({ category: "project" })).toEqual({ ok: false, reason: "project_not_specified" });
    expect(runPlanFor({ category: null })).toEqual({ ok: false, reason: "no_category" });
    expect(runPlanFor({ category: undefined })).toEqual({ ok: false, reason: "no_category" });
    expect(runPlanFor({ category: "urgent" })).toEqual({ ok: false, reason: "no_category" });
  });

  it("every category of the fixed set is either planned or has a reason: none falls through", () => {
    for (const category of TRIAGE_CATEGORIES) {
      const plan = runPlanFor({ category });
      expect(plan.ok || typeof plan.reason === "string", category).toBe(true);
    }
  });

  it("never a negative or NaN value, whatever a price is", () => {
    const plan = runPlanFor({ category: "feature" });
    if (!plan.ok) throw new Error("expected a plan");
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = priceRunPlan(plan.runs, () => ({ usd: bad, history: true }));
      expect(out.total_usd, String(bad)).toBe(0);
      expect(out.slot_phase_usd, String(bad)).toBe(0);
    }
    const mixed = priceRunPlan(plan.runs, (role) => ({ usd: role === "executor" ? -1 : 1, history: true }));
    expect(mixed.total_usd).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(mixed.total_usd)).toBe(true);
  });

  it("basis is history only when every role used had history; an unpriced role or one on the seed makes it seed", () => {
    const plan = runPlanFor({ category: "small" });
    if (!plan.ok) throw new Error("expected a plan");
    expect(priceRunPlan(plan.runs, priceOf).basis).toBe("history");
    expect(priceRunPlan(plan.runs, (role) => ({ usd: 1, history: role !== "executor" })).basis).toBe("seed");
    expect(priceRunPlan(plan.runs, (role) => (role === "executor" ? undefined : { usd: 1, history: true })).basis).toBe("seed");
  });
});

describe("C1: a project is priced none, and the test fails if it ever gains a panel or build run without the estimate changing", () => {
  it("project has no panel seats: the selector has no triple for it", () => {
    // `selectPanel` takes critical or feature only; any other kind must not produce a panel (it throws on the missing triple).
    expect(() => (selectPanel as (kind: string, title: string, body: string) => string[])("project", "t", "b")).toThrow();
  });

  it("project is never buildable", () => {
    expect(isBuildableKind("project")).toBe(false);
  });

  it("the stage move to discussing is not a panel: runsPanel is true for project, and the estimate still says none", () => {
    expect(runsPanel("project")).toBe(true);
    expect(runPlanFor({ category: "project" })).toEqual({ ok: false, reason: "project_not_specified" });
  });

  it("the panel and spec steps refuse any kind but critical and feature, and the advance workflow stops a project after triage", () => {
    expect(read("../../src/plan/panel.ts")).toContain('row.kind !== "critical" && row.kind !== "feature"');
    expect(read("../../src/plan/spec.ts")).toContain('item.kind !== "critical" && item.kind !== "feature"');
    expect(read("../../../../apps/web/workflows/workItemAdvance.ts")).toContain('triaged.category === "project"');
  });

  it("the runsPanel comment no longer says a project runs the consensus panel", () => {
    const src = read("../../src/plan/categories.ts");
    const comment = src.slice(src.indexOf("/** C36"), src.indexOf("export function runsPanel"));
    expect(comment).not.toMatch(/Project run the\s*consensus panel/i);
    expect(comment).toMatch(/project_not_specified/);
  });
});

describe("S5p-4 / S5p-5: one price lookup, and the estimate and the slot code stay apart", () => {
  it("role settings (list.ts) calls the shared lookup and keeps no ledger median query of its own", () => {
    const list = read("../../../core/src/role-settings/list.ts");
    expect(list).toContain("./runPrice.js");
    expect(list).toContain("loadModelRunMedians");
    expect(list).not.toContain("percentile_cont");
    expect(list).not.toContain("FROM ledger");
  });

  it("the seat prices its reservation through the runner's compute helper", () => {
    const seat = read("../../../worker/src/seat.ts");
    expect(seat).toContain("sandboxComputeUsdFor(maxPossibleRunMs)");
    expect(seat).not.toContain("computeComputeUsd");
  });

  it("the estimate module imports nothing from buildSlots.ts, and buildSlots.ts imports nothing from the plan data", () => {
    const dir = new URL("../../src/estimate/", import.meta.url);
    for (const file of readdirSync(dir)) expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/from\s+["'][^"']*buildSlots/);
    expect(read("../../src/advance/buildSlots.ts")).not.toMatch(/from\s+["']@fx\/plan-data/);
    expect(read("../../src/advance/buildSlots.ts")).not.toMatch(/\/estimate\//);
  });

  it("the slot stages repeated in the estimate equal the slot code's", () => {
    expect([...SLOT_HOLD_STAGES]).toEqual([...BUILD_SLOT_STAGES]);
  });
});

describe("slot hold helpers", () => {
  it("the median of odd and even lists", () => {
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });
  it("the seed is the product constant", () => {
    expect(SLOT_HOLD_SEED_MINUTES).toBe(60);
  });
});
