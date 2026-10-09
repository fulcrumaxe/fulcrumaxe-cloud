/**
 * D#6 R4d-4b (C33 H2-H5): the review workspace, against real git: a real bare remote, a real mirror made by the daemon's own sync,
 * the daemon's real git capture. No git fake anywhere in this file.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { pushPlan } from "../../src/daemon/push.js";
import { endOfFailure } from "../../src/daemon/runEnded.js";
import { runCapture } from "../../src/engines/claude/capture.js";

let root: string;
let home: string;
let remote: string;
let remoteUrl: string;
let seed: string;

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
const shStatus = (...args: string[]): number => {
  try {
    execFileSync("git", args, { env: SETUP_ENV(), stdio: ["ignore", "pipe", "pipe"] });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
};
const rev = (repo: string, ref: string): string => sh("-C", repo, "rev-parse", ref).trim();

function commitFile(repo: string, file: string, text: string): string {
  writeFileSync(path.join(repo, file), text);
  sh("-C", repo, "add", file);
  sh("-C", repo, "commit", "-m", `add ${file}`);
  return rev(repo, "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-review-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  commitFile(seed, "README.md", "hello\n");
  sh("-C", seed, "push", remote, "main");
  remoteUrl = pathToFileURL(remote).href;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const repo = { id: randomUUID(), owner: "acme", name: "widgets", private: true as const };
const reviewJob = (head_sha: string, role: GitJob["role"] = "code-reviewer"): GitJob => ({ repo, continues: null, branch_prefix: "fx/", role, review: { head_sha } });
const executorJob = (): GitJob => ({ repo, continues: null, branch_prefix: "fx/", role: "executor" });

const calls: string[][] = [];
function makeGitPath() {
  calls.length = 0;
  const gitPath = createGitPath({
    capture: (command, args, env, timeoutMs) => {
      calls.push([...args]);
      return runCapture(spawn, command, args, env, timeoutMs);
    },
    mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"),
    stateDir: path.join(root, "state"),
    remoteUrl: () => remoteUrl,
  });
  return { gitPath, mirror: path.join(root, "cache", "fx-runner", "mirrors", `${repo.id}.git`) };
}
let n = 0;
function newWorkspace(): string {
  const dir = path.join(root, "work", `run-${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The run's branch on the remote, two commits ahead of main. Returns both commits. */
function pushRunBranch(): { first: string; second: string } {
  sh("-C", seed, "checkout", "-b", "fx/run-g1");
  const first = commitFile(seed, "one.txt", "one\n");
  const second = commitFile(seed, "two.txt", "two\n");
  sh("-C", seed, "push", remote, "fx/run-g1");
  sh("-C", seed, "checkout", "main");
  return { first, second };
}

describe("H2: a review workspace is a detached checkout of exactly the named commit", () => {
  it("HEAD is the sha, HEAD is not a branch, and no branch is named after the run or the lease", async () => {
    const { second } = pushRunBranch();
    const { gitPath } = makeGitPath();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(reviewJob(second), lease, workspace);
    expect(base).toBe(second);
    expect(rev(workspace, "HEAD")).toBe(second);
    expect(shStatus("-C", workspace, "symbolic-ref", "-q", "HEAD")).not.toBe(0);
    const listed = sh("-C", workspace, "branch", "--list");
    expect(listed).not.toContain(lease.runId);
    expect(listed).not.toContain(pushPlan(lease).branch);
    // The clone's own default branch is the only local branch; the checkout made none (no run, lease or review branch).
    expect(sh("-C", workspace, "for-each-ref", "--format=%(refname:short)", "refs/heads/").trim()).toBe("main");
    expect(listed).toContain("(HEAD detached");
  });

  it("the first commit of the branch is reviewable too (the sha chooses the commit, not the branch tip)", async () => {
    const { first } = pushRunBranch();
    const { gitPath } = makeGitPath();
    const workspace = newWorkspace();
    await gitPath.prepare(reviewJob(first), lease, workspace);
    expect(rev(workspace, "HEAD")).toBe(first);
  });
});

describe("H3: the workspace gives the pull request's diff", () => {
  it("git diff origin/main...HEAD --stat equals the same command in a normal clone of the remote at that sha", async () => {
    const { second } = pushRunBranch();
    // The base moves after the PR opened: the three-dot form still shows only the PR's change.
    commitFile(seed, "later-on-main.txt", "x\n");
    sh("-C", seed, "push", remote, "main");
    const { gitPath } = makeGitPath();
    const workspace = newWorkspace();
    await gitPath.prepare(reviewJob(second), lease, workspace);
    const mine = sh("-C", workspace, "diff", "origin/main...HEAD", "--stat");

    const plain = path.join(root, "plain");
    sh("clone", remote, plain);
    sh("-C", plain, "checkout", "--detach", second);
    const theirs = sh("-C", plain, "diff", "origin/main...HEAD", "--stat");
    expect(mine).toBe(theirs);
    expect(mine).toContain("one.txt");
    expect(mine).toContain("two.txt");
    expect(mine).not.toContain("later-on-main.txt");
    expect(mine).not.toContain("README.md");
  });
});

describe("H4: a commit the mirror does not hold on a branch is refused, and no workspace is made", () => {
  it("a sha that is not in the mirror at all", async () => {
    pushRunBranch();
    const { gitPath } = makeGitPath();
    const workspace = newWorkspace();
    await expect(gitPath.prepare(reviewJob("a".repeat(40)), lease, workspace)).rejects.toMatchObject({ code: "review_sha_not_in_mirror" });
    expect(readdirSync(workspace)).toEqual([]);
    // Containment is its own check, made before reachability: an absent object is refused by it, and the branch query is not what refuses it.
    const names = calls.map((args) => args.filter((arg) => ["cat-file", "for-each-ref", "checkout"].includes(arg))[0]).filter(Boolean);
    expect(names.indexOf("cat-file")).toBeGreaterThanOrEqual(0);
    expect(names).not.toContain("for-each-ref");
    expect(endOfFailure("review_sha_not_in_mirror")).toEqual({ reason: "runner_setup", detail: "review_sha_not_in_mirror" });
  });

  it("a sha that is in the mirror's objects but on no branch: the branch was force-pushed back one commit", async () => {
    const { first, second } = pushRunBranch();
    const { gitPath, mirror } = makeGitPath();
    // The first review works, and the mirror now holds `second`.
    await gitPath.prepare(reviewJob(second), lease, newWorkspace());
    expect(shStatus("-C", mirror, "cat-file", "-e", `${second}^{commit}`)).toBe(0);
    // Force-push the branch back one commit. The next sync moves the mirror's ref and leaves `second` dangling in its objects.
    sh("-C", seed, "push", "--force", remote, `${first}:refs/heads/fx/run-g1`);
    const workspace = newWorkspace();
    await expect(gitPath.prepare(reviewJob(second), lease, workspace)).rejects.toMatchObject({ code: "review_sha_not_in_mirror" });
    expect(shStatus("-C", mirror, "cat-file", "-e", `${second}^{commit}`), "the object is still there; only the branch is gone").toBe(0);
    expect(sh("-C", mirror, "for-each-ref", "--contains", second, "refs/heads/")).toBe("");
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("a commit that exists only under refs/pull/1/head on the remote (a fork's pull request)", async () => {
    sh("-C", seed, "checkout", "-b", "forkwork");
    const forked = commitFile(seed, "fork.txt", "fork\n");
    sh("-C", seed, "push", remote, `${forked}:refs/pull/1/head`);
    sh("-C", seed, "checkout", "main");
    const { gitPath, mirror } = makeGitPath();
    const workspace = newWorkspace();
    await expect(gitPath.prepare(reviewJob(forked), lease, workspace)).rejects.toMatchObject({ code: "review_sha_not_in_mirror" });
    expect(shStatus("-C", mirror, "cat-file", "-e", `${forked}^{commit}`), "the mirror never fetched the pull ref").not.toBe(0);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("a value that is not a commit id is refused the same way, and never reaches git", async () => {
    pushRunBranch();
    const { gitPath } = makeGitPath();
    for (const bad of ["--help", "main", "HEAD", "A".repeat(40), "abc"]) {
      const workspace = newWorkspace();
      await expect(gitPath.prepare(reviewJob(bad), lease, workspace), bad).rejects.toMatchObject({ code: "review_sha_not_in_mirror" });
      expect(readdirSync(workspace)).toEqual([]);
    }
  });
});

describe("H5: an executor job still gets plan.branch from the default branch", () => {
  it("creates the run's branch at main's tip, attached", async () => {
    pushRunBranch();
    const { gitPath } = makeGitPath();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(executorJob(), lease, workspace);
    expect(base).toBe(rev(remote, "main"));
    expect(sh("-C", workspace, "branch", "--show-current").trim()).toBe(pushPlan(lease).branch);
    expect(rev(workspace, "HEAD")).toBe(base);
  });
});
