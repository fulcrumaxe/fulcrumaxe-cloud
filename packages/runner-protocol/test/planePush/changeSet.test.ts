import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diffTreeEntries, sameChangeKeys, showTreeEntry, treeFromEntries, treeFromLsTree, type TreeMap } from "../../src/planePush/changeSet.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const e = (path: string, sha: string, mode = "100644", type = "blob") => ({ path, mode, type, sha });
const keep = () => true;

describe("treeFromEntries", () => {
  it("skips directory entries and keeps leaves", () => {
    const t = treeFromEntries([e("src", A, "040000", "tree"), e("src/a.ts", B), e("run.sh", C, "100755"), e("link", A, "120000"), e("sub", B, "160000", "commit")])!;
    expect([...t.keys()].sort()).toEqual(["link", "run.sh", "src/a.ts", "sub"]);
  });
  it("fails closed on every malformed entry, and never returns part of a tree", () => {
    for (const bad of [
      [e("a", A), e("a", B)], // repeated path
      [e("a", "xyz")], // not an object id
      [e("a", A.toUpperCase())],
      [e("a", A, "100664")], // unknown mode
      [e("a", A, "040000", "blob")], // a directory mode on a leaf
      [{ path: "a", mode: "100644", type: "blob" }], // missing sha
      [{ path: 1, mode: "100644", type: "blob", sha: A }],
      ["a"],
      [null],
      [e("a", A), []],
    ]) {
      expect(treeFromEntries(bad as unknown[]), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("diffTreeEntries", () => {
  const base = treeFromEntries([e("keep.ts", A), e("gone.ts", A), e("mode.sh", A), e("docs/ops/x.md", A)])!;
  const head = treeFromEntries([e("keep.ts", A), e("mode.sh", A, "100755"), e("new.ts", B), e("docs/ops/x.md", B)])!;

  it("lists added, removed, mode-changed and blob-changed paths with both entries", () => {
    const d = diffTreeEntries(base, head, keep);
    expect(d.paths.sort()).toEqual(["docs/ops/x.md", "gone.ts", "mode.sh", "new.ts"]);
    expect(d.keys).toEqual([...d.keys].sort());
    expect(d.keys).toContain(`gone.ts\u0000100644:blob:${A}\u0000ABSENT`);
    expect(d.keys).toContain(`new.ts\u0000ABSENT\u0000100644:blob:${B}`);
  });
  it("drops only what keep refuses (the private side drops the overlay)", () => {
    const d = diffTreeEntries(base, head, (p) => !p.startsWith("docs/ops/"));
    expect(d.paths.sort()).toEqual(["gone.ts", "mode.sh", "new.ts"]);
  });
  it("the same end content from another base entry is a different change", () => {
    const fromA = treeFromEntries([e("f", A)])!;
    const fromC = treeFromEntries([e("f", C)])!;
    const end = treeFromEntries([e("f", B)])!;
    expect(sameChangeKeys(diffTreeEntries(fromA, end, keep).keys, diffTreeEntries(fromC, end, keep).keys)).toBe(false);
  });
  it("an extra file, an overlay path on one side, and a missing file are not the same", () => {
    const priv = diffTreeEntries(base, head, (p) => !p.startsWith("docs/ops/")).keys;
    expect(sameChangeKeys(priv, diffTreeEntries(base, head, keep).keys)).toBe(false);
    expect(sameChangeKeys(priv, priv.slice(1))).toBe(false);
    expect(sameChangeKeys(priv, [...priv])).toBe(true);
    expect(sameChangeKeys([], [])).toBe(true);
  });
  it("showTreeEntry names absence", () => expect(showTreeEntry(undefined)).toBe("ABSENT"));
});

describe("treeFromLsTree", () => {
  it("parses the -z format, a path with spaces, newlines and tabs included", () => {
    const out = `100644 blob ${A}\ta b.ts\x00100755 blob ${B}\tline\nbreak\x00160000 commit ${C}\ttab\there\0`;
    const t = treeFromLsTree(out)!;
    expect([...t.keys()]).toEqual(["a b.ts", "line\nbreak", "tab\there"]);
    expect(t.get("tab\there")).toEqual({ mode: "160000", type: "commit", sha: C });
  });
  it("refuses empty, unterminated, malformed and repeated output", () => {
    for (const bad of ["", `100644 blob ${A}\ta`, `100644 blob ${A} a\0`, `100644 blob zz\ta\0`, `100644 blob ${A}\ta\0\0`, `100644 blob ${A}\ta\x00100644 blob ${B}\ta\0`, `100664 blob ${A}\ta\0`]) {
      expect(treeFromLsTree(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parity: GitHub-shaped entries and a real `git ls-tree -r -z` give the same tree and the same keys", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  const put = (cwd: string, rel: string, body: string, mode?: number) => {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), body);
    if (mode) chmodSync(path.join(cwd, rel), mode);
  };

  /** GitHub's tree endpoint lists directories too; the real tree is rebuilt in that shape from `ls-tree -r -t -z`. */
  const githubShape = (cwd: string, commit: string) =>
    run(cwd, "ls-tree", "-r", "-t", "-z", commit)
      .split("\0")
      .filter(Boolean)
      .map((rec) => {
        const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec)!;
        return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
      });
  const tree = (cwd: string, commit: string): TreeMap => treeFromLsTree(run(cwd, "ls-tree", "-r", "-z", commit))!;

  it("a base and a head with an added file, a removed file, a mode change, a blob change and a symlink", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "changeset-parity-"));
    dirs.push(cwd);
    run(cwd, "init", "-q", "-b", "main");
    put(cwd, "src/keep.ts", "k\n");
    put(cwd, "src/gone.ts", "g\n");
    put(cwd, "bin/run.sh", "#!/bin/sh\n");
    put(cwd, "docs/ops/plan.md", "p\n");
    put(cwd, "name with space.txt", "s\n");
    run(cwd, "add", "-A");
    run(cwd, "commit", "-q", "-m", "base");
    const base = run(cwd, "rev-parse", "HEAD").trim();
    rmSync(path.join(cwd, "src/gone.ts"));
    put(cwd, "bin/run.sh", "#!/bin/sh\n", 0o755);
    put(cwd, "src/new.ts", "n\n");
    put(cwd, "docs/ops/plan.md", "changed\n");
    symlinkSync("src/new.ts", path.join(cwd, "link"));
    run(cwd, "add", "-A");
    run(cwd, "commit", "-q", "-m", "head");
    const head = run(cwd, "rev-parse", "HEAD").trim();

    const viaGit = { base: tree(cwd, base), head: tree(cwd, head) };
    const viaRest = { base: treeFromEntries(githubShape(cwd, base))!, head: treeFromEntries(githubShape(cwd, head))! };
    expect([...viaRest.head.entries()]).toEqual([...viaGit.head.entries()]);
    for (const k of [(p: string) => true, (p: string) => !p.startsWith("docs/ops/")]) {
      const g = diffTreeEntries(viaGit.base, viaGit.head, k);
      const r = diffTreeEntries(viaRest.base, viaRest.head, k);
      expect(g.keys).toEqual(r.keys);
      expect(g.paths).toEqual(r.paths);
      expect(sameChangeKeys(g.keys, r.keys)).toBe(true);
    }
    expect(diffTreeEntries(viaGit.base, viaGit.head, () => true).paths.sort()).toEqual(["bin/run.sh", "docs/ops/plan.md", "link", "src/gone.ts", "src/new.ts"]);
  });
});
