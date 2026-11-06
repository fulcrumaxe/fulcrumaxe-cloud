import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleConflictPrompt, assembleRenumberPrompt, checkoutBranchCommand } from "../../src/review/reviewPrompts.js";

/**
 * D#600 CX-7: every sandbox round starts on a fresh `git clone --depth 1 --single-branch` of the default branch. The conflict and renumber prompts' git lines are run here,
 * as the agent would run them, against such a clone of a real upstream whose pull request branch forked BEFORE main's tip. A string check cannot show that `git checkout <branch>`
 * has no branch to find in a single-branch clone, or that the one commit a depth-1 clone holds has no merge base with the branch.
 */
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const sh = (cwd: string, cmd: string): string => execFileSync("bash", ["-ec", cmd], { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
/** The failure text of a command that must fail: git writes its refusals to stderr. */
const failure = (cwd: string, cmd: string): string => {
  try {
    sh(cwd, cmd);
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return `${e.stderr ?? ""}${e.stdout ?? ""}`;
  }
  throw new Error(`expected a failure: ${cmd}`);
};
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.test"];
const BRANCH = "fx/issue-7";

let root: string;
let remote: string;
let head: string;
let mainTip: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxround-git-"));
  remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", seed);
  const commit = (file: string, body: string) => {
    writeFileSync(path.join(seed, file), body);
    git(seed, "add", file);
    git(seed, ...ID, "commit", "-q", "-m", `${file}: ${body}`);
    return git(seed, "rev-parse", "HEAD");
  };
  commit("shared.txt", "one\n");
  commit("early.txt", "early");
  // The pull request branch forks here, and main moves on twice before the round starts: main's tip is not an ancestor of the branch.
  git(seed, ...["checkout", "-q", "-b", BRANCH]);
  commit("0001-first.sql", "select 1;");
  head = commit("feature.txt", "feature");
  git(seed, ...["checkout", "-q", "main"]);
  commit("0001-other.sql", "select 2;");
  commit("early.txt", "early, as main has it");
  mainTip = commit("later.txt", "later");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main", BRANCH);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** The sandbox's clone, exactly the flags of the runner's `CLONE_SCRIPT`: depth 1, single branch (the default one), no tags. */
function sandboxClone(): string {
  const dir = path.join(root, `clone-${n++}`);
  git(root, "clone", "-q", "--depth", "1", "--single-branch", "--no-tags", `file://${remote}`, dir);
  expect(git(dir, "rev-parse", "--is-shallow-repository")).toBe("true");
  return dir;
}

const conflictInput = { owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: "", branch: BRANCH, baseRef: "main", baseSha: "", files: ["early.txt"], round: 1, of: 2 };
const renumberInput = { owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: "", branch: BRANCH, baseRef: "main", baseSha: "", resource: "migration", highest: "0001", files: ["0001-first.sql"], round: 1, of: 2 };

/** The command after the colon that ends the prompt's "Bring your checkout" line. */
function bringLine(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.startsWith("Bring your checkout"));
  if (!line) throw new Error("no checkout line in the prompt");
  const at = line.indexOf("): git fetch");
  if (at < 0) throw new Error("no git command on the checkout line");
  return line.slice(at + 3);
}
const mergeLine = (prompt: string): string => {
  const m = /(git merge origin\/\S+)/.exec(prompt);
  if (!m) throw new Error("no merge command in the prompt");
  return m[1]!;
};

describe("the conflict round's git lines, in a depth-1 single-branch clone", () => {
  const prompt = (): string => assembleConflictPrompt({ ...conflictInput, headSha: head, baseSha: mainTip, runtime: "sandbox" }).prompt;

  it("the old commands could not work: no local branch to check out, and the merge has no common ancestor", () => {
    const dir = sandboxClone();
    const old = `git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" "+refs/heads/main:refs/remotes/origin/main" && git checkout ${BRANCH} && git reset --hard ${head}`;
    expect(failure(dir, old)).toMatch(/pathspec|did not match/);
    const dir2 = sandboxClone();
    sh(dir2, `git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" "+refs/heads/main:refs/remotes/origin/main" && git checkout -B ${BRANCH} origin/${BRANCH}`);
    expect(failure(dir2, "git merge origin/main")).toContain("refusing to merge unrelated histories");
  });

  it("brings the checkout to the branch at the given commit with the history a merge needs, and the merge, the one merge commit and the plain push all work", () => {
    const text = prompt();
    const dir = sandboxClone();
    sh(dir, bringLine(text));
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(git(dir, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(dir, "merge-base", "HEAD", "origin/main")).not.toBe("");
    // The merge as the prompt words it: no unrelated histories, no rebase.
    expect(mergeLine(text)).toBe("git merge origin/main");
    sh(dir, `${mergeLine(text)} --no-edit`.replace("git merge", `git ${ID.join(" ")} merge`));
    expect(git(dir, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    sh(dir, `git push origin ${BRANCH}`);
    expect(git(remote, "rev-parse", BRANCH)).toBe(git(dir, "rev-parse", "HEAD"));
    // Put the remote back for the next case.
    git(remote, "update-ref", `refs/heads/${BRANCH}`, head);
  });

  it("a real conflict is a conflict the agent resolves, not a refusal to merge", () => {
    const dir = sandboxClone();
    sh(dir, bringLine(prompt()));
    writeFileSync(path.join(dir, "early.txt"), "early, as the branch has it");
    git(dir, "add", "early.txt");
    git(dir, ...ID, "commit", "-q", "-m", "branch edit");
    // main changed the same file after the fork.
    const out = failure(dir, mergeLine(prompt()).replace("git merge", `git ${ID.join(" ")} merge`));
    expect(out).toContain("CONFLICT (content): Merge conflict in early.txt");
    expect(out).not.toContain("unrelated histories");
  });

  it("also works on a clone that is already complete (the fetch accepts it), and the prompt never offers the dangerous flags", () => {
    const dir = path.join(root, "full-clone");
    git(root, "clone", "-q", `file://${remote}`, dir);
    sh(dir, bringLine(prompt()));
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    const text = prompt();
    expect(text).not.toContain("--allow-unrelated-histories");
    expect(text).not.toMatch(/--force|\+HEAD|push -f/);
  });
});

describe("the renumber round's git lines, in a depth-1 single-branch clone", () => {
  const prompt = (): string => assembleRenumberPrompt({ ...renumberInput, headSha: head, baseSha: mainTip, runtime: "sandbox" }).prompt;

  it("the old checkout could not find the branch", () => {
    const dir = sandboxClone();
    const old = `git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" "+refs/heads/main:refs/remotes/origin/main" && git checkout ${BRANCH} && git reset --hard ${head}`;
    expect(failure(dir, old)).toMatch(/pathspec|did not match/);
  });

  it("lands on the branch at the given commit, with the default branch fetched to read its latest key, and the renamed file is pushed as a fast-forward", () => {
    const dir = sandboxClone();
    sh(dir, bringLine(prompt()));
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(git(dir, "rev-parse", "origin/main")).toBe(mainTip);
    expect(git(dir, "ls-tree", "--name-only", "origin/main").split("\n")).toContain("0001-other.sql");
    git(dir, "mv", "0001-first.sql", "0002-first.sql");
    git(dir, ...ID, "commit", "-q", "-m", "renumber");
    sh(dir, `git push origin ${BRANCH}`);
    expect(git(remote, "rev-parse", BRANCH)).toBe(git(dir, "rev-parse", "HEAD"));
    git(remote, "update-ref", `refs/heads/${BRANCH}`, head);
  });

  it("a renumber round does not deepen the history: it makes no merge", () => {
    expect(bringLine(prompt())).not.toContain("--depth");
    expect(prompt()).not.toContain("git merge origin");
  });
});

describe("checkoutBranchCommand", () => {
  it("fetches by explicit refspec and uses -B; only the history-needing round deepens", () => {
    const deep = checkoutBranchCommand("b", "main", "a".repeat(40), true);
    const shallow = checkoutBranchCommand("b", "main", "a".repeat(40), false);
    expect(deep).toContain("--depth=2147483647");
    expect(shallow).not.toContain("--depth");
    for (const c of [deep, shallow]) expect(c).toContain('"+refs/heads/b:refs/remotes/origin/b"');
    for (const c of [deep, shallow]) expect(c).toContain("git checkout -B b origin/b");
  });
});
