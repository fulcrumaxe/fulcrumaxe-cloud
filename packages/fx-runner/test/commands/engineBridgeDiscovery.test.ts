import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveRegistration } from "../../src/config.js";
import { BRIDGE_SETTINGS_FILE, loadBridgeSettings, saveBridgeSettings } from "../../src/engineBridge/settings.js";
import { realOps, type DiscoveryOps } from "../../src/engineBridge/discover.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";

const uid = process.getuid?.();
let root: string;
let state: string;
let home: string;
let cmds: FakeCommands;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-onbr1-cli-"));
  state = path.join(root, "state");
  home = path.join(root, "home");
  for (const d of [state, home]) mkdirSync(d, { mode: 0o700 });
  cmds = await startFakeCommands();
  const key = generateRunnerKey();
  cmds.trust(key.publicJwk);
  saveRunnerKey(state, key);
  saveRegistration(state, { version: 1, cloud_origin: cmds.origin, runner_id: cmds.runnerId, account_id: cmds.runnerId, credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
  cmds.allowedRepos = [{ repo_gh_id: 77, full_name: "acme/widgets" }];
  out = [];
  err = [];
});
afterEach(async () => {
  await cmds.close();
  rmSync(root, { recursive: true, force: true });
});

interface Extra {
  searchRoots?: string;
  ops?: DiscoveryOps;
  env?: string;
}
const cli = (extra: Extra, ...argv: string[]): Promise<number> =>
  runCli({
    argv,
    home,
    stateDirOverride: state,
    engineStateDirOverride: extra.env,
    engineDiscovery: { cwd: undefined, searchRoots: extra.searchRoots, ops: extra.ops },
    uid,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    fetchFn: fetch,
    now: () => new Date(),
  });
const saved = () => {
  const l = loadBridgeSettings(state);
  return l.ok ? l.repos : undefined;
};
const settingsText = () => {
  try {
    return readFileSync(path.join(state, BRIDGE_SETTINGS_FILE), "utf8");
  } catch {
    return null;
  }
};
const all = () => out.join("") + err.join("");

/** A coldstarted clone with its own state directory made (the engine makes it, never the runner). */
function checkout(dir: string, project: Record<string, unknown> | string = { project_name: "widgets" }, remote = "git@github.com:acme/widgets.git"): string {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  mkdirSync(path.join(dir, ".autonomous-team"), { recursive: true });
  writeFileSync(path.join(dir, ".autonomous-team", "project.json"), typeof project === "string" ? project : JSON.stringify(project));
  mkdirSync(path.join(dir, "engine"), { recursive: true });
  writeFileSync(path.join(dir, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }));
  return dir;
}
const stateOf = (name: string): string => {
  const d = path.join(root, `eng-${name}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

describe("engine-bridge enable with only --repo (D ON-BR-1)", () => {
  it("item 3 and 4: one clone ends with the same settings entry as the explicit flags, and prints the root and state dir it chose", async () => {
    const eng = stateOf("a");
    const dir = checkout(path.join(home, "code", "widgets"), { project_name: "widgets", state_dir: eng });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
    const viaDiscovery = saved();
    expect(viaDiscovery).toEqual([{ repo_gh_id: 77, full_name: "acme/widgets", state_dir: eng, repo_root: dir }]);
    expect(all()).toContain(dir);
    expect(all()).toContain(eng);
    expect(all()).toContain("disable --repo acme/widgets");
    expect(await cli({}, "engine-bridge", "disable", "--repo", "acme/widgets")).toBe(0);
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets", "--repo-root", dir, "--state-dir", eng)).toBe(0);
    expect(saved()).toEqual(viaDiscovery);
  });

  it("item 4: the state dir is $HOME/.<project_name>-state when the file gives only a name, and never the runner's default", async () => {
    const named = path.join(home, ".widgets-state");
    mkdirSync(named, { mode: 0o700 });
    checkout(path.join(home, "code", "widgets"), { project_name: "widgets" });
    expect(await cli({ env: path.join(root, "env-state") }, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
    expect(saved()![0]!.state_dir).toBe(named);
    expect(saved()![0]!.state_dir).not.toContain(".autonomous-forever-state");
  });

  it("item 4: the project file's state_dir wins over the name", async () => {
    const eng = stateOf("b");
    mkdirSync(path.join(home, ".widgets-state"), { mode: 0o700 });
    checkout(path.join(home, "code", "widgets"), { project_name: "widgets", state_dir: eng });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
    expect(saved()![0]!.state_dir).toBe(eng);
  });

  it("item 5: none found exits 2 with checkout_not_found, lists the roots, says to give --repo-root and writes nothing", async () => {
    mkdirSync(path.join(home, "code"));
    checkout(path.join(home, "code", "other"), { project_name: "other" }, "git@github.com:acme/other.git");
    const before = settingsText();
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    const text = err.join("");
    expect(text).toContain("checkout_not_found");
    expect(text).toContain(path.join(home, "code"));
    expect(text).toContain("--repo-root <path>");
    expect(text).not.toMatch(/undefined|null/);
    expect(settingsText()).toBe(before);
    expect(saved()).toEqual([]);
  });

  it.each([
    ["no project file", null],
    ["a project file that is not JSON", "{broken"],
    ["a project file over 64 KiB", JSON.stringify({ project_name: "widgets", pad: "x".repeat(70 * 1024) })],
    ["a project file with neither name nor state_dir", JSON.stringify({ other: true })],
  ])("item 6: a clone with %s is refused checkout_layout_unexpected with its path, and nothing is written", async (_label, project) => {
    const dir = path.join(home, "code", "widgets");
    checkout(dir, project ?? {});
    if (project === null) rmSync(path.join(dir, ".autonomous-team"), { recursive: true });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain("checkout_layout_unexpected");
    expect(err.join("")).toContain(dir);
    expect(settingsText()).toBeNull();
  });

  it("item 6: a dirty working tree is accepted", async () => {
    const eng = stateOf("c");
    const dir = checkout(path.join(home, "code", "widgets"), { state_dir: eng });
    writeFileSync(path.join(dir, "uncommitted.txt"), "work in progress");
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
  });

  it.each([2, 12])("item 7: %i clones is checkout_ambiguous, listed (at most 10), with no tie-break, and nothing is written", async (n) => {
    for (let i = 0; i < n; i++) checkout(path.join(home, "code", `w${String(i).padStart(2, "0")}`), { project_name: `w${i}` });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    const text = err.join("");
    expect(text).toContain("checkout_ambiguous");
    expect(text).toContain("run again with --repo-root <one of these>");
    expect(text).toContain(path.join(home, "code", "w00"));
    if (n === 12) {
      expect(text).toContain("and 2 more");
      expect(text).not.toContain(path.join(home, "code", "w11"));
    } else {
      expect(text).not.toContain("more");
    }
    expect(settingsText()).toBeNull();
  });

  it("item 8: a state dir that is missing or is a plain file is refused with its path, and the runner creates nothing", async () => {
    const eng = path.join(root, "never-made");
    checkout(path.join(home, "code", "widgets"), { state_dir: eng });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain(`state_dir_missing: ${eng}`);
    expect(() => readFileSync(eng)).toThrow(/ENOENT/);
    err.length = 0;
    writeFileSync(eng, "a file");
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain(`state_dir_unreadable: ${eng}`);
    expect(settingsText()).toBeNull();
  });

  it.skipIf(uid === 0)("item 8: a state dir this user cannot read is refused state_dir_unreadable", async () => {
    const eng = stateOf("d");
    checkout(path.join(home, "code", "widgets"), { state_dir: eng });
    chmodSync(eng, 0o000);
    try {
      expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
      expect(err.join("")).toContain("state_dir_unreadable");
    } finally {
      chmodSync(eng, 0o700);
    }
  });

  it("item 8: the existing shared and reserved refusals still apply to a discovered pair", async () => {
    const eng = stateOf("e");
    saveBridgeSettings(state, [{ repo_gh_id: 99, full_name: "acme/gadgets", state_dir: eng, repo_root: path.join(root, "gadgets") }]);
    const dir = checkout(path.join(home, "code", "widgets"), { state_dir: eng });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain("already belongs to another bridged repo");
    err.length = 0;
    writeFileSync(path.join(dir, ".autonomous-team", "project.json"), JSON.stringify({ state_dir: path.join(dir, "inside") }));
    mkdirSync(path.join(dir, "inside"), { mode: 0o700 });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain("the runner's own state directory or the repository root");
    err.length = 0;
    writeFileSync(path.join(dir, ".autonomous-team", "project.json"), JSON.stringify({ state_dir: state }));
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain("the runner's own state directory or the repository root");
    expect(saved()).toHaveLength(1);
  });

  it("item 9: --repo-root skips the scan entirely (no directory is listed) and still takes the state dir from that root's project file", async () => {
    const eng = stateOf("f");
    const dir = checkout(path.join(home, "code", "widgets"), { state_dir: eng });
    const listed: string[] = [];
    const spy: DiscoveryOps = { readDir: (d) => (listed.push(d), realOps.readDir(d)) };
    expect(await cli({ ops: spy }, "engine-bridge", "enable", "--repo", "acme/widgets", "--repo-root", dir)).toBe(0);
    expect(listed).toEqual([]);
    expect(saved()![0]).toMatchObject({ repo_root: dir, state_dir: eng });
  });

  it("item 9: --state-dir alone fills only the state half; the scan still finds the root and the convention is not read", async () => {
    const mine = path.join(root, "mine");
    const dir = checkout(path.join(home, "code", "widgets"), { state_dir: path.join(root, "never-made") });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets", "--state-dir", mine)).toBe(0);
    expect(saved()![0]).toMatchObject({ repo_root: dir, state_dir: mine });
  });

  it("item 9: flags give the old answer when the root has no usable project file (the engine's environment variable, then its default)", async () => {
    const dir = path.join(root, "plain");
    mkdirSync(path.join(dir, "engine"), { recursive: true });
    writeFileSync(path.join(dir, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }));
    const env = path.join(root, "env-state");
    expect(await cli({ env }, "engine-bridge", "enable", "--repo", "acme/widgets", "--repo-root", dir)).toBe(0);
    expect(saved()![0]!.state_dir).toBe(env);
  });

  it("item 10: a symlink to another tree and a symlink loop are ignored without error, and a clone only reachable through them is not found", async () => {
    const outside = checkout(path.join(root, "outside", "widgets"), { project_name: "widgets" });
    mkdirSync(path.join(home, "code"), { recursive: true });
    symlinkSync(path.dirname(outside), path.join(home, "code", "escape"));
    symlinkSync("/etc", path.join(home, "code", "etc"));
    symlinkSync(path.join(home, "code"), path.join(home, "code", "loop"));
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain("checkout_not_found");
    expect(settingsText()).toBeNull();
  });

  it("item 10: userinfo in a remote is matched on host, owner and name and never printed or stored", async () => {
    const eng = stateOf("g");
    checkout(path.join(home, "code", "widgets"), { state_dir: eng }, "https://someone:SENTINEL-TOKEN-91@github.com/acme/widgets.git");
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
    expect(all()).not.toContain("SENTINEL-TOKEN-91");
    expect(all()).not.toContain("someone");
    expect(readFileSync(path.join(state, BRIDGE_SETTINGS_FILE), "utf8")).not.toContain("SENTINEL");
  });

  it.each([
    ["a relative state_dir", { project_name: "widgets", state_dir: "relative/state" }],
    ["a state_dir with ..", { project_name: "widgets", state_dir: "/fictional/x/../y" }],
  ])("item 10: a project file with %s is refused", async (_label, project) => {
    checkout(path.join(home, "code", "widgets"), project);
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("")).toContain("checkout_layout_unexpected");
    expect(settingsText()).toBeNull();
  });

  it("item 1: a search stopped by its entry limit says so and does not claim the search was complete", async () => {
    mkdirSync(path.join(home, "code"));
    let first = true;
    const flood: DiscoveryOps = {
      readDir: () => {
        if (!first) return [];
        first = false;
        return Array.from({ length: 25000 }, (_, i) => ({ name: `n${i}`, isDirectory: false }));
      },
    };
    expect(await cli({ ops: flood }, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    expect(err.join("") + out.join("")).toContain("20000 entry limit");
    expect(err.join("")).toContain("may be incomplete");
  });

  it("item 1: FX_RUNNER_SEARCH_ROOTS adds a root, and a relative entry is ignored with one printed line", async () => {
    const extra = path.join(root, "elsewhere");
    const eng = stateOf("h");
    const dir = checkout(path.join(extra, "widgets"), { state_dir: eng });
    expect(await cli({ searchRoots: `relative/path:${extra}` }, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
    expect(saved()![0]!.repo_root).toBe(dir);
    expect(out.join("").match(/Ignored 1 entry of FX_RUNNER_SEARCH_ROOTS/g)).toHaveLength(1);
  });

  it("lists up to 10 skipped directories with both remedies when a group-writable checkout is the only candidate", async () => {
    const dirs = Array.from({ length: 12 }, (_, i) => checkout(path.join(home, "code", `w${String(i).padStart(2, "0")}`), { project_name: `w${i}` }));
    for (const d of dirs) chmodSync(d, 0o775);
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(2);
    const text = err.join("");
    expect(text).toContain("chmod go-w <path>");
    expect(text).toContain("--repo-root <path>");
    expect(text.split(path.join(home, "code", "w")).length - 1).toBe(10);
    expect(text).toContain("and 2 more");
    expect(settingsText()).toBeNull();
  });

  it("item 11: discovery needs no cloud call beyond the one allowed-repos ask", async () => {
    const eng = stateOf("i");
    checkout(path.join(home, "code", "widgets"), { state_dir: eng });
    expect(await cli({}, "engine-bridge", "enable", "--repo", "acme/widgets")).toBe(0);
    expect(cmds.pulls).toHaveLength(1);
  });

  it("a repo the cloud does not list is refused before any scan", async () => {
    const listed: string[] = [];
    const spy: DiscoveryOps = { readDir: (d) => (listed.push(d), realOps.readDir(d)) };
    expect(await cli({ ops: spy }, "engine-bridge", "enable", "--repo", "acme/unpaired")).toBe(2);
    expect(listed).toEqual([]);
  });
});
