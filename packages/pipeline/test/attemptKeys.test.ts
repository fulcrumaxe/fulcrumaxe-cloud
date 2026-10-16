import { describe, expect, it } from "vitest";
import { attemptBase, attemptKey, attemptOfKey, nextAttempt, nextAttemptKey } from "../src/advance/attemptKeys.js";

/** D#483 S5k1b-10: the one attempt-key helper every waiting stage uses. */
describe("the attempt-key helper", () => {
  const base = "build:v3:0f3c9c1e-1111-4222-8333-444455556666";

  it("the first ask gets the bare key", () => {
    expect(nextAttemptKey(base, [])).toBe(base);
    expect(nextAttempt(base, [])).toBe(0);
  });

  it("once the bare key's run exists the next ask is :s1, then one more than the highest", () => {
    expect(nextAttemptKey(base, [base])).toBe(`${base}:s1`);
    expect(nextAttemptKey(base, [base, `${base}:s1`, `${base}:s2`])).toBe(`${base}:s3`);
    // The highest wins whatever order the rows come back in, and a gap is not filled.
    expect(nextAttemptKey(base, [`${base}:s7`, base, `${base}:s2`])).toBe(`${base}:s8`);
  });

  it("a replay after a crash: the run the crashed ask made is seen, so the replay moves on; one that made nothing asks the same question again", () => {
    const afterCrashWithRun = [base, `${base}:s1`];
    expect(nextAttemptKey(base, afterCrashWithRun)).toBe(`${base}:s2`);
    expect(nextAttemptKey(base, [base])).toBe(`${base}:s1`);
    expect(nextAttemptKey(base, [base])).toBe(`${base}:s1`);
  });

  it("a key that already ends in :s<n> is read as its base", () => {
    expect(attemptBase(`${base}:s4`)).toBe(base);
    expect(nextAttemptKey(`${base}:s4`, [base, `${base}:s1`])).toBe(`${base}:s2`);
    expect(attemptKey(`${base}:s4`, 0)).toBe(base);
    expect(attemptKey(`${base}:s4`, 6)).toBe(`${base}:s6`);
  });

  it("a re-review round (:rr<n>) is part of the base: the attempt goes after it and never collides with it", () => {
    const review = "review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:code_reviewer";
    const rr = `${review}:rr2`;
    expect(nextAttemptKey(rr, [rr])).toBe(`${rr}:s1`);
    // The round-0 key's attempts and the round-2 key's attempts are different families.
    expect(nextAttempt(review, [rr, `${rr}:s5`])).toBe(0);
    expect(nextAttempt(rr, [review, `${review}:s9`])).toBe(0);
    expect(attemptOfKey(`${rr}:s5`)).toBe(5);
    expect(attemptOfKey(rr)).toBe(0);
  });

  it("a note pin after the suffix is read through and does not change the family", () => {
    const pinned = `${base}:s2:n0123456789abcdef`;
    expect(attemptOfKey(pinned)).toBe(2);
    expect(attemptBase(pinned)).toBe(base);
    expect(nextAttemptKey(base, [base, pinned])).toBe(`${base}:s3`);
  });

  it("keys of other steps are ignored", () => {
    expect(nextAttemptKey(base, [`build:v3:other:s9`, "spec:x:s4"])).toBe(base);
  });

  it("only a non-negative whole attempt gets a suffix", () => {
    expect(attemptKey(base, -1)).toBe(base);
    expect(attemptKey(base, 1.5)).toBe(base);
    expect(attemptKey(base, Number.NaN)).toBe(base);
  });
});
