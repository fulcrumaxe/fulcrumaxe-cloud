/**
 * D#6 R4d-2 (correction C32 section 2): the first real runner build failed to publish because the Claude Code shell sandbox leaves
 * empty mount points in the workspace. These cases run real git against a real local bare repository, no git fakes: a workspace made
 * by `git clone --reference` plus exactly the observed stubs publishes, the agent's own branch name never reaches the remote, work that
 * does not grow from the run's base is not published, and an empty placeholder is never pushed.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { pushPlan } from "../../src/daemon/push.js";
import { isSandboxStubName, SANDBOX_PROTECTED_FILES } from "../../src/daemon/sandboxStubs.js";
import { takeSnapshot } from "../../src/daemon/snapshot.js";
import { assertGitDirShape, assertWorkspaceGit } from "../../src/daemon/workspaceGit.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { addHardLink, addSandboxStubs, OBSERVED_ROOT_STUBS } from "../helpers/sandboxStubFixture.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let home: string;
let remote: string;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});
const sh = (...args: string[]): string => execFileSync("git", args, { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** Every ref of the remote with its commit: a before/after comparison shows any ref that appeared, moved or went. */
const remoteRefs = (): string => sh("ls-remote", remote);

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const job: GitJob = { repo: { id: "4b7f0a3e-0d4e-4c1b-9a53-2f6a2f0d9c11", owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor" };
const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-stubs-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "yarn.lock"), "# yarn lockfile v1\n");
  sh("-C", seed, "add", "README.md", "yarn.lock");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", remote, "main");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A prepared workspace on the run line, with the sandbox's stubs in place and nothing committed yet. */
async function rig() {
  const mirrorsRoot = path.join(root, "cache", "fx-runner", "mirrors");
  const gitPath = createGitPath({ capture, mirrorsRoot, stateDir: path.join(root, "state"), remoteUrl: () => pathToFileURL(remote).href });
  const workspace = path.join(root, "work", "run-1");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const { base } = await gitPath.prepare(job, lease, workspace);
  addSandboxStubs(workspace);
  const mirror = path.join(mirrorsRoot, `${job.repo.id}.git`);
  return { gitPath, workspace, base, mirror, gitDir: path.join(workspace, ".git"), publish: () => gitPath.publish(job, lease, workspace, base) };
}
type Rig = Awaited<ReturnType<typeof rig>>;

function commitFile(r: Rig, name: string, content: string, message = "agent change"): string {
  mkdirSync(path.dirname(path.join(r.workspace, name)), { recursive: true });
  writeFileSync(path.join(r.workspace, name), content);
  sh("-C", r.workspace, "add", "-f", "--", name);
  sh("-C", r.workspace, "commit", "-m", message);
  return sh("-C", r.workspace, "rev-parse", "HEAD").trim();
}

/** Nothing was pushed: the remote is exactly as it was, and no private ref is left in the mirror. */
function expectNothingPushed(r: Rig, before: string): void {
  expect(remoteRefs()).toBe(before);
  expect(sh("-C", r.mirror, "for-each-ref", "--format=%(refname)", "refs/fx-push/").trim()).toBe("");
}

describe("B1: a workspace with exactly the sandbox's stubs is published", () => {
  it("passes the workspace check and pushes HEAD to the run's branch", async () => {
    const r = await rig();
    expect(assertWorkspaceGit(r.workspace, path.join(r.mirror, "objects"))).toBe(r.gitDir);
    const commit = commitFile(r, "agent.txt", "work\n");
    const published = await r.publish();
    expect(published).toMatchObject({ pushed: true, branch: pushPlan(lease).branch, sha: commit });
    expect(sh("-C", remote, "rev-parse", `refs/heads/${pushPlan(lease).branch}`).trim()).toBe(commit);
  });

  it("the stub list is the observed one: every observed root stub is a name the guard knows, and the guard knows nothing else by accident", () => {
    for (const name of OBSERVED_ROOT_STUBS) expect(isSandboxStubName(name), name).toBe(true);
    for (const name of SANDBOX_PROTECTED_FILES) expect(isSandboxStubName(name), name).toBe(true);
    for (const name of ["README.md", "package.json", "src/index.js", "envfile", "my.env.txt", "lock.json", "sub/package-lock.json.bak"]) expect(isSandboxStubName(name), name).toBe(false);
  });
});

describe("B2: any other shape of those entries is refused with workspace_git_refused, and nothing is pushed", () => {
  const VARIANTS: Array<[string, (r: Rig) => void]> = [
    ["commondir pointing to another repository", (r) => writeFileSync(path.join(r.gitDir, "commondir"), "../other/.git")],
    ["commondir of 3 bytes", (r) => writeFileSync(path.join(r.gitDir, "commondir"), "../")],
    ["commondir holding a different byte", (r) => writeFileSync(path.join(r.gitDir, "commondir"), "x")],
    ["commondir `.` and two newlines", (r) => writeFileSync(path.join(r.gitDir, "commondir"), ".\n\n")],
    ["commondir as a symlink", (r) => (rmSync(path.join(r.gitDir, "commondir")), symlinkSync(".", path.join(r.gitDir, "commondir")))],
    ["commondir with two hard links", (r) => addHardLink(path.join(r.gitDir, "commondir"), path.join(r.workspace, "alias"))],
    ["commondir as a directory", (r) => (rmSync(path.join(r.gitDir, "commondir")), mkdirSync(path.join(r.gitDir, "commondir")))],
    ["a non-empty config.worktree", (r) => writeFileSync(path.join(r.gitDir, "config.worktree"), "[core]\n")],
    ["config.worktree with two hard links", (r) => addHardLink(path.join(r.gitDir, "config.worktree"), path.join(r.workspace, "alias"))],
    ["config.worktree as a symlink", (r) => (rmSync(path.join(r.gitDir, "config.worktree")), symlinkSync("/dev/null", path.join(r.gitDir, "config.worktree")))],
    ["a worktrees/x entry", (r) => mkdirSync(path.join(r.gitDir, "worktrees", "x"))],
    ["a file in modules", (r) => writeFileSync(path.join(r.gitDir, "modules", "m"), "")],
    ["a file in glab-cli", (r) => writeFileSync(path.join(r.gitDir, "glab-cli", "token"), "")],
    ["modules as a symlink", (r) => (rmSync(path.join(r.gitDir, "modules"), { recursive: true }), symlinkSync(path.join(r.workspace, "src"), path.join(r.gitDir, "modules")))],
    ["worktrees as a file", (r) => (rmSync(path.join(r.gitDir, "worktrees"), { recursive: true }), writeFileSync(path.join(r.gitDir, "worktrees"), ""))],
  ];
  for (const [name, change] of VARIANTS) {
    it(`${name}`, async () => {
      const r = await rig();
      mkdirSync(path.join(r.workspace, "src"));
      commitFile(r, "agent.txt", "work\n");
      change(r);
      const before = remoteRefs();
      await expect(r.publish()).rejects.toMatchObject({ code: "workspace_git_refused", message: "workspace_git_refused" });
      expect(() => assertWorkspaceGit(r.workspace, path.join(r.mirror, "objects"))).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
      expectNothingPushed(r, before);
    });
  }
});

describe("B3: the agent's own branch name never reaches the remote", () => {
  it("a commit on a side branch is published as the run's branch, and no other ref changes", async () => {
    const r = await rig();
    sh("-C", r.workspace, "checkout", "-b", "fx/issue-65");
    const commit = commitFile(r, "agent.txt", "work\n");
    const before = sh("ls-remote", remote).split("\n").filter(Boolean);
    await r.publish();
    const after = sh("ls-remote", remote).split("\n").filter(Boolean);
    expect(after.filter((line) => !before.includes(line))).toEqual([`${commit}\trefs/heads/${pushPlan(lease).branch}`]);
    expect(before.filter((line) => !after.includes(line))).toEqual([]);
    expect(after.some((line) => line.endsWith("fx/issue-65"))).toBe(false);
  });
});

describe("B4: HEAD that does not descend from the run's base", () => {
  it("an orphan branch is head_not_from_base and the remote is unchanged", async () => {
    const r = await rig();
    sh("-C", r.workspace, "checkout", "--orphan", "unrelated");
    commitFile(r, "other.txt", "other history\n");
    const before = remoteRefs();
    await expect(r.publish()).rejects.toMatchObject({ code: "head_not_from_base" });
    expectNothingPushed(r, before);
  });

  it("HEAD back at the base itself publishes nothing (the existing no-commit path), and leaves the remote alone", async () => {
    const r = await rig();
    commitFile(r, "agent.txt", "work\n");
    sh("-C", r.workspace, "reset", "--hard", "HEAD~1");
    const before = remoteRefs();
    // HEAD is now the base itself: nothing to publish, which is the existing no-commit path.
    expect(await r.publish()).toEqual({ pushed: false });
    expectNothingPushed(r, before);
  });

  it("an unborn HEAD is still push_failed (it could not be read), not head_not_from_base", async () => {
    const r = await rig();
    writeFileSync(path.join(r.gitDir, "HEAD"), "ref: refs/heads/never-made\n");
    const before = remoteRefs();
    await expect(r.publish()).rejects.toMatchObject({ code: "push_failed" });
    expectNothingPushed(r, before);
  });
});

describe("B5: an empty placeholder is never published", () => {
  for (const name of ["package-lock.json", ".env", ".npmrc", "pnpm-lock.yaml", "sub/.env.local", ".gitmodules"]) {
    it(`a commit adding an empty ${name} is sandbox_stub_committed`, async () => {
      const r = await rig();
      commitFile(r, name, "");
      const before = remoteRefs();
      await expect(r.publish()).rejects.toMatchObject({ code: "sandbox_stub_committed", message: "sandbox_stub_committed" });
      expectNothingPushed(r, before);
    });
  }

  it("counts every commit of the range: a stub added in one commit and deleted in the next is still in the pushed history", async () => {
    const r = await rig();
    commitFile(r, ".env", "");
    sh("-C", r.workspace, "rm", "-q", "-f", "--", ".env");
    sh("-C", r.workspace, "commit", "-m", "remove it again");
    commitFile(r, "agent.txt", "work\n");
    const before = remoteRefs();
    await expect(r.publish()).rejects.toMatchObject({ code: "sandbox_stub_committed" });
    expectNothingPushed(r, before);
  });

  it("a stub that only a merge commit adds is found too", async () => {
    const r = await rig();
    sh("-C", r.workspace, "checkout", "-b", "side");
    commitFile(r, "side.txt", "side\n");
    sh("-C", r.workspace, "checkout", "-");
    commitFile(r, "main.txt", "main\n");
    sh("-C", r.workspace, "merge", "--no-commit", "--no-ff", "side");
    writeFileSync(path.join(r.workspace, ".env"), "");
    sh("-C", r.workspace, "add", "-f", "--", ".env");
    sh("-C", r.workspace, "commit", "-m", "merge side");
    const before = remoteRefs();
    await expect(r.publish()).rejects.toMatchObject({ code: "sandbox_stub_committed" });
    expectNothingPushed(r, before);
  });

  it("an empty file with any other name is not a stub", async () => {
    const r = await rig();
    commitFile(r, "src/.gitkeep", "");
    expect((await r.publish()).pushed).toBe(true);
  });

  it("a real, non-empty file of a stub's name that the agent added is pushed", async () => {
    const r = await rig();
    commitFile(r, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    commitFile(r, ".env.example", "KEY=\n");
    expect((await r.publish()).pushed).toBe(true);
  });

  it("a lockfile the agent changed is pushed (the base already holds a non-empty one)", async () => {
    const r = await rig();
    commitFile(r, "yarn.lock", "# yarn lockfile v1\n# changed\n");
    expect((await r.publish()).pushed).toBe(true);
  });

  it("an empty file that was already tracked at the base is not an addition", async () => {
    const r = await rig();
    const empty = "yarn.lock";
    // Modify the tracked lock to empty: a change, not an add (the agent emptied a file; that is the agent's work, not a sandbox stub).
    commitFile(r, empty, "");
    expect((await r.publish()).pushed).toBe(true);
  });
});

describe("B6: the snapshot is still strict", () => {
  it("assertGitDirShape without the tolerance refuses a commondir of `.`, with or without the newline", async () => {
    const r = await rig();
    const objects = path.join(r.mirror, "objects");
    for (const content of [".", ".\n", ""]) {
      writeFileSync(path.join(r.gitDir, "commondir"), content);
      expect(() => assertGitDirShape(r.gitDir, objects, false)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
      expect(() => assertGitDirShape(r.gitDir, objects, true)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
      expect(() => assertGitDirShape(r.gitDir, objects, false, true)).not.toThrow();
    }
  });

  it("the snapshot never holds the sandbox's entries, so the fetch cannot read them", async () => {
    const r = await rig();
    commitFile(r, "agent.txt", "work\n");
    const snapshot = await takeSnapshot({ workspace: r.workspace, mirrorObjects: path.join(r.mirror, "objects"), root: path.join(root, "state", "git-snapshots") });
    try {
      const names = readdirSync(snapshot.gitDir);
      for (const stub of ["commondir", "config.worktree", "modules", "worktrees", "glab-cli"]) expect(names).not.toContain(stub);
      assertGitDirShape(snapshot.gitDir, path.join(r.mirror, "objects"), true);
    } finally {
      snapshot.remove();
    }
  });
});
