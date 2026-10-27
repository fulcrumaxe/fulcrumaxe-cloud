import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangedFiles, createVcsState } from "../../src/daemon/checkStep.js";
import { configEnv, guardConfigEnv, type Git, type GitCapture } from "../../src/daemon/git.js";
import { assertConfigKeys, pinWorkspaceGit } from "../../src/daemon/hostRead.js";
import { cleanResumedWorkspace } from "../../src/daemon/resumeClean.js";
import { unpinWorkspace } from "../../src/daemon/workspacePin.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 RUNNER-HOSTREAD-GITDIR-SHAPE: the daemon's own git reads of a workspace refuse a git folder the agent has changed into a shape or identity the daemon's clone did not
 * leave. Real git, real temp directories, a workspace made by the real `git clone --reference` and pinned the way the daemon pins it after its clone. Each hostile case is aimed at
 * something observable: a program that would write a marker file, or an outside repository the read would otherwise report. The assertions are that git was never started
 * for the read and that the marker and the outside repository are untouched.
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

/** The daemon's `Git` runner, real: the pin and the config listing run through it. */
const realGit: Git = {
  async run(_code, args, config, _timeout, extraEnv) {
    const env = { ...SETUP_ENV(), ...(config === undefined ? guardConfigEnv() : configEnv(config)), ...extraEnv };
    return execFileSync("git", [...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  },
};

/** A capture that records each start and then really runs it, so a read that is not refused would really happen. */
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

function repoAt(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "base");
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpRoot(), "fxr-hostread-"));
  ws = path.join(root, "ws");
  outside = path.join(root, "outside");
  marker = path.join(root, "marker-ran");
  started = [];
  repoAt(path.join(root, "src"));
  execFileSync("git", ["clone", "-q", "--bare", path.join(root, "src"), path.join(root, "mirror.git")], { env: SETUP_ENV() });
  execFileSync("git", ["clone", "-q", "--reference", path.join(root, "mirror.git"), "--no-local", "--", path.join(root, "mirror.git"), ws], { env: SETUP_ENV() });
  sh(ws, "checkout", "-q", "-b", "work");
  mirrorObjects = path.join(root, "mirror.git", "objects");
  repoAt(outside);
  sh(outside, "branch", "outside-secret-branch");
  baseSha = sh(ws, "rev-parse", "HEAD").trim();
  await pinWorkspaceGit(realGit, ws, mirrorObjects);
});
afterEach(() => {
  unpinWorkspace(ws);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const readsRefused = async (): Promise<void> => {
  await expect(createVcsState(capture, envOptions)(ws)).rejects.toMatchObject({ code: "workspace_git_refused" });
  await expect(createChangedFiles(capture, envOptions)(ws, baseSha)).rejects.toMatchObject({ code: "workspace_git_refused" });
  const git: Git = { run: async (_code, args) => (started.push([...args]), "") };
  // The resume clean-up never throws: a listing it may not take leaves the workspace as kept and git is never started.
  expect(await cleanResumedWorkspace(git, ws, undefined, 65536, "linux")).toEqual({ files: 0, dirs: 0 });
  expect(started).toEqual([]);
  expect(existsSync(marker)).toBe(false);
};

describe("host-side git reads of a workspace", () => {
  it("control: an untouched, pinned workspace is read as before (and its real clone config is all on the allowlist)", async () => {
    writeFileSync(path.join(ws, "new.txt"), "x\n");
    expect(await createChangedFiles(capture, envOptions)(ws, baseSha)).toEqual(["new.txt"]);
    expect(await createVcsState(capture, envOptions)(ws)).toContain("refs/heads/main");
  });

  it("a workspace that was never pinned is refused", async () => {
    unpinWorkspace(ws);
    await readsRefused();
  });

  it("a commondir pointing outside the workspace is refused: the outside repository's refs are not read", async () => {
    writeFileSync(path.join(ws, ".git", "commondir"), `${path.join(outside, ".git")}\n`);
    expect(sh(ws, "for-each-ref", "--format=%(refname)")).toContain("outside-secret-branch"); // what an unchecked read would report
    await readsRefused();
  });

  it("a config.worktree that names a filter or textconv driver is refused: no program runs", async () => {
    const program = `touch ${marker}`;
    writeFileSync(path.join(ws, ".git", "config.worktree"), `[filter "x"]\n\tclean = ${program}\n\tsmudge = ${program}\n[diff "x"]\n\ttextconv = ${program}\n[core]\n\tfsmonitor = ${program}\n`);
    writeFileSync(path.join(ws, ".gitattributes"), "* filter=x diff=x\n");
    await readsRefused();
  });

  it("a .git that is a file naming another directory is refused: nothing outside is read", async () => {
    rmSync(path.join(ws, ".git"), { recursive: true });
    writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(outside, ".git")}\n`);
    await readsRefused();
  });

  it("a .git that is a link to another repository is refused", async () => {
    rmSync(path.join(ws, ".git"), { recursive: true });
    symlinkSync(path.join(outside, ".git"), path.join(ws, ".git"));
    await readsRefused();
  });

  it("a commondir with any content, or a non-empty config.worktree, is refused", async () => {
    writeFileSync(path.join(ws, ".git", "commondir"), "..\n");
    await readsRefused();
    rmSync(path.join(ws, ".git", "commondir"));
    writeFileSync(path.join(ws, ".git", "config.worktree"), "[core]\n\tbare = false\n");
    await readsRefused();
  });

  it("a .git/info that holds a link is refused", async () => {
    writeFileSync(path.join(root, "elsewhere-exclude"), "*\n");
    rmSync(path.join(ws, ".git", "info", "exclude"), { force: true });
    symlinkSync(path.join(root, "elsewhere-exclude"), path.join(ws, ".git", "info", "exclude"));
    await readsRefused();
  });

  it("an alternates line other than the pinned mirror's objects is refused", async () => {
    writeFileSync(path.join(ws, ".git", "objects", "info", "alternates"), `${path.join(outside, ".git", "objects")}\n`);
    await readsRefused();
  });

  it("a whole new .git made with the same refs, objects and a config of the agent's own (the swap) is refused", async () => {
    const program = `touch ${marker}`;
    const old = path.join(ws, ".gitold");
    execFileSync("mv", [path.join(ws, ".git"), old]);
    mkdirSync(path.join(ws, ".git"));
    for (const name of ["HEAD", "refs", "objects", "index", "config"]) execFileSync("cp", ["-r", path.join(old, name), path.join(ws, ".git", name)]);
    sh(ws, "config", "filter.x.clean", `${program}; cat`);
    mkdirSync(path.join(ws, ".git", "info"), { recursive: true });
    writeFileSync(path.join(ws, ".git", "info", "attributes"), "* filter=x\n");
    writeFileSync(path.join(ws, "a.txt"), "changed\n");
    await readsRefused();
  });
});

describe("the config key allowlist", () => {
  const entry = (key: string): string => `${key}\nvalue\0`;
  it("accepts what the clone writes", () => {
    for (const key of ["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "remote.origin.url", "remote.origin.fetch", "branch.work.remote", "branch.fix/a.b.merge", "extensions.objectformat"]) {
      expect(() => assertConfigKeys(entry(key)), key).not.toThrow();
    }
  });
  it("accepts the ref storage format only as files or reftable", () => {
    for (const value of ["files", "reftable"]) expect(() => assertConfigKeys(`extensions.refstorage\n${value}\0`), value).not.toThrow();
    for (const value of ["packed", "Files", "files\nreftable", "", "../x"]) expect(() => assertConfigKeys(`extensions.refstorage\n${value}\0`), value).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
    expect(() => assertConfigKeys("extensions.refstorage\0")).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
  });
  it("refuses includes, drivers, worktree, fsmonitor, hooks path, extensions and anything else", () => {
    for (const key of ["include.path", "includeif.gitdir:/x/.path", "filter.x.clean", "filter.lfs.smudge", "diff.x.textconv", "diff.x.command", "core.worktree", "core.fsmonitor", "core.hookspath", "core.sshcommand", "core.pager", "extensions.worktreeconfig", "extensions.compatobjectformat", "remote.origin.uploadpack", "remote.origin.proxy", "remote.other.url", "alias.x", "url.x.insteadof", "branch.work.rebase"]) {
      expect(() => assertConfigKeys(entry(key)), key).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
    }
  });
  it("a workspace whose clone config already holds a refused key cannot be pinned", async () => {
    const other = path.join(root, "ws2");
    execFileSync("git", ["clone", "-q", "--reference", path.join(root, "mirror.git"), "--no-local", "--", path.join(root, "mirror.git"), other], { env: SETUP_ENV() });
    sh(other, "config", "core.fsmonitor", `touch ${marker}`);
    await expect(pinWorkspaceGit(realGit, other, mirrorObjects)).rejects.toMatchObject({ code: "workspace_git_refused" });
    sh(other, "config", "--unset", "core.fsmonitor");
    sh(other, "config", "include.path", "../elsewhere");
    await expect(pinWorkspaceGit(realGit, other, mirrorObjects)).rejects.toMatchObject({ code: "workspace_git_refused" });
    expect(existsSync(marker)).toBe(false);
  });
  it("a config rewritten after the pin (even to an allowed key set) is refused", async () => {
    sh(ws, "config", "core.filemode", "false");
    await readsRefused();
  });
});

describe("a nested repository's own config is never reached by a host read", () => {
  /** A repository at ws/sub with a clean filter set AFTER its commit (so setting it up starts nothing), the way the agent would. `gitfile`: its git folder lives elsewhere in the workspace. */
  function nested(gitfile: boolean): void {
    const inner = path.join(ws, "sub");
    mkdirSync(inner);
    sh(inner, "init", "-q", "-b", "main");
    writeFileSync(path.join(inner, "f"), "one\n");
    writeFileSync(path.join(inner, ".gitattributes"), "* filter=x\n");
    sh(inner, "add", ".");
    sh(inner, "commit", "-q", "-m", "inner");
    if (gitfile) {
      execFileSync("mv", [path.join(inner, ".git"), path.join(ws, ".gitmod")]);
      writeFileSync(path.join(inner, ".git"), "gitdir: ../.gitmod\n");
    }
    sh(inner, "config", "filter.x.clean", `touch ${marker}; cat`);
  }
  /** Records the nested repository in the outer one (a gitlink), makes that the base, then dirties the nested file. */
  function recordAndDirty(): void {
    sh(ws, "add", "sub");
    sh(ws, "commit", "-q", "-m", "gitlink");
    baseSha = sh(ws, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(ws, "sub", "f"), "two\n");
  }
  const rawDiff = (): void => void execFileSync("git", ["-C", ws, "diff", "--name-only", baseSha, "--"], { env: SETUP_ENV(), stdio: "ignore" });
  const hostReads = async (): Promise<string[]> => {
    const listed = (await createChangedFiles(capture, envOptions)(ws, baseSha)) ?? [];
    expect(await createVcsState(capture, envOptions)(ws)).toContain("refs/heads/work");
    const git: Git = { run: async (_code, args) => realGit.run("workspace_failed", args) };
    await cleanResumedWorkspace(git, ws, undefined, 65536, "linux");
    expect(existsSync(marker)).toBe(false);
    // A submodule's changed state is not reported: the header never names files that changed only inside a nested repository.
    expect(listed).not.toContain("sub");
    expect(listed).not.toContain("sub/f");
    return listed;
  };

  const worktreeReadsRefused = async (): Promise<void> => {
    await expect(createChangedFiles(capture, envOptions)(ws, baseSha)).rejects.toMatchObject({ code: "workspace_git_refused" });
    expect(started.filter((args) => !args.includes("config"))).toEqual([]);
    // The ref-only snapshot touches no worktree path and is not refused.
    expect(await createVcsState(capture, envOptions)(ws)).toContain("refs/heads/work");
    expect(existsSync(marker)).toBe(false);
  };

  it("(a) a committed gitlink with a dirty nested file: plain git starts the nested repo's filter, the worktree reads are refused and start nothing", async () => {
    nested(false);
    recordAndDirty();
    rawDiff();
    expect(existsSync(marker)).toBe(true); // control: the attack is real without the check
    rmSync(marker);
    await worktreeReadsRefused();
  });

  it("(b) an uncommitted nested repository (untracked) is refused too: a nested .git is never inspected", async () => {
    nested(false);
    writeFileSync(path.join(ws, "sub", "f"), "two\n");
    await worktreeReadsRefused();
  });

  it("(c) a submodule whose .git is a gitfile pointing elsewhere in the workspace: every nested gitfile is refused, nothing is started", async () => {
    nested(true);
    recordAndDirty();
    rawDiff();
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // The worktree reads are refused; the ref-only snapshot touches no worktree path and is not.
    await expect(createChangedFiles(capture, envOptions)(ws, baseSha)).rejects.toMatchObject({ code: "workspace_git_refused" });
    expect(started.filter((args) => !args.includes("config"))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("the neutral arguments ride on every read, from the shared list", async () => {
    await createVcsState(capture, envOptions)(ws);
    await createChangedFiles(capture, envOptions)(ws, baseSha);
    const reads = started.filter((args) => !args.includes("config"));
    expect(reads.length).toBeGreaterThan(3);
    for (const args of reads) {
      for (const setting of ["diff.ignoreSubmodules=all", "submodule.recurse=false", "status.submoduleSummary=false", "core.attributesFile=/dev/null"]) expect(args, args.join(" ")).toContain(setting);
    }
  });
});

describe("the user's global git config does not reach a host read", () => {
  it("a global filter driver named by the workspace's .gitattributes is not started by the read (control: plain git with the same home does start it)", async () => {
    const home = path.join(root, "home");
    mkdirSync(home);
    writeFileSync(path.join(home, ".gitconfig"), `[filter "lfsx"]\n\tclean = touch ${marker}; cat\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    // The attributes file is the repository's own tracked file; the driver is only defined in the user's global config.
    writeFileSync(path.join(ws, ".gitattributes"), "a.txt filter=lfsx\n");
    writeFileSync(path.join(ws, "a.txt"), "changed\n");
    execFileSync("git", ["-C", ws, "diff", "--name-only", baseSha, "--"], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true); // the attack is real without the neutralised environment
    rmSync(marker);
    const files = await createChangedFiles(capture, envOptions)(ws, baseSha);
    expect(files).toContain("a.txt");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the read sites cannot skip the check", () => {
  const daemon = path.join(__dirname, "..", "..", "src", "daemon");
  // mirror.ts runs before the agent starts (clone, checkout, pin); hostRead.ts is the helper itself; workspacePin.ts reads files, not git.
  const EXEMPT = new Set(["mirror.ts", "hostRead.ts"]);
  it("no daemon file builds a workspace-directed git call itself", () => {
    const files = readdirSync(daemon).filter((name) => name.endsWith(".ts") && !EXEMPT.has(name));
    expect(files.length).toBeGreaterThan(10);
    for (const name of files) {
      const text = readFileSync(path.join(daemon, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
      // `"-C", workspace`, `"-C", input.workspace`, `"-C", ws`, `"-C", job.workspace`: any `-C` whose next argument names a workspace.
      const bare = text.filter((line) => /["']-C["'],\s*[\w.]*(?:workspace|ws|checkout|worktree)\b/i.test(line));
      expect(bare, name).toEqual([]);
    }
  });
});
