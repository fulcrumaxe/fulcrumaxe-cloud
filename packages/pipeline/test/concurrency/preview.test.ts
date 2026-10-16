import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assemblePreview, canonicalJson, previewHash, type PreviewInputs, type PreviewItem } from "../../src/concurrency/preview.js";

/** D#483 S5-c2 [unit]: the preview arithmetic, held to figures worked by hand. */

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const read = (rel: string): string => readFileSync(path.join(srcDir, rel), "utf8");

const item = (repoId: string, waiting: boolean, slotPhaseUsd: number, priced = true): PreviewItem => ({ repoId, waiting, slotPhaseUsd, priced });

/** Five items: A holds one and has one waiting, B has one waiting, C has two waiting (one of them unpriced). */
const fiveItems = (): PreviewItem[] => [item("A", false, 1.0), item("A", true, 0.5), item("B", true, 0.5), item("C", true, 0.3), item("C", true, 0, false)];
const limits = (n: number) => new Map([["A", n], ["B", n], ["C", n]]);

const base = (over: Partial<PreviewInputs> = {}): PreviewInputs => ({
  scope: { kind: "account" },
  from: 2,
  to: 10,
  items: fiveItems(),
  repoLimits: limits(5),
  holdMinutes: 60,
  holdBasis: "history",
  sBar: { usd: 0.5, basis: "history" },
  ...over,
});

describe("S5c2-1: the figures, by hand", () => {
  it("a raise from 2 to 10 over three repos that could each build up to 5 at once", () => {
    // n = A:2, B:1, C:2 -> reach = min(5,2)+min(5,1)+min(5,2) = 5. L_eff(2) = 2, L_eff(10) = 5.
    // clear: ceil(5/2) x 60 = 180 minutes, then ceil(5/5) x 60 = 60 minutes.
    // extra per hour: (5 - 2) x $0.50 / 1 h = $1.50 -> 150 cents; per day 24 x = 3600 cents.
    // queue total: 1.00 + 0.50 + 0.50 + 0.30 = $2.30 (the unpriced item adds nothing).
    const p = assemblePreview(base());
    expect(p).toMatchObject({
      scope: "account",
      repo_id: null,
      kind: "raise",
      from: 2,
      to: 10,
      items: 5,
      unpriced_items: 1,
      effective_limit_old: 2,
      effective_limit_new: 5,
      clear_minutes_old: 180,
      clear_minutes_new: 60,
      extra_per_hour_cents: 150,
      extra_per_day_cents: 3600,
      queue_total_cents: 230,
      basis: "history",
    });
    expect(p.notes.map((n) => n.code)).toEqual(["unpriced_items", "same_total", "limited_by_repos"]);
    // the repos could each build 5 at once here (after D#598), so the sentence does not claim the one-per-repo rule
    expect(p.notes.find((n) => n.code === "limited_by_repos")!.text).toBe("With the work there is, at most 5 builds run at once.");
    expect(p.notes.find((n) => n.code === "unpriced_items")!.text).toBe("1 waiting item can't be priced yet.");
    expect(p.notes.find((n) => n.code === "same_total")!.text).toBe("The same work costs the same in total. A higher limit spends it sooner.");
  });

  it("a slot-hold of 90 minutes changes the clear time and the hourly rate, not the number of waves", () => {
    const p = assemblePreview(base({ holdMinutes: 90 }));
    expect(p.clear_minutes_old).toBe(3 * 90);
    expect(p.clear_minutes_new).toBe(90);
    // (5 - 2) x 0.50 / 1.5 h = $1.00 an hour
    expect(p.extra_per_hour_cents).toBe(100);
    expect(p.extra_per_day_cents).toBe(2400);
  });

  it("with the one-per-repo clamp, the account value cannot pass the number of repos with work, and the preview says so", () => {
    const p = assemblePreview(base({ from: 4, to: 10, repoLimits: limits(1) }));
    expect(p.effective_limit_old).toBe(3);
    expect(p.effective_limit_new).toBe(3);
    expect(p.clear_minutes_old).toBe(2 * 60);
    expect(p.clear_minutes_new).toBe(2 * 60);
    expect(p.extra_per_hour_cents).toBe(0);
    expect(p.extra_per_day_cents).toBe(0);
    const note = p.notes.find((n) => n.code === "limited_by_repos");
    expect(note?.text).toBe("Only 3 repos have work, and each repo builds one item at a time for now, so at most 3 builds run at once.");
  });

  it("a lowering shows a saving as a negative figure and carries no 'same total' sentence", () => {
    const p = assemblePreview(base({ from: 10, to: 2 }));
    expect(p.kind).toBe("lower");
    expect(p.effective_limit_old).toBe(5);
    expect(p.effective_limit_new).toBe(2);
    expect(p.extra_per_hour_cents).toBe(-150);
    expect(p.extra_per_day_cents).toBe(-3600);
    expect(p.clear_minutes_old).toBe(60);
    expect(p.clear_minutes_new).toBe(180);
    expect(p.notes.map((n) => n.code)).not.toContain("same_total");
  });

  it("an equal value is 'same' with no change in any figure", () => {
    const p = assemblePreview(base({ from: 4, to: 4 }));
    expect(p.kind).toBe("same");
    expect(p.clear_minutes_old).toBe(p.clear_minutes_new);
    expect(p.extra_per_hour_cents).toBe(0);
  });

  it("repo scope while the clamp holds shows no speed-up and no extra spend, with the reason", () => {
    const items = [item("R", false, 0.4), item("R", true, 0.4), item("R", true, 0.4)];
    const p = assemblePreview(base({ scope: { kind: "repo", repoId: "R" }, from: 2, to: 5, items, repoLimits: limits(1) }));
    expect(p.repo_id).toBe("R");
    expect(p.effective_limit_old).toBe(1);
    expect(p.effective_limit_new).toBe(1);
    expect(p.clear_minutes_old).toBe(p.clear_minutes_new);
    expect(p.clear_minutes_new).toBe(3 * 60);
    expect(p.extra_per_hour_cents).toBe(0);
    expect(p.extra_per_day_cents).toBe(0);
    expect(p.queue_total_cents).toBe(120);
    const note = p.notes.find((n) => n.code === "one_build_per_repo_until_d598");
    expect(note?.text).toBe("This applies once parallel builds on one repo are supported.");
  });

  it("repo scope with a value of 1 raises nothing and carries no clamp sentence", () => {
    const p = assemblePreview(base({ scope: { kind: "repo", repoId: "R" }, from: 2, to: 1, items: [item("R", true, 0.4)], repoLimits: limits(1) }));
    expect(p.notes.map((n) => n.code)).not.toContain("one_build_per_repo_until_d598");
  });
});

describe("S5c2-1: the no-item and no-estimate cases", () => {
  it("nothing waiting or holding: zero figures, 0 minutes, the sentence, and no price source is needed", () => {
    const p = assemblePreview(base({ items: [], sBar: null, holdBasis: "seed" }));
    expect(p).toMatchObject({ items: 0, clear_minutes_old: 0, clear_minutes_new: 0, extra_per_hour_cents: 0, extra_per_day_cents: 0, queue_total_cents: 0, basis: "seed", unpriced_items: 0 });
    expect(p.notes).toEqual([{ code: "nothing_waiting", text: "Nothing is waiting for a build slot." }]);
  });

  it("items but no price source at all: the spend fields are absent, the basis is none, and the sentence says why", () => {
    const p = assemblePreview(base({ sBar: null }));
    expect(p.basis).toBe("none");
    expect("extra_per_hour_cents" in p).toBe(false);
    expect("extra_per_day_cents" in p).toBe(false);
    expect("queue_total_cents" in p).toBe(false);
    // the time figures still stand
    expect(p.clear_minutes_old).toBe(180);
    expect(p.notes.find((n) => n.code === "cannot_price")?.text).toBe("We can't price this yet: nothing waiting has an estimate and this account has no finished builds.");
  });

  it("a seed price source, or a seed slot-hold, makes the basis seed", () => {
    expect(assemblePreview(base({ sBar: { usd: 0.5, basis: "seed" } })).basis).toBe("seed");
    expect(assemblePreview(base({ holdBasis: "seed" })).basis).toBe("seed");
  });

  it("the unpriced count is plural-aware and counts waiting items only", () => {
    const items = [item("A", true, 0, false), item("A", true, 0, false), item("A", false, 0, false), item("B", true, 0.2)];
    const p = assemblePreview(base({ items }));
    expect(p.unpriced_items).toBe(2);
    expect(p.notes.find((n) => n.code === "unpriced_items")?.text).toBe("2 waiting items can't be priced yet.");
  });

  it("never produces NaN, Infinity or a missing number, even from a bad price or a zero hold", () => {
    const p = assemblePreview(base({ holdMinutes: 0, sBar: { usd: Number.NaN, basis: "seed" }, items: [item("A", true, Number.POSITIVE_INFINITY)] }));
    for (const v of [p.clear_minutes_old, p.clear_minutes_new, p.extra_per_hour_cents, p.extra_per_day_cents, p.queue_total_cents, p.effective_limit_old, p.effective_limit_new]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(p.clear_minutes_old).toBe(1);
  });
});

describe("the preview hash", () => {
  it("is the sha256 of the sorted-key JSON of the named facts, and ignores everything else", () => {
    const p = assemblePreview(base());
    const again = assemblePreview(base());
    expect(again.preview_hash).toBe(p.preview_hash);
    expect(p.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    // notes, items and the effective limits are not hashed
    expect(previewHash({ ...p, items: 0, notes: [] } as never)).toBe(p.preview_hash);
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("changes when any hashed fact changes: the target, a price by one cent, an item, the hold, or the basis", () => {
    const h = (o: Partial<PreviewInputs>) => assemblePreview(base(o)).preview_hash;
    const ref = h({});
    expect(h({ to: 11 })).not.toBe(ref);
    expect(h({ sBar: { usd: 0.51, basis: "history" } })).not.toBe(ref);
    expect(h({ items: [...fiveItems(), item("B", true, 0.5)] })).not.toBe(ref);
    expect(h({ holdMinutes: 61 })).not.toBe(ref);
    expect(h({ sBar: { usd: 0.5, basis: "seed" } })).not.toBe(ref);
    expect(h({ scope: { kind: "repo", repoId: "A" }, items: fiveItems().filter((i) => i.repoId === "A") })).not.toBe(ref);
  });

  it("hashes an absent figure as null, so none-basis previews are still bound", () => {
    const a = assemblePreview(base({ sBar: null }));
    const b = assemblePreview(base({ sBar: null, to: 11 }));
    expect(a.preview_hash).not.toBe(b.preview_hash);
    expect(a.preview_hash).toBe(assemblePreview(base({ sBar: null })).preview_hash);
  });
});

describe("S5c2: where the module sits in the import graph", () => {
  const importsOf = (rel: string): string[] => [...read(rel).matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);

  it("the slot code still imports nothing from the plan data, and the estimate nothing from the slot code (S5c1-6, S5p-5)", () => {
    expect(importsOf("advance/buildSlots.ts").filter((s) => s.includes("plan-data"))).toEqual([]);
    for (const f of ["estimate/estimateItem.ts", "estimate/slotHold.ts", "estimate/runPlan.ts", "estimate/index.ts"]) {
      expect(importsOf(f).filter((s) => s.includes("buildSlots") || s.includes("concurrency")), f).toEqual([]);
    }
  });

  it("the concurrency module reads no plan tier, and prices only through the S5-p estimate", () => {
    for (const f of ["concurrency/preview.ts", "concurrency/setting.ts"]) {
      expect(importsOf(f).filter((s) => s.includes("plan-data")), f).toEqual([]);
    }
    expect(importsOf("concurrency/preview.ts")).toEqual(expect.arrayContaining(["../estimate/estimateItem.js", "../estimate/slotHold.js"]));
    const text = read("concurrency/preview.ts");
    // no price table, no per-model figure, no compute rate of its own
    expect(text).not.toMatch(/computeComputeUsd|sandboxComputeUsdFor|medianCostPerRunSeedUsd|MEDIAN_MIN_RUNS/);
  });
});
