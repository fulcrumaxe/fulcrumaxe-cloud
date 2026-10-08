/**
 * D#6 R4a-3 fix round 3: the daemon fetches only from a snapshot of its own. Whatever the agent leaves in (or later writes to) the
 * workspace's `.git` must not decide what git reads, runs or pushes. Real git throughout; each case asserts what reached the
 * remote and that the snapshot is gone.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertGitVersion, createGit, gitVersionAllowed, GitPathError, type GitCapture, type GitCaptured } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { pushPlan } from "../../src/daemon/push.js";
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_ENTRIES, snapshotConfig, sweepSnapshots, takeSnapshot } from "../../src/daemon/snapshot.js";
import { assertGitDirShape, assertWorkspaceGit } from "../../src/daemon/workspaceGit.js";
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
const real: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs);
const isFetch = (args: readonly string[]): boolean => args.includes("fetch") && args.some((arg) => arg.startsWith("HEAD:refs/fx-push/"));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-snapshot-"));
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
  // A second real clone of the same repository, with one commit that was never pushed: the developer's own checkout.
  victim = path.join(root, "victim");
  sh("clone", remote, victim);
  writeFileSync(path.join(victim, "secret.txt"), "unpushed local work\n");
  sh("-C", victim, "add", "secret.txt");
  sh("-C", victim, "commit", "-m", "private work");
  victimCommit = sh("-C", victim, "rev-parse", "HEAD").trim();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const stateDir = (): string => path.join(root, "state");
const snapshotsRoot = (): string => path.join(stateDir(), "git-snapshots");
const leftovers = (): string[] => (existsSync(snapshotsRoot()) ? readdirSync(snapshotsRoot()) : []);

async function rig(withCapture: GitCapture = real) {
  const mirrorsRoot = path.join(root, "cache", "fx-runner", "mirrors");
  const gitPath = createGitPath({ capture: withCapture, mirrorsRoot, stateDir: stateDir(), remoteUrl: () => pathToFileURL(remote).href });
  const workspace = path.join(root, "work", "run-1");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const { base } = await gitPath.prepare(job, lease, workspace);
  writeFileSync(path.join(workspace, "agent.txt"), "work\n");
  sh("-C", workspace, "add", "agent.txt");
  sh("-C", workspace, "commit", "-m", "agent change");
  const mirror = path.join(mirrorsRoot, `${job.repo.id}.git`);
  return { gitPath, workspace, base, mirror, gitDir: path.join(workspace, ".git"), tip: sh("-C", workspace, "rev-parse", "HEAD").trim() };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** A capture that runs `mutate` once, just before the daemon's fetch from the snapshot: the moment a surviving process would strike. */
function racing(mutate: () => void, seen: Array<{ args: readonly string[]; env: Record<string, string> }> = []): GitCapture {
  let done = false;
  return (command, args, env, timeoutMs) => {
    seen.push({ args: [...args], env });
    if (!done && isFetch(args)) {
      done = true;
      mutate();
    }
    return real(command, args, env, timeoutMs);
  };
}

const nothingReached = (r: Rig): void => {
  expect(refsOf(remote)).toEqual(["refs/heads/main"]);
  expect(refsOf(r.mirror).filter((ref) => ref.startsWith("refs/fx-push/"))).toEqual([]);
  expect(has(r.mirror, victimCommit)).toBe(false);
  expect(has(remote, victimCommit)).toBe(false);
  expect(leftovers()).toEqual([]);
};

describe("the fetch reads a snapshot, never the workspace's .git", () => {
  it("control: an untouched workspace is published, from a snapshot that is gone afterwards", async () => {
    const seen: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const r = await rig(racing(() => undefined, seen));
    expect(await r.gitPath.publish(job, lease, r.workspace, r.base)).toEqual({ pushed: true, branch: pushPlan(lease).branch, sha: r.tip });
    expect(sh("-C", remote, "rev-parse", `refs/heads/${pushPlan(lease).branch}`).trim()).toBe(r.tip);
    expect(leftovers()).toEqual([]);
    const fetch = seen.find((call) => isFetch(call.args))!;
    expect(fetch.args).toContain("--upload-pack=git upload-pack --strict");
    expect(fetch.env.GIT_NO_LAZY_FETCH).toBe("1");
    const from = fetch.args[fetch.args.indexOf("--") + 1]!;
    expect(from.startsWith(`${snapshotsRoot()}${path.sep}`)).toBe(true);
    expect(from.startsWith(r.workspace)).toBe(false);
  });

  it("a promisor remote and `uploadpack` in the workspace config run nothing, even with lazy fetch switched back on", async () => {
    const marker = path.join(root, "marker");
    const script = path.join(root, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);
    // The pre-2.44 behaviour: this git would lazy-fetch a missing object through the promisor remote named in the config.
    const lazy: GitCapture = (command, args, env, timeoutMs) => real(command, args, isFetch(args) ? { ...env, GIT_NO_LAZY_FETCH: "0" } : env, timeoutMs);
    const r = await rig(lazy);
    const blob = sh("-C", r.workspace, "rev-parse", "HEAD:agent.txt").trim();
    const loose = path.join(r.gitDir, "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(loose, 0o644);
    rmSync(loose);
    writeFileSync(path.join(r.gitDir, "config"), `${readFileSync(path.join(r.gitDir, "config"), "utf8").replace("repositoryformatversion = 0", "repositoryformatversion = 1")}[extensions]\n\tpartialclone = evil\n[remote "evil"]\n\tpromisor = true\n\turl = ${victim}\n\tuploadpack = ${script}\n`);
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toBeInstanceOf(GitPathError);
    expect(existsSync(marker)).toBe(false);
    nothingReached(r);
  });

  for (const kind of ["gitfile", "directory", "symlink"] as const) {
    const plant = (r: Rig): void => {
      const target = path.join(r.gitDir, ".git");
      if (kind === "gitfile") writeFileSync(target, `gitdir: ${path.join(victim, ".git")}\n`);
      else if (kind === "directory") cpSync(path.join(victim, ".git"), target, { recursive: true });
      else symlinkSync(path.join(victim, ".git"), target);
    };

    it(`.git/.git as a ${kind} to a second clone with an unpushed commit is refused up front`, async () => {
      const r = await rig();
      plant(r);
      await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused" });
      nothingReached(r);
    });

    it(`.git/.git as a ${kind} planted after the snapshot is copied changes nothing that is pushed`, async () => {
      const r = await rig(racing(() => plant(r)));
      expect(await r.gitPath.publish(job, lease, r.workspace, r.base)).toMatchObject({ pushed: true, sha: r.tip });
      expect(has(remote, victimCommit)).toBe(false);
      expect(sh("-C", remote, "ls-tree", "-r", "--name-only", `refs/heads/${pushPlan(lease).branch}`)).not.toContain("secret.txt");
      expect(leftovers()).toEqual([]);
    });
  }

  it("a race: every redirect at once, written after the copy, leaves the pushed content equal to the snapshot", async () => {
    let later = "";
    const r = await rig(
      racing(() => {
        // What a surviving child could do: a newer commit, HEAD at the other clone's commit, a commondir, alternates, a gitfile.
        writeFileSync(path.join(r.workspace, "later.txt"), "after the stop\n");
        sh("-C", r.workspace, "add", "later.txt");
        sh("-C", r.workspace, "commit", "-m", "after the stop");
        later = sh("-C", r.workspace, "rev-parse", "HEAD").trim();
        writeFileSync(path.join(r.gitDir, "commondir"), `${path.join(victim, ".git")}\n`);
        writeFileSync(path.join(r.gitDir, "objects", "info", "alternates"), `${path.join(victim, ".git", "objects")}\n`);
        writeFileSync(path.join(r.gitDir, "HEAD"), `${victimCommit}\n`);
        rmSync(path.join(r.gitDir, "refs"), { recursive: true });
        symlinkSync(path.join(victim, ".git", "refs"), path.join(r.gitDir, "refs"));
      }),
    );
    const out = await r.gitPath.publish(job, lease, r.workspace, r.base);
    expect(out).toEqual({ pushed: true, branch: pushPlan(lease).branch, sha: r.tip });
    expect(later).not.toBe("");
    expect(later).not.toBe(r.tip);
    expect(has(remote, later)).toBe(false);
    expect(has(remote, victimCommit)).toBe(false);
    expect(sh("-C", remote, "rev-parse", `refs/heads/${pushPlan(lease).branch}`).trim()).toBe(r.tip);
    expect(leftovers()).toEqual([]);
  });

  it("the snapshot itself is validated before the fetch: a `.git` entry that appears in it is refused", async () => {
    let tampered = false;
    const tamper: GitCapture = (command, args, env, timeoutMs) => {
      if (!tampered && args.includes("update-ref")) {
        tampered = true;
        const [name] = readdirSync(snapshotsRoot());
        writeFileSync(path.join(snapshotsRoot(), name!, "git", ".git"), `gitdir: ${path.join(victim, ".git")}\n`);
      }
      return real(command, args, env, timeoutMs);
    };
    const r = await rig(tamper);
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused" });
    expect(tampered).toBe(true);
    nothingReached(r);
  });

  it("a hardlinked object file is refused, and nothing is pushed", async () => {
    const r = await rig();
    const blob = sh("-C", r.workspace, "rev-parse", "HEAD:agent.txt").trim();
    linkSync(path.join(r.gitDir, "objects", blob.slice(0, 2), blob.slice(2)), path.join(root, "elsewhere"));
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "snapshot_refused", message: "snapshot_refused" });
    nothingReached(r);
  });

  it("a hardlinked ref file is refused too", async () => {
    const r = await rig();
    linkSync(path.join(r.gitDir, "refs", "heads", pushPlan(lease).branch.split("/")[0]!, pushPlan(lease).branch.split("/")[1]!), path.join(root, "elsewhere-ref"));
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "snapshot_refused" });
    nothingReached(r);
  });

  it("a symlink inside objects/ or inside refs/ is refused", async () => {
    const r = await rig();
    symlinkSync(path.join(victim, ".git", "objects", "pack"), path.join(r.gitDir, "objects", "pack-link"));
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused" });
    nothingReached(r);
    rmSync(path.join(r.gitDir, "objects", "pack-link"));
    symlinkSync(path.join(victim, ".git", "refs", "heads", "main"), path.join(r.gitDir, "refs", "heads", "ref-link"));
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused" });
    nothingReached(r);
  });

  it("the snapshot is deleted when the fetch fails, and when the push fails", async () => {
    const r = await rig();
    const failing: GitCapture = (command, args, env, timeoutMs) => (isFetch(args) ? Promise.resolve<GitCaptured>({ code: 1, stdout: "", timedOut: false }) : real(command, args, env, timeoutMs));
    const broken = createGitPath({ capture: failing, mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: stateDir(), remoteUrl: () => pathToFileURL(remote).href });
    await expect(broken.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_failed" });
    expect(leftovers()).toEqual([]);
    const noPush: GitCapture = (command, args, env, timeoutMs) => (args.includes("push") ? Promise.resolve<GitCaptured>({ code: 1, stdout: "", timedOut: false }) : real(command, args, env, timeoutMs));
    const refusedPush = createGitPath({ capture: noPush, mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: stateDir(), remoteUrl: () => pathToFileURL(remote).href });
    await expect(refusedPush.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_failed" });
    expect(leftovers()).toEqual([]);
  });

  it("a leftover snapshot from a stopped daemon is swept when the git path starts; other files in the directory are not touched", () => {
    mkdirSync(path.join(snapshotsRoot(), "snap-old", "git"), { recursive: true });
    writeFileSync(path.join(snapshotsRoot(), "snap-old", "git", "HEAD"), "x");
    writeFileSync(path.join(snapshotsRoot(), "keep.txt"), "x");
    createGitPath({ capture: real, mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: stateDir() });
    expect(leftovers()).toEqual(["keep.txt"]);
    sweepSnapshots(path.join(root, "missing")); // no directory yet: nothing to do
  });
});

describe("takeSnapshot", () => {
  const mirrorObjects = (): string => path.join(root, "mirror.git", "objects");

  it("copies HEAD, refs and objects, and writes its own config and alternates; nothing else of the workspace", async () => {
    const r = await rig();
    writeFileSync(path.join(r.gitDir, "config"), `${readFileSync(path.join(r.gitDir, "config"), "utf8")}[alias]\n\tx = !touch ${path.join(root, "never")}\n`);
    writeFileSync(path.join(r.gitDir, "objects", "info", "http-alternates"), "http://example.invalid/\n");
    const snap = await takeSnapshot({ workspace: r.workspace, mirrorObjects: path.join(r.mirror, "objects"), root: snapshotsRoot() });
    try {
      expect(path.dirname(path.dirname(snap.gitDir))).toBe(snapshotsRoot());
      expect(statSync(path.dirname(snap.gitDir)).mode & 0o777).toBe(0o700);
      expect(readFileSync(path.join(snap.gitDir, "HEAD"), "utf8")).toBe(readFileSync(path.join(r.gitDir, "HEAD"), "utf8"));
      expect(readFileSync(path.join(snap.gitDir, "objects", "info", "alternates"), "utf8")).toBe(`${path.join(r.mirror, "objects")}\n`);
      expect(readdirSync(path.join(snap.gitDir, "objects", "info"))).toEqual(["alternates"]);
      const hooks = path.join(path.dirname(snap.gitDir), "no-hooks");
      expect(readdirSync(hooks)).toEqual([]);
      expect(readFileSync(path.join(snap.gitDir, "config"), "utf8")).toBe(snapshotConfig(hooks));
      expect(snapshotConfig("/h")).toBe('[core]\n\trepositoryformatversion = 0\n\tbare = true\n\thooksPath = "/h"\n');
      expect(sh("-C", snap.gitDir, "rev-parse", "--verify", "HEAD^{commit}").trim()).toBe(r.tip);
      assertGitDirShape(snap.gitDir, path.join(r.mirror, "objects"), true);
    } finally {
      snap.remove();
      snap.remove();
    }
    expect(leftovers()).toEqual([]);
  });

  it("refuses a special file, and leaves nothing behind", async () => {
    const r = await rig();
    execFileSync("mkfifo", [path.join(r.gitDir, "refs", "heads", "pipe")]);
    await expect(takeSnapshot({ workspace: r.workspace, mirrorObjects: path.join(r.mirror, "objects"), root: snapshotsRoot() })).rejects.toMatchObject({ code: "snapshot_refused", message: "snapshot_refused" });
    expect(leftovers()).toEqual([]);
  });

  it("refuses a symlink anywhere under refs or objects, and a `.git` that is a link or a file", async () => {
    const r = await rig();
    const attempt = (): Promise<unknown> => takeSnapshot({ workspace: r.workspace, mirrorObjects: path.join(r.mirror, "objects"), root: snapshotsRoot() });
    symlinkSync(path.join(victim, ".git", "refs"), path.join(r.gitDir, "refs", "heads", "l"));
    await expect(attempt()).rejects.toMatchObject({ code: "snapshot_refused" });
    rmSync(path.join(r.gitDir, "refs", "heads", "l"));
    symlinkSync(path.join(victim, ".git", "objects"), path.join(r.gitDir, "objects", "pack", "l"));
    await expect(attempt()).rejects.toMatchObject({ code: "snapshot_refused" });
    rmSync(path.join(r.gitDir, "objects", "pack", "l"));
    cpSync(r.gitDir, path.join(root, "moved"), { recursive: true });
    rmSync(r.gitDir, { recursive: true });
    symlinkSync(path.join(root, "moved"), r.gitDir);
    await expect(attempt()).rejects.toMatchObject({ code: "snapshot_refused" });
    rmSync(r.gitDir);
    writeFileSync(r.gitDir, `gitdir: ${path.join(root, "moved")}\n`);
    await expect(attempt()).rejects.toMatchObject({ code: "snapshot_refused" });
    expect(leftovers()).toEqual([]);
  });

  it("refuses a workspace reached through a path that is not absolute, or a snapshot root that is a link", async () => {
    const r = await rig();
    await expect(takeSnapshot({ workspace: "work", mirrorObjects: mirrorObjects(), root: snapshotsRoot() })).rejects.toMatchObject({ code: "snapshot_refused" });
    mkdirSync(stateDir(), { recursive: true });
    symlinkSync(root, snapshotsRoot());
    await expect(takeSnapshot({ workspace: r.workspace, mirrorObjects: path.join(r.mirror, "objects"), root: snapshotsRoot() })).rejects.toMatchObject({ code: "snapshot_refused" });
  });

  it("refuses a copy over the size cap or the entry cap", async () => {
    const r = await rig();
    const input = { workspace: r.workspace, mirrorObjects: path.join(r.mirror, "objects"), root: snapshotsRoot() };
    await expect(takeSnapshot({ ...input, limits: { bytes: 4, entries: SNAPSHOT_MAX_ENTRIES } })).rejects.toMatchObject({ code: "snapshot_refused" });
    await expect(takeSnapshot({ ...input, limits: { bytes: SNAPSHOT_MAX_BYTES, entries: 3 } })).rejects.toMatchObject({ code: "snapshot_refused" });
    expect(SNAPSHOT_MAX_BYTES).toBe(1024 ** 3);
    expect(SNAPSHOT_MAX_ENTRIES).toBe(200_000);
    expect(leftovers()).toEqual([]);
    (await takeSnapshot(input)).remove();
  });
});

describe("alternates must be absolute", () => {
  it("a relative alternates line that would resolve to the mirror from the daemon's directory is refused", async () => {
    const r = await rig();
    const objects = path.join(r.mirror, "objects");
    writeFileSync(path.join(r.gitDir, "objects", "info", "alternates"), `${path.relative(process.cwd(), objects)}\n`);
    expect(() => assertWorkspaceGit(r.workspace, objects)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    await expect(r.gitPath.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "push_ref_refused" });
    nothingReached(r);
  });

  it("a snapshot without its alternates line, or with a relative one, is refused before the fetch", async () => {
    const r = await rig();
    const objects = path.join(r.mirror, "objects");
    const snap = await takeSnapshot({ workspace: r.workspace, mirrorObjects: objects, root: snapshotsRoot() });
    try {
      writeFileSync(path.join(snap.gitDir, "objects", "info", "alternates"), `${path.relative(process.cwd(), objects)}\n`);
      expect(() => assertGitDirShape(snap.gitDir, objects, true)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
      rmSync(path.join(snap.gitDir, "objects", "info", "alternates"));
      expect(() => assertGitDirShape(snap.gitDir, objects, true)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    } finally {
      snap.remove();
    }
  });

  it("the mirror's own alternates, relative or not, are refused before a job", async () => {
    const r = await rig();
    writeFileSync(path.join(r.mirror, "objects", "info", "alternates"), "../../elsewhere/objects\n");
    const other = path.join(root, "work", "run-2");
    mkdirSync(other, { recursive: true, mode: 0o700 });
    await expect(r.gitPath.prepare(job, { ...lease, leaseGeneration: 2 }, other)).rejects.toMatchObject({ code: "mirror_failed" });
  });
});

describe("the git version gate", () => {
  const withVersion = (text: string, calls: string[][] = []): GitCapture => (command, args, env, timeoutMs) => {
    calls.push([...args]);
    return args[0] === "--version" ? Promise.resolve<GitCaptured>({ code: 0, stdout: text, timedOut: false }) : real(command, args, env, timeoutMs);
  };

  it("allows the patched release of each line and anything newer, and nothing older or unreadable", () => {
    for (const ok of ["2.39.4", "2.39.5", "2.40.2", "2.41.1", "2.42.2", "2.43.4", "2.44.1", "2.45.1", "2.46.0", "2.55.0", "3.0.0"]) expect(gitVersionAllowed(`git version ${ok}\n`), ok).toBe(true);
    expect(gitVersionAllowed("git version 2.39.5 (Apple Git-154)\n")).toBe(true);
    for (const bad of ["2.39.3", "2.39.0", "2.38.9", "2.40.1", "2.41.0", "2.42.1", "2.43.3", "2.44.0", "2.45.0", "1.9.9", "0.0.1"]) expect(gitVersionAllowed(`git version ${bad}\n`), bad).toBe(false);
    for (const junk of ["", "git", "git version", "git version x.y.z", "version 2.50.0", "something git version 2.50.0"]) expect(gitVersionAllowed(junk), junk).toBe(false);
  });

  it("assertGitVersion refuses below the minimum with the closed code, and names the minimum", async () => {
    const git = createGit({ capture: withVersion("git version 2.39.3 (Apple Git-146)\n") });
    await expect(assertGitVersion(git)).rejects.toMatchObject({ code: "git_version_unsupported", message: "git_version_unsupported: git 2.39.4 or newer is required" });
    await expect(assertGitVersion(createGit({ capture: () => Promise.resolve<GitCaptured>({ code: 127, stdout: "", timedOut: false }) }))).rejects.toMatchObject({ code: "git_version_unsupported" });
    await expect(assertGitVersion(createGit({ capture: real }))).resolves.toBeUndefined();
  });

  it("publish on a stubbed old git is refused before the workspace is read: nothing is pushed and no snapshot is made", async () => {
    const r = await rig();
    const calls: string[][] = [];
    const old = createGitPath({ capture: withVersion("git version 2.39.3\n", calls), mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: stateDir(), remoteUrl: () => pathToFileURL(remote).href });
    await expect(old.publish(job, lease, r.workspace, r.base)).rejects.toMatchObject({ code: "git_version_unsupported" });
    expect(calls).toEqual([["--version"]]);
    nothingReached(r);
    expect(existsSync(snapshotsRoot())).toBe(false);
  });

  it("setup on a stubbed old git is refused before a mirror or workspace is made", async () => {
    const calls: string[][] = [];
    const old = createGitPath({ capture: withVersion("git version 2.40.1\n", calls), mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: stateDir(), remoteUrl: () => pathToFileURL(remote).href });
    const workspace = path.join(root, "work", "run-9");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    await expect(old.prepare(job, lease, workspace)).rejects.toMatchObject({ code: "git_version_unsupported" });
    expect(calls).toEqual([["--version"]]);
    expect(existsSync(path.join(root, "cache"))).toBe(false);
  });
});
