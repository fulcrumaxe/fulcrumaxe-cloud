/**
 * D#6 R4a-3 fix round (correction C25 sections 2 and 3.2): where the mirrors live, what the mirror must be, the one read the sandbox
 * gets, and which roles push. Real git; no sandbox is involved, so the read-grant claim is proved by taking away everything else.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPath, PUSHING_ROLES, type GitJob, type GitPathDeps } from "../../src/daemon/gitPath.js";
import { mirrorKeepClear, mirrorsRootFor } from "../../src/daemon/mirror.js";
import { pushPlan } from "../../src/daemon/push.js";
import { runCapture } from "../../src/engines/claude/capture.js";

// Cases here run real git several times; under a loaded host (Gate 1 beside other jobs) the 5 s default has been overrun by cases that take well under 1 s alone.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let home: string;
let remote: string;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // `git commit` starts `git maintenance run --auto --detach`, which outlives the command and can create `.git/objects/maintenance.lock` while a test is
  // replacing parts of that `.git`. Nothing in a fixture wants a gc, so both automatic triggers are off (as in workspaceRedirect.test.ts).
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
const refsOf = (repo: string): string[] => sh("-C", repo, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean).sort();

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const jobFor = (over: Partial<GitJob> = {}): GitJob => ({ repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor", ...over });
const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-mirrorloc-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
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

const stateDir = (): string => path.join(root, "state");
const mirrorsRoot = (): string => path.join(root, "cache", "fx-runner", "mirrors");
function makeGitPath(over: Partial<GitPathDeps> = {}) {
  return createGitPath({ capture, mirrorsRoot: mirrorsRoot(), stateDir: stateDir(), remoteUrl: () => pathToFileURL(remote).href, ...over });
}
function newWorkspace(name = "run-1"): string {
  const dir = path.join(root, "work", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function agentCommits(workspace: string): string {
  writeFileSync(path.join(workspace, "agent.txt"), "work\n");
  sh("-C", workspace, "add", "agent.txt");
  sh("-C", workspace, "commit", "-m", "agent change");
  return sh("-C", workspace, "rev-parse", "HEAD").trim();
}

describe("where the mirrors live", () => {
  it("is the cache directory on Linux and macOS, and FX_RUNNER_HOME does not move it", () => {
    expect(mirrorsRootFor({ home: "/home/jane", platform: "linux" })).toBe("/home/jane/.cache/fx-runner/mirrors");
    expect(mirrorsRootFor({ home: "/home/jane", platform: "linux", xdgCacheHome: "/var/xdg" })).toBe("/var/xdg/fx-runner/mirrors");
    expect(mirrorsRootFor({ home: "/home/jane", platform: "linux", xdgCacheHome: "relative/cache" })).toBe("/home/jane/.cache/fx-runner/mirrors");
    expect(mirrorsRootFor({ home: "/home/jane", platform: "linux", xdgCacheHome: "" })).toBe("/home/jane/.cache/fx-runner/mirrors");
    expect(mirrorsRootFor({ home: "/Users/jane", platform: "darwin", xdgCacheHome: "/ignored" })).toBe("/Users/jane/Library/Caches/fx-runner/mirrors");
    expect(() => mirrorsRootFor({ home: "jane", platform: "linux" })).toThrow(TypeError);
  });

  it("the mirror is made there, 0700, and nothing is made in the state directory", async () => {
    const gitPath = makeGitPath();
    const job = jobFor();
    await gitPath.prepare(job, lease, newWorkspace());
    expect(statSync(mirrorsRoot()).mode & 0o777).toBe(0o700);
    expect(readdirSync(mirrorsRoot())).toEqual([`${job.repo.id}.git`]);
    expect(existsSync(stateDir())).toBe(false);
  });

  it("the mirror's automatic gc and maintenance are off, on a new mirror and on one that existed", async () => {
    const gitPath = makeGitPath();
    const job = jobFor();
    const mirror = path.join(mirrorsRoot(), `${job.repo.id}.git`);
    await gitPath.prepare(job, lease, newWorkspace("a"));
    expect(sh("-C", mirror, "config", "--get", "gc.auto").trim()).toBe("0");
    expect(sh("-C", mirror, "config", "--get", "maintenance.auto").trim()).toBe("false");
    sh("-C", mirror, "config", "--unset", "gc.auto");
    sh("-C", mirror, "config", "--unset", "maintenance.auto");
    await gitPath.prepare(job, { runId: randomUUID(), leaseGeneration: 1 }, newWorkspace("b"));
    expect(sh("-C", mirror, "config", "--get", "gc.auto").trim()).toBe("0");
    expect(sh("-C", mirror, "config", "--get", "maintenance.auto").trim()).toBe("false");
  });

  it("a mirror with alternates of its own is refused before the workspace is made", async () => {
    const gitPath = makeGitPath();
    const job = jobFor();
    await gitPath.prepare(job, lease, newWorkspace("a"));
    const mirror = path.join(mirrorsRoot(), `${job.repo.id}.git`);
    writeFileSync(path.join(mirror, "objects", "info", "alternates"), `${path.join(root, "seed", ".git", "objects")}\n`);
    const workspace = newWorkspace("b");
    await expect(gitPath.prepare(job, { runId: randomUUID(), leaseGeneration: 1 }, workspace)).rejects.toMatchObject({ code: "mirror_failed" });
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("a dangling symlink at the mirrors root is a GitPathError, not a raw EEXIST, and nothing is made through it", async () => {
    mkdirSync(path.dirname(mirrorsRoot()), { recursive: true });
    symlinkSync(path.join(root, "nowhere"), mirrorsRoot());
    await expect(makeGitPath().prepare(jobFor(), lease, newWorkspace())).rejects.toMatchObject({ name: "GitPathError", code: "mirror_dir_insecure" });
    expect(existsSync(path.join(root, "nowhere"))).toBe(false);
  });

  describe("a mirrors root that overlaps a runner root or a protected place is refused", () => {
    const refused = async (over: Partial<GitPathDeps>, workspace = "w"): Promise<void> => {
      await expect(makeGitPath(over).prepare(jobFor(), lease, newWorkspace(workspace))).rejects.toMatchObject({ code: "mirror_dir_insecure" });
    };
    const keep = (): string[] => mirrorKeepClear({ home, stateDir: stateDir(), binaryDir: path.join(home, ".local", "bin"), workspaceRoot: path.join(root, "work"), tempRoot: path.join(root, "tmp") });

    it("inside the state directory, or the state directory itself, or a parent of it", async () => {
      await refused({ mirrorsRoot: path.join(stateDir(), "mirrors") });
      await refused({ mirrorsRoot: stateDir() }, "w2");
      await refused({ mirrorsRoot: root }, "w3");
      expect(existsSync(stateDir())).toBe(false);
    });

    it("reached through a symlink into the state directory", async () => {
      mkdirSync(path.join(stateDir(), "inner"), { recursive: true });
      symlinkSync(path.join(stateDir(), "inner"), path.join(root, "link"));
      await refused({ mirrorsRoot: path.join(root, "link", "mirrors") });
      expect(readdirSync(path.join(stateDir(), "inner"))).toEqual([]);
    });

    it("inside the binary directory, the workspace root, the temp root or a credential directory", async () => {
      for (const [index, place] of [path.join(home, ".local", "bin"), path.join(root, "work"), path.join(root, "tmp"), path.join(home, ".ssh"), path.join(home, ".config", "fx-runner")].entries()) {
        await refused({ keepClear: keep(), mirrorsRoot: path.join(place, "mirrors") }, `w${index}`);
      }
    });

    it("and the default place, away from all of them, is accepted with the same list", async () => {
      await makeGitPath({ keepClear: keep() }).prepare(jobFor(), lease, newWorkspace());
      expect(existsSync(mirrorsRoot())).toBe(true);
    });
  });
});

describe("the objects directory is all a job's git needs of the mirror", () => {
  const runAsRoot = process.getuid?.() === 0;
  const hidden: string[] = [];
  afterEach(() => {
    for (const target of hidden.splice(0).reverse()) {
      try {
        chmodSync(target, 0o755);
      } catch {
        // fx-swallow-ok: test cleanup; a path that is gone needs no restore
      }
    }
  });

  it.skipIf(runAsRoot)("with the mirror's config, refs, packed-refs and hooks unreadable, the workspace still logs and commits", async () => {
    const gitPath = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    await gitPath.prepare(job, lease, workspace);
    const mirror = path.join(mirrorsRoot(), `${job.repo.id}.git`);
    writeFileSync(path.join(mirror, "packed-refs"), "# pack-refs with: peeled fully-peeled sorted\n");
    mkdirSync(path.join(mirror, "hooks"), { recursive: true });
    for (const name of ["config", "refs", "packed-refs", "hooks"]) {
      hidden.push(path.join(mirror, name));
      chmodSync(path.join(mirror, name), 0o000);
    }
    expect(() => execFileSync("cat", [path.join(mirror, "config")], { stdio: "ignore" })).toThrow();
    expect(sh("-C", workspace, "log", "-1", "--format=%s").trim()).toBe("first");
    const commit = agentCommits(workspace);
    expect(sh("-C", workspace, "log", "-1", "--format=%H").trim()).toBe(commit);
  });
});

describe("only an executor or a docs-writer run pushes (C25 section 3.2)", () => {
  it("names exactly those two roles", () => {
    expect([...PUSHING_ROLES].sort()).toEqual(["docs-writer", "executor"]);
  });

  for (const role of ["code-reviewer", "security-reviewer", "acceptance-tester", "project-manager", "debater"] as const) {
    it(`a ${role} run that commits pushes nothing: no push process, no branch on the remote`, async () => {
      const calls: Array<readonly string[]> = [];
      const gitPath = makeGitPath({ capture: (command, args, env, timeoutMs) => (calls.push(args), capture(command, args, env, timeoutMs)) });
      const job = jobFor({ role });
      const workspace = newWorkspace();
      const { base } = await gitPath.prepare(job, lease, workspace);
      agentCommits(workspace);
      const before = calls.length;
      expect(await gitPath.publish(job, lease, workspace, base)).toEqual({ pushed: false });
      expect(calls.length).toBe(before);
      expect(calls.some((args) => args.includes("push"))).toBe(false);
      expect(refsOf(remote)).toEqual(["refs/heads/main"]);
    });
  }

  for (const role of ["executor", "docs-writer"] as const) {
    it(`a ${role} run that commits is pushed to its own run branch`, async () => {
      const gitPath = makeGitPath();
      const job = jobFor({ role });
      const workspace = newWorkspace();
      const { base } = await gitPath.prepare(job, lease, workspace);
      const commit = agentCommits(workspace);
      expect(await gitPath.publish(job, lease, workspace, base)).toEqual({ pushed: true, branch: pushPlan(lease).branch, sha: commit });
      expect(refsOf(remote)).toEqual([`refs/heads/${pushPlan(lease).branch}`, "refs/heads/main"]);
    });
  }

  it("a run that is read-grant bound: the grant is the repo's mirror objects directory and nothing else", () => {
    const gitPath = makeGitPath();
    const job = jobFor({ role: "code-reviewer" });
    expect(gitPath.readGrants(job)).toEqual([path.join(mirrorsRoot(), `${job.repo.id}.git`, "objects")]);
  });
});
