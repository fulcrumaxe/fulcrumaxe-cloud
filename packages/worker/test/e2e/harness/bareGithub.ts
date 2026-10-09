import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FakeChangeType, FakeGithub, FakeRepo } from "../../../../runner-cloud/test/helpers/githubFake.js";

/**
 * D#6 R4d-6: the "GitHub" of the end-to-end runner test is a local bare git repository. The runner's mirror fetches from it and its publish step pushes the run's
 * branch to it, through the real mirror and push code and a real `git`. The fake GitHub API (githubServer.ts) answers for the same repository from what is
 * really in it: before every API call `syncFakeFromBare` reads each branch's tip, its distance from the default branch and its changed paths with `git`, so what
 * the cloud is told about a branch is what the runner really pushed and not a number a test typed in.
 */

/** Setup commands run with no user config at all, so the harness is the same on every machine. */
function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "seed",
    GIT_AUTHOR_EMAIL: "seed@example.test",
    GIT_COMMITTER_NAME: "seed",
    GIT_COMMITTER_EMAIL: "seed@example.test",
  };
}

export interface BareGithub {
  /** The bare repository: the repository "on GitHub". */
  dir: string;
  /** The address the runner's mirror fetches from and pushes to. */
  url: string;
  defaultBranch: string;
  git(...args: string[]): string;
}

/** A bare repository with one commit on `main`, made from a scratch clone. */
export function createBareGithub(files: Record<string, string> = { "README.md": "hello\n" }): BareGithub {
  const root = mkdtempSync(path.join(tmpdir(), "r4d6-gh-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  const env = gitEnv(home);
  const run = (...args: string[]): string => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const dir = path.join(root, "widgets.git");
  run("init", "--bare", "-b", "main", dir);
  const seed = path.join(root, "seed");
  run("init", "-b", "main", seed);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    writeFileSync(path.join(seed, file), text);
    run("-C", seed, "add", file);
  }
  run("-C", seed, "commit", "-m", "first");
  run("-C", seed, "push", dir, "main");
  return { dir, url: pathToFileURL(dir).href, defaultBranch: "main", git: (...args) => run("-C", dir, ...args) };
}

const CHANGE_TYPES: Readonly<Record<string, FakeChangeType>> = { A: "ADDED", D: "DELETED", M: "MODIFIED", R: "RENAMED", C: "COPIED", T: "CHANGED" };

/**
 * Makes `repo` (the fake's record of the repository) say what the bare repository holds: the default branch's tip, and for every other branch its tip, the
 * commits it is ahead of the default branch and the paths it changes with GitHub's change types (a rename is `RENAMED`, found with `-M`, and listed under its
 * new path, as GitHub lists it).
 */
export function syncFakeFromBare(bare: BareGithub, repo: FakeRepo): void {
  const tipOf = (ref: string): string => bare.git("rev-parse", `refs/heads/${ref}`).trim();
  repo.defaultBranch = bare.defaultBranch;
  const names = bare
    .git("for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .filter((name) => name !== "");
  repo.branches.clear();
  for (const name of names) {
    if (name === bare.defaultBranch) {
      repo.branches.set(name, { oid: tipOf(name), aheadBy: 0, files: [] });
      continue;
    }
    const aheadBy = Number(bare.git("rev-list", "--count", `${bare.defaultBranch}..${name}`).trim());
    const files = bare
      .git("diff", "--name-status", "-M", "-z", `${bare.defaultBranch}...${name}`)
      .split("\0")
      .filter((part) => part !== "");
    const listed: Array<{ path: string; changeType: FakeChangeType }> = [];
    for (let i = 0; i < files.length; ) {
      const status = files[i]!;
      const kind = CHANGE_TYPES[status.charAt(0)] ?? status;
      // A rename or copy is followed by its old and new path; every other change by one path.
      if (status.startsWith("R") || status.startsWith("C")) {
        listed.push({ path: files[i + 2]!, changeType: kind });
        i += 3;
      } else {
        listed.push({ path: files[i + 1]!, changeType: kind });
        i += 2;
      }
    }
    repo.branches.set(name, { oid: tipOf(name), aheadBy, files: listed });
  }
}

/** Attaches the sync to a fake, so every API call it answers first looks at the repository. */
export function backFakeWithBare(fake: FakeGithub, bare: BareGithub, repo: FakeRepo): void {
  fake.before = () => syncFakeFromBare(bare, repo);
}
