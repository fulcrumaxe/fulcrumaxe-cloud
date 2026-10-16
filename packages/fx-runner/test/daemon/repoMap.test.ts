import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, GitPathError, type GitCapture } from "../../src/daemon/git.js";
import { LISTING_CAP, MAP_DEADLINE_MS, parseListing, readRepoMap } from "../../src/daemon/repoMap.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { REPO_MAP_MAX_BYTES, REPO_MAP_TRUNCATED_MARKER, buildRepoMap, repoMapDigest } from "../../src/job/repoMap.js";
import { SHARED, largeTree } from "../helpers/repoMapFixture.js";

/**
 * D#600 CX-3b: the map read from a real git repository with the daemon's real git capture. The repository is built from the shared fixture's
 * tree, so what comes out is the map the cloud builds from GitHub's listing of that tree.
 */
let root: string;
let home: string;
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
const sh = (repo: string | null, args: string[], input?: string): string =>
  execFileSync("git", repo === null ? args : ["-C", repo, ...args], { env: SETUP_ENV(), encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-repomap-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const captureOf = (max?: number): GitCapture => (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs, max, 2048);
/** The daemon's two captures: the ordinary 64 K one, and the 8 MB one for the listing. */
const gitsOf = (large = true) => ({ listing: createGit({ capture: captureOf(large ? LISTING_CAP : undefined) }), small: createGit({ capture: captureOf() }), listingCap: large ? LISTING_CAP : 64 * 1024 });

/** A bare repository whose one commit holds exactly `files` (path -> content), plus gitlinks. Returns its directory and the commit. */
function repoWith(files: Record<string, string | Buffer>, gitlinks: string[] = []): { dir: string; commit: string } {
  const dir = path.join(root, `repo-${Math.random().toString(16).slice(2)}.git`);
  sh(null, ["init", "--bare", "-b", "main", dir]);
  const lines: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const blob = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { env: SETUP_ENV(), input: content, encoding: "utf8" }).trim();
    lines.push(`100644 ${blob}\t${file}`);
  }
  for (const link of gitlinks) lines.push(`160000 ${"a".repeat(40)}\t${link}`);
  sh(dir, ["update-index", "--index-info"], `${lines.join("\n")}\n`);
  const tree = sh(dir, ["write-tree"]).trim();
  return { dir, commit: sh(dir, ["commit-tree", tree, "-m", "c"]).trim() };
}

describe("reading a map out of a mirror (D#600 CX-3b)", () => {
  it("the shared tree, read through real git, is the cloud's map: every line but the commit line is the fixture's, and the sha256 follows the commit line", async () => {
    const files: Record<string, string> = {};
    const links: string[] = [];
    for (const e of SHARED.entries) {
      if (e.type === "commit") links.push(e.path);
      else if (e.type === "blob" && !e.path.includes("\n")) files[e.path] = SHARED.blobs[e.sha] ?? "x\n";
    }
    const { dir, commit } = repoWith(files, links);
    const out = await readRepoMap(gitsOf(), dir, commit);
    expect(out).not.toBeNull();
    const lines = out!.text.split("\n");
    // The commit line is the one thing a re-built repository cannot share with the fixture (its commit has another id); the rest is the same tree.
    expect(lines[0]).toBe(`commit: ${commit.slice(0, 12)}`);
    expect(lines.slice(1)).toEqual(SHARED.expected.text.split("\n").slice(1));
    expect(repoMapDigest([`commit: ${SHARED.commit.slice(0, 12)}`, ...lines.slice(1)].join("\n"))).toEqual({ bytes: SHARED.expected.bytes, sha256: SHARED.expected.sha256 });
  });

  it("60,000 paths: git's listing is over the 64 K the ordinary capture keeps, and the map is still at most 8 KiB and ends with the marker", async () => {
    const dir = path.join(root, "big.git");
    sh(null, ["init", "--bare", "-b", "main", dir]);
    const blob = sh(dir, ["hash-object", "-w", "--stdin"], "x\n").trim();
    sh(dir, ["update-index", "--index-info"], `${largeTree(SHARED.large.count).map((e) => `100644 ${blob}\t${e.path}`).join("\n")}\n`);
    const commit = sh(dir, ["commit-tree", sh(dir, ["write-tree"]).trim(), "-m", "c"]).trim();
    const out = await readRepoMap(gitsOf(), dir, commit);
    expect(Buffer.byteLength(out!.text, "utf8")).toBeLessThanOrEqual(REPO_MAP_MAX_BYTES);
    expect(out!.text.endsWith(`\n${REPO_MAP_TRUNCATED_MARKER}`)).toBe(true);
    // The same paths the fixture's large case builds from, under this repository's own commit id.
    expect(out!.text.split("\n").slice(1)).toEqual(
      buildRepoMap({ sha: commit, paths: largeTree(SHARED.large.count), truncated: false, manifests: [] }).split("\n").slice(1),
    );
  });

  it("with only the ordinary 64 K capture a big tree is not mistaken for a whole one: the cut listing yields the marker", async () => {
    const dir = path.join(root, "big2.git");
    sh(null, ["init", "--bare", "-b", "main", dir]);
    const blob = sh(dir, ["hash-object", "-w", "--stdin"], "x\n").trim();
    sh(dir, ["update-index", "--index-info"], `${largeTree(5000).map((e) => `100644 ${blob}\t${e.path}`).join("\n")}\n`);
    const commit = sh(dir, ["commit-tree", sh(dir, ["write-tree"]).trim(), "-m", "c"]).trim();
    const out = await readRepoMap(gitsOf(false), dir, commit);
    expect(out!.text.endsWith(REPO_MAP_TRUNCATED_MARKER)).toBe(true);
  });

  it("reads manifests only through git: a manifest over 64 KiB, one that is not UTF-8 and one that is not JSON are left out, the rest are read", async () => {
    const { dir, commit } = repoWith({
      "package.json": JSON.stringify({ name: "root", scripts: { test: "vitest" } }),
      "a/package.json": `{"name":"big","pad":"${"x".repeat(70_000)}"}`,
      "b/package.json": Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]),
      "c/package.json": "not json",
      "d/package.json": JSON.stringify({ name: "fine" }),
    });
    const out = await readRepoMap(gitsOf(), dir, commit);
    expect(out!.text).toContain("package.json: name=root; scripts: test=vitest");
    expect(out!.text).toContain("d/package.json: name=fine");
    for (const left of ["a/package.json: name", "b/package.json: name", "c/package.json: name"]) expect(out!.text).not.toContain(left);
    expect(out!.text).toContain("test command: npm test");
  });

  it("is a pure read of the mirror: the working tree is never opened, and a second read gives the same bytes", async () => {
    const { dir, commit } = repoWith({ "README.md": "x\n", "src/a.ts": "x\n" });
    const first = await readRepoMap(gitsOf(), dir, commit);
    writeFileSync(path.join(root, "unrelated.txt"), "later\n");
    expect((await readRepoMap(gitsOf(), dir, commit))!.text).toBe(first!.text);
  });

  it("is null, never a throw, for a sha git does not hold, a sha that is not a sha, and a directory that is not a repository", async () => {
    const { dir } = repoWith({ "a.txt": "x\n" });
    expect(await readRepoMap(gitsOf(), dir, "b".repeat(40))).toBeNull();
    expect(await readRepoMap(gitsOf(), dir, "--output=/tmp/x")).toBeNull();
    expect(await readRepoMap(gitsOf(), path.join(root, "nothing-here"), "b".repeat(40))).toBeNull();
  });

  it("a git that fails with its closed code leaves no trace of git's output in the answer", async () => {
    const failing = createGit({ capture: async () => ({ code: 128, stdout: "fatal: /home/victim/PLANTED/secret.txt", timedOut: false }) });
    expect(await readRepoMap({ listing: failing, small: failing, listingCap: LISTING_CAP }, "/m.git", "c".repeat(40))).toBeNull();
    await expect(failing.run("mirror_failed", ["x"])).rejects.toBeInstanceOf(GitPathError);
  });
});

describe("the deadline on the whole map build (D#600 CX-3b)", () => {
  const SHA40 = "c".repeat(40);
  const LISTING = `100644 blob ${"1".repeat(40)}\tpackage.json\0`;

  it("the deadline is 30 seconds across all the git calls", () => {
    expect(MAP_DEADLINE_MS).toBe(30_000);
  });

  it("a git that never answers is killed at the deadline and the run starts with no map; no call is given more time than is left", async () => {
    const limits: number[] = [];
    let killed = 0;
    // A fake git that stalls: it answers the listing after 40 ms, then stalls on the manifest read until its own time limit runs out (as the real capture does, with SIGKILL).
    const capture: GitCapture = (_command, args, _env, timeoutMs) => {
      limits.push(timeoutMs);
      if (args.includes("ls-tree")) return new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: LISTING, timedOut: false }), 40));
      return new Promise((resolve) =>
        setTimeout(() => {
          killed += 1;
          resolve({ code: null, stdout: "", timedOut: true });
        }, timeoutMs),
      );
    };
    const git = createGit({ capture });
    const started = Date.now();
    const out = await readRepoMap({ listing: git, small: git, listingCap: LISTING_CAP }, "/m.git", SHA40, { deadlineMs: 180 });
    const took = Date.now() - started;
    expect(out).toBeNull();
    expect(killed).toBe(1);
    expect(took).toBeGreaterThanOrEqual(130);
    expect(took).toBeLessThan(1000);
    expect(limits).toHaveLength(2);
    expect(limits[0]).toBeLessThanOrEqual(180);
    // The second call got only what the first left over.
    expect(limits[1]!).toBeLessThan(limits[0]! - 30);
  });

  it("with the deadline already passed no git is started at all", async () => {
    let calls = 0;
    const git = createGit({ capture: async () => { calls += 1; return { code: 0, stdout: LISTING, timedOut: false }; } });
    let clock = 1000;
    const out = await readRepoMap({ listing: git, small: git, listingCap: LISTING_CAP }, "/m.git", SHA40, { deadlineMs: 50, now: () => (clock += 100) });
    expect(out).toBeNull();
    expect(calls).toBe(0);
  });

  it("a real git child that stalls is really killed (not left running) when the deadline passes", async () => {
    const pids: number[] = [];
    const stalling: GitCapture = (_command, _args, env, timeoutMs) =>
      runCapture(((cmd: string, args: readonly string[], opts: object) => {
        const child = spawn("sleep", ["30"], opts as never);
        void cmd;
        void args;
        pids.push(child.pid!);
        return child;
      }) as unknown as typeof spawn, "git", [], env, timeoutMs);
    const git = createGit({ capture: stalling });
    const out = await readRepoMap({ listing: git, small: git, listingCap: LISTING_CAP }, "/m.git", SHA40, { deadlineMs: 300 });
    expect(out).toBeNull();
    expect(pids).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });
});

describe("parsing git's listing", () => {
  const rec = (mode: string, type: string, sha: string, file: string): string => `${mode} ${type} ${sha}\t${file}\0`;
  const SHA = "1".repeat(40);

  it("reads files, folders, a submodule and a name with a space, a tab and a quote, byte for byte", () => {
    const out = parseListing(rec("040000", "tree", SHA, "d") + rec("100644", "blob", SHA, "d/a b.ts") + rec("160000", "commit", SHA, "vendor/x") + rec("100644", "blob", SHA, 'we"ird\tname.ts'), 1024);
    expect(out.truncated).toBe(false);
    expect(out.entries.map((e) => [e.type, e.path])).toEqual([["tree", "d"], ["blob", "d/a b.ts"], ["commit", "vendor/x"], ["blob", 'we"ird\tname.ts']]);
  });

  it("a record that is not git's shape fails the whole read (no guess)", () => {
    expect(() => parseListing(`100644 blob nothex\tfile\0`, 1024)).toThrow();
    expect(() => parseListing(`just text\0`, 1024)).toThrow();
  });

  it("a listing that reached the cap is cut: it is flagged, and its last (maybe partial) record is dropped", () => {
    const whole = Array.from({ length: 10 }, (_, i) => rec("100644", "blob", SHA, `f${i}.ts`)).join("");
    const cut = whole + "100644 blob 1111";
    const out = parseListing(cut, cut.length);
    expect(out.truncated).toBe(true);
    expect(out.entries).toHaveLength(10);
    expect(parseListing(whole, whole.length + 1).truncated).toBe(false);
  });
});
