import { chmodSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aboveSafe,
  ancestorSafe,
  conventionStateDir,
  discoverCheckout,
  originUrl,
  parseGithubRemote,
  parseProjectFile,
  searchRoots,
  stateDirProblem,
  realOps,
  type DiscoverInput,
} from "../../src/engineBridge/discover.js";

const uid = process.getuid?.();
let base: string;
let home: string;
let runnerState: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "fx-onbr1-"));
  home = path.join(base, "home");
  runnerState = path.join(base, "runner-state");
  mkdirSync(home, { recursive: true });
  mkdirSync(runnerState, { mode: 0o700 });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A clone of `remote` at `dir` with real files, and (unless `project` is null) a project file. */
function clone(dir: string, remote = "https://github.com/acme/widgets.git", project: string | null = JSON.stringify({ project_name: "widgets" })): string {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  if (project !== null) {
    mkdirSync(path.join(dir, ".autonomous-team"), { recursive: true });
    writeFileSync(path.join(dir, ".autonomous-team", "project.json"), project);
  }
  return dir;
}

const scan = (extra: Partial<DiscoverInput> = {}) =>
  discoverCheckout({ repo: "acme/widgets", home, cwd: undefined, extraRoots: undefined, runnerStateDir: runnerState, uid, nowMs: () => 0, ...extra });
const found = (extra: Partial<DiscoverInput> = {}) => scan(extra).matches.map((m) => m.root);

describe("remote matching (ON-BR-1 item 2)", () => {
  const SPELLINGS = [
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets.git",
    "https://github.com/ACME/Widgets.git",
    "https://user:SENTINEL-TOKEN@github.com/acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@ssh.github.com:443/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "git@github.com:Acme/widgets/",
  ];
  it.each(SPELLINGS)("matches %s", (url) => {
    expect(parseGithubRemote(url)).toEqual({ owner: "acme", name: "widgets" });
  });
  it.each(["https://example.com/acme/widgets.git", "https://github.com/acme", "https://github.com/acme/widgets/extra.git", "/srv/git/widgets.git", "", "git@gitlab.com:acme/widgets.git"])("does not match %s", (url) => {
    expect(parseGithubRemote(url)).toBeNull();
  });
  it("reads the origin url only, not another remote's", () => {
    expect(originUrl('[remote "upstream"]\n\turl = https://github.com/x/y\n[remote "origin"]\n\turl = https://github.com/acme/widgets\n')).toBe("https://github.com/acme/widgets");
    expect(originUrl('[remote "upstream"]\n\turl = https://github.com/acme/widgets\n')).toBeUndefined();
  });
  it("ignores a clone of a different repo, and one whose repo name only starts the same", () => {
    clone(path.join(home, "code", "other"), "https://github.com/acme/widgets-extra.git");
    clone(path.join(home, "code", "mine"));
    expect(found()).toEqual([path.join(home, "code", "mine")]);
  });
});

describe("search roots and exclusions (item 1)", () => {
  it("searches the named roots, the current directory and FX_RUNNER_SEARCH_ROOTS, most specific first and the home last", () => {
    for (const d of ["code", "src", "projects", "work", "dev"]) mkdirSync(path.join(home, d));
    const cwd = path.join(base, "cwd");
    const extra = path.join(base, "extra");
    mkdirSync(cwd);
    mkdirSync(extra);
    const { roots, ignored } = searchRoots({ home, cwd, extraRoots: `${extra}:relative/dir:${path.join(base, "missing")}`, runnerStateDir: runnerState });
    expect(roots).toEqual([...["code", "src", "projects", "work", "dev"].map((d) => path.join(home, d)), cwd, extra, home]);
    expect(ignored).toBe(2);
  });
  it("never searches /, /proc, /sys, /dev or the runner's own state directory", () => {
    const { roots } = searchRoots({ home: undefined, cwd: "/", extraRoots: `/:/proc:/proc/self:/sys:/dev:${runnerState}:${runnerState}/inner`, runnerStateDir: runnerState });
    expect(roots).toEqual([]);
  });
  it("does not look inside the runner's state directory even when a root contains it", () => {
    clone(path.join(runnerState, "clone"));
    expect(found({ extraRoots: undefined, home: base })).toEqual([]);
  });
  it.each(["node_modules", ".cache", ".git", "target", "dist"])("does not enter a directory named %s", (name) => {
    clone(path.join(home, "code", name, "widgets"));
    expect(found()).toEqual([]);
    clone(path.join(home, "dev", "fine", "widgets"));
    expect(found()).toEqual([path.join(home, "dev", "fine", "widgets")]);
  });
  it("goes four directories deep from a root and no further", () => {
    clone(path.join(home, "code", "a", "b", "c", "d"));
    expect(found()).toEqual([path.join(home, "code", "a", "b", "c", "d")]);
    rmSync(path.join(home, "code"), { recursive: true });
    clone(path.join(home, "code", "a", "b", "c", "d", "e"));
    expect(found()).toEqual([]);
  });
  it("finds a clone through the current directory root and through an extra root", () => {
    const cwd = clone(path.join(base, "elsewhere", "w"));
    const extra = path.join(base, "more");
    clone(path.join(extra, "w2"), "git@github.com:acme/other.git");
    expect(found({ cwd: path.join(base, "elsewhere"), home: undefined })).toEqual([cwd]);
    expect(found({ cwd: undefined, home: undefined, extraRoots: extra })).toEqual([]);
  });
  it("stops at the time limit with a fake clock and says which limit it hit", () => {
    for (let i = 0; i < 30; i++) mkdirSync(path.join(home, "code", `d${i}`), { recursive: true });
    clone(path.join(home, "code", "zzz-last"));
    let t = 0;
    // The host lists a directory in whatever order its filesystem likes, so the clone could come up before the clock ran out. List it last, always.
    const lastOrder = { readDir: (dir: string) => [...realOps.readDir(dir)].sort((a, b) => Number(a.name === "zzz-last") - Number(b.name === "zzz-last")) };
    const r = scan({ nowMs: () => (t += 1000), ops: lastOrder });
    expect(r.limit).toBe("time");
    expect(r.visited).toBeLessThan(10);
    expect(r.matches).toEqual([]);
  });
  it("stops at the entry limit and says so; under it, limit is null", () => {
    for (let i = 0; i < 40; i++) mkdirSync(path.join(home, "code", `d${i}`), { recursive: true });
    const r = scan({ maxEntries: 10 });
    expect(r.limit).toBe("entries");
    expect(scan().limit).toBeNull();
  });
  it("looks at every folder of a level before it lists any of them, so a big early tree cannot starve a later checkout", () => {
    // `aaa-junk` is listed first and holds 50 folders with 5 each; the checkout sits in `zzz-mine`. Going deep first, the budget below would be gone inside `aaa-junk`.
    for (let i = 0; i < 50; i++) for (let j = 0; j < 5; j++) mkdirSync(path.join(home, "aaa-junk", `d${i}`, `e${j}`), { recursive: true });
    const mine = clone(path.join(home, "zzz-mine"));
    const byName = { readDir: (dir: string) => [...realOps.readDir(dir)].sort((a, b) => a.name.localeCompare(b.name)) };
    const r = scan({ maxEntries: 120, ops: byName });
    expect(r.limit).toBe("entries");
    expect(r.matches.map((m) => m.root)).toEqual([mine]);
  });
  it("counts an entry limit of 20000 by default", () => {
    const list = Array.from({ length: 25000 }, (_, i) => ({ name: `d${i}`, isDirectory: false }));
    let calls = 0;
    mkdirSync(path.join(home, "code"));
    const r = scan({ ops: { readDir: () => (calls++ === 0 ? list : []) } });
    expect(r.limit).toBe("entries");
  });
});

describe("what counts as a checkout (item 2, 6)", () => {
  it("skips a linked worktree whose .git is a file", () => {
    const wt = path.join(home, "code", "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, ".git"), "gitdir: /fictional/main/.git/worktrees/wt\n");
    mkdirSync(path.join(wt, ".autonomous-team"));
    writeFileSync(path.join(wt, ".autonomous-team", "project.json"), JSON.stringify({ project_name: "widgets" }));
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.unexpected).toEqual([]);
  });
  it.each([
    ["no project file", null],
    ["not JSON", "{nope"],
    ["over 64 KiB", JSON.stringify({ project_name: "widgets", pad: "x".repeat(70 * 1024) })],
    ["neither fact", JSON.stringify({ other: 1 })],
    ["an array", "[]"],
    ["a relative state_dir", JSON.stringify({ project_name: "widgets", state_dir: "state/here" })],
    ["a state_dir with ..", JSON.stringify({ project_name: "widgets", state_dir: "/fictional/a/../b" })],
  ])("reports a clone with %s as not an engine checkout and never matches it", (_label, project) => {
    const dir = clone(path.join(home, "code", "w"), undefined, project);
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.unexpected).toEqual([dir]);
  });
  it("accepts a clone with uncommitted changes (the scan never asks git)", () => {
    const dir = clone(path.join(home, "code", "w"));
    writeFileSync(path.join(dir, "scratch.txt"), "dirty");
    expect(found()).toEqual([dir]);
  });
  it("finds a checkout once even when two roots reach it", () => {
    const dir = clone(path.join(home, "code", "w"));
    expect(found({ extraRoots: path.join(home, "code") })).toEqual([dir]);
  });
  it("ignores a .autonomous-team that is a link", () => {
    const dir = clone(path.join(home, "code", "w"), undefined, null);
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "project.json"), JSON.stringify({ project_name: "widgets" }));
    symlinkSync(elsewhere, path.join(dir, ".autonomous-team"));
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.unexpected).toEqual([dir]);
  });
});

describe("the state directory convention (item 4, 8)", () => {
  it("takes the project file's state_dir, then $HOME/.<project_name>-state, then the environment, in that order", () => {
    const both = parseProjectFile(JSON.stringify({ project_name: "w", state_dir: "/fictional/s" }))!;
    expect(conventionStateDir(both, "/fictional/home", "/fictional/env")).toEqual({ dir: "/fictional/s", source: "project_state_dir" });
    const named = parseProjectFile(JSON.stringify({ project_name: "w" }))!;
    expect(conventionStateDir(named, "/fictional/home", "/fictional/env")).toEqual({ dir: "/fictional/home/.w-state", source: "project_name" });
    expect(conventionStateDir(named, undefined, "/fictional/env")).toEqual({ dir: "/fictional/env", source: "env" });
    expect(conventionStateDir(named, undefined, undefined)).toBeUndefined();
  });
  it("never produces the runner's default .autonomous-forever-state when the file names another", () => {
    const named = parseProjectFile(JSON.stringify({ project_name: "w" }))!;
    expect(conventionStateDir(named, "/fictional/home", undefined)?.dir).not.toContain(".autonomous-forever-state");
  });
  it("reports a missing, plain-file, unreadable and (by uid) foreign directory, and never creates one", () => {
    const missing = path.join(base, "nope");
    expect(stateDirProblem(missing, uid)).toBe("state_dir_missing");
    expect(() => statNone(missing)).not.toThrow();
    const file = path.join(base, "file");
    writeFileSync(file, "x");
    expect(stateDirProblem(file, uid)).toBe("state_dir_unreadable");
    const ok = path.join(base, "ok");
    mkdirSync(ok, { mode: 0o700 });
    expect(stateDirProblem(ok, uid)).toBeNull();
    expect(stateDirProblem(ok, (uid ?? 0) + 1)).toBe("state_dir_unreadable");
    chmodSync(ok, 0o000);
    expect(stateDirProblem(ok, uid)).toBe("state_dir_unreadable");
    chmodSync(ok, 0o700);
    const link = path.join(base, "link");
    symlinkSync(ok, link);
    expect(stateDirProblem(link, uid)).toBe("state_dir_unreadable");
  });
});

function statNone(p: string): void {
  // The runner's check must leave nothing behind.
  expect(() => [...realOps.readDir(p)]).toThrow();
}

describe("symlinks and escapes (item 10)", () => {
  it("never follows a link to a directory outside the root, and ignores a loop", () => {
    const outside = clone(path.join(base, "outside", "w"));
    mkdirSync(path.join(home, "code"), { recursive: true });
    symlinkSync(path.dirname(outside), path.join(home, "code", "escape"));
    symlinkSync("/etc", path.join(home, "code", "etc-link"));
    symlinkSync(path.join(home, "code"), path.join(home, "code", "loop"));
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.limit).toBeNull();
  });
  it("does not open a candidate whose real path is outside its root, even if the lister reports a link as a directory", () => {
    const outside = clone(path.join(base, "outside", "w"));
    mkdirSync(path.join(home, "code"), { recursive: true });
    symlinkSync(path.dirname(outside), path.join(home, "code", "escape"));
    const listed: string[] = [];
    const lying = { readDir: (dir: string) => (listed.push(dir), [...realOps.readDir(dir)].map((e) => ({ ...e, isDirectory: true }))) };
    expect(found({ ops: lying })).toEqual([]);
    // The link's target was never listed or opened: only directories inside the home were.
    expect(listed.every((d) => d === home || d.startsWith(`${home}/`))).toBe(true);
    expect(listed.some((d) => d.includes("outside"))).toBe(false);
  });
  it("does not read a .git/config that is a link", () => {
    const dir = path.join(home, "code", "w");
    clone(dir);
    rmSync(path.join(dir, ".git", "config"));
    const real = path.join(base, "real-config");
    writeFileSync(real, '[remote "origin"]\n\turl = https://github.com/acme/widgets\n');
    symlinkSync(real, path.join(dir, ".git", "config"));
    expect(found()).toEqual([]);
  });
});

describe("swaps and unsafe directories (CWE-367 and CWE-59)", () => {
  const swapIn = (target: string, replacement: () => void) => ({
    readDir: realOps.readDir,
    beforeOpen: (file: string) => {
      if (file.startsWith(target)) replacement();
    },
  });

  it("refuses a .git that is a link to a directory, even one holding a matching config", () => {
    const outside = clone(path.join(base, "outside", "w"));
    const dir = path.join(home, "code", "w");
    mkdirSync(dir, { recursive: true });
    symlinkSync(path.join(outside, ".git"), path.join(dir, ".git"));
    mkdirSync(path.join(dir, ".autonomous-team"));
    writeFileSync(path.join(dir, ".autonomous-team", "project.json"), JSON.stringify({ project_name: "widgets" }));
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.unexpected).toEqual([]);
    expect(r.unsafe).toBe(0);
  });

  it("does not adopt a candidate whose directory or .git is writable by group or others, and counts it", () => {
    const dir = clone(path.join(home, "code", "w"));
    for (const target of [dir, path.join(dir, ".git")]) {
      chmodSync(target, 0o775);
      const r = scan();
      expect(r.matches, target).toEqual([]);
      expect(r.unsafe, target).toBe(1);
      chmodSync(target, 0o755);
    }
    expect(found()).toEqual([dir]);
    chmodSync(path.join(dir, ".autonomous-team"), 0o777);
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.unexpected).toEqual([dir]);
  });

  it("does not adopt a candidate owned by another user (the uid is injected)", () => {
    clone(path.join(home, "code", "w"));
    const r = scan({ uid: (uid ?? 0) + 1 });
    expect(r.matches).toEqual([]);
    expect(r.unsafe).toBe(1);
  });

  it("refuses when .git is swapped for a link to an outside clone between the check and the open", () => {
    const outside = clone(path.join(base, "outside", "w"));
    const dir = clone(path.join(home, "code", "w"), "git@github.com:acme/other.git");
    const ops = swapIn(path.join(dir, ".git"), () => {
      rmSync(path.join(dir, ".git"), { recursive: true });
      symlinkSync(path.join(outside, ".git"), path.join(dir, ".git"));
    });
    expect(scan({ ops }).matches).toEqual([]);
  });

  it("refuses when .git is replaced by a different real directory (device/inode mismatch) between the check and the open", () => {
    const dir = clone(path.join(home, "code", "w"));
    const ops = swapIn(path.join(dir, ".git"), () => {
      cpSync(path.join(dir, ".git"), path.join(dir, ".git-copy"), { recursive: true });
      rmSync(path.join(dir, ".git"), { recursive: true });
      renameSync(path.join(dir, ".git-copy"), path.join(dir, ".git"));
    });
    expect(scan({ ops }).matches).toEqual([]);
  });

  it("refuses when .autonomous-team is swapped for a link to an outside project between the check and the open", () => {
    const outside = clone(path.join(base, "outside", "w"));
    const dir = clone(path.join(home, "code", "w"));
    const ops = swapIn(path.join(dir, ".autonomous-team"), () => {
      rmSync(path.join(dir, ".autonomous-team"), { recursive: true });
      symlinkSync(path.join(outside, ".autonomous-team"), path.join(dir, ".autonomous-team"));
    });
    const r = scan({ ops });
    expect(r.matches).toEqual([]);
    expect(r.unexpected).toEqual([dir]);
  });

  it.each([0o777, 0o775])("does not adopt a checkout below a directory with mode %o (the parent could be swapped for a link)", (mode) => {
    const parent = path.join(home, "code", "shared");
    clone(path.join(parent, "w"));
    chmodSync(parent, mode);
    const r = scan();
    expect(r.matches).toEqual([]);
    expect(r.unsafe).toBe(1);
    expect(r.unsafePaths).toEqual([path.join(parent, "w")]);
    chmodSync(parent, 0o755);
    expect(found()).toEqual([path.join(parent, "w")]);
  });

  it("does not adopt anything when the search root itself is group or other writable, and a mid-chain directory counts too", () => {
    clone(path.join(home, "code", "a", "b", "w"));
    chmodSync(path.join(home, "code"), 0o777);
    expect(scan().matches).toEqual([]);
    chmodSync(path.join(home, "code"), 0o755);
    chmodSync(path.join(home, "code", "a"), 0o770);
    expect(scan().matches).toEqual([]);
    chmodSync(path.join(home, "code", "a"), 0o755);
    expect(found()).toHaveLength(1);
  });

  it("allows a directory above the checkout that is writable by others when it has the sticky bit", () => {
    const parent = path.join(home, "code", "tmpish");
    clone(path.join(parent, "w"));
    chmodSync(parent, 0o1777);
    expect(found()).toEqual([path.join(parent, "w")]);
  });

  it("ancestorSafe: owner or root only, no group or other write unless sticky, directories only", () => {
    const d = (over: Partial<{ isDirectory: boolean; uid: number; mode: number }> = {}) => ({ isDirectory: true, uid: 1000, mode: 0o755, ...over });
    expect(ancestorSafe(d(), 1000)).toBe(true);
    expect(ancestorSafe(d({ uid: 0 }), 1000)).toBe(true);
    expect(ancestorSafe(d({ uid: 1001 }), 1000)).toBe(false);
    expect(ancestorSafe(d({ mode: 0o775 }), 1000)).toBe(false);
    expect(ancestorSafe(d({ mode: 0o757 }), 1000)).toBe(false);
    expect(ancestorSafe(d({ mode: 0o1777 }), 1000)).toBe(true);
    expect(ancestorSafe(d({ isDirectory: false }), 1000)).toBe(false);
  });

  it("does not adopt a checkout when a directory above the search root is writable by others, and allows one that is sticky", () => {
    const team = path.join(base, "team");
    const myHome = path.join(team, "me");
    clone(path.join(myHome, "code", "w"));
    chmodSync(team, 0o777);
    const r = scan({ home: myHome });
    expect(r.matches).toEqual([]);
    expect(r.unsafe).toBe(1);
    expect(r.unsafePaths).toEqual([path.join(myHome, "code", "w")]);
    chmodSync(team, 0o1777);
    expect(found({ home: myHome })).toEqual([path.join(myHome, "code", "w")]);
  });

  it("judges a root reached through a link by the real parents of its target", () => {
    const evil = path.join(base, "team", "evil");
    const target = path.join(evil, "me");
    clone(path.join(target, "code", "w"));
    chmodSync(path.join(base, "team"), 0o777);
    chmodSync(evil, 0o777);
    const alias = path.join(base, "alias-home");
    symlinkSync(target, alias);
    const r = scan({ home: alias });
    expect(r.matches).toEqual([]);
    expect(r.unsafe).toBe(1);
  });

  it("aboveSafe passes the ordinary parents of a private scratch directory", () => {
    expect(aboveSafe(path.join(home, "code"), uid)).toBe(true);
  });

  it("returns the real path of the checkout when its root was reached through a link", () => {
    const real = clone(path.join(base, "real-home", "code", "w"));
    const alias = path.join(base, "alias-home");
    symlinkSync(path.join(base, "real-home"), alias);
    expect(found({ home: alias })).toEqual([real]);
  });

  it("reads a long url line in linear time", () => {
    const evil = `url =${" ".repeat(120000)}x${" ".repeat(120000)}y`;
    const start = Date.now();
    expect(originUrl(`[remote "origin"]\n${evil}\n`)).toBeUndefined();
    expect(originUrl(`[remote "origin"]\n\turl =${" ".repeat(3000)}https://github.com/acme/widgets${" ".repeat(900)}\n`)).toBe("https://github.com/acme/widgets");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("skips the runner's state directory when a root names it through a link", () => {
    clone(path.join(runnerState, "w"));
    const alias = path.join(base, "alias");
    symlinkSync(runnerState, alias);
    expect(searchRoots({ home: undefined, cwd: undefined, extraRoots: alias, runnerStateDir: runnerState }).roots).toEqual([]);
    expect(found({ home: undefined, extraRoots: alias })).toEqual([]);
  });

  it("counts entries while one huge directory is being read", () => {
    mkdirSync(path.join(home, "code"));
    let yielded = 0;
    const ops = {
      readDir: function* () {
        for (let i = 0; i < 1_000_000; i++) {
          yielded += 1;
          yield { name: `n${i}`, isDirectory: false };
        }
      },
    };
    expect(scan({ ops, maxEntries: 50 }).limit).toBe("entries");
    expect(yielded).toBeLessThan(200);
  });
});
