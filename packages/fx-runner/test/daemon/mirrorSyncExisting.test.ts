/**
 * D#6 PUBLIC-MERGE PR3: `mirrors.syncExisting`, the only mirror access a merge order has. The repo it is given comes from an unsigned cloud reply, so it may only
 * fetch a mirror that a verified job already made, whose origin is exactly this runner's own address for the owner and name. Real git, real local remotes; every git
 * command is recorded so "never cloned, never wrote config, never fetched" is read off the log, and the mirror's config is compared before and after.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, type GitCapture } from "../../src/daemon/git.js";
import { createMirrors, type Mirrors, type RepoRef } from "../../src/daemon/mirror.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let root: string;
let home: string;
let commands: string[][];
const ENV = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
const sh = (...args: string[]): string => execFileSync("git", args, { env: ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repo: RepoRef = { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner: "acme", name: "alpha" };
const stranger: RepoRef = { id: "33333333-cccc-4ccc-8ccc-cccccccccccc", owner: "acme", name: "gamma" };
let remoteUrl = "";
let seed = "";
let bare = "";

const capture: GitCapture = async (command, args, env, timeoutMs) => {
  commands.push([...args]);
  return runCapture(spawn, testLaunch(), command, args, { ...env, ...ENV() }, timeoutMs);
};
const mirrorsRoot = (): string => path.join(root, "cache", "fx-runner", "mirrors");
const mirrors = (): Mirrors => createMirrors({ git: createGit({ capture }), mirrorsRoot: mirrorsRoot(), stateDir: path.join(root, "state"), remoteUrl: (r) => (r.id === repo.id ? remoteUrl : `https://github.com/${r.owner}/${r.name}.git`) });
const configOf = (dir: string): string => readFileSync(path.join(dir, "config"), "utf8");
const verbs = (): string[] => commands.map((c) => c.filter((a) => !a.startsWith("-") && a !== path.join(mirrorsRoot(), `${repo.id}.git`))[0] ?? "");

function advance(name: string): string {
  writeFileSync(path.join(seed, `${name}.txt`), `${name}\n`);
  sh("-C", seed, "add", `${name}.txt`);
  sh("-C", seed, "commit", "-m", name);
  sh("-C", seed, "push", bare, "main");
  return sh("-C", seed, "rev-parse", "HEAD").trim();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-mirrorex-"));
  home = path.join(root, "home");
  mkdirSync(home);
  mkdirSync(path.join(root, "state"));
  commands = [];
  bare = path.join(root, "alpha-remote.git");
  seed = path.join(root, "alpha-seed");
  sh("init", "--bare", "-b", "main", bare);
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "alpha\n");
  sh("-C", seed, "add", "README.md");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", bare, "main");
  remoteUrl = pathToFileURL(bare).href;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("syncExisting", () => {
  it("fetches a mirror a job already made, and does nothing but read its origin and fetch", async () => {
    const m = mirrors();
    const { dir } = await m.sync(repo);
    const tip = advance("second");
    const before = configOf(dir);
    commands = [];
    expect(await m.syncExisting(repo)).toEqual({ dir });
    expect(sh("-C", dir, "rev-parse", "refs/heads/main").trim()).toBe(tip);
    expect(verbs()).toEqual(["config", "fetch"]);
    expect(commands[0]).toEqual(expect.arrayContaining(["--get", "remote.origin.url"]));
    expect(configOf(dir)).toBe(before);
  });

  it("a repo with no mirror: refused with nothing cloned, no config written, nothing fetched, nothing created", async () => {
    const m = mirrors();
    await m.sync(repo);
    commands = [];
    await expect(m.syncExisting(stranger)).rejects.toMatchObject({ code: "mirror_failed" });
    expect(commands).toEqual([]);
    expect(() => readFileSync(path.join(mirrorsRoot(), `${stranger.id}.git`, "config"))).toThrow();
  });

  it("an empty mirrors directory too: nothing is made", async () => {
    await expect(mirrors().syncExisting(repo)).rejects.toMatchObject({ code: "mirror_failed" });
    expect(commands).toEqual([]);
  });

  it("a mirror whose origin is another address (the owner and name the reply names are not the ones it was made for): refused, untouched, not fetched", async () => {
    const m = mirrors();
    const { dir } = await m.sync(repo);
    sh("-C", dir, "config", "remote.origin.url", "https://github.com/acme/elsewhere.git");
    const before = configOf(dir);
    commands = [];
    await expect(m.syncExisting(repo)).rejects.toMatchObject({ code: "mirror_failed" });
    expect(verbs()).toEqual(["config"]);
    expect(commands.some((c) => c.includes("fetch") || c.includes("clone"))).toBe(false);
    expect(configOf(dir)).toBe(before);
  });

  it("the same id named with another owner or name: the expected address differs from the recorded one, so it is refused untouched", async () => {
    const m = createMirrors({ git: createGit({ capture }), mirrorsRoot: mirrorsRoot(), stateDir: path.join(root, "state"), remoteUrl: (r) => (r.id === repo.id && r.owner === "acme" ? remoteUrl : `https://github.com/${r.owner}/${r.name}.git`) });
    const { dir } = await m.sync(repo);
    const before = configOf(dir);
    commands = [];
    await expect(m.syncExisting({ ...repo, owner: "evil" })).rejects.toMatchObject({ code: "mirror_failed" });
    expect(commands.some((c) => c.includes("fetch") || c.includes("clone"))).toBe(false);
    expect(configOf(dir)).toBe(before);
  });

  it("a mirror directory that is a link, and a mirror that borrows objects, are refused before any git command", async () => {
    const m = mirrors();
    const { dir } = await m.sync(repo);
    commands = [];
    writeFileSync(path.join(dir, "objects", "info", "alternates"), "/somewhere/else/objects\n");
    await expect(m.syncExisting(repo)).rejects.toMatchObject({ code: "mirror_failed" });
    rmSync(path.join(dir, "objects", "info", "alternates"));
    const moved = `${dir}.moved`;
    renameSync(dir, moved);
    symlinkSync(moved, dir);
    await expect(m.syncExisting(repo)).rejects.toMatchObject({ code: "mirror_failed" });
    expect(commands).toEqual([]);
  });
});
