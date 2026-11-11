import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, GitPathError, type GitCapture } from "../../src/daemon/git.js";
import { createChangedFiles } from "../../src/daemon/checkStep.js";
import { mergeDefaultInto } from "../../src/daemon/hostRead.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { outOfScopeCount } from "../../src/daemon/scopeStep.js";
import { pushPlan } from "../../src/daemon/push.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

/**
 * A fix round continues a branch cut earlier; the repository's default branch has moved on (a repaired test, say). The runner brings the branch up to date before the agent
 * starts (`updateWorkspaceBranch`). Real git over a local bare remote, no network.
 */
const T = 60_000;
let root: string;
let home: string;
let remote: string;
let remoteUrl: string;

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
const tip = (repo: string, ref: string): string => sh("-C", repo, "rev-parse", ref).trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-baseupdate-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "flaky.test.txt"), "broken\n");
  sh("-C", seed, "add", "README.md", "flaky.test.txt");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", remote, "main");
  remoteUrl = pathToFileURL(remote).href;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs);
function makeGitPath() {
  return createGitPath({ platform: "linux", capture, mirrorsRoot: path.join(root, "cache", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: () => remoteUrl });
}

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const FIX_LEASE = { runId: "7c7c7c7c-7d7d-4e7e-8f7f-707070707070", leaseGeneration: 2 };
const CHECK = { argv: ["bash", "scripts/check.sh"], dev_shell: false, timeout_s: 60 };
const repo = { id: randomUUID(), owner: "acme", name: "widgets", private: true as const };
const jobFor = (over: Partial<GitJob> = {}): GitJob => ({ repo, continues: null, branch_prefix: "fx/", role: "executor", ...over });
const continuesOn = (branch: string) => ({ parent_run_id: randomUUID(), session_id: "s1", branch });
const fixJobOn = (branch: string, over: Partial<GitJob> = {}): GitJob => jobFor({ continues: continuesOn(branch), check: CHECK, ...over });

function newWorkspace(name: string): string {
  const dir = path.join(root, "work", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The first run, whose check failed: its commit is pushed to the run branch and no pull request is opened for it. */
async function firstRun(gitPath: ReturnType<typeof makeGitPath>) {
  const job = jobFor();
  const workspace = newWorkspace("first");
  const { base } = await gitPath.prepare(job, lease, workspace);
  writeFileSync(path.join(workspace, "agent.txt"), "work\n");
  sh("-C", workspace, "add", "agent.txt");
  sh("-C", workspace, "commit", "-m", "agent change");
  const commit = tip(workspace, "HEAD");
  await gitPath.publish(job, lease, workspace, base);
  return { branch: pushPlan(lease).branch, commit, workspace };
}

/** The default branch moves: a commit that repairs the test, and optionally another file. */
function mainMoves(files: Record<string, string> = { "flaky.test.txt": "fixed\n" }): string {
  const other = path.join(root, `main-${randomUUID()}`);
  sh("clone", "--branch", "main", remote, other);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(other, name), text);
    sh("-C", other, "add", name);
  }
  sh("-C", other, "commit", "-m", "repair the test");
  sh("-C", other, "push", "origin", "main");
  return tip(other, "HEAD");
}

const parents = (repoDir: string, ref: string): string[] => sh("-C", repoDir, "rev-list", "--parents", "-n", "1", ref).trim().split(" ").slice(1);

describe("a fix round on a branch that is behind the default branch (no pull request involved)", () => {
  it("resume: the kept workspace gets the default branch merged in before the agent starts, and says which commit", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const main = mainMoves();
    const resumed = await gitPath.resume(fixJobOn(first.branch), FIX_LEASE, first.workspace);
    expect(resumed).toEqual({ base: first.commit, updatedTo: main });
    // The repaired test is in the workspace; the agent's own commit is still there; history was not rewritten (the old tip is an ancestor of the new head).
    expect(readFileSync(path.join(first.workspace, "flaky.test.txt"), "utf8")).toBe("fixed\n");
    expect(existsSync(path.join(first.workspace, "agent.txt"))).toBe(true);
    expect(parents(first.workspace, "HEAD")).toEqual([first.commit, main]);
    expect(sh("-C", first.workspace, "merge-base", "--is-ancestor", first.commit, "HEAD")).toBe("");
    expect(sh("-C", first.workspace, "status", "--porcelain")).toBe("");
  });

  it("prepare: a fresh workspace on the branch gets the same update", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const main = mainMoves();
    const fresh = newWorkspace("fresh");
    const prepared = await gitPath.prepare(fixJobOn(first.branch), FIX_LEASE, fresh);
    expect(prepared).toEqual({ base: first.commit, updatedTo: main });
    expect(readFileSync(path.join(fresh, "flaky.test.txt"), "utf8")).toBe("fixed\n");
    expect(parents(fresh, "HEAD")).toEqual([first.commit, main]);
  });

  it("the merge is pushed on top of the branch's tip as an ordinary fast-forward: nothing is forced", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    mainMoves();
    const job = fixJobOn(first.branch);
    const resumed = await gitPath.resume(job, FIX_LEASE, first.workspace);
    const published = await gitPath.publish(job, FIX_LEASE, first.workspace, resumed!.base);
    expect(published.pushed).toBe(true);
    expect(parents(remote, `refs/heads/${first.branch}`)).toEqual([first.commit, tip(remote, "refs/heads/main")]);
  });

  it("a branch that already holds the default branch is left alone: no merge commit, no update to report", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const resumed = await gitPath.resume(fixJobOn(first.branch), FIX_LEASE, first.workspace);
    expect(resumed).toEqual({ base: first.commit });
    expect(tip(first.workspace, "HEAD")).toBe(first.commit);
  });

  it("a conflict ends the round before the agent: base_conflict from resume and from prepare, and the branch and tree are untouched", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    mainMoves({ "agent.txt": "main wrote this file too\n" });
    await expect(gitPath.resume(fixJobOn(first.branch), FIX_LEASE, first.workspace)).rejects.toMatchObject({ code: "base_conflict" });
    expect(tip(first.workspace, "HEAD")).toBe(first.commit);
    expect(existsSync(path.join(first.workspace, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readFileSync(path.join(first.workspace, "agent.txt"), "utf8")).toBe("work\n");
    expect(sh("-C", first.workspace, "status", "--porcelain")).toBe("");
    const fresh = newWorkspace("fresh");
    await expect(gitPath.prepare(fixJobOn(first.branch), FIX_LEASE, fresh)).rejects.toBeInstanceOf(GitPathError);
    await expect(gitPath.prepare(fixJobOn(first.branch), FIX_LEASE, newWorkspace("fresh2"))).rejects.toMatchObject({ code: "base_conflict" });
  });

  it("only a pushing job that carries a check is touched: a job without a check, a review and a non-pushing role keep the old branch", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    mainMoves();
    expect(await gitPath.resume(fixJobOn(first.branch, { check: undefined }), FIX_LEASE, first.workspace)).toEqual({ base: first.commit });
    expect(await gitPath.resume(fixJobOn(first.branch, { role: "code-reviewer" as never }), FIX_LEASE, first.workspace)).toEqual({ base: first.commit });
    expect(tip(first.workspace, "HEAD")).toBe(first.commit);
    expect(readFileSync(path.join(first.workspace, "flaky.test.txt"), "utf8")).toBe("broken\n");
  });

  it("a merge the working tree would not take falls back to a fresh clone (resume answers null) instead of failing the round", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    mainMoves();
    // Local, uncommitted work in a file the merge has to change.
    writeFileSync(path.join(first.workspace, "flaky.test.txt"), "local edit\n");
    expect(await gitPath.resume(fixJobOn(first.branch), FIX_LEASE, first.workspace)).toBeNull();
    // The merge itself answered "blocked" (not a conflict, not an error): asked again now that the mirror holds the commit, it says so and changes nothing.
    expect(await mergeDefaultInto(createGit({ capture }), first.workspace, tip(remote, "refs/heads/main"))).toEqual({ kind: "blocked" });
    expect(readFileSync(path.join(first.workspace, "flaky.test.txt"), "utf8")).toBe("local edit\n");
    expect(existsSync(path.join(first.workspace, ".git", "MERGE_HEAD"))).toBe(false);
  });
});

describe("a build again starts from the current default branch", () => {
  it("a fresh run (no continuation) is cut from the mirror's current default tip, with nothing to merge", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const main = mainMoves();
    const workspace = newWorkspace("again");
    const prepared = await gitPath.prepare(jobFor({ check: CHECK }), { runId: "9d9d9d9d-9e9e-4f9f-8a9a-909090909090", leaseGeneration: 1 }, workspace);
    expect(prepared).toEqual({ base: main });
    expect(tip(workspace, "HEAD")).toBe(main);
    expect(readFileSync(path.join(workspace, "flaky.test.txt"), "utf8")).toBe("fixed\n");
    void first;
  });
});

describe("the scope test judges the pull request's own changes, not what came from the default branch", () => {
  it("listing against the commit merged in names only the run's files; against the old branch point it also names the default branch's", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const main = mainMoves({ "flaky.test.txt": "fixed\n", "elsewhere.txt": "from main\n" });
    const resumed = await gitPath.resume(fixJobOn(first.branch), FIX_LEASE, first.workspace);
    expect(resumed?.updatedTo).toBe(main);
    const changedFiles = createChangedFiles(capture, {} as never);
    const scope = ["agent.txt"];
    expect(await outOfScopeCount({ scope, changedFiles, workspace: first.workspace, base: main })).toBe(0);
    // Judged against the branch's old merge-base, the files that arrived from the default branch would count as out of scope.
    const oldBase = tip(path.join(root, "seed"), "HEAD");
    expect(await outOfScopeCount({ scope, changedFiles, workspace: first.workspace, base: oldBase })).toBe(2);
  });
});
