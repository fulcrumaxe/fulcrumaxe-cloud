import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFixPrompt, type FixPromptInput } from "../../src/review/reviewPrompts.js";

/**
 * The fix prompts' git lines, run as the agent would run them against real git. The sandbox checkout is `--depth 1 --single-branch` of the default branch, so a
 * plain `git fetch origin <branch>` never makes `refs/remotes/origin/<branch>`; the prompts name the refspec. The remote's branch has moved ahead of the reviewed
 * commit (the platform merged the base into it), and the agent's push afterwards must fast-forward.
 */
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" } }).trim();
const sh = (cwd: string, cmd: string) => execFileSync("bash", ["-ec", cmd], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" } }).trim();
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.test"];
const BRANCH = "fx/issue-7";
const STOP = "The branch no longer contains the commit that was reviewed.";

let root: string;
let remote: string;
let reviewed: string;
let merged: string;
let stray: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxprompt-git-"));
  remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(root, "init", "-q", "-b", "main", seed);
  const commit = (file: string, msg: string) => {
    writeFileSync(path.join(seed, file), msg);
    git(seed, "add", file);
    git(seed, ...ID, "commit", "-q", "-m", msg);
    return git(seed, "rev-parse", "HEAD");
  };
  commit("a.txt", "a");
  git(seed, "checkout", "-q", "-b", BRANCH);
  reviewed = commit("fix.txt", "the reviewed change");
  // Main moves on, and the platform merges it into the branch: a merge commit on top of the reviewed commit.
  git(seed, "checkout", "-q", "main");
  commit("b.txt", "main moved");
  git(seed, "checkout", "-q", BRANCH);
  git(seed, ...ID, "merge", "-q", "--no-ff", "-m", "bring up to date", "main");
  merged = git(seed, "rev-parse", "HEAD");
  // A commit that is on another branch only: what a rewritten branch looks like to the check.
  git(seed, "checkout", "-q", "-b", "other", "main");
  stray = commit("c.txt", "elsewhere");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main", BRANCH, "other");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Each case starts with the remote branch at the merge commit (an earlier case's push moved it).
beforeEach(() => void git(remote, "update-ref", `refs/heads/${BRANCH}`, merged));

/** The sandbox's clone: depth 1, single branch, the default branch only. */
function sandboxClone(name: string): string {
  const dir = path.join(root, name);
  git(root, "clone", "-q", "--depth", "1", "--single-branch", `file://${remote}`, dir);
  return dir;
}
const base: FixPromptInput = { owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: "", branch: BRANCH, version: 1, spec: "s", findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["a.ts:1 - bad"], summary: "x" }] };
const lines = (prompt: string): string[] => prompt.split("\n");
const startsWith = (prompt: string, prefix: string): string => {
  const hit = lines(prompt).find((l) => l.trimStart().startsWith(prefix));
  if (!hit) throw new Error(`no prompt line starting ${prefix}`);
  return hit.trim();
};
const ancestorCommand = (prompt: string): string => {
  const m = /run: (git merge-base --is-ancestor [0-9a-f]+ HEAD)\./.exec(prompt);
  if (!m) throw new Error("no ancestor check in the prompt");
  return m[1]!;
};

describe("the cross-side fix prompt's git lines, in a depth-1 single-branch clone", () => {
  it("lands on the merge commit, passes the ancestor check, and the agent's push fast-forwards", () => {
    const prompt = buildFixPrompt({ ...base, headSha: reviewed, crossSide: true });
    const dir = sandboxClone("cross-ok");
    sh(dir, startsWith(prompt, "git fetch origin"));
    expect(git(dir, "rev-parse", "HEAD")).toBe(merged);
    sh(dir, ancestorCommand(prompt));
    writeFileSync(path.join(dir, "agent.txt"), "agent");
    git(dir, "add", "agent.txt");
    git(dir, ...ID, "commit", "-q", "-m", "agent fix");
    const push = /(git push origin \S+)/.exec(prompt)![1]!;
    sh(dir, push);
    expect(git(remote, "rev-parse", BRANCH)).toBe(git(dir, "rev-parse", "HEAD"));
    expect(git(remote, "merge-base", "--is-ancestor", merged, BRANCH) || "ok").toBe("ok");
  });

  it("a branch that does not contain the reviewed commit fails the check, and the prompt carries the fixed stop message", () => {
    const prompt = buildFixPrompt({ ...base, headSha: stray, crossSide: true });
    const dir = sandboxClone("cross-bad");
    sh(dir, startsWith(prompt, "git fetch origin"));
    // The reviewed commit exists locally (as it would from the earlier fetch of the build) but is not in the branch.
    git(dir, "fetch", "-q", "origin", stray);
    expect(() => sh(dir, ancestorCommand(prompt))).toThrow();
    expect(prompt).toContain(STOP);
  });
});

describe("the same-side fix prompt's git lines, in a depth-1 single-branch clone", () => {
  it("resets the local branch to the merge commit, and the agent's push fast-forwards", () => {
    const prompt = buildFixPrompt({ ...base, headSha: reviewed });
    const dir = sandboxClone("same-ok");
    // The build had left its local branch at the reviewed commit.
    git(dir, "fetch", "-q", "origin", reviewed);
    git(dir, "branch", BRANCH, reviewed);
    sh(dir, startsWith(prompt, "git fetch origin"));
    expect(git(dir, "rev-parse", "HEAD")).toBe(merged);
    writeFileSync(path.join(dir, "agent.txt"), "agent");
    git(dir, "add", "agent.txt");
    git(dir, ...ID, "commit", "-q", "-m", "agent fix");
    sh(dir, `git push origin ${BRANCH}`);
    expect(git(remote, "rev-parse", BRANCH)).toBe(git(dir, "rev-parse", "HEAD"));
  });

  it("the old plain fetch could not do it (the reason for the refspec)", () => {
    const dir = sandboxClone("plain");
    expect(() => sh(dir, `git fetch origin ${BRANCH} && git rev-parse origin/${BRANCH}`)).toThrow();
  });
});
