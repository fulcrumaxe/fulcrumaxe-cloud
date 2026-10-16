import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORK_ITEM_STAGES } from "@fx/core/src/work-items/stages.js";
import {
  BUILD_SLOT_STAGES,
  BUILD_WAIT_REASONS,
  BUILD_SLOT_POLL_SECONDS,
  WAITER_WINDOW_SECONDS,
  ONE_BUILD_PER_REPO_UNTIL_D598,
  START_BUILDS_PER_ACCOUNT,
  START_BUILDS_PER_REPO,
  decideSlot,
  resolveBuildLimits,
  type SlotInputs,
} from "../src/advance/buildSlots.js";

/** D#483 S5-c1: the pure half of the build slots, and the lists other packages repeat. */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

const base = (over: Partial<SlotInputs> = {}): SlotInputs => ({
  limits: resolveBuildLimits({ accountValue: null, repoValue: null }),
  hosted: true,
  repoHeld: 0,
  accountHeldHosted: 0,
  repoWaiterAhead: false,
  accountWaiterAhead: false,
  ...over,
});

describe("build limits", () => {
  it("with no setting the starting values are 2 per repository and 4 per account, and the repository value is clamped to one until D#598", () => {
    expect(resolveBuildLimits({ accountValue: null, repoValue: null })).toEqual({ repoValue: START_BUILDS_PER_REPO, repoLimit: ONE_BUILD_PER_REPO_UNTIL_D598, accountValue: START_BUILDS_PER_ACCOUNT });
    expect(START_BUILDS_PER_REPO).toBe(2);
    expect(START_BUILDS_PER_ACCOUNT).toBe(4);
    expect(ONE_BUILD_PER_REPO_UNTIL_D598).toBe(1);
  });

  it("the person's account value is used as set, with no ceiling; a repository value above one is still clamped", () => {
    expect(resolveBuildLimits({ accountValue: 10, repoValue: 5 })).toEqual({ repoValue: 5, repoLimit: ONE_BUILD_PER_REPO_UNTIL_D598, accountValue: 10 });
    expect(resolveBuildLimits({ accountValue: 100_000, repoValue: 1 }).accountValue).toBe(100_000);
  });
});

describe("the slot decision", () => {
  it("grants when nothing is held", () => {
    expect(decideSlot(base())).toEqual({ granted: true });
  });

  it("a second build on one repository waits with the D#598 reason while the person's value is above the clamp, and with the plain repository reason when the value is one", () => {
    expect(decideSlot(base({ repoHeld: 1 }))).toEqual({ granted: false, reason: "one_build_per_repo_until_d598" });
    expect(decideSlot(base({ repoHeld: 1, limits: resolveBuildLimits({ accountValue: null, repoValue: 5 }) }))).toEqual({ granted: false, reason: "one_build_per_repo_until_d598" });
    expect(decideSlot(base({ repoHeld: 1, limits: resolveBuildLimits({ accountValue: null, repoValue: 1 }) }))).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
  });

  it("the account value limits hosted items only, after the repository rule", () => {
    expect(decideSlot(base({ accountHeldHosted: 4 }))).toEqual({ granted: false, reason: "waiting_for_build_slot_account" });
    expect(decideSlot(base({ accountHeldHosted: 4, limits: resolveBuildLimits({ accountValue: 10, repoValue: null }) }))).toEqual({ granted: true });
    expect(decideSlot(base({ accountHeldHosted: 99, hosted: false }))).toEqual({ granted: true });
    // Both full: the repository's own reason is the one shown.
    expect(decideSlot(base({ repoHeld: 1, accountHeldHosted: 4 }))).toEqual({ granted: false, reason: "one_build_per_repo_until_d598" });
  });

  it("a free slot goes to the better-ordered waiter: the worse one gives way with the scope's reason", () => {
    expect(decideSlot(base({ repoWaiterAhead: true }))).toEqual({ granted: false, reason: "one_build_per_repo_until_d598" });
    expect(decideSlot(base({ accountWaiterAhead: true }))).toEqual({ granted: false, reason: "waiting_for_build_slot_account" });
    expect(decideSlot(base({ accountWaiterAhead: true, hosted: false }))).toEqual({ granted: true });
  });
});

describe("the lists this module shares", () => {
  it("every slot stage is a real stage, and a finished or not-yet-started stage never holds one", () => {
    for (const s of BUILD_SLOT_STAGES) expect(WORK_ITEM_STAGES as readonly string[]).toContain(s);
    for (const s of ["triaged", "discussing", "spec_ready", "needs_human", "merged", "closed_unmerged", "closed"]) expect(BUILD_SLOT_STAGES).not.toContain(s);
  });

  it("the workflow and the worker repeat the wait reasons, and the lists are equal to this module's", () => {
    const listIn = (src: string): string[] => {
      const m = /BUILD_SLOT_WAIT_REASONS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
      expect(m).not.toBeNull();
      return [...m![1]!.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
    };
    expect(listIn(read("../../../apps/web/workflows/workItemAdvance.ts"))).toEqual([...BUILD_WAIT_REASONS]);
    expect(listIn(read("../../worker/src/advance.ts"))).toEqual([...BUILD_WAIT_REASONS]);
  });
});

describe("the waiter window follows the workflow's poll", () => {
  it("the workflow polls every BUILD_SLOT_POLL_SECONDS and a waiter counts for three polls", () => {
    const m = /BUILD_SLOT_POLL_MS = ([0-9_]+);/.exec(read("../../../apps/web/workflows/workItemAdvance.ts"));
    expect(Number(m![1]!.replaceAll("_", "")) / 1000).toBe(BUILD_SLOT_POLL_SECONDS);
    expect(WAITER_WINDOW_SECONDS).toBe(3 * BUILD_SLOT_POLL_SECONDS);
  });
});

describe("no plan tier can set a limit (import-graph)", () => {
  it("the slot module imports nothing from the plan-data package, directly or through a relative file that does", () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        expect(spec, `${file} imports ${spec}`).not.toMatch(/plan-data/);
        if (spec.startsWith(".")) visit(join(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    };
    visit(join(here, "../src/advance/buildSlots.ts"));
    expect(seen.size).toBe(1);
  });
});
