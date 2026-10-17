import { describe, expect, it } from "vitest";
import type { GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import { isCleanMerge, readMergeOnly, readTreeEntries } from "../../src/review/mergeOnly.js";
import { commit, sha40, withGitGraph, type FakeGraph } from "./helpers/fakeGitGraph.js";

/**
 * D#598 P7c: the GitHub reads behind the delta re-check, over a history that answers like the real compare, git-commit and git-tree calls.
 * The rule under test: a new head is carried only when its tree is the clean three-way merge of the reviewed head and the second parent.
 */
const notFound = { request: async () => ({ status: 404, body: { message: "Not Found" } }) };
const repo = { owner: "customer-co", name: "storefront" };
const ask = (g: FakeGraph, from: string, head: string, seen: GitHubHttpRequest[] = []) =>
  readMergeOnly(withGitGraph(notFound, repo, g, seen), { ...repo, baseRef: "main", from, head });

/** b0 -> r (the pull request edits x) and b0 -> b1 (the base edits z, and, when `baseEditsX`, x as well, like a security fix). */
function graph(baseEditsX: boolean) {
  const g: FakeGraph = { commits: new Map(), branches: {} };
  const b0 = commit(g, "b0", [], { "x.ts": "x0", "y.ts": "y0", "z.ts": "z0" });
  const r = commit(g, "r", [b0], { "x.ts": "xR", "y.ts": "y0", "z.ts": "z0" });
  const b1 = commit(g, "b1", [b0], { "x.ts": baseEditsX ? "xB" : "x0", "y.ts": "y0", "z.ts": "zB" });
  g.branches.main = b1;
  return { g, b0, r, b1 };
}

describe("a head that is only a merge of the base branch", () => {
  it("is carried when its tree is the clean merge", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "m", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });

  it("is a full review when total_commits disagrees with ahead_by, or is missing, on the compare reads", async () => {
    for (const skew of [1, -1, "omit"] as const) {
      const { g, r, b1 } = graph(false);
      const m = commit(g, "m", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
      g.totalCommitsSkew = skew;
      expect(await ask(g, r, m), String(skew)).toEqual({ mergeOnly: false, reason: "diff_unreadable" });
    }
  });

  it("is carried when the second parent is a stale base commit and the tree is unchanged", async () => {
    const { g, r, b0 } = graph(false);
    const m = commit(g, "m-stale", [r, b0], { "x.ts": "xR", "y.ts": "y0", "z.ts": "z0" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });

  it("is carried when both sides made the same change to a file", async () => {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const b0 = commit(g, "b0", [], { "x.ts": "x0" });
    const r = commit(g, "r", [b0], { "x.ts": "xSame" });
    const b1 = commit(g, "b1", [b0], { "x.ts": "xSame" });
    g.branches.main = b1;
    const m = commit(g, "m", [r, b1], { "x.ts": "xSame" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });

  it("is refused when it hand-edits a file outside the pull request", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "m-evil", [r, b1], { "x.ts": "xR", "y.ts": "yEVIL", "z.ts": "zB" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("is refused when it silently reverts a change that only the base made", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "m-revert", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "z0" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("is refused when it adds a file neither side has", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "m-extra", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB", "new.ts": "n1" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("is refused when the second parent is not in the base branch's history", async () => {
    const { g, r, b0 } = graph(false);
    const side = commit(g, "side", [b0], { "x.ts": "x0", "y.ts": "y0", "z.ts": "zSide" });
    const m = commit(g, "m-side", [r, side], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zSide" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "merged_something_other_than_base" });
  });

  it("is refused with the parents in the other order, or with one parent, or with three", async () => {
    const { g, r, b0, b1 } = graph(false);
    const tree = { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" };
    const reversed = { mergeOnly: false, reason: "not_a_merge_of_the_reviewed_head" };
    expect(await ask(g, r, commit(g, "m-rev", [b1, r], tree))).toEqual(reversed);
    expect(await ask(g, r, commit(g, "m-one", [r], tree))).toEqual(reversed);
    expect(await ask(g, r, commit(g, "m-three", [r, b1, b0], tree))).toEqual(reversed);
  });
});

describe("a file the base also changed (the reviewer's 'keep mine' probe)", () => {
  it("resolved to the pull request's version is a full review, not a carry: the squash merge would revert the base's change", async () => {
    const { g, r, b1 } = graph(true);
    const ours = commit(g, "m-ours", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
    expect(await ask(g, r, ours)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("resolved to the base's version (dropping the pull request's change) is a full review", async () => {
    const { g, r, b1 } = graph(true);
    const theirs = commit(g, "m-theirs", [r, b1], { "x.ts": "xB", "y.ts": "y0", "z.ts": "zB" });
    expect(await ask(g, r, theirs)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("hand-merged into new content is a full review", async () => {
    const { g, r, b1 } = graph(true);
    const hand = commit(g, "m-hand", [r, b1], { "x.ts": "xBoth", "y.ts": "y0", "z.ts": "zB" });
    expect(await ask(g, r, hand)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("an add/add of the same path (status unchanged, blob resolved to the pull request's) is a full review", async () => {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const b0 = commit(g, "b0", [], { "keep.ts": "k" });
    const r = commit(g, "r", [b0], { "keep.ts": "k", "new.ts": "nR" });
    const b1 = commit(g, "b1", [b0], { "keep.ts": "k", "new.ts": "nB" });
    g.branches.main = b1;
    const m = commit(g, "m", [r, b1], { "keep.ts": "k", "new.ts": "nR" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("a rename in the pull request while the base edited the old name, resolved to the rename alone, is a full review", async () => {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const b0 = commit(g, "b0", [], { "old.ts": "o0", "keep.ts": "k" });
    const r = commit(g, "r", [b0], { "new.ts": "o0", "keep.ts": "k" });
    const b1 = commit(g, "b1", [b0], { "old.ts": "oB", "keep.ts": "k" });
    g.branches.main = b1;
    const m = commit(g, "m", [r, b1], { "new.ts": "o0", "keep.ts": "k" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("a rename in the pull request alongside an unrelated base change, merged cleanly, is carried", async () => {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const b0 = commit(g, "b0", [], { "old.ts": "o0", "keep.ts": "k0" });
    const r = commit(g, "r", [b0], { "new.ts": "o0", "keep.ts": "k0" });
    const b1 = commit(g, "b1", [b0], { "old.ts": "o0", "keep.ts": "kB" });
    g.branches.main = b1;
    const m = commit(g, "m", [r, b1], { "new.ts": "o0", "keep.ts": "kB" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });
});

describe("file mode and symlinks", () => {
  const exec = (g: FakeGraph, label: string, parents: string[], tree: Record<string, string>, modes: Record<string, string>) => commit(g, label, parents, tree, modes);

  it("flipping the executable bit on a file the pull request changed is a full review", async () => {
    const { g, r, b1 } = graph(false);
    const m = exec(g, "m-exec", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" }, { "x.ts": "100755" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("turning a file into a symlink with the same blob is a full review", async () => {
    const { g, r, b1 } = graph(false);
    const m = exec(g, "m-link", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" }, { "x.ts": "120000" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("a mode flip on a file outside the pull request is a full review", async () => {
    const { g, r, b1 } = graph(false);
    const m = exec(g, "m-exec-y", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" }, { "y.ts": "100755" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("modes that both sides already had are carried through a clean merge", async () => {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const b0 = commit(g, "b0", [], { "run.sh": "s0", "z.ts": "z0" });
    const r = exec(g, "r", [b0], { "run.sh": "s0", "z.ts": "z0", "tool.sh": "t" }, { "tool.sh": "100755" });
    const b1 = exec(g, "b1", [b0], { "run.sh": "s0", "z.ts": "zB" }, { "run.sh": "100755" });
    g.branches.main = b1;
    const m = exec(g, "m", [r, b1], { "run.sh": "s0", "z.ts": "zB", "tool.sh": "t" }, { "run.sh": "100755", "tool.sh": "100755" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });
});

describe("big pull requests (GitHub's compare lists at most 300 files, all on page 1)", () => {
  const files = (n: number, tag = "") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${String(i).padStart(4, "0")}.ts`, `b${i}${tag}`]));
  function big(n: number) {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const b0 = commit(g, "B0", [], { README: "r1" });
    const r = commit(g, "P", [b0], { README: "r1", ...files(n) });
    const b1 = commit(g, "M1", [b0], { README: "r2" });
    g.branches.main = b1;
    return { g, r, b1 };
  }

  it("the fake answers like GitHub: every file on page 1 (to 300), none on later pages", async () => {
    const { g, r } = big(320);
    const http = withGitGraph(notFound, repo, g);
    const base = `/repos/${repo.owner}/${repo.name}/compare/main...${r}`;
    const p1 = await http.request({ method: "GET", path: base, query: { per_page: 100, page: 1 } });
    const p2 = await http.request({ method: "GET", path: base, query: { per_page: 100, page: 2 } });
    expect((p1.body as { files: unknown[] }).files).toHaveLength(300);
    expect(p2.body).not.toHaveProperty("files");
  });

  it.each([100, 250, 299, 300, 320])("a clean merge into a %i-file pull request is carried (the tree read has no 300-file limit)", async (n) => {
    const { g, r, b1 } = big(n);
    const m = commit(g, "N", [r, b1], { README: "r2", ...files(n) });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });

  it("a hand edit among 250 files is still caught", async () => {
    const { g, r, b1 } = big(250);
    const m = commit(g, "N", [r, b1], { README: "r2", ...files(250), "src/f0100.ts": "evil" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "code_changed" });
  });

  it("a tree the API reports as truncated is a full review, never a carry", async () => {
    const { g, r, b1 } = big(250);
    const m = commit(g, "N", [r, b1], { README: "r2", ...files(250) });
    g.maxTreeEntries = 200;
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "diff_unreadable" });
    expect(await readTreeEntries(withGitGraph(notFound, repo, g), repo, m)).toEqual({ ok: false });
  });

  it("the trees are read recursively (a top-level-only read would hide every nested change)", async () => {
    const { g, r, b1 } = big(5);
    const m = commit(g, "N", [r, b1], { README: "r2", ...files(5) });
    const seen: GitHubHttpRequest[] = [];
    await ask(g, r, m, seen);
    const treeReads = seen.filter((q) => q.path.includes("/git/trees/"));
    expect(treeReads).toHaveLength(4);
    for (const q of treeReads) expect(q.query).toEqual({ recursive: 1 });
  });
});

describe("the merge base must be the unique best one (a criss-cross history has two)", () => {
  /**
   * X1 (main side, p=A) and X2 (side branch, p=B). The pull request's line merges X1 into X2 (keeping B), then the reviewed head r sets p=Bp.
   * Main merges X2 keeping p=A (its own resolution), then a second parent p2 changes q. Real git: `merge-base --all r p2` lists X1 and X2,
   * and `git merge` conflicts on p (A on the base side, Bp on the pull request side, B at X2, O at the common root). `mmParents` orders the
   * parents of main's merge, which decides which of the two best bases the fake (like GitHub) names.
   */
  function crissCross(mmParents: "x1x2" | "x2x1") {
    const g: FakeGraph = { commits: new Map(), branches: {} };
    const root = commit(g, "cc-root", [], { p: "O", q: "O" });
    const x1 = commit(g, "cc-x1", [root], { p: "A", q: "O" });
    const x2 = commit(g, "cc-x2", [root], { p: "B", q: "O" });
    const prMerge = commit(g, "cc-pr-merge", [x2, x1], { p: "B", q: "O" });
    const r = commit(g, "cc-r", [prMerge], { p: "Bp", q: "O" });
    const mainMerge = commit(g, "cc-main-merge", mmParents === "x1x2" ? [x1, x2] : [x2, x1], { p: "A", q: "O" });
    const p2 = commit(g, "cc-p2", [mainMerge], { p: "A", q: "Q2" });
    g.branches.main = p2;
    return { g, r, p2, x1, x2 };
  }

  it.each(["x1x2", "x2x1"] as const)("a 'keep mine' merge over a conflicting path is a full review, whichever best base is named (%s)", async (order) => {
    const { g, r, p2 } = crissCross(order);
    // Hand-made merge: the pull request's p=Bp kept over main's p=A, and main's q change taken. Git itself reports a conflict on p.
    const m = commit(g, `cc-keep-mine-${order}`, [r, p2], { p: "Bp", q: "Q2" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "ambiguous_merge_base" });
  });

  it("even a merge that would be clean over the named base is a full review, because the base is ambiguous", async () => {
    const { g, r, p2 } = crissCross("x1x2");
    const m = commit(g, "cc-other", [r, p2], { p: "A", q: "Q2" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: false, reason: "ambiguous_merge_base" });
  });

  it("the fake reports the counts the rule relies on (3 from the named base, 2 from the reviewed head)", async () => {
    const { g, r, p2, x1 } = crissCross("x1x2");
    const http = withGitGraph(notFound, repo, g);
    const named = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/compare/${r}...${p2}` });
    expect((named.body as { merge_base_commit: { sha: string } }).merge_base_commit.sha).toBe(x1);
    const fromBase = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/compare/${x1}...${p2}` });
    expect([(fromBase.body as { ahead_by: number }).ahead_by, (named.body as { ahead_by: number }).ahead_by]).toEqual([3, 2]);
  });

  it("a linear history is still carried (the counts match)", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "lin-m", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
    expect(await ask(g, r, m)).toEqual({ mergeOnly: true });
  });

  it("a merge on top of an earlier merge (the reviewed head is itself a merge) is still carried", async () => {
    const { g, r, b1 } = graph(false);
    const r2 = commit(g, "mom-r2", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
    const b2 = commit(g, "mom-b2", [b1], { "x.ts": "x0", "y.ts": "yB2", "z.ts": "zB" });
    g.branches.main = b2;
    const m = commit(g, "mom-m", [r2, b2], { "x.ts": "xR", "y.ts": "yB2", "z.ts": "zB" });
    expect(await ask(g, r2, m)).toEqual({ mergeOnly: true });
  });

  it("a missing, malformed or unreadable count is never a carry", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "cnt-m", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
    const tamper = (mutate: (path: string, body: Record<string, unknown>) => Record<string, unknown> | null) => ({
      request: async (q: GitHubHttpRequest) => {
        const res = await withGitGraph(notFound, repo, g).request(q);
        if (res.status !== 200 || !q.path.includes("/compare/")) return res;
        const out = mutate(q.path, res.body as Record<string, unknown>);
        return out === null ? { status: 500, body: {} } : { status: 200, body: out };
      },
    });
    const baseCompare = (path: string) => path.includes("/compare/") && !path.includes(`/compare/${r}...`) && !path.includes("...main");
    const cases: [string, (path: string, body: Record<string, unknown>) => Record<string, unknown> | null, string][] = [
      ["the count from the merge base is missing", (p, b) => (baseCompare(p) ? { ...b, ahead_by: undefined } : b), "ambiguous_merge_base"],
      ["the count from the reviewed head is a string", (p, b) => (p.includes(`/compare/${r}...`) ? { ...b, ahead_by: "2" } : b), "ambiguous_merge_base"],
      ["the count from the merge base cannot be read", (p, b) => (baseCompare(p) ? null : b), "diff_unreadable"],
    ];
    for (const [, mutate, reason] of cases) {
      expect(await readMergeOnly(tamper(mutate), { ...repo, baseRef: "main", from: r, head: m })).toEqual({ mergeOnly: false, reason });
    }
  });
});

describe("failing closed", () => {
  it("a ref that is not a plain ref, or a head that is not a full sha, is refused before any call", async () => {
    const seen: string[] = [];
    const http = { request: async (r: { path: string }) => (seen.push(r.path), { status: 404, body: {} }) };
    expect(await readMergeOnly(http, { ...repo, baseRef: "main;rm", from: sha40("a"), head: sha40("x") })).toEqual({ mergeOnly: false, reason: "malformed" });
    expect(await readMergeOnly(http, { ...repo, baseRef: "main", from: "abc", head: sha40("x") })).toEqual({ mergeOnly: false, reason: "malformed" });
    expect(await readTreeEntries(http, repo, "main")).toEqual({ ok: false });
    expect(seen).toEqual([]);
  });

  it("an unreadable commit, compare or tree is a full review", async () => {
    const { g, r, b1 } = graph(false);
    const m = commit(g, "m", [r, b1], { "x.ts": "xR", "y.ts": "y0", "z.ts": "zB" });
    expect(await ask(g, r, sha40("unknown"))).toEqual({ mergeOnly: false, reason: "github_unavailable" });
    const failing = (match: string) => ({
      request: async (q: GitHubHttpRequest) => (q.path.includes(match) ? { status: 500, body: {} } : withGitGraph(notFound, repo, g).request(q)),
    });
    for (const [match, reason] of [["/git/trees/", "diff_unreadable"], ["...", "github_unavailable"]] as const) {
      expect(await readMergeOnly(failing(match), { ...repo, baseRef: "main", from: r, head: m })).toEqual({ mergeOnly: false, reason });
    }
  });

  it("a malformed tree answer is unreadable", async () => {
    const id = sha40("tree");
    const bodies: unknown[] = [
      { tree: [{ path: 7 }], truncated: false },
      { tree: [], truncated: "no" },
      { tree: [] },
      { tree: "x", truncated: false },
    ];
    for (const body of bodies) {
      const http = {
        request: async (q: GitHubHttpRequest) => (q.path.includes("/git/trees/") ? { status: 200, body } : { status: 200, body: { tree: { sha: id } } }),
      };
      expect(await readTreeEntries(http, repo, sha40("c"))).toEqual({ ok: false });
    }
  });
});

describe("the three-way rule", () => {
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  it("keeps the reviewed head's entry unless the base changed it, and the base's unless the pull request changed it", () => {
    const base = m({ a: "1", b: "1", c: "1" });
    const from = m({ a: "P", b: "1", c: "1" });
    const other = m({ a: "1", b: "B", c: "1" });
    expect(isCleanMerge(base, from, other, m({ a: "P", b: "B", c: "1" }))).toBe(true);
    expect(isCleanMerge(base, from, other, m({ a: "1", b: "B", c: "1" }))).toBe(false);
    expect(isCleanMerge(base, from, other, m({ a: "P", b: "1", c: "1" }))).toBe(false);
  });
  it("a path removed on one side and untouched on the other is removed; a path both changed differently is never clean", () => {
    expect(isCleanMerge(m({ a: "1" }), m({}), m({ a: "1" }), m({}))).toBe(true);
    expect(isCleanMerge(m({ a: "1" }), m({}), m({ a: "1" }), m({ a: "1" }))).toBe(false);
    expect(isCleanMerge(m({ a: "1" }), m({}), m({ a: "B" }), m({}))).toBe(false);
    expect(isCleanMerge(m({ a: "1" }), m({ a: "P" }), m({ a: "B" }), m({ a: "P" }))).toBe(false);
  });
});
