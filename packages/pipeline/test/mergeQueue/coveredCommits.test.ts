import { describe, expect, it } from "vitest";
import { CONFLICT_COMMIT_READS_MAX, coveredCommits, type PlatformPush } from "../../src/mergeQueue/conflict.js";

/**
 * D#519 C10-1: the push-record walk, pure. A record (old, new) covers new and its ancestors inside the pull request, minus old and its ancestors; a record
 * that created the branch is bounded below by the run's start commit instead. Anything it cannot bound covers nothing.
 */
const sha = (c: string) => c.repeat(40);
const ZERO = "0".repeat(40);
const OUT = sha("f"); // a commit outside the pull request (the merge base, a default-branch commit, or a rewritten one)
// a <- b <- c <- d, and a merge m with parents [d, OUT]
const parents = new Map<string, readonly string[]>([
  [sha("a"), [OUT]],
  [sha("b"), [sha("a")]],
  [sha("c"), [sha("b")]],
  [sha("d"), [sha("c")]],
  [sha("e"), [sha("d"), OUT]],
]);
const P = ["a", "b", "c", "d", "e"].map(sha);
const push = (oldSha: string | null, newSha: string, startSha: string | null = null): PlatformPush => ({ oldSha, newSha, startSha, runId: "run" });
const cover = (...pushes: PlatformPush[]) => {
  const out = coveredCommits(P, parents, { pushes });
  return out === "unreadable" ? out : [...out].sort();
};

describe("C10-1 coveredCommits", () => {
  it("a create record covers reach(new) minus reach(start)", () => {
    expect(cover(push(null, sha("c"), sha("a")))).toEqual([sha("b"), sha("c")]);
    expect(cover(push(ZERO, sha("c"), sha("a")))).toEqual([sha("b"), sha("c")]);
    // No start: the run began at the default branch, so nothing in the pull request is below it.
    expect(cover(push(null, sha("c")))).toEqual([sha("a"), sha("b"), sha("c")]);
    // A start outside the pull request bounds nothing inside it.
    expect(cover(push(null, sha("b"), OUT))).toEqual([sha("a"), sha("b")]);
  });

  it("a record with old in the pull request covers reach(new) minus reach(old)", () => {
    expect(cover(push(sha("b"), sha("d")))).toEqual([sha("c"), sha("d")]);
    expect(cover(push(sha("d"), sha("e")))).toEqual([sha("e")]);
    // The start is ignored when old is known.
    expect(cover(push(sha("c"), sha("d"), sha("a")))).toEqual([sha("d")]);
    // Records add up; a gap between them stays uncovered.
    expect(cover(push(null, sha("a")), push(sha("c"), sha("e")))).toEqual([sha("a"), sha("d"), sha("e")]);
  });

  it("a record with a non-zero old outside the pull request covers nothing (history was rewritten)", () => {
    expect(cover(push(OUT, sha("e")))).toEqual([]);
    expect(cover(push(sha("9"), sha("b"), null))).toEqual([]);
  });

  it("a record with new outside the pull request covers nothing", () => {
    expect(cover(push(null, OUT))).toEqual([]);
    expect(cover(push(sha("a"), sha("9")))).toEqual([]);
  });

  it("the walk never leaves the pull request: a parent outside it is not followed", () => {
    // e's second parent is OUT; OUT is never in the answer.
    expect(cover(push(null, sha("e")))).toEqual(P.slice().sort());
  });

  it("a commit is never covered by its own author fields: the walk sees shas and parents only", () => {
    expect(cover()).toEqual([]);
  });

  it("more than 100 pull request commits is unreadable", () => {
    const many = Array.from({ length: CONFLICT_COMMIT_READS_MAX + 1 }, (_, i) => (i + 1).toString(16).padStart(40, "a"));
    expect(coveredCommits(many, new Map(), { pushes: [push(null, many[0]!)] })).toBe("unreadable");
    expect(coveredCommits(many.slice(1), new Map(), { pushes: [push(null, many[1]!)] })).not.toBe("unreadable");
  });
});
