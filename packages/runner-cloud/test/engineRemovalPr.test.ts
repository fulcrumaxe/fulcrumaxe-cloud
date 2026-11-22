import { describe, expect, it } from "vitest";
import { EngineRemovalError, buildEngineRemovalPr } from "../src/engineRemovalPr.js";
import { LocalOnlyGithubError, localOnlyGithub } from "../src/localOnlyGithub.js";
import { FakeRepoDataApi } from "./helpers/fakeRepoDataApi.js";

const IN = { owner: "acme", repo: "app", installPr: 7, version: "1.2.3" };
const BRANCH = "fx/engine-remove-1.2.3";

/** A repo where install PR 7 added a.txt and b.txt and changed README, then somebody changed b.txt. Every call goes through the fence. */
function world(extra: Record<string, string | null> = {}) {
  const fake = new FakeRepoDataApi();
  fake.commit("main", { README: "one", "src/keep.ts": "keep" });
  const merge = fake.commit("main", { "engine/a.txt": "a", "engine/b.txt": "b", README: "one + engine" });
  fake.merged(7, merge, [{ path: "engine/a.txt", changeType: "ADDED" }, { path: "engine/b.txt", changeType: "ADDED" }, { path: "README", changeType: "MODIFIED" }]);
  fake.commit("main", { "engine/b.txt": "b edited", ...extra });
  return { fake, github: localOnlyGithub(fake, { exclude: ["A10"], engineRemove: true }) };
}

describe("the engine removal pull request (D#845 ON-16b)", () => {
  it("deletes an added file whose blob is unchanged, and lists the changed ones as left in place", async () => {
    const { fake, github } = world();
    const out = await buildEngineRemovalPr(github, IN);
    expect(out).toMatchObject({ outcome: "opened", branch: BRANCH, removed: ["engine/a.txt"] });
    expect(out.left).toEqual([{ path: "README", why: "changed_by_install" }, { path: "engine/b.txt", why: "changed_since" }]);
    expect(fake.headTree(BRANCH)).toEqual(["README", "engine/b.txt", "src/keep.ts"]);
    const pr = fake.pulls.find((p) => p.number === out.prNumber)!;
    expect(pr).toMatchObject({ head: BRANCH, base: "main", draft: false });
    expect(pr.body).toContain("`README` (the install changed it, it did not add it)");
    expect(pr.body).toContain("`engine/b.txt` (changed since the install)");
    expect(pr.body).not.toContain("engine/a.txt");
    expect(fake.headTree("main")).toContain("engine/a.txt"); // the default branch itself is untouched
  });

  it("a file the install only modified is never deleted, even when nothing touched it since", async () => {
    const { fake, github } = world();
    const out = await buildEngineRemovalPr(github, IN);
    expect(fake.headTree(BRANCH)).toContain("README");
    expect(out.removed).not.toContain("README");
  });

  it("reads every page of the install's files", async () => {
    const fake = new FakeRepoDataApi();
    const names = ["p1", "p2", "p3", "p4", "p5"].map((n) => `engine/${n}`);
    const merge = fake.commit("main", Object.fromEntries(names.map((n) => [n, n])));
    fake.merged(7, merge, names.map((path) => ({ path, changeType: "ADDED" })));
    const out = await buildEngineRemovalPr(localOnlyGithub(fake, { engineRemove: true }), IN);
    expect(out.removed).toEqual(names);
  });

  it("skips a file already removed since, and opens nothing when every added file changed", async () => {
    const { fake, github } = world({ "engine/a.txt": null });
    const out = await buildEngineRemovalPr(github, IN);
    expect(out).toMatchObject({ outcome: "nothing_to_remove", prNumber: null, removed: [] });
    expect(out.left.map((l) => l.path)).toEqual(["README", "engine/b.txt"]);
    expect(fake.writes).toEqual([]);
    expect(fake.hasBranch(BRANCH)).toBe(false);
  });

  it("is idempotent: a rerun finds the open pull request and writes nothing", async () => {
    const { fake, github } = world();
    const first = await buildEngineRemovalPr(github, IN);
    const writes = fake.writes.length;
    const again = await buildEngineRemovalPr(github, IN);
    expect(again).toMatchObject({ outcome: "exists", prNumber: first.prNumber, branch: BRANCH });
    expect(fake.writes.length).toBe(writes);
  });

  it("refuses a branch of that name that it did not make, and opens no pull request (an attacker's or an old run's commit is never trusted)", async () => {
    const { fake, github } = world();
    fake.addRef(BRANCH, fake.commit("scratch", {})); // an empty-tree commit: opening a pull request on it would delete everything
    await expect(buildEngineRemovalPr(github, IN)).rejects.toEqual(new EngineRemovalError("removal_branch_conflict"));
    expect(fake.pulls).toHaveLength(1); // only the install pull request
  });

  it("reports an open pull request as its own only when it deletes nothing but paths the install added", async () => {
    const { github } = world();
    const first = await buildEngineRemovalPr(github, IN);
    expect(first.outcome).toBe("opened");
    // Somebody else's pull request on the same head: it also changes README. Refused, and no write is made.
    const other = world();
    other.fake.addRef(BRANCH, other.fake.sha("main"));
    other.fake.commit(BRANCH, { README: "other", "engine/a.txt": null });
    other.fake.openPr(BRANCH);
    await expect(buildEngineRemovalPr(other.github, IN)).rejects.toMatchObject({ code: "removal_branch_conflict" });
    expect(other.fake.writes).toEqual([]);
    // A pull request that rewrites a path the install added (changes it, not deletes it): refused too.
    const edit = world();
    edit.fake.addRef(BRANCH, edit.fake.sha("main"));
    edit.fake.commit(BRANCH, { "engine/a.txt": "rewritten" });
    edit.fake.openPr(BRANCH);
    await expect(buildEngineRemovalPr(edit.github, IN)).rejects.toMatchObject({ code: "removal_branch_conflict" });
    // A pull request on the same head that deletes a file the install did not add: refused as well.
    const gone = world();
    gone.fake.addRef(BRANCH, gone.fake.sha("main"));
    gone.fake.commit(BRANCH, { "src/keep.ts": null });
    gone.fake.openPr(BRANCH);
    await expect(buildEngineRemovalPr(gone.github, IN)).rejects.toMatchObject({ code: "removal_branch_conflict" });
    expect(gone.fake.writes).toEqual([]);
  });

  it("refuses an open pull request that deletes only a strict subset of the computed set, even though every path is install-added", async () => {
    const fake = new FakeRepoDataApi();
    const names = ["engine/p1", "engine/p2", "engine/p3"];
    const merge = fake.commit("main", Object.fromEntries(names.map((n) => [n, n])));
    fake.merged(7, merge, names.map((path) => ({ path, changeType: "ADDED" })));
    fake.addRef(BRANCH, fake.sha("main"));
    fake.commit(BRANCH, { "engine/p1": null });
    fake.openPr(BRANCH);
    await expect(buildEngineRemovalPr(localOnlyGithub(fake, { engineRemove: true }), IN)).rejects.toMatchObject({ code: "removal_branch_conflict" });
    expect(fake.writes).toEqual([]);
  });

  it("refuses an install pull request whose head is the removal branch itself, before any write", async () => {
    const { fake, github } = world();
    fake.pulls[0]!.head = BRANCH;
    await expect(buildEngineRemovalPr(github, IN)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(fake.writes).toEqual([]);
  });

  it("leaves an added file in place when only its mode changed since, and lists it as changed since", async () => {
    const { fake, github } = world();
    fake.commit("main", { "engine/a.txt": "a" }, "100755"); // the same blob, 100644 to 100755
    const out = await buildEngineRemovalPr(github, IN);
    expect(out.outcome).toBe("nothing_to_remove");
    expect(out.left).toContainEqual({ path: "engine/a.txt", why: "changed_since" });
  });

  it("refuses an install pull request whose base is not the default branch or whose head is not the install branch, before any write", async () => {
    const wrongBase = world();
    wrongBase.fake.pulls[0]!.base = "dev";
    await expect(buildEngineRemovalPr(wrongBase.github, IN)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(wrongBase.fake.writes).toEqual([]);
    const { fake, github } = world();
    await expect(buildEngineRemovalPr(github, { ...IN, installBranch: "fx/other" })).rejects.toMatchObject({ code: "github_unavailable" });
    expect(fake.writes).toEqual([]);
    expect((await buildEngineRemovalPr(github, { ...IN, installBranch: "fx/install" })).outcome).toBe("opened");
  });

  it("bounds the pages it reads, and keeps the body under the pull request limit", async () => {
    const paged = world();
    paged.fake.pageSize = 1;
    paged.fake.setFiles(7, Array.from({ length: 31 }, (_, i) => ({ path: `engine/f${i}`, changeType: "MODIFIED" })));
    await expect(buildEngineRemovalPr(paged.github, IN)).rejects.toMatchObject({ code: "github_unavailable" });
    const { fake, github } = world();
    fake.pageSize = 100;
    fake.setFiles(7, [{ path: "engine/a.txt", changeType: "ADDED" }, ...Array.from({ length: 150 }, (_, i) => ({ path: `${"d".repeat(450)}${i}`, changeType: "MODIFIED" }))]);
    const out = await buildEngineRemovalPr(github, IN);
    expect(fake.pulls.find((p) => p.number === out.prNumber)!.body!.length).toBeLessThan(65536);
  });

  it("refuses an install pull request that is not merged, before any write", async () => {
    const fake = new FakeRepoDataApi();
    fake.merged(7, "0".repeat(40), [], false); // closed, not merged; GitHub still answers a test-merge sha, so only the flag tells
    await expect(buildEngineRemovalPr(localOnlyGithub(fake, { engineRemove: true }), IN)).rejects.toMatchObject({ code: "install_pr_not_merged" });
    expect(fake.writes).toEqual([]);
  });

  it("fails closed on a truncated tree, before any write", async () => {
    const { fake, github } = world();
    fake.truncate = true;
    await expect(buildEngineRemovalPr(github, IN)).rejects.toEqual(new EngineRemovalError("tree_truncated"));
    expect(fake.writes).toEqual([]);
  });

  it("sends no delete and touches the repository itself only to read it", async () => {
    const { fake, github } = world();
    await buildEngineRemovalPr(github, IN);
    expect(fake.unrouted).toEqual([]);
    expect(new Set(fake.calls.map((c) => c.method))).toEqual(new Set(["GET", "POST"]));
    expect(fake.calls.filter((c) => c.path === "/repos/acme/app" && c.method !== "GET")).toEqual([]);
    expect(fake.writes.map((c) => c.path.replace("/repos/acme/app/", ""))).toEqual(["git/trees", "git/commits", "git/refs", "pulls"]);
  });

  it("the client cannot be used to delete the repository or any ref", async () => {
    const { fake, github } = world();
    for (const req of [{ method: "DELETE", path: "/repos/acme/app" }, { method: "DELETE", path: "/repos/acme/app/git/refs/heads/main" }, { method: "PATCH", path: "/repos/acme/app/git/refs/heads/main", body: { sha: "0".repeat(40), force: true } }]) {
      await expect(github.request(req)).rejects.toBeInstanceOf(LocalOnlyGithubError);
    }
    expect(fake.calls).toEqual([]);
  });
});
