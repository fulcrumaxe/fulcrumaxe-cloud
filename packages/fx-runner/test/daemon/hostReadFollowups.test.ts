import { execFile, execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangedFiles, createVcsState } from "../../src/daemon/checkStep.js";
import { configEnv, guardConfigEnv, type Git, type GitCapture } from "../../src/daemon/git.js";
import { cleanResumedWorkspace } from "../../src/daemon/resumeClean.js";
import { hostGit, pinWorkspaceGit } from "../../src/daemon/hostRead.js";
import { unpinWorkspace } from "../../src/daemon/workspacePin.js";
import { REFTABLE_NAME } from "../../src/daemon/workspaceGit.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

// The walker, called through: counts how often a host read walks the worktree.
const walks = vi.hoisted(() => vi.fn());
const walkOff = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/daemon/nestedGitfiles.js", async (original) => {
  const real = await original<typeof import("../../src/daemon/nestedGitfiles.js")>();
  return { ...real, assertNoOutsideGitfiles: (workspace: string): void => (walks(), walkOff.on ? undefined : real.assertNoOutsideGitfiles(workspace)) };
});

/**
 * D#6 RUNNER-HOSTREAD-FOLLOWUPS-527: three holes the final review of the host-read check left.
 *  F1 the reftable folder's shape, F2 a nested gitfile that names a place outside the workspace, F3 `.gitmodules` overriding the ignore-submodules setting.
 * Real git, real temp directories, a workspace made by the real `git clone` and pinned the way the daemon pins it after its clone.
 */
let root: string;
let ws: string;
let mirrorObjects: string;
let outside: string;
let marker: string;
let started: string[][];
let baseSha = "";

const SETUP_ENV = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.test" });
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const realGit: Git = {
  async run(_code, args, config, _timeout, extraEnv) {
    const env = { ...SETUP_ENV(), ...(config === undefined ? guardConfigEnv() : configEnv(config)), ...extraEnv };
    return execFileSync("git", [...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  },
};
const capture: GitCapture = (command, args, env, timeoutMs) => {
  started.push([...args]);
  return new Promise((resolve) => {
    execFile(command, [...args], { env, timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
      resolve({ code, stdout, timedOut: false });
    });
  });
};
const envOptions = {} as never;

function repoAt(dir: string, refFormat = "files"): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main", `--ref-format=${refFormat}`);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "base");
}

/** Makes `ws` the way the daemon's clone does, in the given ref storage format, and pins it. */
async function makeWorkspace(refFormat: string): Promise<void> {
  execFileSync("git", ["clone", "-q", "--bare", path.join(root, "src"), path.join(root, "mirror.git")], { env: SETUP_ENV() });
  execFileSync("git", ["clone", "-q", `--ref-format=${refFormat}`, "--reference", path.join(root, "mirror.git"), "--no-local", "--", path.join(root, "mirror.git"), ws], { env: SETUP_ENV() });
  sh(ws, "checkout", "-q", "-b", "work");
  mirrorObjects = path.join(root, "mirror.git", "objects");
  baseSha = sh(ws, "rev-parse", "HEAD").trim();
  await pinWorkspaceGit(realGit, ws, mirrorObjects);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpRoot(), "fxr-hostread-fu-"));
  ws = path.join(root, "ws");
  outside = path.join(root, "outside");
  marker = path.join(root, "marker-ran");
  started = [];
  repoAt(path.join(root, "src"));
});
afterEach(() => {
  walkOff.on = false;
  unpinWorkspace(ws);
  rmSync(root, { recursive: true, force: true });
});

const readsRefused = async (): Promise<void> => {
  await expect(createVcsState(capture, envOptions)(ws)).rejects.toMatchObject({ code: "workspace_git_refused" });
  await expect(createChangedFiles(capture, envOptions)(ws, baseSha)).rejects.toMatchObject({ code: "workspace_git_refused" });
  expect(started).toEqual([]);
};

describe("F1: the reftable folder", () => {
  /** The victim: another repository on the host, in reftable storage, with a branch whose name must never show. Returns the name of its table. */
  function victim(): string {
    repoAt(outside, "reftable");
    sh(outside, "branch", "outside-secret-branch");
    const lines = readFileSync(path.join(outside, ".git", "reftable", "tables.list"), "utf8").split("\n").filter((line) => line !== "");
    return lines[lines.length - 1]!;
  }

  it("a real reftable clone passes (and the real table names match the strict pattern)", async () => {
    await makeWorkspace("reftable");
    expect(readFileSync(path.join(ws, ".git", "config"), "utf8")).toContain("refstorage = reftable");
    const names = readFileSync(path.join(ws, ".git", "reftable", "tables.list"), "utf8").split("\n").filter((line) => line !== "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(REFTABLE_NAME);
    writeFileSync(path.join(ws, "new.txt"), "x\n");
    expect(await createChangedFiles(capture, envOptions)(ws, baseSha)).toEqual(["new.txt"]);
    const state = await createVcsState(capture, envOptions)(ws);
    expect(state).toContain("refs/heads/work");
    expect(state).not.toContain("outside-secret-branch");
  });

  it("a reftable folder that is a link to another repository's is refused: its refs are not listed", async () => {
    await makeWorkspace("reftable");
    victim();
    rmSync(path.join(ws, ".git", "reftable"), { recursive: true });
    symlinkSync(path.join(outside, ".git", "reftable"), path.join(ws, ".git", "reftable"));
    expect(sh(ws, "for-each-ref", "--format=%(refname)")).toContain("outside-secret-branch"); // what an unchecked read reports
    await readsRefused();
  });

  it("a tables.list that names another repository's table by a relative path is refused", async () => {
    await makeWorkspace("reftable");
    const table = victim();
    writeFileSync(path.join(ws, ".git", "reftable", "tables.list"), `../../../outside/.git/reftable/${table}\n`);
    expect(sh(ws, "for-each-ref", "--format=%(refname)")).toContain("outside-secret-branch");
    await readsRefused();
  });

  it("other shapes inside the reftable folder are refused: a link, a sub-folder, a name that is not a table, a hard link", async () => {
    await makeWorkspace("reftable");
    const dir = path.join(ws, ".git", "reftable");
    const original = readFileSync(path.join(dir, "tables.list"), "utf8");
    const table = original.split("\n")[0]!;
    const cases: Array<[string, () => void, () => void]> = [
      ["link", () => symlinkSync(path.join(root, "src", "a.txt"), path.join(dir, "x.ref")), () => rmSync(path.join(dir, "x.ref"))],
      ["sub-folder", () => mkdirSync(path.join(dir, "sub")), () => rmSync(path.join(dir, "sub"), { recursive: true })],
      ["hard link", () => linkSync(path.join(dir, table), path.join(root, "second-name")), () => rmSync(path.join(root, "second-name"))],
      ["a name with a slash", () => writeFileSync(path.join(dir, "tables.list"), `sub/${table}\n`), () => writeFileSync(path.join(dir, "tables.list"), original)],
      ["a name with dots", () => writeFileSync(path.join(dir, "tables.list"), `..${table}\n`), () => writeFileSync(path.join(dir, "tables.list"), original)],
      ["a second line that is not a table", () => writeFileSync(path.join(dir, "tables.list"), `${table}\nHEAD\n`), () => writeFileSync(path.join(dir, "tables.list"), original)],
    ];
    for (const [label, apply, undo] of cases) {
      apply();
      await expect(createVcsState(capture, envOptions)(ws), label).rejects.toMatchObject({ code: "workspace_git_refused" });
      undo();
      expect(await createVcsState(capture, envOptions)(ws), `${label} undone`).toContain("refs/heads/work");
    }
  });
});

describe("F2: nested repositories that lead out of the workspace", () => {
  beforeEach(async () => {
    await makeWorkspace("files");
    repoAt(outside);
    sh(outside, "branch", "outside-secret-branch");
    mkdirSync(path.join(outside, "deep"));
    walks.mockClear();
  });
  const bothRefused = async (label: string): Promise<void> => {
    await expect(createChangedFiles(capture, envOptions)(ws, baseSha), label).rejects.toMatchObject({ code: "workspace_git_refused" });
    expect(started, label).toEqual([]);
  };

  it("control: git itself reads the outside repository through a gitfile (the listing differs from an empty directory)", () => {
    mkdirSync(path.join(ws, "sub"));
    writeFileSync(path.join(ws, "sub", "f"), "x\n");
    expect(sh(ws, "ls-files", "--others", "--exclude-standard")).toContain("sub/f");
    writeFileSync(path.join(ws, "sub", ".git"), `gitdir: ${path.join(outside, ".git")}\n`);
    expect(sh(ws, "ls-files", "--others", "--exclude-standard")).not.toContain("sub/f"); // the nested directory now counts as a repository
  });

  it("every nested gitfile is refused, whatever it names: absolute, relative, inside, folded through a link (A), or to a folder whose commondir leads out (B)", async () => {
    mkdirSync(path.join(ws, "sub"));
    symlinkSync(path.join(outside, "deep"), path.join(ws, "l"));
    mkdirSync(path.join(ws, "gd"));
    writeFileSync(path.join(ws, "gd", "commondir"), `${path.join(outside, ".git")}\n`);
    const cases: Array<[string, string]> = [
      ["absolute", `gitdir: ${path.join(outside, ".git")}\n`],
      ["relative", "gitdir: ../../outside/.git\n"],
      ["A: a dot-dot folded away by a link", "gitdir: ../l/../.git\n"],
      ["inside", "gitdir: ../gd\n"],
      ["B: inside, with a commondir that leads out", "gitdir: ../gd\n"],
      ["not a gitdir line", "something else\n"],
    ];
    for (const [label, text] of cases) {
      writeFileSync(path.join(ws, "sub", ".git"), text);
      await bothRefused(label);
    }
    rmSync(path.join(ws, "sub", ".git"));
    symlinkSync(path.join(outside, ".git"), path.join(ws, "sub", ".git")); // a link named .git
    await bothRefused("link");
  });

  /** A real nested repository at ws/<rel>, which the agent then tampers with. */
  function nestedRepo(rel: string, refFormat = "files"): string {
    const inner = path.join(ws, rel);
    mkdirSync(inner, { recursive: true });
    sh(inner, "init", "-q", "-b", "main", `--ref-format=${refFormat}`);
    return path.join(inner, ".git");
  }

  it("any nested .git folder is refused without being entered, whatever it holds: a plain repository, links, includes, reftable names, a commondir (C), linked entries (D)", async () => {
    const nestedGit = nestedRepo("sub");
    await bothRefused("plain nested repository");
    rmSync(nestedGit, { recursive: true });
    mkdirSync(nestedGit);
    writeFileSync(path.join(nestedGit, "commondir"), `${path.join(outside, ".git")}\n`);
    await bothRefused("C commondir");
    rmSync(path.join(nestedGit, "commondir"));
    for (const name of ["HEAD", "config", "packed-refs", "objects", "refs", "reftable"]) {
      symlinkSync(path.join(outside, ".git", name === "reftable" ? "refs" : name), path.join(nestedGit, name));
      await bothRefused(`D ${name}`);
      rmSync(path.join(nestedGit, name));
    }
    rmSync(nestedGit, { recursive: true });
    expect(await createChangedFiles(capture, envOptions)(ws, baseSha)).toBeDefined(); // nothing named .git is left
  });

  it("a nested repository the agent has tampered with inside is refused before git starts: X1 a link in refs/heads, X3 a linked refs/heads, X7 reftable names with ../, X8 an include.path", async () => {
    // X1
    let g = nestedRepo("x1");
    symlinkSync(path.join(outside, ".git", "refs", "heads", "main"), path.join(g, "refs", "heads", "leak"));
    await bothRefused("X1");
    rmSync(path.join(ws, "x1"), { recursive: true });
    // X3
    g = nestedRepo("x3");
    rmSync(path.join(g, "refs", "heads"), { recursive: true });
    symlinkSync(path.join(outside, ".git", "refs", "heads"), path.join(g, "refs", "heads"));
    await bothRefused("X3");
    rmSync(path.join(ws, "x3"), { recursive: true });
    // X7
    g = nestedRepo("x7", "reftable");
    writeFileSync(path.join(g, "reftable", "tables.list"), "../../../../../outside/.git/reftable/0x000000000001-0x000000000001-deadbeef.ref\n");
    await bothRefused("X7");
    rmSync(path.join(ws, "x7"), { recursive: true });
    // X8: the answer to "does this host file exist" would come from whether the include is read
    g = nestedRepo("x8");
    writeFileSync(path.join(root, "host-file"), "[user]\n\tname = leaked\n");
    writeFileSync(path.join(g, "config"), `${readFileSync(path.join(g, "config"), "utf8")}[include]\n\tpath = ${path.join(root, "host-file")}\n`);
    await bothRefused("X8");
  });

  it("a loose ref that is /dev/zero or a FIFO, and a FIFO as a nested HEAD, are refused: git never runs, nothing is read", async () => {
    let g = nestedRepo("x2");
    symlinkSync("/dev/zero", path.join(g, "refs", "heads", "zero"));
    await bothRefused("X2");
    rmSync(path.join(ws, "x2"), { recursive: true });
    g = nestedRepo("x5");
    execFileSync("mkfifo", [path.join(g, "refs", "heads", "fifo")]);
    await bothRefused("X5 loose ref");
    rmSync(path.join(g, "refs", "heads", "fifo"));
    rmSync(path.join(g, "HEAD"));
    execFileSync("mkfifo", [path.join(g, "HEAD")]);
    await bothRefused("X6 HEAD");
  });

  it("the trigger shapes are refused too: a tracked file replaced by a folder holding a nested repository, an ignored folder that holds one, and the resume listing", async () => {
    rmSync(path.join(ws, "a.txt"));
    const g = nestedRepo("a.txt");
    await bothRefused("tracked file replaced by a directory");
    rmSync(path.join(ws, "a.txt"), { recursive: true });
    writeFileSync(path.join(ws, ".gitignore"), "cache/\n");
    nestedRepo(path.join("cache", "deep"));
    await bothRefused("ignored folder");
    const git: Git = { run: async (_code, args) => (started.push([...args]), "") };
    expect(await cleanResumedWorkspace(git, ws, undefined, 65536, "linux")).toEqual({ files: 0, dirs: 0 });
    expect(started).toEqual([]);
    expect(g).toContain("a.txt");
  });

  it("a symlinked directory loop does not hang the walk, and is not entered", async () => {
    mkdirSync(path.join(ws, "a", "b"), { recursive: true });
    symlinkSync(".", path.join(ws, "loop"));
    symlinkSync("../..", path.join(ws, "a", "b", "up"));
    symlinkSync(root, path.join(ws, "to-root"));
    mkdirSync(path.join(root, "also-outside"));
    writeFileSync(path.join(root, "also-outside", ".git"), `gitdir: ${path.join(outside, ".git")}\n`); // behind a link: never walked
    expect(await createChangedFiles(capture, envOptions)(ws, baseSha)).toBeDefined();
  }, 20_000);

  it("a very deep tree is refused for a worktree read, not walked without bound", async () => {
    let dir = ws;
    for (let level = 0; level < 70; level++) {
      dir = path.join(dir, "d");
      mkdirSync(dir);
    }
    await bothRefused("deep");
  });

  it("the ref-only reads never walk; the changed-files pair walks once", async () => {
    await createVcsState(capture, envOptions)(ws);
    expect(walks).not.toHaveBeenCalled();
    await createChangedFiles(capture, envOptions)(ws, baseSha);
    expect(walks).toHaveBeenCalledTimes(1);
  });

  it("a tree past the walk's entry cap refuses the worktree reads and does not touch the ref-only snapshot", async () => {
    for (let d = 0; d < 450; d++) {
      const dir = path.join(ws, "big", `d${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 1000; f++) writeFileSync(path.join(dir, `f${f}`), "");
    }
    expect(await createVcsState(capture, envOptions)(ws)).toContain("refs/heads/work");
    started.length = 0;
    await bothRefused("450k entries");
  }, 240_000);
});

describe("a fresh clone of a repository with an uninitialised submodule", () => {
  it("is read as before", async () => {
    repoAt(path.join(root, "subrepo"));
    sh(path.join(root, "src"), "-c", "protocol.file.allow=always", "submodule", "add", "-q", path.join(root, "subrepo"), "sub");
    sh(path.join(root, "src"), "commit", "-q", "-m", "add the submodule");
    await makeWorkspace("files");
    expect(existsSync(path.join(ws, "sub"))).toBe(true);
    writeFileSync(path.join(ws, "new.txt"), "x\n");
    expect(await createChangedFiles(capture, envOptions)(ws, baseSha)).toEqual(["new.txt"]);
    expect(await createVcsState(capture, envOptions)(ws)).toContain("refs/heads/work");
  });
});

describe("F3: .gitmodules cannot turn the submodule inspection back on", () => {
  beforeEach(async () => {
    await makeWorkspace("files");
  });

  it("`ignore = none` in .gitmodules plus a nested repository with a clean filter: no program starts", async () => {
    const inner = path.join(ws, "sub");
    mkdirSync(inner);
    sh(inner, "init", "-q", "-b", "main");
    writeFileSync(path.join(inner, "f"), "one\n");
    writeFileSync(path.join(inner, ".gitattributes"), "* filter=x\n");
    sh(inner, "add", ".");
    sh(inner, "commit", "-q", "-m", "inner");
    sh(inner, "config", "filter.x.clean", `touch ${marker}; cat`);
    writeFileSync(path.join(ws, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
    sh(ws, "add", "sub", ".gitmodules");
    sh(ws, "commit", "-q", "-m", "gitlink");
    baseSha = sh(ws, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(inner, "f"), "two\n");
    // The walk would refuse this nested repository first; it is switched off here so the argument alone is under test (it is the second line).
    walkOff.on = true;
    // Control: with only the setting (what the neutral config had before), .gitmodules wins and the nested repository's filter runs.
    execFileSync("git", ["-C", ws, "-c", "diff.ignoreSubmodules=all", "diff", "--name-only", baseSha, "--"], { env: SETUP_ENV(), stdio: "ignore" });
    const overridden = existsSync(marker);
    if (overridden) rmSync(marker);
    // Re-pin: the commit above changed nothing in .git/config, but make the point that the host read has to hold without help from the setting.
    await createChangedFiles(capture, envOptions)(ws, baseSha);
    expect(existsSync(marker)).toBe(false);
    expect(overridden, "the .gitmodules override is real in this git").toBe(true);
    expect(started.some((args) => args.includes("diff") && args.includes("--ignore-submodules=all"))).toBe(true);
  });

  it("the builder puts --ignore-submodules=all on the diff family and refuses a caller's own", () => {
    expect(hostGit("diff", "--name-only", "HEAD").argv).toEqual(["diff", "--ignore-submodules=all", "--name-only", "HEAD"]);
    expect(hostGit("status", "--porcelain").argv).toEqual(["status", "--ignore-submodules=all", "--porcelain"]);
    expect(hostGit("ls-files", "-z").argv).toEqual(["ls-files", "-z"]);
    for (const recurse of ["--recurse-submodules", "--recurse-submodules=on-demand"]) {
      for (const verb of ["diff", "status", "ls-files"] as const) expect(() => hostGit(verb, recurse), `${verb} ${recurse}`).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
    }
    for (const own of ["--ignore-submodules", "--ignore-submodules=none", "--ignore-submodules=dirty"]) {
      expect(() => hostGit("diff", own), own).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
    }
  });
});
