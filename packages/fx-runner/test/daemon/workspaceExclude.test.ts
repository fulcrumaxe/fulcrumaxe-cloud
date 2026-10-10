/**
 * D#6 C44-3: the sandbox's stub files must never be committed. Real git, real local remotes, real directories and real filesystem links; no git
 * fakes. A workspace is made by `createMirrors().prepareWorkspace` (every checkout kind), the stubs are laid in the way the sandbox leaves them
 * (including the agent CLI's own exclude block, copied from a kept workspace of a real run), and `git status` / `git add -A` are asked.
 *
 * Not covered here: a run of the installed agent CLI's sandbox. The CLI cannot be started from the worktree-isolated build seat; the stub list
 * is the one read from kept workspaces of real runs (see the PR body), and the TL's live acceptance step (A3) checks a real kept workspace.
 */
import { execFileSync, spawn } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, type GitCapture } from "../../src/daemon/git.js";
import { createMirrors, type Mirrors, type RepoRef } from "../../src/daemon/mirror.js";
import { EXCLUDE_BEGIN, EXCLUDE_DIR_NAMES, EXCLUDE_FILE_NAMES, excludeBlock, writeWorkspaceExclude } from "../../src/daemon/workspaceExclude.js";
import { SANDBOX_PROTECTED_FILES } from "../../src/daemon/sandboxStubs.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { OBSERVED_ROOT_STUBS } from "../helpers/sandboxStubFixture.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

/** The block the agent CLI wrote in kept workspaces of real runs (CLI 2.1.295): the root stubs of `OBSERVED_ROOT_STUBS`, plus `/package.json`. */
const CLI_BLOCK = `# claude-code scrub-mode stubs\n${["/bunfig.toml", "/package.json", ...OBSERVED_ROOT_STUBS.filter((name) => name !== "bunfig.toml").map((name) => `/${name}`)].join("\n")}\n`;

let root: string;
let home: string;
let remote: string;
let seed: string;
let hook: ((args: readonly string[]) => void) | null;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});
const sh = (...args: string[]): string => execFileSync("git", args, { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repo: RepoRef = { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner: "acme", name: "alpha" };
const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f01", leaseGeneration: 1 };

/** Real git through the real process path; `hook` runs after each command, so a test can swap something in right after a checkout. */
const capture: GitCapture = async (command, args, env, timeoutMs) => {
  const out = await runCapture(spawn, command, args, { ...env, ...SETUP_ENV() }, timeoutMs);
  hook?.(args);
  return out;
};
const mirrorsFor = (): Mirrors =>
  createMirrors({ git: createGit({ capture }), mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: () => pathToFileURL(remote).href });
const workspace = (name: string): string => {
  const target = path.join(root, "ws", name);
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
};

/** Every stub the sandbox may leave at the workspace root: empty files, the editor and tool directories (with a file inside, like a real one). */
function layStubs(ws: string): void {
  for (const name of EXCLUDE_FILE_NAMES) writeFileSync(path.join(ws, name), "");
  for (const name of EXCLUDE_DIR_NAMES) {
    mkdirSync(path.join(ws, name));
    writeFileSync(path.join(ws, name, "state.json"), "{}\n");
  }
}
const status = (ws: string): string => sh("-C", ws, "status", "--porcelain", "--untracked-files=all");
const staged = (ws: string): string => {
  sh("-C", ws, "add", "-A");
  return sh("-C", ws, "diff", "--cached", "--name-only");
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-c443-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  hook = null;
  remote = path.join(root, "remote.git");
  seed = path.join(root, "seed");
  sh("init", "--bare", "-b", "main", remote);
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  sh("-C", seed, "add", "README.md");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", remote, "main");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("the exclude list", () => {
  it("covers every sandbox-protected name, the observed root stubs and the criterion's extra names, all root-anchored", () => {
    const block = excludeBlock([]) as string;
    for (const name of [...SANDBOX_PROTECTED_FILES, ...OBSERVED_ROOT_STUBS, "package.json", ".gitconfig"]) expect(block).toContain(`\n/${name}\n`);
    for (const name of [".idea", ".vscode", ".claude"]) expect(block).toContain(`\n/${name}/\n`);
    expect(block.split("\n").filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("/"))).toEqual([]);
  });
  it("leaves out a name the commit tracks, and a directory with anything tracked below it", () => {
    const block = excludeBlock([".npmrc", ".vscode", "package.json"]) as string;
    expect(block).not.toContain("/package.json\n");
    expect(block).not.toContain("/.npmrc\n");
    expect(block).not.toContain("/.vscode/");
    expect(block).toContain("/.yarnrc\n");
    expect(block).toContain("/.idea/\n");
  });
});

describe("every kind of checkout", () => {
  it("a fresh run: the stubs are not in git status and git add -A stages nothing", async () => {
    const { base } = await mirrorsFor().prepareWorkspace(repo, lease, workspace("fresh"));
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    const ws = workspace("fresh");
    layStubs(ws);
    expect(status(ws)).toBe("");
    expect(staged(ws)).toBe("");
  });
  it("a review job (detached HEAD) and a fix round get the block too", async () => {
    const mirrors = mirrorsFor();
    const first = sh("-C", seed, "rev-parse", "HEAD").trim();
    await mirrors.prepareWorkspace(repo, lease, workspace("review"), null, { head_sha: first });
    sh("-C", seed, "branch", "fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f99-g1");
    sh("-C", seed, "push", remote, "fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f99-g1");
    await mirrors.prepareWorkspace(repo, lease, workspace("fix"), { branch: "fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f99-g1" }, null);
    for (const name of ["review", "fix"]) {
      const ws = workspace(name);
      layStubs(ws);
      expect(status(ws)).toBe("");
      expect(staged(ws)).toBe("");
    }
  });
  it("without the block the same stubs do show up (the control)", async () => {
    sh("clone", "--", remote, workspace("control"));
    layStubs(workspace("control"));
    expect(status(workspace("control"))).toContain(".gitconfig");
    expect(staged(workspace("control")).split("\n")).toContain(".vscode/state.json");
  });
  it("the agent CLI's own block, added later, sits beside ours and nothing breaks", async () => {
    await mirrorsFor().prepareWorkspace(repo, lease, workspace("both"));
    const ws = workspace("both");
    const file = path.join(ws, ".git", "info", "exclude");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${CLI_BLOCK}\n${CLI_BLOCK}`);
    layStubs(ws);
    expect(status(ws)).toBe("");
    expect(staged(ws)).toBe("");
  });
});

describe("a name the repo tracks is never excluded", () => {
  it("a committed .vscode/settings.json and .npmrc still show edits; the other stubs stay out", async () => {
    mkdirSync(path.join(seed, ".vscode"));
    writeFileSync(path.join(seed, ".vscode", "settings.json"), "{}\n");
    writeFileSync(path.join(seed, ".npmrc"), "a=1\n");
    sh("-C", seed, "add", ".vscode/settings.json", ".npmrc");
    sh("-C", seed, "commit", "-m", "tracked tool files");
    sh("-C", seed, "push", remote, "main");
    await mirrorsFor().prepareWorkspace(repo, lease, workspace("tracked"));
    const ws = workspace("tracked");
    const exclude = readFileSync(path.join(ws, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("/.vscode/");
    expect(exclude).not.toContain("/.npmrc\n");
    writeFileSync(path.join(ws, ".vscode", "settings.json"), '{"edited":true}\n');
    writeFileSync(path.join(ws, ".npmrc"), "a=2\n");
    writeFileSync(path.join(ws, ".gitconfig"), "");
    mkdirSync(path.join(ws, ".idea"));
    writeFileSync(path.join(ws, ".idea", "x.xml"), "");
    expect(status(ws).trimEnd().split("\n").sort()).toEqual([" M .npmrc", " M .vscode/settings.json"]);
    expect(staged(ws).trimEnd().split("\n").sort()).toEqual([".npmrc", ".vscode/settings.json"]);
  });
});

describe("one block per checkout", () => {
  it("a second write into the same workspace adds nothing", async () => {
    await mirrorsFor().prepareWorkspace(repo, lease, workspace("twice"));
    const ws = workspace("twice");
    const file = path.join(ws, ".git", "info", "exclude");
    const once = readFileSync(file, "utf8");
    expect(writeWorkspaceExclude(ws, [])).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(once.split("\n").filter((line) => line === EXCLUDE_BEGIN)).toHaveLength(1);
  });
  it("an exclude file that lacks a final newline gets one before the block, and git still reads both", () => {
    const ws = workspace("nonl");
    sh("init", "-b", "main", ws);
    writeFileSync(path.join(ws, ".git", "info", "exclude"), "*.log");
    expect(writeWorkspaceExclude(ws, [])).toBe(true);
    writeFileSync(path.join(ws, "a.log"), "");
    writeFileSync(path.join(ws, ".gitconfig"), "");
    expect(status(ws)).toBe("");
  });
  it("a missing info directory is made (a template without one)", () => {
    const ws = workspace("noinfo");
    sh("init", "-b", "main", ws);
    rmSync(path.join(ws, ".git", "info"), { recursive: true });
    expect(writeWorkspaceExclude(ws, [])).toBe(true);
    writeFileSync(path.join(ws, ".gitconfig"), "");
    expect(status(ws)).toBe("");
  });
});

describe("a hostile checkout is refused, and nothing outside the workspace is written", () => {
  const victimSetup = (): { dir: string; file: string } => {
    const dir = path.join(root, "victim");
    mkdirSync(dir);
    const file = path.join(dir, "exclude");
    writeFileSync(file, "keep\n");
    return { dir, file };
  };

  it(".git/info as a symlink: the checkout is refused with workspace_git_refused", async () => {
    const { dir, file } = victimSetup();
    hook = (args) => {
      if (!args.includes("checkout")) return;
      const info = path.join(String(args[args.indexOf("-C") + 1]), ".git", "info");
      renameSync(info, `${info}.real`);
      symlinkSync(dir, info);
    };
    await expect(mirrorsFor().prepareWorkspace(repo, lease, workspace("linkinfo"))).rejects.toMatchObject({ code: "workspace_git_refused" });
    expect(readFileSync(file, "utf8")).toBe("keep\n");
    expect(lstatSync(path.join(dir)).isDirectory()).toBe(true);
  });
  it(".git/info/exclude as a symlink to another file: refused, the target is not touched", () => {
    const { file } = victimSetup();
    const ws = workspace("linkfile");
    sh("init", "-b", "main", ws);
    rmSync(path.join(ws, ".git", "info", "exclude"), { force: true });
    symlinkSync(file, path.join(ws, ".git", "info", "exclude"));
    expect(() => writeWorkspaceExclude(ws, [])).toThrowError(expect.objectContaining({ code: "workspace_git_refused" }));
    expect(readFileSync(file, "utf8")).toBe("keep\n");
  });
  it(".git/info/exclude as a dangling symlink: not created through, refused", () => {
    const ws = workspace("dangling");
    sh("init", "-b", "main", ws);
    rmSync(path.join(ws, ".git", "info", "exclude"), { force: true });
    const target = path.join(root, "not-yet");
    symlinkSync(target, path.join(ws, ".git", "info", "exclude"));
    expect(() => writeWorkspaceExclude(ws, [])).toThrowError(expect.objectContaining({ code: "workspace_git_refused" }));
    expect(() => lstatSync(target)).toThrow();
  });
  it(".git as a symlink, a hard-linked exclude and a FIFO exclude are all refused", () => {
    const { dir, file } = victimSetup();
    const linkedGit = workspace("linkgit");
    mkdirSync(linkedGit);
    sh("init", "-b", "main", path.join(root, "elsewhere"));
    symlinkSync(path.join(root, "elsewhere", ".git"), path.join(linkedGit, ".git"));
    expect(() => writeWorkspaceExclude(linkedGit, [])).toThrowError(expect.objectContaining({ code: "workspace_git_refused" }));

    const hard = workspace("hard");
    sh("init", "-b", "main", hard);
    rmSync(path.join(hard, ".git", "info", "exclude"), { force: true });
    linkSync(file, path.join(hard, ".git", "info", "exclude"));
    expect(() => writeWorkspaceExclude(hard, [])).toThrowError(expect.objectContaining({ code: "workspace_git_refused" }));
    expect(readFileSync(file, "utf8")).toBe("keep\n");

    const fifo = workspace("fifo");
    sh("init", "-b", "main", fifo);
    rmSync(path.join(fifo, ".git", "info", "exclude"), { force: true });
    execFileSync("mkfifo", [path.join(fifo, ".git", "info", "exclude")]);
    expect(() => writeWorkspaceExclude(fifo, [])).toThrowError(expect.objectContaining({ code: "workspace_git_refused" }));
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });
  it("an error carries the closed code only, never a path", () => {
    const ws = workspace("msg");
    sh("init", "-b", "main", ws);
    rmSync(path.join(ws, ".git", "info"), { recursive: true });
    symlinkSync(root, path.join(ws, ".git", "info"));
    try {
      writeWorkspaceExclude(ws, []);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toBe("workspace_git_refused");
    }
  });
});
