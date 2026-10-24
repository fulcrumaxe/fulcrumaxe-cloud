/**
 * D#6 RUNNER-CWD-1: the placeholders the agent CLI makes in a job's workspace during the run are cleared before the check, the publish snapshot and
 * the push. Real git against a real local bare repository, the real-contract fake CLI (`stubbingClaude.ts`, the 2.1.309 start-up) started in the
 * workspace with scrubbing on as a model run starts, and the real check step. Nothing the repository had before the run, and nothing the agent wrote,
 * is touched.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckStep, createVcsState } from "../../src/daemon/checkStep.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { pushPlan } from "../../src/daemon/push.js";
import { takeSnapshot } from "../../src/daemon/snapshot.js";
import { clearCliStubs, stubBaseline } from "../../src/daemon/workspaceStubs.js";
import { runCapture, runInstall } from "../../src/engines/claude/capture.js";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { testLaunch } from "../helpers/launch.js";
import { fakeBwrapDir, makeStubbingClaude, treeOf, type StubbingClaude } from "../helpers/stubbingClaude.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let home: string;
let remote: string;
let fake: StubbingClaude;

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
const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const job: GitJob = { repo: { id: "4b7f0a3e-0d4e-4c1b-9a53-2f6a2f0d9c11", owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor" };
const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpRoot(), "fxr-cwd1-ws-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  fake = makeStubbingClaude(path.join(root, "fake"));
  vi.stubEnv("PATH", `${fakeBwrapDir(root)}:${process.env.PATH ?? ""}`);
  remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  // The repository's own files with placeholder names: a real lock file, and an empty `.npmrc` it ships on purpose. Both must survive.
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "yarn.lock"), "# yarn lockfile v1\n");
  writeFileSync(path.join(seed, ".npmrc"), "");
  sh("-C", seed, "add", "README.md", "yarn.lock", ".npmrc");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", remote, "main");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function rig() {
  const mirrorsRoot = path.join(root, "cache", "fx-runner", "mirrors");
  const gitPath = createGitPath({ platform: "linux", capture, mirrorsRoot, stateDir: path.join(root, "state"), remoteUrl: () => pathToFileURL(remote).href });
  const workspace = path.join(root, "work", "run-1");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const { base } = await gitPath.prepare(job, lease, workspace);
  return { gitPath, workspace, base, mirrorsRoot, publish: () => gitPath.publish(job, lease, workspace, base) };
}

/** The CLI starting a model run in the workspace: the run's own environment, scrubbing on. */
async function cliStartsIn(workspace: string): Promise<void> {
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(fake.binary, ["-p", "--model", "sonnet"], { cwd: workspace, env: cleanEnv({ mode: "subscription" }), stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end("go\n");
    child.on("close", resolve);
  });
  expect(code).toBe(0);
}

const STUB_NAMES = ["package.json", ".env", ".env.production.local", "bunfig.toml", "pnpm-lock.yaml", ".claude/", "node_modules/", ".git/commondir", ".git/config.worktree", ".git/modules/", ".git/worktrees/", ".git/glab-cli/"];

describe("clearing the CLI's placeholders from a job workspace", () => {
  it("control: the fake CLI really leaves them in the workspace, .git/commondir and the exclude block included", async () => {
    const r = await rig();
    const before = treeOf(r.workspace);
    await cliStartsIn(r.workspace);
    const after = treeOf(r.workspace);
    for (const name of STUB_NAMES) expect(after, name).toContain(name);
    expect(before).not.toContain(".git/commondir");
    expect(readFileSync(path.join(r.workspace, ".git", "info", "exclude"), "utf8")).toContain("# claude-code scrub-mode stubs");
  });

  it("puts the workspace back to its pre-run state plus the agent's own work; the repository's own files are untouched", async () => {
    const r = await rig();
    const exclude = path.join(r.workspace, ".git", "info", "exclude");
    const excludeBefore = readFileSync(exclude);
    const baseline = stubBaseline(r.workspace);
    const before = treeOf(r.workspace).filter((entry) => !entry.startsWith(".git/objects/") && !entry.startsWith(".git/logs/"));
    await cliStartsIn(r.workspace);
    // The agent's own work: a real file, an `.env` it wrote content into, and an empty file of a name that is no placeholder.
    writeFileSync(path.join(r.workspace, "agent.txt"), "work\n");
    writeFileSync(path.join(r.workspace, ".env.local"), "KEY=value\n");
    writeFileSync(path.join(r.workspace, "empty-on-purpose"), "");
    const removed = clearCliStubs(r.workspace, baseline);
    expect(removed).toContain(".git/commondir");
    expect(removed).toContain(".git/info/exclude");
    const after = treeOf(r.workspace).filter((entry) => !entry.startsWith(".git/objects/") && !entry.startsWith(".git/logs/"));
    expect(after).toEqual([...before, "agent.txt", ".env.local", "empty-on-purpose"].sort());
    expect(readFileSync(exclude).equals(excludeBefore)).toBe(true);
    expect(readFileSync(path.join(r.workspace, "yarn.lock"), "utf8")).toBe("# yarn lockfile v1\n");
    expect(readFileSync(path.join(r.workspace, ".npmrc"), "utf8")).toBe("");
    expect(readFileSync(path.join(r.workspace, ".env.local"), "utf8")).toBe("KEY=value\n");
    // Twice is the same as once.
    expect(clearCliStubs(r.workspace, baseline)).toEqual([]);
  });

  it("follows no link: a `.claude` that is a link to elsewhere is left, and what it points at is untouched", async () => {
    const r = await rig();
    const baseline = stubBaseline(r.workspace);
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(path.join(elsewhere, "commands"), { recursive: true });
    symlinkSync(elsewhere, path.join(r.workspace, ".claude"));
    clearCliStubs(r.workspace, baseline);
    expect(existsSync(path.join(elsewhere, "commands"))).toBe(true);
  });

  it("no placeholder reaches the pushed branch or the publish snapshot, after an agent `git add -A` and commit", async () => {
    const r = await rig();
    const baseline = stubBaseline(r.workspace);
    await cliStartsIn(r.workspace);
    writeFileSync(path.join(r.workspace, "agent.txt"), "work\n");
    sh("-C", r.workspace, "add", "-A");
    sh("-C", r.workspace, "commit", "-m", "agent change");
    clearCliStubs(r.workspace, baseline);
    const snap = await takeSnapshot({ workspace: r.workspace, mirrorObjects: path.join(r.mirrorsRoot, `${job.repo.id}.git`, "objects"), root: path.join(root, "state", "snapshots") });
    try {
      expect(existsSync(path.join(snap.gitDir, "commondir"))).toBe(false);
      expect(existsSync(path.join(snap.gitDir, "config.worktree"))).toBe(false);
    } finally {
      snap.remove();
    }
    expect(existsSync(path.join(r.workspace, ".git", "commondir"))).toBe(false);
    const published = await r.publish();
    expect(published).toMatchObject({ pushed: true, branch: pushPlan(lease).branch });
    const files = sh("-C", remote, "ls-tree", "-r", "--name-only", `refs/heads/${pushPlan(lease).branch}`).trim().split("\n").sort();
    expect(files).toEqual([".npmrc", "README.md", "agent.txt", "yarn.lock"]);
  });

  it("the check's protected-path comparison sees no change: the placeholders are gone before it, the repository's own protected files are as they were", async () => {
    const r = await rig();
    const baseline = stubBaseline(r.workspace);
    await cliStartsIn(r.workspace);
    clearCliStubs(r.workspace, baseline);
    const step = createCheckStep({
      capture: (command, args, env, cwd, timeoutMs, tail, signal, feed) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed),
      now: () => new Date(),
      vcsState: createVcsState((command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, { ...env, ...SETUP_ENV() }, timeoutMs, 1024 * 1024, 2048), {}),
    });
    const out = await step({
      check: { argv: ["/bin/sh", "-c", "echo checked"], dev_shell: false, timeout_s: 30 },
      workspace: r.workspace,
      base: r.base,
      baseDir: r.workspace,
      baseFile: async () => null,
      launch: (v) => ({ tool: v[0]!, args: v.slice(1), env: { PATH: process.env.PATH ?? "" } }),
    });
    expect(out.passed).toBe(true);
    expect(out.body.summary).not.toMatch(/protected/i);
    expect(readFileSync(path.join(r.workspace, "yarn.lock"), "utf8")).toBe("# yarn lockfile v1\n");
  });
});

/** Every entry under `dir` (links not followed), with each regular file's bytes and each link's target: what "untouched" is compared on. */
function stateOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      const info = lstatSync(path.join(dir, child));
      if (info.isSymbolicLink()) out[child] = `link:${readlinkSync(path.join(dir, child))}`;
      else if (info.isDirectory()) {
        out[`${child}/`] = `dir:${info.ino}`;
        walk(child);
      } else out[child] = `file:${info.ino}:${readFileSync(path.join(dir, child), "utf8")}`;
    }
  };
  walk("");
  return out;
}

const BLOCK = "\n# claude-code scrub-mode stubs\n/package.json\n/.env";
const PROC_FD = existsSync("/proc/self/fd");

/** A workspace with a `.git` (and its exclude), then what the CLI makes in it during a run; the baseline is taken in between. */
function stubbedWorkspace(): { workspace: string; baseline: ReturnType<typeof stubBaseline> } {
  const workspace = path.join(root, "race", "ws");
  mkdirSync(path.join(workspace, ".git", "info"), { recursive: true });
  writeFileSync(path.join(workspace, ".git", "info", "exclude"), "# repo excludes\n");
  const baseline = stubBaseline(workspace);
  for (const name of ["package.json", ".env"]) writeFileSync(path.join(workspace, name), "");
  for (const dir of [".claude/commands", ".claude/agents", "node_modules/.bin", ".git/modules", ".git/worktrees", ".git/glab-cli"]) mkdirSync(path.join(workspace, dir), { recursive: true });
  writeFileSync(path.join(workspace, ".git", "commondir"), ".");
  writeFileSync(path.join(workspace, ".git", "config.worktree"), "");
  writeFileSync(path.join(workspace, ".git", "info", "exclude"), BLOCK, { flag: "a" });
  return { workspace, baseline };
}

/** A directory outside the workspace holding every name a redirected removal could reach, in the shape the clear would remove or cut. */
function outsideTarget(): string {
  const outside = path.join(root, "race", "outside");
  for (const dir of ["modules", "worktrees", "glab-cli", "info", "commands", "agents", ".bin"]) mkdirSync(path.join(outside, dir), { recursive: true });
  writeFileSync(path.join(outside, "commondir"), ".");
  writeFileSync(path.join(outside, "config.worktree"), "");
  writeFileSync(path.join(outside, "exclude"), `# repo excludes\n${BLOCK}`);
  writeFileSync(path.join(outside, "info", "exclude"), `# repo excludes\n${BLOCK}`);
  return outside;
}

describe.each([
  ...(PROC_FD ? [{ mode: "through /proc/self/fd", viaProcFd: true }] : []),
  { mode: "by real path and dev/ino recheck (macOS)", viaProcFd: false },
])("a parent swapped for a link between the checks and the removal ($mode)", ({ viaProcFd }) => {
  it("control: with no swap the same clear removes every placeholder", () => {
    const { workspace, baseline } = stubbedWorkspace();
    const removed = clearCliStubs(workspace, baseline, { viaProcFd });
    for (const rel of ["package.json", ".env", ".claude/commands", ".claude", "node_modules", ".git/commondir", ".git/config.worktree", ".git/info/exclude", ".git/modules"]) expect(removed, rel).toContain(rel);
    expect(treeOf(workspace)).toEqual([".git/", ".git/info/", ".git/info/exclude"]);
    expect(readFileSync(path.join(workspace, ".git", "info", "exclude"), "utf8")).toBe("# repo excludes\n");
  });

  it.each([".git", ".git/info", ".claude", "node_modules"])("swapping %s touches nothing outside the workspace", (parent) => {
    const { workspace, baseline } = stubbedWorkspace();
    const outside = outsideTarget();
    const outsideBefore = stateOf(outside);
    let swapped: string | undefined;
    const removed = clearCliStubs(workspace, baseline, {
      viaProcFd,
      beforeChange: (rel) => {
        if (swapped !== undefined || !rel.startsWith(`${parent}/`)) return;
        // What a process the run left behind can do while the sandbox is up: move the real directory aside and put a link in its place.
        swapped = rel;
        renameSync(path.join(workspace, parent), path.join(workspace, `${parent}-moved`));
        symlinkSync(outside, path.join(workspace, parent));
      },
    });
    expect(swapped, "the hook ran between a check and a change").toBeDefined();
    expect(stateOf(outside)).toEqual(outsideBefore);
    expect(lstatSync(path.join(workspace, parent)).isSymbolicLink()).toBe(true);
    const leftAt = path.join(workspace, `${parent}-moved`, path.posix.relative(parent, swapped!));
    if (viaProcFd) {
      // Through the descriptor the change still lands in the directory that was checked (now moved aside, still inside the workspace).
      expect(removed).toContain(swapped);
      if (swapped !== EXCLUDE_REL) expect(existsSync(leftAt)).toBe(false);
      else expect(readFileSync(leftAt, "utf8")).toBe("# repo excludes\n");
    } else {
      // On the recheck path the move is noticed right before the change, and the entry is left as it was.
      expect(removed).not.toContain(swapped);
      expect(existsSync(leftAt)).toBe(true);
    }
  });

  it("never throws, whatever the hook does", () => {
    const { workspace, baseline } = stubbedWorkspace();
    expect(() => clearCliStubs(workspace, baseline, { viaProcFd, beforeChange: () => rmSync(workspace, { recursive: true, force: true }) })).not.toThrow();
  });
});

const EXCLUDE_REL = ".git/info/exclude";
