import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs, UsageError } from "../src/cli.js";
import { loadPacks } from "../src/manifest.js";
import { buildPlan } from "../src/plan.js";
import { EmptySelectionError, select, triggerRule, TRIGGERS, UnknownPackError } from "../src/select.js";
import { makeIo, makePack, makeTarget, needsCtx, PACKAGE_ROOT, scratchRoot } from "./helpers.js";

const packs = [
  makePack({ id: "smoke-a", tier: "smoke", tags: ["@api"] }),
  makePack({ id: "smoke-b", tier: "smoke", tags: ["@ui"], projects: ["desktop", "phone", "tablet"] }),
  makePack({ id: "std-x", tier: "standard", tags: ["@api", "@stripe"] }),
  makePack({ id: "std-y", tier: "standard", tags: ["@ui"], projects: ["desktop", "phone", "tablet"] }),
  makePack({ id: "full-z", tier: "full", tags: ["@api"] }),
];
const ids = (r: { packs: { id: string }[] }): string[] => r.packs.map((p) => p.id);

describe("select: union", () => {
  it("a tier selects every pack at or below it", () => {
    expect(ids(select({ packs, tier: "smoke" }))).toEqual(["smoke-a", "smoke-b"]);
    expect(ids(select({ packs, tier: "standard" }))).toEqual(["smoke-a", "smoke-b", "std-x", "std-y"]);
    expect(ids(select({ packs, tier: "full" }))).toHaveLength(5);
  });

  it("--tier smoke --pack <standard pack> selects every smoke pack plus that pack", () => {
    const r = select({ packs, tier: "smoke", named: ["std-x"] });
    expect(ids(r)).toEqual(["smoke-a", "smoke-b", "std-x"]);
    expect([...r.named]).toEqual(["std-x"]);
  });

  it("a pack named alone selects just that pack", () => {
    expect(ids(select({ packs, named: ["full-z"] }))).toEqual(["full-z"]);
  });

  it("routed pack ids (from changed-files routing) join the union", () => {
    expect(ids(select({ packs, tier: "smoke", routed: ["std-y"] }))).toEqual(["smoke-a", "smoke-b", "std-y"]);
  });

  it("a name selected twice appears once; order follows the manifest, not the flags", () => {
    expect(ids(select({ packs, tier: "standard", named: ["std-y", "smoke-a"] }))).toEqual(["smoke-a", "smoke-b", "std-x", "std-y"]);
  });

  it("an unknown named or routed pack is an error, not a silent drop", () => {
    expect(() => select({ packs, named: ["nope"] })).toThrow(UnknownPackError);
    expect(() => select({ packs, tier: "smoke", routed: ["nope"] })).toThrow(UnknownPackError);
  });
});

describe("select: tag filter and EMPTY-SELECTION", () => {
  it("the tag narrows the whole union, named packs included", () => {
    expect(ids(select({ packs, tier: "standard", tag: "@ui" }))).toEqual(["smoke-b", "std-y"]);
    expect(ids(select({ packs, tier: "smoke", named: ["std-x"], tag: "@stripe" }))).toEqual(["std-x"]);
  });

  it("--tier smoke --pack <x> --tag @nomatch is EMPTY-SELECTION", () => {
    expect(() => select({ packs, tier: "smoke", named: ["std-x"], tag: "@nomatch" })).toThrow(EmptySelectionError);
  });

  it("no tier, no pack and no routing selects nothing: EMPTY-SELECTION", () => {
    expect(() => select({ packs })).toThrow(EmptySelectionError);
    expect(() => select({ packs: [], tier: "full" })).toThrow(EmptySelectionError);
  });

  it("end to end the CLI exits non-zero with EMPTY-SELECTION and writes no plan", async () => {
    const root = scratchRoot(packs);
    const { io, err } = makeIo(root);
    const code = await main(["plan", "--target", "staging", "--tier", "smoke", "--pack", "std-x", "--tag", "@nomatch"], io);
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("EMPTY-SELECTION");
    expect(() => readFileSync(join(root, "plan.json"))).toThrow();
  });
});

describe("select: trigger rule", () => {
  const spender = makePack({ id: "spender", tier: "full", model_spend: true });

  it("refuses a model_spend pack on deploy, nightly, poll and when no trigger is given", () => {
    for (const t of ["deploy", "nightly", "poll", undefined] as const) {
      expect(triggerRule(spender, t), String(t)).toBe("full-tier-trigger");
    }
  });

  it("allows it on dispatch and weekly", () => {
    expect(triggerRule(spender, "dispatch")).toBeNull();
    expect(triggerRule(spender, "weekly")).toBeNull();
  });

  it("never touches a pack that spends no model tokens", () => {
    for (const t of [...TRIGGERS, undefined]) expect(triggerRule(makePack({ id: "free", tier: "full" }), t)).toBeNull();
  });

  it("plan: REFUSED full-tier-trigger for deploy, nightly, poll; RUN-eligible for dispatch and weekly", () => {
    const target = makeTarget({ protected: false });
    for (const trigger of TRIGGERS) {
      const plan = buildPlan({ packs: [spender], target, tier: "full", trigger, needs: needsCtx() });
      const expected = trigger === "dispatch" || trigger === "weekly" ? "RUN" : "REFUSED";
      expect(plan.packs[0]?.outcome, trigger).toBe(expected);
      if (expected === "REFUSED") expect(plan.refused[0]?.reason).toBe("full-tier-trigger");
    }
  });

  it("a named model_spend pack refused by the trigger rule makes the CLI exit non-zero", async () => {
    const root = scratchRoot([spender]);
    const { io, err } = makeIo(root);
    expect(await main(["plan", "--target", "staging", "--pack", "spender", "--trigger", "deploy"], io)).toBe(1);
    expect(err.join("\n")).toContain("REFUSED full-tier-trigger");
    const ok = makeIo(root);
    expect(await main(["plan", "--target", "staging", "--pack", "spender", "--trigger", "dispatch"], ok.io)).toBe(0);
  });
});

describe("select: every workflow trigger's argument list selects at least every smoke pack", () => {
  const fixture = JSON.parse(readFileSync(join(PACKAGE_ROOT, "test", "fixtures", "workflow-args.json"), "utf8")) as Record<string, string[] | string>;
  const real = loadPacks(join(PACKAGE_ROOT, "packs"));
  const smokeIds = real.filter((p) => p.tier === "smoke").map((p) => p.id);

  it("the shipped packs include smoke packs (so the check below is not vacuous)", () => {
    expect(smokeIds.length).toBeGreaterThan(0);
  });

  for (const [trigger, argv] of Object.entries(fixture)) {
    if (trigger.startsWith("_")) continue;
    it(`${trigger}: non-empty argument list, selects every smoke pack`, () => {
      const list = argv as string[];
      expect(list.length).toBeGreaterThan(0);
      const args = parseArgs(list);
      expect(args.trigger).toBe(trigger);
      const sel = select({ packs: real, ...(args.tier !== undefined ? { tier: args.tier } : {}), named: args.packs, ...(args.tag !== undefined ? { tag: args.tag } : {}) });
      expect(ids(sel)).toEqual(expect.arrayContaining(smokeIds));
      if (["deploy", "nightly", "poll"].includes(trigger)) expect(args.tag).toBeUndefined();
    });
  }
});

describe("cli: argument parsing", () => {
  it("rejects unknown flags, missing values, repeated single flags and bad enum values", () => {
    expect(() => parseArgs(["plan", "--force"])).toThrow(UsageError);
    expect(() => parseArgs(["plan", "--target"])).toThrow("needs a value");
    expect(() => parseArgs(["plan", "--target", "staging", "--target", "production"])).toThrow("more than once");
    expect(() => parseArgs(["plan", "--target", "staging", "--tier", "huge"])).toThrow("--tier");
    expect(() => parseArgs(["plan", "--target", "staging", "--trigger", "cron"])).toThrow("--trigger");
    expect(() => parseArgs(["plan", "--target", "staging", "--tag", "ui"])).toThrow("--tag");
    expect(() => parseArgs(["plan", "--tier", "smoke"])).toThrow("--target is required");
  });

  it("does not accept flags owned by later tasks, nor a way to force past a guard", () => {
    for (const flag of ["--budget-usd", "--force", "--allow-destructive"]) {
      expect(() => parseArgs(["plan", "--target", "staging", flag, "x"]), flag).toThrow("unknown argument");
    }
    expect(() => parseArgs(["run", "--target", "staging", "--force", "x"])).toThrow("unknown argument");
    expect(parseArgs(["run", "--target", "staging"]).command).toBe("run");
  });

  it("splits comma lists and repeated --pack", () => {
    expect(parseArgs(["plan", "--target", "staging", "--pack", "a,b", "--pack", "c"]).packs).toEqual(["a", "b", "c"]);
  });

  it("an unknown pack name exits 2 with a clear message", async () => {
    const { io, err } = makeIo(scratchRoot([makePack({ id: "only" })]));
    expect(await main(["plan", "--target", "staging", "--pack", "ghost"], io)).toBe(2);
    expect(err.join("\n")).toContain('unknown pack "ghost"');
  });
});
