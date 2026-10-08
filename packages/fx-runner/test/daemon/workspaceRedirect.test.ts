/**
 * D#6 R4a-3 fix round: the agent writes the workspace's `.git`, and the daemon reads it outside the sandbox. Each vector below makes
 * git read another real repository on the machine (the "victim", with its own history); each must push nothing, and the victim's
 * commit must never reach the mirror. Real git throughout.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { pushPlan } from "../../src/daemon/push.js";
import { assertWorkspaceGit } from "../../src/daemon/workspaceGit.js";
import { runCapture } from "../../src/engines/claude/capture.js";

let root: string;
let home: string;
let remote: string;
let victim: string;
let victimCommit: string;

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
const refsOf = (repo: string): string[] => sh("-C", repo, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean).sort();
const has = (repo: string, sha: string): boolean => {
  try {
    sh("-C", repo, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const job: GitJob = { repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor" };
const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-redirect-"));
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
  // Another repository on the same machine, with a history of its own that must never leave it.
  victim = path.join(root, "victim");
  sh("init", "-b", "main", victim);
  writeFileSync(path.join(victim, "secret.txt"), "not for the customer's repo\n");
  sh("-C", victim, "add", "secret.txt");
  sh("-C", victim, "commit", "-m", "private work");
  victimCommit = sh("-C", victim, "rev-parse", "HEAD").trim();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A prepared workspace with one agent commit, and the paths the checks look at. */
async function rig(withCapture: GitCapture = capture) {
  const mirrorsRoot = path.join(root, "cache", "fx-runner", "mirrors");
  const gitPath = createGitPath({ capture: withCapture,mirrorsRoot, stateDir: path.join(root, "state"), remoteUrl: () => pathToFileURL(remote).href });
  const workspace = path.join(root, "work", "run-1");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const { base } = await gitPath.prepare(job, lease, workspace);
  writeFileSync(path.join(workspace, "agent.txt"), "work\n");
  sh("-C", workspace, "add", "agent.txt");
  sh("-C", workspace, "commit", "-m", "agent change");
  const mirror = path.join(mirrorsRoot, `${job.repo.id}.git`);
  return { gitPath, workspace, base, mirror, gitDir: path.join(workspace, ".git") };
}

/** The daemon refuses, nothing reaches the remote, no private ref is left in the mirror, and the victim's commit is not in the mirror. */
async function expectRefused(r: Awaited<ReturnType<typeof rig>>): Promise<void> {
  await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused", message: "push_ref_refused" });
  expect(refsOf(remote)).toEqual(["refs/heads/main"]);
  expect(refsOf(r.mirror).filter((ref) => ref.startsWith("refs/fx-push/"))).toEqual([]);
  expect(has(r.mirror, victimCommit)).toBe(false);
  expect(has(remote, victimCommit)).toBe(false);
}

describe("the agent cannot point the daemon's fetch at another repository", () => {
  it("control: an untouched workspace is published", async () => {
    const r = await rig();
    expect((await r.gitPath.publish(job, lease, r.workspace, r.base)).pushed).toBe(true);
    expect(refsOf(remote)).toContain(`refs/heads/${pushPlan(lease).branch}`);
  });

  it("the fetch reads a daemon-owned snapshot, never the workspace path or its `.git`", async () => {
    const calls: Array<readonly string[]> = [];
    const r = await rig((command, args, env, timeoutMs) => (calls.push(args), capture(command, args, env, timeoutMs)));
    await r.gitPath.publish(job, lease, r.workspace, r.base);
    const fetches = calls.filter((args) => args.includes("fetch") && args.includes(`HEAD:${pushPlan(lease).localRef}`));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.some((arg) => arg.includes("git-snapshots"))).toBe(true);
    expect(fetches[0]!.some((arg) => arg.startsWith(r.workspace))).toBe(false);
  });

  it("a base that is not an object id is refused before any git process runs for the publish", async () => {
    const r = await rig();
    for (const bad of ["--upload-pack=x", "HEAD", "", "main", "g".repeat(40)]) {
      await expect(r.gitPath.publish(job, lease, r.workspace, bad)).rejects.toMatchObject({ code: "push_ref_refused" });
    }
    expect(refsOf(remote)).toEqual(["refs/heads/main"]);
  });

  it("a `.git` file naming the other repo (gitfile)", async () => {
    const r = await rig();
    rmSync(r.gitDir, { recursive: true });
    writeFileSync(r.gitDir, `gitdir: ${path.join(victim, ".git")}\n`);
    await expectRefused(r);
  });

  it("a `.git` symlink to the other repo", async () => {
    const r = await rig();
    renameSync(r.gitDir, path.join(root, "moved-git"));
    symlinkSync(path.join(victim, ".git"), r.gitDir);
    await expectRefused(r);
  });

  it("a `commondir` file inside a real `.git` directory", async () => {
    const r = await rig();
    writeFileSync(path.join(r.gitDir, "commondir"), `${path.join(victim, ".git")}\n`);
    await expectRefused(r);
  });

  it("alternates naming the other repo's objects, with HEAD set to its commit", async () => {
    const r = await rig();
    writeFileSync(path.join(r.gitDir, "objects", "info", "alternates"), `${path.join(victim, ".git", "objects")}\n`);
    writeFileSync(path.join(r.gitDir, "HEAD"), `${victimCommit}\n`);
    await expectRefused(r);
  });

  it("alternates with the mirror's objects and a second line for the other repo", async () => {
    const r = await rig();
    writeFileSync(path.join(r.gitDir, "objects", "info", "alternates"), `${path.join(r.mirror, "objects")}\n${path.join(victim, ".git", "objects")}\n`);
    writeFileSync(path.join(r.gitDir, "HEAD"), `${victimCommit}\n`);
    await expectRefused(r);
  });

  it("a symlinked `objects` directory and a symlinked `refs` directory, with HEAD at the other repo's branch", async () => {
    const r = await rig();
    rmSync(path.join(r.gitDir, "objects"), { recursive: true });
    symlinkSync(path.join(victim, ".git", "objects"), path.join(r.gitDir, "objects"));
    rmSync(path.join(r.gitDir, "refs"), { recursive: true });
    symlinkSync(path.join(victim, ".git", "refs"), path.join(r.gitDir, "refs"));
    writeFileSync(path.join(r.gitDir, "HEAD"), "ref: refs/heads/main\n");
    await expectRefused(r);
  });

  it("a symlinked HEAD", async () => {
    const r = await rig();
    rmSync(path.join(r.gitDir, "HEAD"));
    symlinkSync(path.join(victim, ".git", "HEAD"), path.join(r.gitDir, "HEAD"));
    await expectRefused(r);
  });

  it("a link planted deeper: a ref file, a loose object directory, a pack", async () => {
    const r = await rig();
    mkdirSync(path.join(r.gitDir, "refs", "heads", "x"), { recursive: true });
    symlinkSync(path.join(victim, ".git", "refs", "heads", "main"), path.join(r.gitDir, "refs", "heads", "x", "y"));
    await expectRefused(r);
    rmSync(path.join(r.gitDir, "refs", "heads", "x"), { recursive: true });
    symlinkSync(path.join(victim, ".git", "objects", "pack"), path.join(r.gitDir, "objects", "pack-link"));
    await expectRefused(r);
  });

  it("backstop: a commit with no link anywhere, but no ancestry in the run's base, is not pushed", async () => {
    const r = await rig();
    sh("-C", r.workspace, "checkout", "--orphan", "unrelated");
    writeFileSync(path.join(r.workspace, "other.txt"), "other history\n");
    sh("-C", r.workspace, "add", "other.txt");
    sh("-C", r.workspace, "commit", "-m", "unrelated root");
    const unrelated = sh("-C", r.workspace, "rev-parse", "HEAD").trim();
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused" });
    expect(refsOf(remote)).toEqual(["refs/heads/main"]);
    expect(refsOf(r.mirror).filter((ref) => ref.startsWith("refs/fx-push/"))).toEqual([]);
    expect(has(remote, unrelated)).toBe(false);
  });
});

describe("assertWorkspaceGit on its own", () => {
  const objects = (dir: string): string => path.join(dir, "mirror", "objects");

  /** The shape `git clone --reference` leaves: a real directory with HEAD, config, refs, objects and one alternates line. */
  function fixture(): string {
    const dir = path.join(root, `ws-${randomUUID()}`);
    mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(path.join(dir, ".git", "objects", "info"), { recursive: true });
    mkdirSync(objects(dir), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/fx/x\n");
    writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
    writeFileSync(path.join(dir, ".git", "objects", "info", "alternates"), `${objects(dir)}\n`);
    return dir;
  }

  it("accepts that shape, with or without alternates, and returns the git directory", () => {
    const dir = fixture();
    expect(assertWorkspaceGit(dir, objects(dir))).toBe(path.join(dir, ".git"));
    rmSync(path.join(dir, ".git", "objects", "info", "alternates"));
    expect(assertWorkspaceGit(dir, objects(dir))).toBe(path.join(dir, ".git"));
  });

  const OTHER = (): string => path.join(victim, ".git", "objects");
  const BREAKS: Array<[string, (dir: string) => void]> = [
    ["no .git at all", (dir) => rmSync(path.join(dir, ".git"), { recursive: true })],
    ["a .git file", (dir) => (rmSync(path.join(dir, ".git"), { recursive: true }), writeFileSync(path.join(dir, ".git"), "gitdir: /x\n"))],
    ["a .git link", (dir) => (renameSync(path.join(dir, ".git"), path.join(dir, "g")), symlinkSync(path.join(dir, "g"), path.join(dir, ".git")))],
    ["a commondir", (dir) => writeFileSync(path.join(dir, ".git", "commondir"), "../x\n")],
    ["a HEAD link", (dir) => (rmSync(path.join(dir, ".git", "HEAD")), symlinkSync(path.join(victim, ".git", "HEAD"), path.join(dir, ".git", "HEAD")))],
    ["a config link", (dir) => (rmSync(path.join(dir, ".git", "config")), symlinkSync(path.join(victim, ".git", "config"), path.join(dir, ".git", "config")))],
    ["a packed-refs link", (dir) => symlinkSync(path.join(victim, ".git", "HEAD"), path.join(dir, ".git", "packed-refs"))],
    ["a refs link", (dir) => (rmSync(path.join(dir, ".git", "refs"), { recursive: true }), symlinkSync(path.join(victim, ".git", "refs"), path.join(dir, ".git", "refs")))],
    ["an objects link", (dir) => (rmSync(path.join(dir, ".git", "objects"), { recursive: true }), symlinkSync(OTHER(), path.join(dir, ".git", "objects")))],
    ["an objects/info link", (dir) => (rmSync(path.join(dir, ".git", "objects", "info"), { recursive: true }), symlinkSync(path.join(dir, "mirror"), path.join(dir, ".git", "objects", "info")))],
    // A link to a file that holds exactly the right line: the content is fine, the link is not.
    ["an alternates link", (dir) => (writeFileSync(path.join(dir, "alt.txt"), `${objects(dir)}\n`), rmSync(path.join(dir, ".git", "objects", "info", "alternates")), symlinkSync(path.join(dir, "alt.txt"), path.join(dir, ".git", "objects", "info", "alternates")))],
    ["alternates for another repo", (dir) => writeFileSync(path.join(dir, ".git", "objects", "info", "alternates"), `${OTHER()}\n`)],
    ["alternates with a second line", (dir) => writeFileSync(path.join(dir, ".git", "objects", "info", "alternates"), `${objects(dir)}\n${OTHER()}\n`)],
    ["a relative alternates path", (dir) => writeFileSync(path.join(dir, ".git", "objects", "info", "alternates"), "../../mirror/objects\n")],
    ["a pack file link", (dir) => (mkdirSync(path.join(dir, ".git", "objects", "pack")), symlinkSync(OTHER(), path.join(dir, ".git", "objects", "pack", "p.pack")))],
  ];
  for (const [name, breakIt] of BREAKS) {
    it(`refuses ${name}, with the closed code`, () => {
      const dir = fixture();
      breakIt(dir);
      expect(() => assertWorkspaceGit(dir, objects(dir))).toThrow(expect.objectContaining({ code: "push_ref_refused", message: "push_ref_refused" }));
    });
  }

  it("refuses a relative workspace or mirror path", () => {
    expect(() => assertWorkspaceGit("work", "/m/objects")).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    expect(() => assertWorkspaceGit("/work", "m/objects")).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
  });

  it("the fixture is what the real clone makes: the same checks pass on a real --reference clone", async () => {
    const r = await rig();
    expect(assertWorkspaceGit(r.workspace, path.join(r.mirror, "objects"))).toBe(r.gitDir);
    expect(readFileSync(path.join(r.gitDir, "objects", "info", "alternates"), "utf8").trim()).toBe(path.join(r.mirror, "objects"));
    expect(existsSync(path.join(r.gitDir, "commondir"))).toBe(false);
  });
});
