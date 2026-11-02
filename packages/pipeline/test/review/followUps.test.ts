import { describe, expect, it } from "vitest";
import { MAX_FOLLOW_UPS_READ, readFollowUps } from "../../src/review/followUps.js";
import { readVerdict } from "../../src/review/verdicts.js";

/** [unit] D#483 S5-b2d-1, C27-b2d1-4: the follow-ups reader. Every envelope is a fixture; the model is never called. */
describe("readFollowUps", () => {
  it("absent, null, a string, an object, a number: []", () => {
    for (const follow_ups of [undefined, null, "Add a retry", { title: "Add a retry", why: "" }, 3, true]) {
      const env = follow_ups === undefined ? { verdict: "pass" } : { verdict: "pass", follow_ups };
      expect(readFollowUps("succeeded", env), JSON.stringify(follow_ups)).toEqual([]);
    }
  });

  it("a run that did not succeed, and an envelope that is not a plain object, read as none", () => {
    const env = { follow_ups: [{ title: "Add a retry", why: "w" }] };
    for (const status of ["failed", "timed_out", "cancelled", "running", "Succeeded"]) expect(readFollowUps(status, env)).toEqual([]);
    for (const bad of [null, [], "x", Object.create({ follow_ups: env.follow_ups })]) expect(readFollowUps("succeeded", bad)).toEqual([]);
  });

  it("reads title and why; a missing why is empty; an item that is not an object or has a non-string field is skipped", () => {
    const env = { follow_ups: [{ title: "Add a retry", why: "flaky network" }, { title: "Log it" }, "plain", null, [1], { title: 7, why: "" }, { title: "t", why: 5 }] };
    expect(readFollowUps("succeeded", env)).toEqual([
      { title: "Add a retry", why: "flaky network" },
      { title: "Log it", why: "" },
    ]);
  });

  it("strips control characters and folds white space; keeps one character past each bound so the definer, not the reader, refuses an over-long item", () => {
    const [one] = readFollowUps("succeeded", { follow_ups: [{ title: "Add\u0000 a\u0007\n retry\u001b", why: " line one\r\nline\ttwo " }] });
    expect(one).toEqual({ title: "Add a retry", why: "line one line two" });
    const [long] = readFollowUps("succeeded", { follow_ups: [{ title: "x".repeat(500), why: "y".repeat(5000) }] });
    expect([long!.title.length, long!.why.length]).toEqual([121, 601]);
  });

  it("counts and cuts by characters (code points), as the definer does: an emoji counts once, and a cut never leaves half a pair", () => {
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const exact = "😀".repeat(120);
    const [atBound] = readFollowUps("succeeded", { follow_ups: [{ title: exact, why: "🧪".repeat(600) }] });
    // Exactly at the bound in characters (240 and 1200 UTF-16 units) is kept whole.
    expect(atBound).toEqual({ title: exact, why: "🧪".repeat(600) });
    for (const title of ["😀".repeat(500), "a" + "😀".repeat(500), "ab" + "👩‍💻".repeat(300)]) {
      const [cut] = readFollowUps("succeeded", { follow_ups: [{ title, why: "x" + "😀".repeat(900) }] });
      expect(Array.from(cut!.title).length, title.slice(0, 4)).toBe(121);
      expect(Array.from(cut!.why).length).toBe(601);
      expect(LONE.test(cut!.title) || LONE.test(cut!.why)).toBe(false);
      // What the writer sends: no `\ud83d`-style escape a jsonb cast would refuse.
      expect(JSON.stringify(cut)).not.toMatch(/\\ud[89a-f]/i);
    }
  });

  it("drops a surrogate with no partner from the model's own text", () => {
    expect(readFollowUps("succeeded", { follow_ups: [{ title: "a\uD800b\uDC00c", why: "\uDBFFend" }] })).toEqual([{ title: "abc", why: "end" }]);
  });

  it("hands on at most MAX_FOLLOW_UPS_READ items (the definer keeps 3 and counts the rest)", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ title: `t${i}`, why: "" }));
    expect(readFollowUps("succeeded", { follow_ups: many })).toHaveLength(MAX_FOLLOW_UPS_READ);
  });
});

describe("readVerdict with follow-ups", () => {
  it("carries them only when there is one; the verdict word, the findings and the flags read exactly as without", () => {
    const base = { verdict: "needs-fix", findings: ["a"], summary: "s", security_review_needed: true };
    const without = readVerdict("succeeded", base);
    const withFu = readVerdict("succeeded", { ...base, follow_ups: [{ title: "Add a retry", why: "w" }] });
    expect(without.followUps).toBeUndefined();
    expect(withFu.followUps).toEqual([{ title: "Add a retry", why: "w" }]);
    const rest: Partial<typeof withFu> = { ...withFu };
    delete rest.followUps;
    expect(rest).toEqual(without);
    for (const follow_ups of [null, "x", { title: "t" }, []]) expect(readVerdict("succeeded", { ...base, follow_ups })).toEqual(without);
    expect(readVerdict("failed", { ...base, follow_ups: [{ title: "t", why: "" }] }).followUps).toBeUndefined();
  });
});
