import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLONE_EXIT_TOO_LARGE, DEEPEN_SCRIPT, MAX_CLONE_KB } from "@fx/runner";
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
  const at = Math.max(line.indexOf("): git fetch"), line.indexOf("): sh -c "));
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
    expect(deep).toContain(`fx-deepen ${MAX_CLONE_KB} `);
    expect(shallow).not.toContain("--depth");
    expect(shallow).not.toContain("fx-deepen");
    for (const c of [deep, shallow]) expect(c).toContain('"+refs/heads/b:refs/remotes/origin/b"');
    for (const c of [deep, shallow]) expect(c).toContain("git checkout -B b origin/b");
  });

  it.each([["NaN", Number.NaN], ["infinity", Number.POSITIVE_INFINITY], ["zero", 0], ["negative", -5], ["fractional", 1.5], ["beyond the safe integers", 2 ** 60], ["a string", "9" as unknown as number], ["null", null as unknown as number]])(
    "a size limit that is %s is refused, never put into the command",
    (_n, bad) => {
      expect(() => checkoutBranchCommand("b", "main", "a".repeat(40), true, bad)).toThrow(/positive integer/);
      expect(() => checkoutBranchCommand("b", "main", "a".repeat(40), false, bad)).toThrow(/positive integer/);
    },
  );
});

describe("the deepening fetch is under the clone's size watch", () => {
  const kb = (dir: string): number => Number(sh(root, `du -sk "${dir}" | cut -f1`));
  const run = (dir: string, cmd: string) => spawnSync("bash", ["-c", cmd], { cwd: dir, encoding: "utf8", env: ENV });

  it("a deepen that takes the checkout over the limit stops with the clone's refusal code and removes the checkout; one inside the limit goes through", () => {
    const probe = sandboxClone();
    const before = kb(probe);
    expect(run(probe, checkoutBranchCommand(BRANCH, "main", head, true)).status).toBe(0);
    const after = kb(probe);
    expect(after).toBeGreaterThan(before); // the full history is bigger than the depth-1 clone, or this test shows nothing

    const over = sandboxClone();
    const refused = run(over, checkoutBranchCommand(BRANCH, "main", head, true, before));
    expect(refused.status).toBe(CLONE_EXIT_TOO_LARGE);
    expect(existsSync(over)).toBe(false);

    const inside = sandboxClone();
    expect(run(inside, checkoutBranchCommand(BRANCH, "main", head, true, after)).status).toBe(0);
    expect(git(inside, "rev-parse", "HEAD")).toBe(head);
  });

  it("an oversize deepen does not go on to check out or reset anything", () => {
    const dir = sandboxClone();
    const out = run(dir, `${checkoutBranchCommand(BRANCH, "main", head, true, 1)}; echo after:$?`);
    expect(out.stdout).not.toContain("Switched to");
    expect(existsSync(dir)).toBe(false);
  });
});


describe("the deepening script on its own", () => {
  const script = (dir: string, args: string[], env: NodeJS.ProcessEnv = ENV, timeout = 60_000) =>
    spawnSync("sh", ["-c", DEEPEN_SCRIPT, "fx-deepen", ...args], { cwd: dir, encoding: "utf8", env, timeout });
  const refspecs = [`+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`, "+refs/heads/main:refs/remotes/origin/main"];
  /** A directory first on PATH whose `git` is a stand-in for the fetch only; every other git command is the real one. */
  function stubGit(fetchBody: string): NodeJS.ProcessEnv {
    const bin = mkdtempSync(path.join(root, "bin-"));
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then\n${fetchBody}\nfi\nexec "${real}" "$@"\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    return { ...ENV, PATH: `${bin}:${process.env.PATH ?? ""}` };
  }

  it.each([["--upload-pack"], ["--receive-pack"], ["--exec"]])("an argument that starts with a dash (%s=...) is never an option: the script's own stop at the end of options makes it a refspec git refuses", (flag) => {
    const dir = sandboxClone();
    const marker = path.join(root, `ran-${n++}`);
    const hook = path.join(root, `hook-${n++}.sh`);
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    const out = script(dir, ["100000", `${flag}=${hook}`, ...refspecs]);
    expect(existsSync(marker)).toBe(false);
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBe(CLONE_EXIT_TOO_LARGE);
    expect(existsSync(dir)).toBe(true);
    expect(git(dir, "rev-parse", "--is-shallow-repository")).toBe("true");
  });

  it("the script puts the end-of-options marker before the repository, and holds no single quote", () => {
    expect(DEEPEN_SCRIPT).toContain("fetch --depth=2147483647 -- origin ");
    expect(DEEPEN_SCRIPT).not.toContain("'");
  });

  it.each([["empty", ""], ["letters", "abc"], ["an exponent", "1e9"], ["a sign", "-1"], ["a trailing blank", "5 "], ["a decimal", "1.5"], ["sixteen digits", "1000000000000000"], ["a shell word", "1;touch x"]])(
    "a limit that is %s exits 2 before anything is fetched, so the watch is never silently off",
    (_n, limit) => {
      const dir = sandboxClone();
      const out = script(dir, [limit, ...refspecs]);
      expect(out.status).toBe(2);
      expect(existsSync(dir)).toBe(true);
      expect(git(dir, "rev-parse", "--is-shallow-repository")).toBe("true");
    },
  );

  it("fifteen digits is accepted", () => {
    const dir = sandboxClone();
    expect(script(dir, ["999999999999999", ...refspecs]).status).toBe(0);
    expect(git(dir, "rev-parse", "--is-shallow-repository")).toBe("false");
  });

  it("a fetch that grows the checkout past the limit while it runs is killed with the clone's refusal code, and the checkout is removed", () => {
    const dir = sandboxClone();
    const env = stubGit(`dd if=/dev/zero of="$(command git rev-parse --show-toplevel)/.git/big" bs=1024 count=200 2>/dev/null\nexec sleep 60`);
    const started = Date.now();
    const out = script(dir, ["50", ...refspecs], env);
    expect(out.status).toBe(CLONE_EXIT_TOO_LARGE);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(existsSync(dir)).toBe(false);
  });

  it("a fetch that fails passes its own exit code on, and the checkout is left where it was", () => {
    const dir = sandboxClone();
    const out = script(dir, ["100000", ...refspecs], stubGit("exit 42"));
    expect(out.status).toBe(42);
    expect(existsSync(dir)).toBe(true);
  });

  it("a real fetch that fails (a branch the remote does not have) stops the line before any checkout", () => {
    const dir = sandboxClone();
    const out = spawnSync("bash", ["-c", checkoutBranchCommand(BRANCH, "no-such-branch", head, true)], { cwd: dir, encoding: "utf8", env: ENV });
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBe(CLONE_EXIT_TOO_LARGE);
    expect(out.stdout).not.toContain("Switched to");
    expect(existsSync(dir)).toBe(true);
  });

  it("run from a subdirectory, the cleanup removes the checkout's top level and nothing around it", () => {
    const dir = sandboxClone();
    const sub = path.join(dir, "deep", "er");
    mkdirSync(sub, { recursive: true });
    const neighbour = path.join(root, `neighbour-${n++}.txt`);
    writeFileSync(neighbour, "keep");
    const sibling = path.join(root, `sibling-${n++}`);
    mkdirSync(sibling);
    const out = script(sub, ["1", ...refspecs]);
    expect(out.status).toBe(CLONE_EXIT_TOO_LARGE);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });
});
