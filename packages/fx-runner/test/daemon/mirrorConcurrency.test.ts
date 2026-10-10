/**
 * D#6 C43-3: several jobs of one runner share each repo's bare mirror. Real git, real local remotes, real directories; the only
 * thing added is a pause before every `git fetch`, so that two fetches that are allowed to run together do run together and the
 * test can see it. The rule: jobs on one repo take turns on its mirror, jobs on different repos do not wait for each other.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, type GitCapture } from "../../src/daemon/git.js";
import { createMirrors, type Mirrors, type RepoRef } from "../../src/daemon/mirror.js";
import { runCapture } from "../../src/engines/claude/capture.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const FETCH_PAUSE_MS = 250;
const FIX_BRANCH = "fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f99-g1";
let root: string;
let home: string;
let events: string[];
let inFlight: Map<string, number>;
let mostTogether: Map<string, number>;
let mostAnywhere: number;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});
const sh = (...args: string[]): string => execFileSync("git", args, { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const repoA: RepoRef = { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner: "acme", name: "alpha" };
const repoB: RepoRef = { id: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", owner: "acme", name: "beta" };
const remotes = new Map<string, string>();
const seeds = new Map<string, string>();

function makeRemote(repo: RepoRef): void {
  const bare = path.join(root, `${repo.name}-remote.git`);
  const seed = path.join(root, `${repo.name}-seed`);
  sh("init", "--bare", "-b", "main", bare);
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), `${repo.name}\n`);
  sh("-C", seed, "add", "README.md");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", bare, "main");
  remotes.set(repo.id, pathToFileURL(bare).href);
  seeds.set(repo.id, seed);
}

/** A new commit on the remote's main, so the next fetch has something to bring. */
function advance(repo: RepoRef, name: string): string {
  const seed = seeds.get(repo.id) as string;
  writeFileSync(path.join(seed, `${name}.txt`), `${name}\n`);
  sh("-C", seed, "add", `${name}.txt`);
  sh("-C", seed, "commit", "-m", name);
  sh("-C", seed, "push", path.join(root, `${repo.name}-remote.git`), "main");
  return sh("-C", seed, "rev-parse", "HEAD").trim();
}

/** Real git through the real process path; every fetch is logged with its mirror and held for a moment so overlapping ones are caught. */
const capture: GitCapture = async (command, args, env, timeoutMs) => {
  const isFetch = args.includes("fetch");
  const mirror = isFetch ? String(args[args.indexOf("-C") + 1]) : "";
  if (isFetch) {
    events.push(`start ${path.basename(mirror)}`);
    const here = (inFlight.get(mirror) ?? 0) + 1;
    inFlight.set(mirror, here);
    mostTogether.set(mirror, Math.max(mostTogether.get(mirror) ?? 0, here));
    const all = [...inFlight.values()].reduce((sum, count) => sum + count, 0);
    mostAnywhere = Math.max(mostAnywhere, all);
    await sleep(FETCH_PAUSE_MS);
  }
  try {
    return await runCapture(spawn, command, args, { ...env, ...SETUP_ENV() }, timeoutMs);
  } finally {
    if (isFetch) {
      inFlight.set(mirror, (inFlight.get(mirror) ?? 1) - 1);
      events.push(`end ${path.basename(mirror)}`);
    }
  }
};

const mirrorsFor = (): Mirrors =>
  createMirrors({ git: createGit({ capture }), mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: (repo) => remotes.get(repo.id) as string });
const lease = (n: number) => ({ runId: `0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f${String(n).padStart(2, "0")}`, leaseGeneration: 1 });
const workspace = (name: string): string => {
  const target = path.join(root, "ws", name);
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
};
const headOf = (repo: string): string => sh("-C", repo, "rev-parse", "HEAD").trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-mirrorconc-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  events = [];
  inFlight = new Map();
  mostTogether = new Map();
  mostAnywhere = 0;
  remotes.clear();
  seeds.clear();
  makeRemote(repoA);
  makeRemote(repoB);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("two jobs on one repo", () => {
  it("run their fetches one after the other, and each gets a correct workspace at the new tip", async () => {
    const mirrors = mirrorsFor();
    await mirrors.sync(repoA); // the mirror exists, so each job below fetches
    events.length = 0;
    const tip = advance(repoA, "second");
    const [one, two] = await Promise.all([
      mirrors.prepareWorkspace(repoA, lease(1), workspace("one"), null, null),
      mirrors.prepareWorkspace(repoA, lease(2), workspace("two"), null, null),
    ]);
    const name = `${repoA.id}.git`;
    expect(events).toEqual([`start ${name}`, `end ${name}`, `start ${name}`, `end ${name}`]);
    expect(mostTogether.get(path.join(root, "cache", "fx-runner", "mirrors", `${repoA.id}.git`))).toBe(1);
    expect(one.base).toBe(tip);
    expect(two.base).toBe(tip);
    expect(headOf(path.join(root, "ws", "one"))).toBe(tip);
    expect(headOf(path.join(root, "ws", "two"))).toBe(tip);
    const mirror = path.join(root, "cache", "fx-runner", "mirrors", `${repoA.id}.git`);
    expect(() => sh("-C", mirror, "fsck", "--strict")).not.toThrow();
    expect(() => sh("-C", path.join(root, "ws", "one"), "fsck", "--strict")).not.toThrow();
    expect(() => sh("-C", path.join(root, "ws", "two"), "fsck", "--strict")).not.toThrow();
  });

  it("two review jobs, a fix round and a fresh run all at once leave one correct workspace each", async () => {
    const mirrors = mirrorsFor();
    const first = (await mirrors.sync(repoA)).base;
    sh("-C", seeds.get(repoA.id) as string, "branch", FIX_BRANCH);
    sh("-C", seeds.get(repoA.id) as string, "push", path.join(root, "alpha-remote.git"), FIX_BRANCH);
    const tip = advance(repoA, "next");
    const results = await Promise.all([
      mirrors.prepareWorkspace(repoA, lease(1), workspace("r1"), null, { head_sha: first }),
      mirrors.prepareWorkspace(repoA, lease(2), workspace("r2"), null, { head_sha: first }),
      mirrors.prepareWorkspace(repoA, lease(3), workspace("fix"), { branch: FIX_BRANCH }, null),
      mirrors.prepareWorkspace(repoA, lease(4), workspace("run"), null, null),
    ]);
    expect(results.map((r) => r.base)).toEqual([first, first, first, tip]);
    expect(headOf(path.join(root, "ws", "r1"))).toBe(first);
    expect(headOf(path.join(root, "ws", "r2"))).toBe(first);
    expect(headOf(path.join(root, "ws", "run"))).toBe(tip);
    expect(mostTogether.get(path.join(root, "cache", "fx-runner", "mirrors", `${repoA.id}.git`))).toBe(1);
  });

  it("the first use of a repo by two jobs at once makes the mirror once and both workspaces work", async () => {
    const mirrors = mirrorsFor();
    const [one, two] = await Promise.all([mirrors.prepareWorkspace(repoA, lease(1), workspace("one"), null, null), mirrors.prepareWorkspace(repoA, lease(2), workspace("two"), null, null)]);
    expect(one.base).toBe(two.base);
    expect(headOf(path.join(root, "ws", "one"))).toBe(one.base);
    expect(headOf(path.join(root, "ws", "two"))).toBe(one.base);
  });

  it("holds across separate Mirrors objects for the same directory (path A makes one per job)", async () => {
    await mirrorsFor().sync(repoA);
    events.length = 0;
    await Promise.all([mirrorsFor().sync(repoA), mirrorsFor().sync(repoA), mirrorsFor().sync(repoA)]);
    expect(mostTogether.get(path.join(root, "cache", "fx-runner", "mirrors", `${repoA.id}.git`))).toBe(1);
    expect(events).toHaveLength(6);
  });

  it("a failed job does not hold up the next one", async () => {
    const mirrors = mirrorsFor();
    await expect(mirrors.prepareWorkspace(repoA, lease(1), workspace("bad"), null, { head_sha: "f".repeat(40) })).rejects.toMatchObject({ code: "review_sha_not_in_mirror" });
    await expect(mirrors.prepareWorkspace(repoA, lease(2), workspace("good"), null, null)).resolves.toMatchObject({ base: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});

describe("two jobs on different repos", () => {
  it("fetch at the same time", async () => {
    const mirrors = mirrorsFor();
    await mirrors.sync(repoA);
    await mirrors.sync(repoB);
    events.length = 0;
    const started = Date.now();
    await Promise.all([mirrors.prepareWorkspace(repoA, lease(1), workspace("a"), null, null), mirrors.prepareWorkspace(repoB, lease(2), workspace("b"), null, null)]);
    expect(mostAnywhere).toBe(2);
    expect(events.slice(0, 2).every((line) => line.startsWith("start "))).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("waiting for a mirror turn is abortable (D#6 C43-4)", () => {
  const withSignal = (signal: AbortSignal): Mirrors =>
    createMirrors({ git: createGit({ capture }), mirrorsRoot: path.join(root, "cache", "fx-runner", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: (repo) => remotes.get(repo.id) as string, signal });

  it("a job whose signal aborts while it waits gives up at once; the fetch in progress and the jobs behind keep their order", async () => {
    const stop = new AbortController();
    const patient = mirrorsFor();
    const impatient = withSignal(stop.signal);
    await patient.sync(repoA);
    events.length = 0;
    const running = patient.sync(repoA);
    await sleep(60);
    const waiting = impatient.sync(repoA);
    const after = patient.sync(repoA);
    await sleep(60);
    stop.abort();
    const abortedAt = Date.now();
    await expect(waiting).rejects.toMatchObject({ code: "mirror_failed" });
    expect(Date.now() - abortedAt).toBeLessThan(FETCH_PAUSE_MS);
    await running;
    await after;
    // Two fetches ran (the one in progress and the one behind the aborted wait), one after the other; the aborted job never started one.
    expect(events.map((event) => event.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  });

  it("an already-aborted signal never takes a turn", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(withSignal(stop.signal).sync(repoA)).rejects.toMatchObject({ code: "mirror_failed" });
    expect(events).toEqual([]);
  });
});
