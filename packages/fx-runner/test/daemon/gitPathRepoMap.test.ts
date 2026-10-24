import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

/**
 * D#600 CX-3b: `GitPath.repoMap` over a real mirror made by the real git path: the map is of the commit the workspace was made from, it reads the
 * mirror (not the workspace the agent can write), and the large capture is what lets a big tree through.
 */
let root: string;
let home: string;
let remoteUrl: string;
const ENV = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
const sh = (...args: string[]): string => execFileSync("git", args, { env: ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const job = (): GitJob => ({ repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor" });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-gpmap-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  const remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  mkdirSync(path.join(seed, "src"));
  writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "widgets", scripts: { test: "vitest run" } }));
  writeFileSync(path.join(seed, "src", "index.ts"), "export {};\n");
  sh("-C", seed, "add", "-A");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", remote, "main");
  remoteUrl = pathToFileURL(remote).href;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const capture = (max?: number): GitCapture => (command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, max, 2048);
const makeGitPath = (large: boolean) =>
  createGitPath({ platform: "linux", capture: capture(), ...(large ? { captureLarge: capture(8 * 1024 * 1024) } : {}), mirrorsRoot: path.join(root, "cache", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: () => remoteUrl });

describe("GitPath.repoMap over a real mirror (D#600 CX-3b)", () => {
  it("is the map of the commit the workspace starts from, with the test command and the manifest, read from the mirror", async () => {
    for (const large of [true, false]) {
      const git = makeGitPath(large);
      const j = job();
      const workspace = path.join(root, "work", `w-${large}`);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const { base } = await git.prepare(j, lease, workspace);
      // The agent writes into its workspace; the map is read from the mirror and does not see it.
      writeFileSync(path.join(workspace, "agent-wrote-this.txt"), "x\n");
      const map = await git.repoMap!(j, base);
      expect(map!.version).toBe("1");
      expect(map!.text.split("\n")).toEqual([`commit: ${base.slice(0, 12)}`, "test command: npm test", "package manifests:", "package.json: name=widgets; scripts: test=vitest run", "files:", "package.json", "src/index.ts"]);
    }
  });

  it("is null for a commit the mirror does not hold, and for a repo that has no mirror yet", async () => {
    const git = makeGitPath(true);
    const j = job();
    const workspace = path.join(root, "work", "w");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    await git.prepare(j, lease, workspace);
    expect(await git.repoMap!(j, "d".repeat(40))).toBeNull();
    expect(await git.repoMap!(job(), "d".repeat(40))).toBeNull();
  });
});
