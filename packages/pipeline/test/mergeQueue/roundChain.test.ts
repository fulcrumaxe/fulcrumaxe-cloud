import { describe, expect, it } from "vitest";
import { chainHeads, deltaInput, readMergeCommit, readPlainDiff, roundSource, type ConflictRound, type DeltaSource } from "../../src/mergeQueue/index.js";

/**
 * D#483: a chain of conflict rounds (each one "conflicted again" until the last) is reviewed from the head last fully reviewed. The readers are pure over a stub of GitHub's
 * reads, so every shape (merge-commit round, plain-diff renumber round, broken link) is shown here without a database.
 */
const A = "a".repeat(40);
const M1 = "1".repeat(40);
const M2 = "2".repeat(40);
const MAIN = "d".repeat(40);
const OTHER = "9".repeat(40);
const entry = { accountId: "a", repoId: "r", prNumber: 7 } as never;

const round = (o: Partial<ConflictRound> & Pick<ConflictRound, "id" | "fromSha" | "toSha" | "outcome">): ConflictRound =>
  ({ accountId: "a", repoId: "r", workItemId: "w", entryId: null, round: 1, baseSha: MAIN, baseRef: "main", conflictFiles: [], kind: "conflict", runId: null, createdAt: new Date(0), endedAt: null, ...o }) as ConflictRound;

type Commit = { parents: string[]; files: string[] | null };
function stub(head: string, commits: Record<string, Commit>, compares: Record<string, { status: "ahead" | "diverged"; files: string[] | null; truncated?: boolean }>) {
  const calls: string[] = [];
  return {
    calls,
    github: {
      getMergeability: async () => ({ state: "open", merged: false, headSha: head }) as never,
      getCommit: async (_pr: unknown, sha: string) => {
        calls.push(`commit ${sha}`);
        return commits[sha] as never;
      },
      compareToBase: async () => ({ files: null }) as never,
      compareCommits: async (_pr: unknown, a: string, b: string) => {
        calls.push(`compare ${a}...${b}`);
        const c = compares[`${a}...${b}`];
        return (c ? { status: c.status, files: c.files, filesTruncated: c.truncated ?? false } : { status: "diverged", files: null, filesTruncated: false }) as never;
      },
    },
  };
}

describe("D#483 chainHeads / roundSource", () => {
  const r1 = round({ id: "1", fromSha: A, toSha: M1, outcome: "conflicted_again" });
  const r2 = round({ id: "2", round: 2, fromSha: M1, toSha: M2, outcome: null });

  it("a single round has no chain: its source is exactly the old one", () => {
    expect(chainHeads([r1], r1)).toEqual([A]);
    expect(roundSource([r1], r1, M1, MAIN)).toEqual({ fromSha: A, toSha: M1, baseSha: MAIN, trigger: "conflict_resolution" });
  });

  it("round 2 of a chain that conflicted again starts the review at the head round 1 began at", () => {
    expect(chainHeads([r1, r2], r2)).toEqual([A, M1]);
    expect(roundSource([r1, r2], r2, M2, MAIN)).toEqual({ fromSha: M1, toSha: M2, baseSha: MAIN, trigger: "conflict_resolution", chain: [A, M1] });
  });

  it("an earlier round that was resolved (and so reviewed) is no part of the chain; nor is an unrelated one", () => {
    expect(chainHeads([{ ...r1, outcome: "resolved" }, r2], r2)).toEqual([M1]);
    expect(chainHeads([{ ...r1, toSha: OTHER }, r2], r2)).toEqual([M1]);
  });

  it("three rounds walk back to the first, and a cycle in the rows ends the walk", () => {
    const r3 = round({ id: "3", round: 3, fromSha: M2, toSha: OTHER, outcome: null });
    expect(chainHeads([r1, { ...r2, outcome: "conflicted_again" }, r3], r3)).toEqual([A, M1, M2]);
    const loop = [round({ id: "x", fromSha: M1, toSha: M2, outcome: "conflicted_again" }), round({ id: "y", fromSha: M2, toSha: M1, outcome: "conflicted_again" })];
    expect(chainHeads(loop, loop[0]!).length).toBeLessThanOrEqual(3);
  });

  it("a renumber round continuing a chain keeps its trigger", () => {
    const rn = round({ id: "3", kind: "renumber", fromSha: M1, toSha: M2, outcome: null });
    expect(roundSource([r1, rn], rn, M2, null)).toMatchObject({ trigger: "renumber", chain: [A, M1] });
  });
});

describe("D#483 the readers over a chain", () => {
  const commits: Record<string, Commit> = {
    [M1]: { parents: [A, MAIN], files: ["src/a.ts", "src/extra.ts"] },
    [M2]: { parents: [M1, MAIN], files: ["src/a.ts"] },
  };
  const all = { status: "ahead" as const, files: ["src/a.ts", "src/extra.ts", "src/main.ts"] };
  const src: DeltaSource = { fromSha: M1, toSha: M2, baseSha: MAIN, trigger: "conflict_resolution", chain: [A, M1] };

  it("a merge-commit chain: the review is told the whole chain's files and parents from the origin; the merge commit's own list is kept for the main-side test", async () => {
    const s = stub(M2, commits, { [`${A}...${M2}`]: all });
    const read = await readMergeCommit(s.github as never, entry, src);
    expect(read).toEqual({ ok: true, files: all.files, own: ["src/a.ts"], baseSha: MAIN });
    expect(deltaInput(src, read.ok ? read.files : [], MAIN)).toMatchObject({ mergeCommitSha: M2, parents: [A, MAIN], changedFiles: all.files });
    // The merge commit is read, and so is the earlier link.
    expect(s.calls).toEqual([`commit ${M2}`, `commit ${M1}`, `compare ${A}...${M2}`]);
  });

  it("a single round reads exactly what it did: the merge commit only, no compare", async () => {
    const s = stub(M1, commits, {});
    const read = await readMergeCommit(s.github as never, entry, { fromSha: A, toSha: M1, baseSha: MAIN, trigger: "conflict_resolution" });
    expect(read).toEqual({ ok: true, files: ["src/a.ts", "src/extra.ts"], own: ["src/a.ts", "src/extra.ts"], baseSha: MAIN });
    expect(s.calls).toEqual([`commit ${M1}`]);
  });

  it("a link of the chain that no longer has the earlier head as its first parent, or is not a merge commit, stops: head_changed", async () => {
    for (const bad of [{ parents: [OTHER, MAIN], files: ["x"] }, { parents: [A], files: ["x"] }]) {
      const s = stub(M2, { ...commits, [M1]: bad }, { [`${A}...${M2}`]: all });
      expect(await readMergeCommit(s.github as never, entry, src)).toEqual({ ok: false, reason: "head_changed" });
    }
  });

  it("the round's own commit still has to have the round's pre-round head as first parent (a foreign commit between M1 and M2)", async () => {
    const s = stub(M2, { ...commits, [M2]: { parents: [OTHER, MAIN], files: ["src/a.ts"] } }, { [`${A}...${M2}`]: all });
    expect(await readMergeCommit(s.github as never, entry, src)).toEqual({ ok: false, reason: "head_changed" });
  });

  it("a chain diff that is unreadable, truncated, empty or not ahead is no review input: invalid_input", async () => {
    for (const c of [undefined, { status: "ahead" as const, files: null }, { status: "ahead" as const, files: ["a"], truncated: true }, { status: "ahead" as const, files: [] }, { status: "diverged" as const, files: ["a"] }]) {
      const s = stub(M2, commits, c ? { [`${A}...${M2}`]: c } : {});
      expect(await readMergeCommit(s.github as never, entry, src)).toEqual({ ok: false, reason: "invalid_input" });
    }
  });

  it("a chain whose last head is not the round's pre-round head is refused", async () => {
    const s = stub(M2, commits, { [`${A}...${M2}`]: all });
    expect(await readMergeCommit(s.github as never, entry, { ...src, chain: [A, OTHER] })).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("a renumber round that continues a chain: the review reads the plain diff from the origin, and the round's own diff is kept for the scope test", async () => {
    const plain: Record<string, Commit> = { ...commits, [M2]: { parents: [M1], files: ["db/0002.sql"] } };
    const rn: DeltaSource = { fromSha: M1, toSha: M2, baseSha: null, trigger: "renumber", chain: [A, M1] };
    const s = stub(M2, plain, { [`${M1}...${M2}`]: { status: "ahead", files: ["db/0002.sql"] }, [`${A}...${M2}`]: all });
    const read = await readPlainDiff(s.github as never, entry, rn);
    expect(read).toEqual({ ok: true, files: all.files, own: ["db/0002.sql"], baseSha: M1 });
    expect(deltaInput(rn, all.files, M1)).toMatchObject({ parents: [A], parentRoles: ["pr_side"], changedFiles: all.files });
    // A broken link stops it, as for a merge-commit chain; a single renumber round reads only its own diff.
    const broken = stub(M2, { ...plain, [M1]: { parents: [OTHER, MAIN], files: ["x"] } }, { [`${M1}...${M2}`]: { status: "ahead", files: ["db/0002.sql"] }, [`${A}...${M2}`]: all });
    expect(await readPlainDiff(broken.github as never, entry, rn)).toEqual({ ok: false, reason: "head_changed" });
    const one = stub(M2, plain, { [`${M1}...${M2}`]: { status: "ahead", files: ["db/0002.sql"] } });
    expect(await readPlainDiff(one.github as never, entry, { fromSha: M1, toSha: M2, baseSha: null, trigger: "renumber" })).toEqual({ ok: true, files: ["db/0002.sql"], own: ["db/0002.sql"], baseSha: M1 });
    expect(one.calls).toEqual([`commit ${M2}`, `compare ${M1}...${M2}`]);
  });

  it("the main-side-only test reads the merge commit's OWN list, not the chain's: M1 touches the PR's files, M2 does not", async () => {
    // The completion tests (conflictComplete) pin the decision; this pins the reader that feeds it: `own` differs from `files` exactly when a chain is read.
    const commitsM2: Record<string, Commit> = { ...commits, [M2]: { parents: [M1, MAIN], files: ["docs/main-only.md"] } };
    const s = stub(M2, commitsM2, { [`${A}...${M2}`]: { status: "ahead", files: ["src/a.ts", "src/extra.ts", "docs/main-only.md"] } });
    const read = await readMergeCommit(s.github as never, entry, src);
    expect(read).toEqual({ ok: true, files: ["src/a.ts", "src/extra.ts", "docs/main-only.md"], own: ["docs/main-only.md"], baseSha: MAIN });
  });
});

describe("D#483 the delta input of a chain", () => {
  const chained: DeltaSource = { fromSha: M1, toSha: M2, baseSha: MAIN, trigger: "conflict_resolution", chain: [A, M1] };

  it("names the earlier merge commits (the heads after the origin) and nothing else; a single round names none", () => {
    expect(deltaInput(chained, ["src/a.ts"], MAIN)).toMatchObject({ parents: [A, MAIN], earlierMerges: [M1] });
    expect(deltaInput({ ...chained, fromSha: OTHER, chain: [A, M1, OTHER] }, ["src/a.ts"], MAIN)).toMatchObject({ earlierMerges: [M1, OTHER] });
    expect(deltaInput({ ...chained, trigger: "renumber", baseSha: null }, ["x"], M1)).toMatchObject({ parents: [A], earlierMerges: [M1] });
    for (const single of [{ fromSha: A, toSha: M1, baseSha: MAIN, trigger: "conflict_resolution" as const }, { ...chained, chain: undefined }, { ...chained, chain: [A] }]) {
      expect(deltaInput(single as DeltaSource, ["src/a.ts"], MAIN)).not.toHaveProperty("earlierMerges");
    }
  });
});
