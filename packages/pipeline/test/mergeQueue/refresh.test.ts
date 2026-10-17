import { afterEach, describe, expect, it } from "vitest";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import type { RunRow } from "../../src/build/mergeGate.js";
import { decideCarryForward, effectiveRunRows, refreshTip, verifyRefresh, type HeadRefreshRow } from "../../src/mergeQueue/index.js";
import { startMergeTlsGitHub, type FakeCommit, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";

/**
 * D#519 MQ3-a, no database: the carry-forward rule, the refresh chain, and the verification of a new head against GitHub's real
 * contract (a strict fake served over real TLS). The identity fields the verification reads are PINNED here: the commit's
 * `author.login` (our App), `committer.login` (`web-flow`) and GitHub's signature verdict (`verified`, reason `valid`). Whether a real
 * update-branch commit carries exactly these is still to be confirmed from one real commit on cloud-staging; if it differs, these
 * tests, `platformRefreshIdentity` and `fakeGitHubMergeTls.ts` change together.
 */
const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const BASE_TIP = "9".repeat(40);
const OTHER = "e".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const PR = { repoId: "repo-1", prNumber: 7 };

let open: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

async function github(over: Partial<MergeWorld> = {}) {
  const g = await startMergeTlsGitHub({ headSha: TO, ...over });
  open.push(g);
  const port = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined });
  return { g, port };
}

const row = (role: string, over: Partial<RunRow> = {}): RunRow => ({ role, status: "succeeded", runtime: "production", verdict: "pass", is_latest: true, is_latest_terminal: true, ts_ok: true, ...over });

describe("D#519 MQ3-a carry-forward rule (Q1(b))", () => {
  it("disjoint files carry; one shared path does not", () => {
    expect(decideCarryForward(["src/a.ts"], ["docs/x.md"])).toEqual({ carry: true });
    expect(decideCarryForward(["src/a.ts", "src/b.ts"], ["src/b.ts"])).toEqual({ carry: false, reason: "files_overlap" });
  });

  it("an unknown list (cut at GitHub's cap) is never disjoint, on either side", () => {
    expect(decideCarryForward(null, ["docs/x.md"])).toEqual({ carry: false, reason: "files_unknown" });
    expect(decideCarryForward(["src/a.ts"], null)).toEqual({ carry: false, reason: "files_unknown" });
  });

  it("paths are compared exactly: a directory prefix or a case change is a different path", () => {
    expect(decideCarryForward(["src/a.ts"], ["src/a.tsx", "src", "SRC/a.ts"])).toEqual({ carry: true });
  });

  it("two empty lists are disjoint (nothing to collide), and an empty merge side carries", () => {
    expect(decideCarryForward([], [])).toEqual({ carry: true });
    expect(decideCarryForward(["src/a.ts"], [])).toEqual({ carry: true });
  });
});

describe("D#519 MQ3-a effective reviewer rows across a refresh", () => {
  it("a role with no row on the refreshed head is spoken for by the head before it", () => {
    const rows = effectiveRunRows([
      { rows: [], refreshOverlap: false },
      { rows: [row("code-reviewer"), row("acceptance-tester")], refreshOverlap: false },
    ]);
    expect(rows.map((r) => r.role).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
  });

  it("a head's own rows win: a failing review on the refreshed head is never overridden by the older pass", () => {
    const rows = effectiveRunRows([
      { rows: [row("code-reviewer", { verdict: "needs-fix" })], refreshOverlap: false },
      { rows: [row("code-reviewer")], refreshOverlap: false },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("needs-fix");
  });

  it("an overlapping refresh carries NOTHING: no role's pass crosses it, the security reviewer's included", () => {
    const rows = effectiveRunRows([
      { rows: [], refreshOverlap: true },
      { rows: [row("code-reviewer"), row("security-reviewer"), row("acceptance-tester"), row("debater")], refreshOverlap: false },
    ]);
    expect(rows).toEqual([]);
  });

  it("a delta review on an overlapping refresh speaks for the roles it covers, and only those", () => {
    const rows = effectiveRunRows([
      { rows: [row("code-reviewer")], refreshOverlap: true },
      { rows: [row("code-reviewer", { verdict: "needs-fix" }), row("security-reviewer"), row("acceptance-tester")], refreshOverlap: false },
    ]);
    expect(rows.map((r) => r.role)).toEqual(["code-reviewer"]);
    expect(rows[0]!.verdict).toBe("pass");
  });

  it("the overlap of an OLD hop stops every pass at that hop, and a later disjoint hop does not bring them back", () => {
    const rows = effectiveRunRows([
      { rows: [], refreshOverlap: false },
      { rows: [], refreshOverlap: true },
      { rows: [row("code-reviewer"), row("security-reviewer")], refreshOverlap: false },
    ]);
    expect(rows).toEqual([]);
  });

  it("a disjoint hop below an overlapping one is reached only by a role the overlapping head's own review covers", () => {
    const rows = effectiveRunRows([
      { rows: [], refreshOverlap: false },
      { rows: [row("code-reviewer")], refreshOverlap: true },
      { rows: [row("security-reviewer")], refreshOverlap: false },
    ]);
    expect(rows.map((r) => r.role)).toEqual(["code-reviewer"]);
  });

  it("a head with no refresh row has its own rows and nothing else", () => {
    expect(effectiveRunRows([{ rows: [], refreshOverlap: false }])).toEqual([]);
  });
});

describe("D#519 MQ3-a refresh chain", () => {
  const hop = (fromSha: string, toSha: string): HeadRefreshRow => ({ fromSha, toSha, baseSha: BASE_TIP, filesOverlap: false });
  it("follows from -> to rows from the reviewed head", () => {
    expect(refreshTip(FROM, [])).toBe(FROM);
    expect(refreshTip(FROM, [hop(FROM, TO)])).toBe(TO);
    expect(refreshTip(FROM, [hop(TO, "c".repeat(40)), hop(FROM, TO)])).toBe("c".repeat(40));
  });
  it("ignores a row that does not start at the chain, and never loops on a cycle", () => {
    expect(refreshTip(FROM, [hop(OTHER, TO)])).toBe(FROM);
    expect(refreshTip(FROM, [hop(FROM, TO), hop(TO, FROM)])).toBe(TO);
  });
});

describe("D#519 MQ3-a GitHub commit read (real TLS, strict fake)", () => {
  it("reads parents, the author's login, GitHub's signature verdict and the files against the first parent", async () => {
    const { g, port } = await github();
    g.world.commits[TO] = { parents: [FROM, BASE_TIP], authorLogin: BOT, verified: true, files: [{ filename: "docs/a.md" }, { filename: "new.ts", previous_filename: "old.ts" }] };
    const c = await port.getCommit(PR, TO);
    expect(c).toEqual({ sha: TO, parents: [FROM, BASE_TIP], authorLogin: BOT, committerLogin: "web-flow", verified: true, verificationReason: "valid", files: ["docs/a.md", "new.ts", "old.ts"], filesTruncated: false });
    expect(g.world.calls.some((x) => x.method === "GET" && x.path === "/repos/acme/widgets/commits/" + TO)).toBe(true);
  });

  it("an author GitHub cannot resolve to an account reads as null, and a file list at the cap is withheld", async () => {
    const { g, port } = await github();
    g.world.commits[TO] = { parents: [FROM, BASE_TIP], authorLogin: null, verified: false, files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` })) };
    const c = await port.getCommit(PR, TO);
    expect(c.authorLogin).toBeNull();
    expect(c.files).toBeNull();
    expect(c.filesTruncated).toBe(true);
  });

  it("a committer who is a person reads as that login, and a missing committer as null", async () => {
    const { g, port } = await github();
    g.world.commits[TO] = { parents: [FROM, BASE_TIP], authorLogin: BOT, committerLogin: "mallory", verified: true, verificationReason: "valid", files: [] };
    expect((await port.getCommit(PR, TO)).committerLogin).toBe("mallory");
    g.world.commits[TO] = { parents: [FROM, BASE_TIP], authorLogin: BOT, committerLogin: null, verified: false, files: [] };
    expect(await port.getCommit(PR, TO)).toMatchObject({ committerLogin: null, verificationReason: "unsigned" });
  });

  it("an unknown commit throws (the live API answers 422 for it, which the fake now matches), and a malformed sha throws before any request", async () => {
    const { g, port } = await github();
    await expect(port.getCommit(PR, OTHER)).rejects.toThrow(/unexpected status 422/);
    const before = g.world.calls.length;
    await expect(port.getCommit(PR, "nope")).rejects.toThrow(/malformed SHA/);
    expect(g.world.calls.length).toBe(before);
  });
});

describe("D#519 MQ3-a verification of a new head (acceptance 17)", () => {
  const platform: FakeCommit = { parents: [FROM, BASE_TIP], authorLogin: BOT, verified: true, files: [{ filename: "docs/a.md" }] };
  const verify = async (commit: Partial<FakeCommit> | null, ourLogin = BOT) => {
    const { g, port } = await github();
    if (commit) g.world.commits[TO] = { ...platform, ...commit };
    return verifyRefresh(port, PR, { fromSha: FROM, toSha: TO, ourLogin });
  };

  it("accepts exactly the platform shape: previous head first, a default-branch commit second, our App as author, signed by GitHub", async () => {
    const v = await verify({});
    expect(v).toMatchObject({ ok: true, baseSha: BASE_TIP });
  });

  it("identity is the author's login, compared case-insensitively", async () => {
    expect((await verify({ authorLogin: BOT.toUpperCase() })).ok).toBe(true);
    expect(await verify({ authorLogin: "alice" })).toEqual({ ok: false, reason: "author_not_our_app" });
    expect(await verify({ authorLogin: null })).toEqual({ ok: false, reason: "author_not_our_app" });
  });

  it("a commit that names our App but is not signed by GitHub is not a refresh (the name alone can be typed by anyone)", async () => {
    expect(await verify({ verified: false })).toEqual({ ok: false, reason: "not_signed_by_github" });
  });

  it("a person's own merge of the default branch into the branch is not a refresh, even signed and with the right parents", async () => {
    expect(await verify({ authorLogin: "alice", verified: true })).toEqual({ ok: false, reason: "author_not_our_app" });
  });

  it("MUST 1: the bot as AUTHOR, a contributor as COMMITTER, signed with the contributor's own key (verified) is refused", async () => {
    // The author is an email anyone can type; the signature is checked against the committer, so this commit shows `verified: true`.
    expect(await verify({ authorLogin: BOT, committerLogin: "mallory", verified: true, verificationReason: "valid" })).toEqual({ ok: false, reason: "committer_not_github" });
    expect(await verify({ authorLogin: BOT, committerLogin: null, verified: true, verificationReason: "valid" })).toEqual({ ok: false, reason: "committer_not_github" });
  });

  it("the committer must be web-flow (compared case-insensitively) and the signature reason must be exactly valid", async () => {
    expect((await verify({ committerLogin: "Web-Flow" })).ok).toBe(true);
    expect(await verify({ verified: true, verificationReason: "expired_key" })).toEqual({ ok: false, reason: "not_signed_by_github" });
    expect(await verify({ verified: true, verificationReason: "unknown_key" })).toEqual({ ok: false, reason: "not_signed_by_github" });
    expect(await verify({ verified: false, verificationReason: "valid" })).toEqual({ ok: false, reason: "not_signed_by_github" });
  });

  it("parents: not two, previous head not first, or the same commit twice", async () => {
    expect(await verify({ parents: [FROM] })).toEqual({ ok: false, reason: "not_two_parents" });
    expect(await verify({ parents: [FROM, BASE_TIP, OTHER] })).toEqual({ ok: false, reason: "not_two_parents" });
    expect(await verify({ parents: [OTHER, BASE_TIP] })).toEqual({ ok: false, reason: "first_parent_not_previous_head" });
    expect(await verify({ parents: [BASE_TIP, FROM] })).toEqual({ ok: false, reason: "first_parent_not_previous_head" });
    expect(await verify({ parents: [FROM, FROM] })).toEqual({ ok: false, reason: "first_parent_not_previous_head" });
  });

  it("the second parent must be on the default branch: a commit GitHub knows that is not on it is refused", async () => {
    const { g, port } = await github();
    g.world.commits[OTHER] = { parents: [FROM], authorLogin: "alice", verified: true, files: [] };
    g.world.commits[TO] = { ...platform, parents: [FROM, OTHER] };
    expect(await verifyRefresh(port, PR, { fromSha: FROM, toSha: TO, ourLogin: BOT })).toEqual({ ok: false, reason: "second_parent_not_on_default" });
  });

  it("an older commit on the default branch (not the tip) is on it", async () => {
    const older = "8".repeat(40);
    expect(await verify({ parents: [FROM, older] })).toMatchObject({ ok: true, baseSha: older });
  });

  describe("MUST 2: the tree is exactly the clean three-way merge", () => {
    const blob = (c: string): string => `100644 blob ${c.repeat(40)}`;
    /** base (the merge base) -> the reviewed head (the PR edits src/a.ts and adds src/pr-check.ts) and the default branch (adds docs/m.md). */
    const MB = "7".repeat(40);
    const baseTree = { "src/a.ts": blob("1"), "keep.ts": blob("1") };
    const fromTree = { "src/a.ts": blob("2"), "keep.ts": blob("1"), "src/pr-check.ts": blob("5") };
    const otherTree = { "src/a.ts": blob("1"), "keep.ts": blob("1"), "docs/m.md": blob("3") };
    const cleanTree = { "src/a.ts": blob("2"), "keep.ts": blob("1"), "src/pr-check.ts": blob("5"), "docs/m.md": blob("3") };

    const verifyTree = async (headTree: Record<string, string>, over: Partial<MergeWorld> = {}) => {
      const { g, port } = await github(over);
      g.world.commits[TO] = { ...platform };
      g.world.trees = { [MB]: baseTree, [FROM]: fromTree, [BASE_TIP]: otherTree, [TO]: headTree };
      Object.assign(g.world, over);
      return verifyRefresh(port, PR, { fromSha: FROM, toSha: TO, ourLogin: BOT });
    };

    it("the real merge verifies", async () => {
      expect(await verifyTree(cleanTree)).toMatchObject({ ok: true, baseSha: BASE_TIP });
    });

    it("a forged tree with the right parents and identity: an ADDED file is refused", async () => {
      expect(await verifyTree({ ...cleanTree, "src/evil.ts": blob("6") })).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("a forged tree: an EDITED file is refused, whether the PR's, the default branch's or an untouched one", async () => {
      expect(await verifyTree({ ...cleanTree, "src/a.ts": blob("6") })).toEqual({ ok: false, reason: "tree_not_verified" });
      expect(await verifyTree({ ...cleanTree, "docs/m.md": blob("6") })).toEqual({ ok: false, reason: "tree_not_verified" });
      expect(await verifyTree({ ...cleanTree, "keep.ts": blob("6") })).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("a forged tree: a PR file REVERTED to its merge-base version (it then appears in neither file list) is refused", async () => {
      expect(await verifyTree({ ...cleanTree, "src/a.ts": blob("1") })).toEqual({ ok: false, reason: "tree_not_verified" });
      const withoutCheck: Record<string, string> = { ...cleanTree };
      delete withoutCheck["src/pr-check.ts"];
      expect(await verifyTree(withoutCheck)).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("a file mode flip on an otherwise identical blob is a different tree", async () => {
      expect(await verifyTree({ ...cleanTree, "src/a.ts": `100755 blob ${"2".repeat(40)}` })).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("a criss-cross history (the merge base GitHub names is not the unique best one) is not verified, even with the right tree", async () => {
      expect(await verifyTree(cleanTree, { aheadFromBase: 2 })).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("a truncated recursive tree, on any of the four commits, is not verified", async () => {
      for (const commit of [MB, FROM, BASE_TIP, TO]) {
        expect(await verifyTree(cleanTree, { truncatedTrees: [commit] })).toEqual({ ok: false, reason: "tree_not_verified" });
      }
    });

    it("any failed read is not verified (it does not throw and does not carry)", async () => {
      expect(await verifyTree(cleanTree, { treeStatus: 500 })).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("both sides changing one path the same way is clean; differently is not", async () => {
      const { g, port } = await github();
      g.world.commits[TO] = { ...platform };
      g.world.trees = { [MB]: { "x.ts": blob("1") }, [FROM]: { "x.ts": blob("2") }, [BASE_TIP]: { "x.ts": blob("2") }, [TO]: { "x.ts": blob("2") } };
      expect((await verifyRefresh(port, PR, { fromSha: FROM, toSha: TO, ourLogin: BOT })).ok).toBe(true);
      g.world.trees[BASE_TIP] = { "x.ts": blob("3") };
      expect(await verifyRefresh(port, PR, { fromSha: FROM, toSha: TO, ourLogin: BOT })).toEqual({ ok: false, reason: "tree_not_verified" });
    });

    it("a malformed sha throws before any request", async () => {
      const { g, port } = await github();
      const before = g.world.calls.length;
      await expect(port.checkCleanMerge(PR, { from: "nope", other: BASE_TIP, head: TO })).rejects.toThrow(/malformed SHA/);
      expect(g.world.calls.length).toBe(before);
    });
  });

  it("fails closed: an unreadable commit throws, and no login to compare with throws", async () => {
    await expect(verify(null)).rejects.toThrow(/unexpected status 422/);
    await expect(verify({}, "  ")).rejects.toThrow(/no App login/);
  });
});
