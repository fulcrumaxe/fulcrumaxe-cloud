import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, GitPathError, GUARD_CONFIG, guardConfigEnv, type GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { githubUrl } from "../../src/daemon/mirror.js";
import { assertAllowedRefspec, publishBranch, pushPlan, runPush } from "../../src/daemon/push.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { filesUnder, PACKAGE_DIR } from "../helpers/srcFiles.js";

let root: string;
let home: string;
let remote: string;
let remoteUrl: string;

/** Setup commands run with no user config at all, so the rig is the same on every machine. */
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
const tip = (repo: string, ref: string): string => sh("-C", repo, "rev-parse", ref).trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-gitpath-"));
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
  remoteUrl = pathToFileURL(remote).href;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

interface Call {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

/** The daemon's real capture over the real process start, recording every call. */
function recordingCapture(): { capture: GitCapture; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    capture: (command, args, env, timeoutMs) => {
      calls.push({ command, args: [...args], env });
      return runCapture(spawn, command, args, env, timeoutMs);
    },
  };
}

const RUN_BRANCH = "fx/2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e-g1";
const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const jobFor = (over: Partial<GitJob> = {}): GitJob => ({ repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor", ...over });

function makeGitPath(over: { remoteUrl?: string; capture?: GitCapture } = {}) {
  const recorded = recordingCapture();
  const cacheDir = path.join(root, "cache", "fx-runner");
  const gitPath = createGitPath({ capture: over.capture ?? recorded.capture, mirrorsRoot: path.join(cacheDir, "mirrors"), stateDir: path.join(root, "state"), remoteUrl: () => over.remoteUrl ?? remoteUrl });
  return { gitPath, calls: recorded.calls, cacheDir };
}

/** An empty 0700 directory for a run, as the workspace store makes it. */
function newWorkspace(name = "run-1"): string {
  const dir = path.join(root, "work", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** What the agent does in its workspace: commit a file. Run with no user config, as the agent's own sandbox would not use ours. */
function agentCommits(workspace: string, file = "agent.txt"): string {
  writeFileSync(path.join(workspace, file), "work\n");
  sh("-C", workspace, "add", file);
  sh("-C", workspace, "commit", "-m", "agent change");
  return tip(workspace, "HEAD");
}

describe("the push target is built from the lease alone", () => {
  it("is fx/<run>-g<generation>, pushed from a private ref, with no force and no wildcard", () => {
    expect(pushPlan(lease)).toEqual({
      branch: "fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f-g1",
      localRef: "refs/fx-push/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f-g1",
      refspec: "refs/fx-push/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f-g1:refs/heads/fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f-g1",
    });
    expect(pushPlan({ ...lease, leaseGeneration: 12 }).branch).toBe("fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f-g12");
    const { refspec } = pushPlan(lease);
    expect(refspec).not.toMatch(/^\+|\*|--/);
  });

  const BAD_LEASES: Array<[string, unknown, unknown]> = [
    ["a path climb", "../../main", 1],
    ["a branch name", "main", 1],
    ["an upper-case id", "0B1B6C52-7A43-4D5E-8A77-0F0F0F0F0F0F", 1],
    ["an id with a refspec in it", "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f:refs/heads/main", 1],
    ["an id with a newline", "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f\n", 1],
    ["generation zero", lease.runId, 0],
    ["a negative generation", lease.runId, -1],
    ["a fractional generation", lease.runId, 1.5],
    ["a string generation", lease.runId, "1; main"],
    ["a huge generation", lease.runId, 2 ** 60],
    ["no run id", undefined, 1],
  ];
  for (const [name, runId, leaseGeneration] of BAD_LEASES) {
    it(`refuses ${name}`, () => {
      expect(() => pushPlan({ runId, leaseGeneration } as never)).toThrow(GitPathError);
      try {
        pushPlan({ runId, leaseGeneration } as never);
      } catch (error) {
        expect((error as GitPathError).code).toBe("push_ref_refused");
      }
    });
  }

  const OTHER_REFS = [
    "refs/fx-push/x:refs/heads/main",
    `${pushPlan(lease).localRef}:refs/heads/main`,
    `${pushPlan(lease).localRef}:refs/heads/master`,
    `${pushPlan(lease).localRef}:refs/heads/release/1.0`,
    `+${pushPlan(lease).refspec}`,
    `${pushPlan(lease).refspec} `,
    `${pushPlan(lease).refspec}\nrefs/heads/main:refs/heads/main`,
    `HEAD:refs/heads/${pushPlan(lease).branch}`,
    `${pushPlan({ ...lease, leaseGeneration: 2 }).refspec}`,
    `${pushPlan({ runId: "11111111-1111-4111-8111-111111111111", leaseGeneration: 1 }).refspec}`,
    "refs/*:refs/*",
    "refs/heads/*:refs/heads/*",
    ":refs/heads/main",
    "--force",
    "--mirror",
    "",
  ];
  it("runPush refuses every other refspec and runs no process for it", async () => {
    const calls: unknown[] = [];
    const git = createGit({ capture: async (...call) => (calls.push(call), { code: 0, stdout: "", timedOut: false }) });
    for (const refspec of OTHER_REFS) {
      await expect(runPush(git, "/m", remoteUrl, refspec, lease), JSON.stringify(refspec)).rejects.toMatchObject({ code: "push_ref_refused" });
      expect(() => assertAllowedRefspec(refspec, lease)).toThrow(GitPathError);
    }
    expect(calls).toEqual([]);
    await runPush(git, "/m", remoteUrl, pushPlan(lease).refspec, lease);
    expect(calls).toHaveLength(1);
  });

  it("the push command line has no force flag and ends with the url and the planned refspec", async () => {
    const calls: Array<readonly string[]> = [];
    const git = createGit({ capture: async (_c, args) => (calls.push(args), { code: 0, stdout: "", timedOut: false }) });
    await runPush(git, "/m", remoteUrl, pushPlan(lease).refspec, lease);
    expect(calls[0]!.slice(-2)).toEqual([remoteUrl, pushPlan(lease).refspec]);
    expect(calls[0]!.filter((a) => /force|mirror|delete|^\+/.test(a))).toEqual([]);
    expect(calls[0]!).toContain("--no-verify");
  });

  it("a job whose branch prefix is not fx/, or that continues a branch that is not a run branch, is refused before anything is made", () => {
    const { gitPath, cacheDir, calls } = makeGitPath();
    expect(() => gitPath.check(jobFor(), lease)).not.toThrow();
    expect(() => gitPath.check(jobFor({ branch_prefix: "release/" }), lease)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    expect(() => gitPath.check(jobFor({ branch_prefix: "fx/../" }), lease)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    expect(() => gitPath.check(jobFor({ continues: { parent_run_id: randomUUID(), session_id: "s", branch: "fx/issue-3" } }), lease)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    expect(() => gitPath.check(jobFor({ continues: { parent_run_id: randomUUID(), session_id: "s", branch: RUN_BRANCH } }), lease)).not.toThrow();
    expect(() => gitPath.check(jobFor(), { runId: "main", leaseGeneration: 1 })).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
    expect(calls).toEqual([]);
    expect(existsSync(cacheDir)).toBe(false);
  });
});

describe("mirror, workspace and push against a real repository", () => {
  it("clones a mirror into the 0700 state directory, a workspace from it on the run's branch, and pushes the agent's commit there only", async () => {
    const { gitPath, cacheDir, calls } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const mainBefore = tip(remote, "main");

    const { base } = await gitPath.prepare(job, lease, workspace);
    expect(base).toBe(mainBefore);
    const mirror = path.join(cacheDir, "mirrors", `${job.repo.id}.git`);
    expect(statSync(path.join(cacheDir, "mirrors")).mode & 0o777).toBe(0o700);
    expect(sh("-C", mirror, "rev-parse", "--is-bare-repository").trim()).toBe("true");
    expect(sh("-C", workspace, "branch", "--show-current").trim()).toBe(pushPlan(lease).branch);
    // `--reference`: the workspace borrows the mirror's objects instead of copying them.
    expect(readFileSync(path.join(workspace, ".git", "objects", "info", "alternates"), "utf8").trim()).toBe(path.join(mirror, "objects"));
    expect(readdirSync(path.join(workspace, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"))).toEqual([]);
    expect(readFileSync(path.join(workspace, "README.md"), "utf8")).toBe("hello\n");

    const commit = agentCommits(workspace);
    const published = await gitPath.publish(job, lease, workspace, base);
    expect(published).toEqual({ pushed: true, branch: pushPlan(lease).branch, sha: commit });

    expect(refsOf(remote)).toEqual([`refs/heads/${pushPlan(lease).branch}`, "refs/heads/main"]);
    expect(tip(remote, "main")).toBe(mainBefore);
    expect(tip(remote, `refs/heads/${pushPlan(lease).branch}`)).toBe(commit);
    // The private ref the commit travelled through is gone.
    expect(refsOf(mirror).filter((r) => r.startsWith("refs/fx-push/"))).toEqual([]);
    // Every process was `git` with an argv array and no shell, and the push went out of the mirror, not the workspace.
    expect(new Set(calls.map((c) => c.command))).toEqual(new Set(["git"]));
    const push = calls.find((c) => c.args.includes("push"))!;
    expect(push.args.slice(0, 2)).toEqual(["-C", mirror]);
  });

  it("pushes nothing when the agent added no commit, and leaves no branch behind", async () => {
    const { gitPath } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    expect(await gitPath.publish(job, lease, workspace, base)).toEqual({ pushed: false });
    expect(refsOf(remote)).toEqual(["refs/heads/main"]);
  });

  it("an agent that commits on main still lands on the run's branch only: the remote's main is never moved", async () => {
    const { gitPath } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    const mainBefore = tip(remote, "main");
    sh("-C", workspace, "checkout", "-B", "main");
    const commit = agentCommits(workspace);
    await gitPath.publish(job, lease, workspace, base);
    expect(tip(remote, "main")).toBe(mainBefore);
    expect(tip(remote, `refs/heads/${pushPlan(lease).branch}`)).toBe(commit);
    expect(refsOf(remote)).toEqual([`refs/heads/${pushPlan(lease).branch}`, "refs/heads/main"]);
  });

  it("runPush cannot move another branch of the real remote, whatever refspec it is given", async () => {
    const { gitPath, cacheDir } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommits(workspace);
    await gitPath.publish(job, lease, workspace, base);
    const mirror = path.join(cacheDir, "mirrors", `${job.repo.id}.git`);
    const git = createGit({ capture: recordingCapture().capture });
    const before = refsOf(remote).map((r) => `${r} ${tip(remote, r)}`);
    for (const refspec of ["refs/heads/main:refs/heads/main", "+refs/heads/main:refs/heads/main", `refs/heads/main:refs/heads/${pushPlan(lease).branch}x`, ":refs/heads/main"]) {
      await expect(runPush(git, mirror, remoteUrl, refspec, lease)).rejects.toMatchObject({ code: "push_ref_refused" });
    }
    expect(refsOf(remote).map((r) => `${r} ${tip(remote, r)}`)).toEqual(before);
  });

  it("a second job reuses the mirror (no new clone), sees what was pushed to the remote since, and follows a changed default branch", async () => {
    const { gitPath, calls, cacheDir } = makeGitPath();
    const job = jobFor();
    await gitPath.prepare(job, lease, newWorkspace("a"));
    const clones = (): number => calls.filter((c) => c.args.includes("clone") && c.args.includes("--bare")).length;
    expect(clones()).toBe(1);

    const other = path.join(root, "other");
    sh("clone", remote, other);
    writeFileSync(path.join(other, "later.txt"), "later\n");
    sh("-C", other, "add", "later.txt");
    sh("-C", other, "commit", "-m", "later");
    sh("-C", other, "push", "origin", "main");
    const second = await gitPath.prepare(job, { runId: randomUUID(), leaseGeneration: 1 }, newWorkspace("b"));
    expect(clones()).toBe(1);
    expect(second.base).toBe(tip(remote, "main"));

    sh("-C", other, "checkout", "-b", "develop");
    writeFileSync(path.join(other, "dev.txt"), "dev\n");
    sh("-C", other, "add", "dev.txt");
    sh("-C", other, "commit", "-m", "dev");
    sh("-C", other, "push", "origin", "develop");
    sh("-C", remote, "symbolic-ref", "HEAD", "refs/heads/develop");
    const third = await gitPath.prepare(job, { runId: randomUUID(), leaseGeneration: 1 }, newWorkspace("c"));
    expect(third.base).toBe(tip(remote, "develop"));
    expect(readdirSync(path.join(cacheDir, "mirrors"))).toEqual([`${job.repo.id}.git`]);
  });

  it("a first clone that fails leaves no half-made mirror and throws a closed code", async () => {
    const { gitPath, cacheDir } = makeGitPath({ remoteUrl: pathToFileURL(path.join(root, "missing.git")).href });
    const job = jobFor();
    const workspace = newWorkspace();
    await expect(gitPath.prepare(job, lease, workspace)).rejects.toMatchObject({ code: "mirror_failed", message: "mirror_failed" });
    expect(existsSync(path.join(cacheDir, "mirrors", `${job.repo.id}.git`))).toBe(false);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("a mirrors directory that is a link, or open to others, is not used", async () => {
    const { gitPath, cacheDir } = makeGitPath();
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(cacheDir, "mirrors"));
    await expect(gitPath.prepare(jobFor(), lease, newWorkspace())).rejects.toMatchObject({ code: "mirror_dir_insecure" });
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(path.join(cacheDir, "mirrors"));
    mkdirSync(path.join(cacheDir, "mirrors"), { mode: 0o755 });
    chmodSync(path.join(cacheDir, "mirrors"), 0o755);
    await gitPath.prepare(jobFor(), lease, newWorkspace("again"));
    expect(statSync(path.join(cacheDir, "mirrors")).mode & 0o777).toBe(0o700);
  });

  it("the remote address is built from the validated owner and name only", () => {
    expect(githubUrl({ id: randomUUID(), owner: "acme", name: "widgets" })).toBe("https://github.com/acme/widgets.git");
    for (const [owner, name] of [["acme", ".."], ["acme", "a/b"], ["a/b", "c"], ["-x", "c"], ["acme", "w@evil"], ["acme", ""], ["acme", "w w"]]) {
      expect(() => githubUrl({ id: randomUUID(), owner: owner!, name: name! })).toThrow(GitPathError);
    }
  });
});

describe("nothing the agent or the machine's hooks can plant runs, and nothing it plants redirects the push", () => {
  /** Hooks that record that they ran, at every hook name the commands in this path could reach. */
  function plantHooks(dir: string, marker: string): void {
    mkdirSync(dir, { recursive: true });
    // Only hooks this runner's own commands could fire. The receive-side ones (pre-receive, update, reference-transaction in the remote)
    // belong to the remote's process: git starts it without our config for a local path, and for a real remote it is GitHub's own.
    for (const hook of ["pre-push", "post-checkout", "post-merge", "pre-commit", "post-commit", "pre-auto-gc", "reference-transaction", "post-rewrite", "applypatch-msg", "prepare-commit-msg"]) {
      const file = path.join(dir, hook);
      writeFileSync(file, `#!/bin/sh\necho "${hook} $(pwd)" >> ${marker}\nexit 0\n`);
      chmodSync(file, 0o755);
    }
  }

  it("hooks named by the user's own config, by the mirror's hooks directory or by the workspace never run", async () => {
    const marker = path.join(root, "hook-ran");
    // The user's own config points every repository at a hooks directory (a common setup).
    const userHooks = path.join(root, "user-hooks");
    plantHooks(userHooks, marker);
    writeFileSync(path.join(home, ".gitconfig"), `[core]\n\thooksPath = ${userHooks}\n`);
    const { gitPath, cacheDir } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    // `reference-transaction` fires on every ref update, clone and checkout included: the guard alone has to stop it, push's --no-verify does not cover it.
    expect(existsSync(marker), existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe(false);
    // The mirror's own hooks directory, and the workspace's, which the agent writes.
    plantHooks(path.join(cacheDir, "mirrors", `${job.repo.id}.git`, "hooks"), marker);
    plantHooks(path.join(workspace, ".git", "hooks"), marker);
    agentCommits(workspace); // the test's own commit, with no user config: its hooks (the workspace's) may run, so clear what they wrote
    rmSync(marker, { force: true });
    expect((await gitPath.publish(job, lease, workspace, base)).pushed).toBe(true);
    // The remote is a local bare repository, and git starts its `receive-pack` with the user's own config (no guard): its hooks are the remote's
    // own process, not ours (a real remote is GitHub's). Every hook that ran in the mirror or the workspace would show its directory here.
    const ran = existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((line) => line !== "" && !line.endsWith("remote.git")) : [];
    expect(ran).toEqual([]);
    expect(refsOf(remote)).toContain(`refs/heads/${pushPlan(lease).branch}`);
  });

  it("the control: the same planted hooks do run when git is not given the guard config", async () => {
    const marker = path.join(root, "hook-ran");
    const userHooks = path.join(root, "user-hooks");
    plantHooks(userHooks, marker);
    writeFileSync(path.join(home, ".gitconfig"), `[core]\n\thooksPath = ${userHooks}\n`);
    const unguarded: GitCapture = (command, args, env, timeoutMs) => {
      const plain: Record<string, string> = {};
      for (const key of Object.keys(env)) if (!key.startsWith("GIT_CONFIG_")) plain[key] = env[key]!;
      return runCapture(spawn, command, args, plain, timeoutMs);
    };
    const { gitPath } = makeGitPath({ capture: unguarded });
    await gitPath.prepare(jobFor(), lease, newWorkspace());
    expect(existsSync(marker)).toBe(true);
  });

  it("a workspace config that rewrites urls, remotes and commands changes neither where the push goes nor what runs", async () => {
    const { gitPath } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    const commit = agentCommits(workspace);
    const marker = path.join(root, "planted-ran");
    const script = path.join(root, "planted.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0" >> ${marker}\n`);
    chmodSync(script, 0o755);
    const evil = pathToFileURL(path.join(root, "evil.git")).href;
    sh("init", "--bare", path.join(root, "evil.git"));
    writeFileSync(
      path.join(workspace, ".git", "config"),
      [
        readFileSync(path.join(workspace, ".git", "config"), "utf8"),
        "[core]",
        `\talternateRefsCommand = ${script}`,
        `\tfsmonitor = ${script}`,
        `\tsshCommand = ${script}`,
        `\thooksPath = ${path.join(root, "agent-hooks")}`,
        `[url "${evil}"]`,
        `\tinsteadOf = ${remoteUrl}`,
        `[remote "origin"]`,
        `\tpushurl = ${evil}`,
        `[credential]`,
        `\thelper = ${script}`,
        `[include]`,
        `\tpath = ${path.join(root, "nothing.cfg")}`,
        "",
      ].join("\n"),
    );
    plantHooks(path.join(root, "agent-hooks"), marker);
    expect((await gitPath.publish(job, lease, workspace, base)).pushed).toBe(true);
    expect(tip(remote, `refs/heads/${pushPlan(lease).branch}`)).toBe(commit);
    expect(refsOf(path.join(root, "evil.git"))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("the hook guard is in the environment of every git process, and names the keys it should", () => {
    const env = guardConfigEnv();
    expect(env.GIT_CONFIG_COUNT).toBe(String(GUARD_CONFIG.length));
    const pairs = GUARD_CONFIG.map((_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs).toContainEqual(["core.hooksPath", "/dev/null"]);
    expect(pairs).toContainEqual(["core.fsmonitor", "false"]);
    expect(pairs).toContainEqual(["protocol.ext.allow", "never"]);
  });
});

describe("the user's own credential helper, and nothing else of ours, is what git is given", () => {
  let server: http.Server;
  let seen: Array<{ url: string; auth: string | undefined }>;
  let origin: string;
  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization });
      if (req.headers.authorization === undefined) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fx"' });
        res.end();
        return;
      }
      res.writeHead(403);
      res.end("no");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/widgets.git`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("asks the helper from the user's config for the push, sends what it returns, and gives the helper no Claude credential", async () => {
    const log = path.join(root, "helper.log");
    const helper = path.join(root, "helper.sh");
    writeFileSync(helper, `#!/bin/sh\necho "$1 token=$CLAUDE_CODE_OAUTH_TOKEN key=$ANTHROPIC_API_KEY" >> ${log}\nif [ "$1" = get ]; then cat > /dev/null; echo username=runner-user; echo password=fake-pass; fi\n`);
    chmodSync(helper, 0o755);
    writeFileSync(path.join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-token-must-not-reach-git");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key-must-not-reach-git");

    // A mirror and a workspace with a commit, made against the local remote; then the push goes to the credentialed address.
    const { gitPath, cacheDir, calls } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommits(workspace);
    const mirror = path.join(cacheDir, "mirrors", `${job.repo.id}.git`);
    const git = createGit({ capture: recordingCapture().capture });
    await expect(publishBranch(git, mirror, origin, workspace, base, lease, path.join(root, "state", "git-snapshots"))).rejects.toMatchObject({ code: "push_failed" });

    const logged = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(logged[0]).toBe("get token= key=");
    expect(seen[0]).toMatchObject({ auth: undefined });
    expect(seen[0]!.url).toContain("git-receive-pack");
    expect(seen.at(-1)!.auth).toBe(`Basic ${Buffer.from("runner-user:fake-pass").toString("base64")}`);
    // No process was given the agent's credentials, or anything outside the named allowlist.
    for (const call of calls) {
      expect(JSON.stringify(call.env)).not.toMatch(/must-not-reach-git/);
      expect(Object.keys(call.env).filter((k) => /ANTHROPIC|CLAUDE/.test(k))).toEqual([]);
      expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(call.env.HOME).toBe(home);
    }
  });

  it("the mirror's fetch and clone use the same helper", async () => {
    const log = path.join(root, "helper.log");
    const helper = path.join(root, "helper.sh");
    writeFileSync(helper, `#!/bin/sh\necho "$1" >> ${log}\nif [ "$1" = get ]; then cat > /dev/null; echo username=u; echo password=p; fi\n`);
    chmodSync(helper, 0o755);
    writeFileSync(path.join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
    const { gitPath } = makeGitPath({ remoteUrl: origin });
    await expect(gitPath.prepare(jobFor(), lease, newWorkspace())).rejects.toMatchObject({ code: "mirror_failed" });
    expect(readFileSync(log, "utf8").split("\n")[0]).toBe("get");
    expect(seen.some((s) => s.auth === `Basic ${Buffer.from("u:p").toString("base64")}`)).toBe(true);
  });
});

describe("local-only means no reference to our proxy", () => {
  /** What names our GitHub proxy: its host, its policy purpose and the connection field that holds its address. */
  const PROXY = /gh-proxy|fulcrumaxe\.app|github_proxy|githubForwardHost|forwardURL|\bproxy\b|authHeader/i;
  const LOCAL_ONLY_FILES = ["git.ts", "gitPath.ts", "jobHandler.ts", "mirror.ts", "push.ts"].map((name) => path.join(PACKAGE_DIR, "src", "daemon", name));

  it("the git path and the handler that calls it name none of it", () => {
    for (const file of LOCAL_ONLY_FILES) expect(readFileSync(file, "utf8"), path.relative(PACKAGE_DIR, file)).not.toMatch(PROXY);
  });

  it("no file of the daemon, the job runner or the host sandbox does either", () => {
    const files = [...filesUnder(path.join(PACKAGE_DIR, "src", "daemon")), ...filesUnder(path.join(PACKAGE_DIR, "src", "job"))].filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) expect(readFileSync(file, "utf8"), path.relative(PACKAGE_DIR, file)).not.toMatch(/gh-proxy|fulcrumaxe\.app|github_proxy|githubForwardHost/i);
  });

  it("the scan finds each of the names it looks for", () => {
    for (const sample of ["https://gh-proxy.fulcrumaxe.app", "purpose: 'github_proxy'", "githubForwardHost", "const forwardURL = x", "use the proxy", "authHeader: x"]) expect(PROXY.test(sample), sample).toBe(true);
  });

  it("the only remote address the path builds is GitHub's own", () => {
    expect(githubUrl({ id: randomUUID(), owner: "acme", name: "widgets" })).not.toMatch(PROXY);
  });
});

describe("a fix round pushes to the pull request's branch (D#6 R4a-3b, C25 section 1)", () => {
  const FIX_LEASE = { runId: "7c7c7c7c-7d7d-4e7e-8f7f-707070707070", leaseGeneration: 2 };
  const fixPlan = (branch: string) => pushPlan(FIX_LEASE, { branch });
  const continuesOn = (branch: string) => ({ parent_run_id: randomUUID(), session_id: "s1", branch });

  /** The first run opens the pull request's branch: its commit is pushed to `fx/<run>-g<gen>`, and that branch is what a fix round continues. */
  async function firstRun(gitPath: ReturnType<typeof makeGitPath>["gitPath"], job: GitJob) {
    const workspace = newWorkspace("first");
    const { base } = await gitPath.prepare(job, lease, workspace);
    const commit = agentCommits(workspace);
    await gitPath.publish(job, lease, workspace, base);
    return { branch: pushPlan(lease).branch, commit, workspace };
  }

  /** Someone else pushes to the branch (the person fixing the pull request by hand). */
  function personPushes(branch: string, file = "person.txt"): string {
    const other = path.join(root, `person-${randomUUID()}`);
    sh("clone", "--branch", branch, remote, other);
    writeFileSync(path.join(other, file), "by hand\n");
    sh("-C", other, "add", file);
    sh("-C", other, "commit", "-m", "by hand");
    sh("-C", other, "push", "origin", branch);
    return tip(other, "HEAD");
  }

  const pushCalls = (calls: Call[]): Call[] => calls.filter((c) => c.args.includes("push"));

  it("the refspec is the lease's private ref to refs/heads/<continues.branch>, with no plus, no wildcard and no delete", () => {
    expect(fixPlan(RUN_BRANCH)).toEqual({
      branch: RUN_BRANCH,
      localRef: "refs/fx-push/7c7c7c7c-7d7d-4e7e-8f7f-707070707070-g2",
      refspec: `refs/fx-push/7c7c7c7c-7d7d-4e7e-8f7f-707070707070-g2:refs/heads/${RUN_BRANCH}`,
    });
    expect(fixPlan(RUN_BRANCH).refspec).not.toMatch(/^\+|\*|--/);
    // A fresh run is unchanged.
    expect(pushPlan(lease, null)).toEqual(pushPlan(lease));
  });

  const BAD_BRANCHES = ["main", "master", "fx/issue-12", `${RUN_BRANCH.slice(0, -1)}0`, "refs/heads/x", `refs/heads/${RUN_BRANCH}`, `${RUN_BRANCH}/../../main`, `${RUN_BRANCH}..x`, `${RUN_BRANCH}x`, `${RUN_BRANCH}\n`, `+${RUN_BRANCH}`, `${RUN_BRANCH}:refs/heads/main`, "fx/", "", "fx/2A2A2A2A-2B2B-4C2C-8D2D-2E2E2E2E2E2E-g1", "fx/2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e-g1000000000"];
  for (const branch of BAD_BRANCHES) {
    it(`refuses the target ${JSON.stringify(branch)} as push_ref_refused, in the plan and in check, and runs no process`, () => {
      expect(() => fixPlan(branch)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
      const { gitPath, calls, cacheDir } = makeGitPath();
      expect(() => gitPath.check(jobFor({ continues: continuesOn(branch) }), FIX_LEASE)).toThrow(expect.objectContaining({ code: "push_ref_refused" }));
      expect(calls).toEqual([]);
      expect(existsSync(cacheDir)).toBe(false);
    });
  }

  it("runPush for a fix round refuses every refspec but its own target: not main, not the lease's own fx branch, not another run branch, not a force", async () => {
    const calls: unknown[] = [];
    const git = createGit({ capture: async (...call) => (calls.push(call), { code: 0, stdout: "", timedOut: false }) });
    const own = fixPlan(RUN_BRANCH);
    const other = fixPlan("fx/9a9a9a9a-9b9b-4c9c-8d9d-9e9e9e9e9e9e-g1");
    for (const refspec of [`${own.localRef}:refs/heads/main`, `+${own.refspec}`, other.refspec, pushPlan(FIX_LEASE).refspec, `${own.refspec} `, `${own.localRef}:refs/heads/${RUN_BRANCH}x`, `:refs/heads/${RUN_BRANCH}`, "refs/heads/*:refs/heads/*"]) {
      await expect(runPush(git, "/m", remoteUrl, refspec, FIX_LEASE, { branch: RUN_BRANCH }), refspec).rejects.toMatchObject({ code: "push_ref_refused" });
    }
    expect(calls).toEqual([]);
    // The fix round's refspec is not allowed for a fresh run's lease plan, and its own is.
    await expect(runPush(git, "/m", remoteUrl, own.refspec, FIX_LEASE)).rejects.toMatchObject({ code: "push_ref_refused" });
    await runPush(git, "/m", remoteUrl, own.refspec, FIX_LEASE, { branch: RUN_BRANCH });
    expect(calls).toHaveLength(1);
  });

  it("a fast-forward continuation, from a second real clone through the snapshot path, updates the PR branch and nothing else", async () => {
    const { gitPath, calls, cacheDir } = makeGitPath();
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const mainBefore = tip(remote, "main");

    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    const second = newWorkspace("second");
    expect(second).not.toBe(first.workspace);
    const { base } = await gitPath.prepare(fixJob, FIX_LEASE, second);
    // The mirror shows the branch, the second clone is on it at its tip, and that tip is the base.
    const mirror = path.join(cacheDir, "mirrors", `${job.repo.id}.git`);
    expect(tip(mirror, `refs/heads/${first.branch}`)).toBe(first.commit);
    expect(base).toBe(first.commit);
    expect(sh("-C", second, "branch", "--show-current").trim()).toBe(first.branch);
    expect(tip(second, "HEAD")).toBe(first.commit);

    const fix = agentCommits(second, "fix.txt");
    const published = await gitPath.publish(fixJob, FIX_LEASE, second, base);
    expect(published).toEqual({ pushed: true, branch: first.branch, sha: fix });
    expect(tip(remote, `refs/heads/${first.branch}`)).toBe(fix);
    expect(sh("-C", remote, "rev-parse", `${fix}^`).trim()).toBe(first.commit);
    expect(tip(remote, "main")).toBe(mainBefore);
    // No new branch was made for the fix round.
    expect(refsOf(remote)).toEqual([`refs/heads/${first.branch}`, "refs/heads/main"]);
    expect(refsOf(mirror).filter((r) => r.startsWith("refs/fx-push/"))).toEqual([]);
    // The push went out of the mirror, to the PR branch, and no push command line holds a force flag of any kind.
    const pushes = pushCalls(calls);
    expect(pushes).toHaveLength(2);
    expect(pushes.at(-1)!.args.slice(0, 2)).toEqual(["-C", mirror]);
    expect(pushes.at(-1)!.args.at(-1)).toBe(fixPlan(first.branch).refspec);
    for (const push of pushes) expect(push.args.filter((a) => /^--(force|mirror|delete|force-with-lease)/.test(a) || /^-[a-zA-Z]*f/.test(a) || a.startsWith("+") || a.includes(":+"))).toEqual([]);
  });

  it("a remote that moved during the run gives push_rejected, pushes nothing, and leaves the remote branch as the person left it", async () => {
    const { gitPath, calls } = makeGitPath();
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    const second = newWorkspace("second");
    const { base } = await gitPath.prepare(fixJob, FIX_LEASE, second);
    agentCommits(second, "fix.txt");
    const theirs = personPushes(first.branch);
    const pushesBefore = pushCalls(calls).length;
    await expect(gitPath.publish(fixJob, FIX_LEASE, second, base)).rejects.toMatchObject({ code: "push_rejected", message: "push_rejected" });
    expect(tip(remote, `refs/heads/${first.branch}`)).toBe(theirs);
    expect(pushCalls(calls).length).toBe(pushesBefore);
  });

  it("a branch that moves between the check and the push is rejected by the remote as non-fast-forward: push_rejected, remote unchanged, no retry", async () => {
    const real = recordingCapture();
    const arm: { branch?: string } = {};
    let theirs: string | undefined;
    const pushes: string[][] = [];
    const capture: GitCapture = (command, args, env, timeoutMs) => {
      if (args.includes("push")) {
        pushes.push([...args]);
        // The person's push lands after the daemon's own check and before the daemon's push reaches the remote.
        if (arm.branch !== undefined) theirs = personPushes(arm.branch);
      }
      return real.capture(command, args, env, timeoutMs);
    };
    const { gitPath } = makeGitPath({ capture });
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    const second = newWorkspace("second");
    const { base } = await gitPath.prepare(fixJob, FIX_LEASE, second);
    agentCommits(second, "fix.txt");
    arm.branch = first.branch;
    const pushesBefore = pushes.length;
    await expect(gitPath.publish(fixJob, FIX_LEASE, second, base)).rejects.toMatchObject({ code: "push_rejected" });
    expect(theirs).toBeDefined();
    expect(tip(remote, `refs/heads/${first.branch}`)).toBe(theirs);
    expect(pushes.length - pushesBefore).toBe(1); // tried once, not retried
  });

  it("a branch that is gone at prepare stops everything: continuation_branch_missing, nothing in the workspace, no clone of a workspace", async () => {
    const { gitPath, calls } = makeGitPath();
    const job = jobFor();
    const workspace = newWorkspace("second");
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(RUN_BRANCH) });
    await expect(gitPath.prepare(fixJob, FIX_LEASE, workspace)).rejects.toMatchObject({ code: "continuation_branch_missing", message: "continuation_branch_missing" });
    expect(readdirSync(workspace)).toEqual([]);
    expect(calls.filter((c) => c.args.includes("clone") && !c.args.includes("--bare"))).toEqual([]);
    expect(refsOf(remote)).toEqual(["refs/heads/main"]);
  });

  it("a branch deleted after prepare is not pushed: continuation_branch_missing, and the branch is not re-created", async () => {
    const { gitPath, calls } = makeGitPath();
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    const second = newWorkspace("second");
    const { base } = await gitPath.prepare(fixJob, FIX_LEASE, second);
    agentCommits(second, "fix.txt");
    sh("-C", remote, "branch", "-D", first.branch);
    const pushesBefore = pushCalls(calls).length;
    await expect(gitPath.publish(fixJob, FIX_LEASE, second, base)).rejects.toMatchObject({ code: "continuation_branch_missing" });
    expect(refsOf(remote)).toEqual(["refs/heads/main"]);
    expect(pushCalls(calls).length).toBe(pushesBefore);
  });

  it("after a stop reply nothing is pushed: the check passed, the commit is ready, and the remote is untouched", async () => {
    const { gitPath, calls } = makeGitPath();
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    const second = newWorkspace("second");
    const { base } = await gitPath.prepare(fixJob, FIX_LEASE, second);
    agentCommits(second, "fix.txt");
    const pushesBefore = pushCalls(calls).length;
    expect(await gitPath.publish(fixJob, FIX_LEASE, second, base, () => true)).toEqual({ pushed: false });
    expect(tip(remote, `refs/heads/${first.branch}`)).toBe(first.commit);
    expect(pushCalls(calls).length).toBe(pushesBefore);
    // The same publish with no stop does push.
    expect((await gitPath.publish(fixJob, FIX_LEASE, second, base, () => false)).pushed).toBe(true);
  });

  it("a kept session's workspace is resumed only when it is exactly at the branch's tip after a fresh mirror sync", async () => {
    const { gitPath } = makeGitPath();
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    // The first run's workspace is at the tip it pushed: usable.
    expect(await gitPath.resume(fixJob, FIX_LEASE, first.workspace)).toEqual({ base: first.commit });
    // A person pushed to the branch since: the kept workspace is stale, so the run starts fresh instead.
    const theirs = personPushes(first.branch);
    expect(await gitPath.resume(fixJob, FIX_LEASE, first.workspace)).toBeNull();
    // The fresh start is on the new tip.
    const fresh = newWorkspace("fresh");
    expect((await gitPath.prepare(fixJob, FIX_LEASE, fresh)).base).toBe(theirs);
    expect(tip(fresh, "HEAD")).toBe(theirs);
    // A directory that is not a clone this path made is not resumed either (and nothing in it is trusted).
    expect(await gitPath.resume(fixJob, FIX_LEASE, newWorkspace("empty"))).toBeNull();
    // A branch that is gone is an error, not a fallback: there is nothing to start fresh on.
    sh("-C", remote, "branch", "-D", first.branch);
    await expect(gitPath.resume(fixJob, FIX_LEASE, first.workspace)).rejects.toMatchObject({ code: "continuation_branch_missing" });
  });

  it("the mirror shows the branch after the sync, and the workspace has the branch's history, not the default branch's", async () => {
    const { gitPath, cacheDir } = makeGitPath();
    const job = jobFor();
    const first = await firstRun(gitPath, job);
    const fixJob = jobFor({ repo: job.repo, continues: continuesOn(first.branch) });
    const second = newWorkspace("second");
    await gitPath.prepare(fixJob, FIX_LEASE, second);
    expect(readFileSync(path.join(second, "agent.txt"), "utf8")).toBe("work\n");
    expect(refsOf(path.join(cacheDir, "mirrors", `${job.repo.id}.git`))).toContain(`refs/heads/${first.branch}`);
  });
});
