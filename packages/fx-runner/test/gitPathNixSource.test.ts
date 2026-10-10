import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/engines/claude/capture.js";
import { createGitPath } from "../src/daemon/gitPath.js";

/**
 * D#6 R7c: the default-branch rule of `nixSource`, against a real git origin and the real git path's own mirror. No nix is needed, so this runs on every
 * machine (the real-nix test covers the same guard end to end but skips without nix). The mirror's HEAD follows the default branch, so a commit counts only
 * when it is in that branch's history; a commit that exists only on a run branch is `not_default_branch`.
 */
const LOCK = JSON.stringify({ nodes: { root: {} }, root: "root", version: 7 });
const capture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 4096);

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const gitUsable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!gitUsable)("nixSource against a plain git repo", () => {
  let root: string;
  const sha: Record<string, string> = {};
  let gitPath: ReturnType<typeof createGitPath>;
  let job: Parameters<ReturnType<typeof createGitPath>["prepare"]>[0];

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "r7c-source-"));
    const origin = path.join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    const commit = (name: string, message: string, files: Record<string, string>) => {
      for (const [file, text] of Object.entries(files)) writeFileSync(path.join(origin, file), text);
      git(origin, "add", ...Object.keys(files));
      git(origin, "commit", "-q", "-m", message);
      sha[name] = git(origin, "rev-parse", "HEAD");
    };
    commit("noFlake", "readme", { "README.md": "x" });
    commit("noLock", "flake without a lock", { "flake.nix": "{ outputs = { self }: {}; }\n" });
    commit("flake", "lock", { "flake.lock": LOCK });
    git(origin, "checkout", "-q", "-b", "fx/side");
    commit("side", "run branch only", { "side.txt": "x" });
    commit("sideFlake", "edits the flake", { "flake.nix": "{ outputs = { self }: { touched = true; }; }\n" });
    git(origin, "checkout", "-q", "main");
    commit("mainMoved", "default branch moves on after the fork", { "later.txt": "x" });
    git(origin, "checkout", "-q", "-b", "fx/lockEdit", sha["side"]!);
    commit("sideLock", "edits the lock", { "flake.lock": JSON.stringify({ nodes: { root: {} }, root: "root", version: 7, edited: true }) });
    git(origin, "checkout", "-q", "--orphan", "fx/orphan");
    commit("orphan", "unrelated history", { "orphan.txt": "x" });
    git(origin, "checkout", "-q", "main");
    commit("submodules", "submodules", { ".gitmodules": '[submodule "x"]\n\tpath = x\n\turl = file:///srv/private/x\n' });
    commit("tip", "tip", { "tip.txt": "x" });

    const stateDir = path.join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    gitPath = createGitPath({ capture, mirrorsRoot: path.join(root, "mirrors"), stateDir, remoteUrl: () => origin });
    job = { repo: { id: "33333333-3333-4333-8333-333333333333", owner: "acme", name: "widgets" }, continues: null, branch_prefix: "fx/", role: "executor" } as unknown as typeof job;
    // the mirror is made by the real path's own prepare, so its HEAD follows the default branch exactly as in production
    const prepared = await gitPath.prepare(job, { runId: "11111111-1111-4111-8111-111111111111", leaseGeneration: 1 }, path.join(root, "workspace"));
    expect(prepared.base).toBe(sha["tip"]);
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("control: a default-branch commit with a flake and a lock gives the flake and its lock text", async () => {
    expect(await gitPath.nixSource!(job, sha["flake"]!)).toMatchObject({ kind: "flake", lock: LOCK });
  });

  it("a commit only on a run branch is built from its merge-base with the default branch, not from the branch tip or the commit itself", async () => {
    const source = await gitPath.nixSource!(job, sha["side"]!);
    expect(source).toMatchObject({ kind: "flake", lock: LOCK, fromDefault: { rev: sha["flake"], flakeChanged: false } });
    // the default branch has moved on since the fork: the tip is never the answer
    expect((source as { fromDefault: { rev: string } }).fromDefault.rev).not.toBe(sha["tip"]);
    expect((source as { fromDefault: { rev: string } }).fromDefault.rev).not.toBe(sha["side"]);
  });

  it("a default-branch commit has no fromDefault: it is used as it is", async () => {
    expect(await gitPath.nixSource!(job, sha["flake"]!)).not.toHaveProperty("fromDefault");
  });

  it("a commit that edits flake.nix or flake.lock against the merge-base says so, and its own lock text is never the one handed on", async () => {
    expect(await gitPath.nixSource!(job, sha["sideFlake"]!)).toMatchObject({ kind: "flake", lock: LOCK, fromDefault: { rev: sha["flake"], flakeChanged: true } });
    expect(await gitPath.nixSource!(job, sha["sideLock"]!)).toMatchObject({ kind: "flake", lock: LOCK, fromDefault: { rev: sha["flake"], flakeChanged: true } });
  });

  it("unrelated history has no merge-base and keeps the skip", async () => {
    expect(await gitPath.nixSource!(job, sha["orphan"]!)).toEqual({ kind: "not_default_branch" });
  });

  it("an unknown commit and a value that is not a full commit id are not the default branch", async () => {
    expect(await gitPath.nixSource!(job, "f".repeat(40))).toEqual({ kind: "not_default_branch" });
    expect(await gitPath.nixSource!(job, "main")).toEqual({ kind: "not_default_branch" });
    expect(await gitPath.nixSource!(job, "HEAD")).toEqual({ kind: "not_default_branch" });
  });

  it("a default-branch commit with no flake.nix has no flake", async () => {
    expect(await gitPath.nixSource!(job, sha["noFlake"]!)).toEqual({ kind: "no_flake" });
  });

  it("a flake without a flake.lock gives a null lock", async () => {
    expect(await gitPath.nixSource!(job, sha["noLock"]!)).toMatchObject({ kind: "flake", lock: null });
  });

  it("a repo with a .gitmodules file is refused whatever the flake says", async () => {
    expect(await gitPath.nixSource!(job, sha["submodules"]!)).toEqual({ kind: "submodules" });
    expect(await gitPath.nixSource!(job, sha["tip"]!)).toEqual({ kind: "submodules" });
  });
});
