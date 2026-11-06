import { execFileSync, spawn } from "node:child_process";
import { pinFixture } from "../helpers/pinFixture.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangedFiles } from "../../src/daemon/checkStep.js";
import { lockfileSyncFor } from "../../src/commands/run.js";
import { PM_ON_FAIL_FLAG } from "../../src/daemon/depsInstall.js";
import { createLockfileSync, LOCK_SYNC_SETTINGS, lockSyncArgs, type LockSyncOutcome } from "../../src/daemon/lockfileSync.js";
import { prepareCheckHome } from "../../src/sandbox/checkHome.js";
import { runCapture, runInstall } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

/**
 * D#6 BUILD-LOCKFILE-ON-DEP-ADD: the runner's offline lockfile update, on a real pnpm, a real git repository and the real process-group capture. The fixture is a
 * small pnpm workspace (root, `a`, `b`) with a lockfile pnpm itself wrote, committed as the job's start commit. What cannot be faked faithfully here: a registry. The
 * "needs the network" case runs with no network access at all, which is what the runner's offline mode is for; pnpm's own refusal is the contract under test.
 */
let root: string;
let ws: string;
let scratch: string;
let base: string;
const git = (...args: string[]): string => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
const put = (rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), text);
};
const read = (rel: string): string => readFileSync(path.join(ws, rel), "utf8");
const pkg = (name: string, deps: Record<string, string> = {}, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, version: "1.0.0", ...(Object.keys(deps).length === 0 ? {} : { dependencies: deps }), ...extra }, null, 2);

/** pnpm as the tests drive it: a clean environment, nothing from the machine's own settings, offline, no scripts. */
function pnpm(args: string[]): { code: number | null; out: string } {
  const home = path.join(scratch, "test-home");
  mkdirSync(home, { recursive: true });
  const r = spawnSyncPnpm(args, home);
  return r;
}
function spawnSyncPnpm(args: string[], home: string): { code: number | null; out: string } {
  try {
    const out = execFileSync("pnpm", [...args, "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false", `--config.store-dir=${path.join(scratch, "test-store")}`], { cwd: ws, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? null, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fx-locksync-test-"));
  ws = path.join(root, "ws");
  scratch = path.join(root, "scratch");
  mkdirSync(ws);
  mkdirSync(scratch);
  git("init", "-q", "-b", "main");
  put("pnpm-workspace.yaml", "packages:\n  - a\n  - b\n");
  put("package.json", pkg("root", {}, { private: true }));
  put("a/package.json", pkg("@x/a"));
  put("b/package.json", pkg("@x/b"));
  put("a/index.js", "module.exports = 1;\n");
  expect(pnpm(["install", "--lockfile-only", "--offline"]).code).toBe(0);
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  base = git("rev-parse", "HEAD");
  pinFixture(ws);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function subject(over: { calls?: string[]; said?: string[]; timeoutMs?: number; capture?: Parameters<typeof createLockfileSync>[0]["capture"]; changedFiles?: () => Promise<string[] | null> } = {}) {
  const said = over.said ?? [];
  const gitCapture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048);
  const real: typeof runInstall extends (s: never, ...rest: infer R) => infer T ? (...a: R) => T : never = (command, args, env, cwd, timeoutMs, tail, signal, feed) => (over.calls?.push(command), runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed));
  const sync = createLockfileSync({ capture: over.capture ?? real, envOptions: {}, changedFiles: over.changedFiles ?? createChangedFiles(gitCapture, {}), say: (line) => said.push(line), scratchRoot: scratch, ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }) });
  return { said, run: (signal?: AbortSignal): Promise<LockSyncOutcome> => sync.run({ workspace: ws, base, ...(signal === undefined ? {} : { signal }) }) };
}

describe("a change that adds a dependency on another workspace package", () => {
  it("fails the frozen install before the update, and passes it after: the lockfile now matches the manifests", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const stale = pnpm(["install", "--frozen-lockfile", "--offline"]);
    expect(stale.code).not.toBe(0);
    expect(stale.out).toMatch(/ERR_PNPM_OUTDATED_LOCKFILE|dependencies were added/);

    chmodSync(path.join(ws, "pnpm-lock.yaml"), 0o640);
    const calls: string[] = [];
    const r = subject({ calls });
    expect(await r.run()).toEqual({ kind: "updated" });
    expect(statSync(path.join(ws, "pnpm-lock.yaml")).mode & 0o777).toBe(0o640);
    expect(calls).toHaveLength(1);
    expect(read("pnpm-lock.yaml")).toContain("'@x/b':");
    expect(read("pnpm-lock.yaml")).toContain("link:../b");
    expect(r.said).toEqual(["fx-runner: lockfile updated to match the changed manifests (lockfile_sync_updated)"]);

    // Only the lockfile was written: no node_modules, no scratch left behind, nothing else changed in the repo but the manifest.
    expect(existsSync(path.join(ws, "node_modules"))).toBe(false);
    expect(git("status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["M a/package.json", "M pnpm-lock.yaml"]);
    expect(readdirSync(scratch).filter((n) => n.startsWith("fx-locksync-"))).toEqual([]);
    // The frozen install, exactly as the check runs it, is not weakened and now passes.
    expect(pnpm(["install", "--frozen-lockfile", "--offline"]).code).toBe(0);
  });

  it("a dependency removed again, and a new package added to the workspace, are brought along too", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    expect(await subject().run()).toEqual({ kind: "updated" });
    git("add", "-A");
    git("commit", "-q", "-m", "link");
    base = git("rev-parse", "HEAD");

    put("c/package.json", pkg("@x/c", { "@x/a": "workspace:*" }));
    put("pnpm-workspace.yaml", "packages:\n  - a\n  - b\n  - c\n");
    put("a/package.json", pkg("@x/a"));
    expect(await subject().run()).toEqual({ kind: "updated" });
    const lock = read("pnpm-lock.yaml");
    expect(lock).toContain("  c:");
    expect(lock).not.toContain("link:../b");
    expect(pnpm(["install", "--frozen-lockfile", "--offline"]).code).toBe(0);
  });
});

describe("what is left alone", () => {
  it("no manifest changed: pnpm is not started and the lockfile is not touched", async () => {
    put("a/index.js", "module.exports = 2;\n");
    put("a/new.js", "x\n");
    const before = statSync(path.join(ws, "pnpm-lock.yaml"));
    const calls: string[] = [];
    const r = subject({ calls });
    expect(await r.run()).toEqual({ kind: "none" });
    expect(calls).toEqual([]);
    expect(r.said).toEqual([]);
    const after = statSync(path.join(ws, "pnpm-lock.yaml"));
    expect([after.mtimeMs, after.ino]).toEqual([before.mtimeMs, before.ino]);
  });

  it("a manifest changed in a way the lockfile does not record (a script): pnpm runs and the lockfile stays byte for byte", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", {}, { scripts: { test: "echo ok" } }));
    expect(await subject().run()).toEqual({ kind: "unchanged" });
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a repository with no lockfile, or only the empty stub the agent's sandbox leaves, is not touched", async () => {
    rmSync(path.join(ws, "pnpm-lock.yaml"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const calls: string[] = [];
    expect(await subject({ calls }).run()).toEqual({ kind: "none" });
    put("pnpm-lock.yaml", "");
    expect(await subject({ calls }).run()).toEqual({ kind: "none" });
    expect(calls).toEqual([]);
    expect(read("pnpm-lock.yaml")).toBe("");
  });

  it("a package-lock.json repository is out of scope: nothing runs", async () => {
    rmSync(path.join(ws, "pnpm-lock.yaml"));
    put("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const calls: string[] = [];
    expect(await subject({ calls }).run()).toEqual({ kind: "none" });
    expect(calls).toEqual([]);
  });
});

describe("which changed files count as manifests", () => {
  it("a package.json under node_modules or .git is not the project's manifest: nothing runs", async () => {
    put("node_modules/dep/package.json", pkg("dep", { "@x/b": "workspace:*" }));
    put("vendor/node_modules/dep/package.json", pkg("dep"));
    const calls: string[] = [];
    expect(await subject({ calls }).run()).toEqual({ kind: "none" });
    // Git never lists a path inside .git, so the list is given directly.
    expect(await subject({ calls, changedFiles: async () => ["vendor/.git/package.json", ".git/package.json"] }).run()).toEqual({ kind: "none" });
    expect(calls).toEqual([]);
  });

  it("a deleted package.json is a change: the project leaves the lockfile", async () => {
    expect(read("pnpm-lock.yaml")).toContain("  b: {}");
    rmSync(path.join(ws, "b/package.json"));
    const calls: string[] = [];
    expect(await subject({ calls }).run()).toEqual({ kind: "updated" });
    expect(calls).toHaveLength(1);
    expect(read("pnpm-lock.yaml")).not.toContain("  b: {}");
    expect(pnpm(["install", "--frozen-lockfile", "--offline"]).code).toBe(0);
  });
});

describe("the daemon's wiring (lockfileSyncFor, as run.ts builds the handler's dependencies)", () => {
  const gitCapture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048);
  const installCapture = (command: string, args: readonly string[], env: Record<string, string>, cwd: string, timeoutMs: number, tail: number, signal: AbortSignal | undefined, feed: Buffer | undefined) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed);

  it("with both captures it yields an update that really runs pnpm on the workspace and brings the lockfile along", async () => {
    const said: string[] = [];
    const wired = lockfileSyncFor({ installCapture, captureLarge: gitCapture }, {}, (line) => said.push(line), scratch);
    expect(wired.lockfileSync).toBeDefined();
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    expect(await wired.lockfileSync!.run({ workspace: ws, base })).toEqual({ kind: "updated" });
    expect(pnpm(["install", "--frozen-lockfile", "--offline"]).code).toBe(0);
    expect(said.some((l) => l.includes("lockfile_sync_updated"))).toBe(true);
  });

  it("without the process-group capture, or without the guarded git listing, it yields nothing", () => {
    expect(lockfileSyncFor({ captureLarge: gitCapture }, {}, () => undefined, scratch)).toEqual({});
    expect(lockfileSyncFor({ installCapture }, {}, () => undefined, scratch)).toEqual({});
    expect(lockfileSyncFor({}, {}, () => undefined, scratch)).toEqual({});
  });
});

describe("a dependency that needs the registry", () => {
  it("fails at once with the closed code needs_network, puts the lockfile back byte for byte and leaves nothing behind", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0" }));
    const r = subject({ timeoutMs: 45_000 });
    const started = Date.now();
    expect(await r.run()).toEqual({ kind: "failed", why: "needs_network" });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(read("pnpm-lock.yaml")).toBe(original);
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toMatch(/^fx-runner: lockfile update failed \(lockfile_sync_failed: needs_network, exit \d+\)/);
    expect(r.said[0]).not.toContain(ws);
    expect(readdirSync(scratch).filter((n) => n.startsWith("fx-locksync-"))).toEqual([]);
  });
});

/**
 * A workspace whose lockfile already lists a registry package, as every real repository's does. pnpm 11 judges such entries against its release-age policy, which needs registry metadata that an
 * offline run does not have (`ERR_PNPM_NO_OFFLINE_META`), so these cases are the ones the empty fixture above could not reach. The runner's per-run settings file turns that one check off.
 */
describe("a lockfile that lists registry packages (the release-age policy needs metadata an offline run does not have)", () => {
  const LEFT_PAD = "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";
  const registryLock = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  a:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n\n  b: {}\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: ${LEFT_PAD}}\n    deprecated: use String.prototype.padStart()\n\nsnapshots:\n\n  left-pad@1.3.0: {}\n`;

  beforeEach(() => {
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0" }));
    put("pnpm-lock.yaml", registryLock);
    git("add", "-A");
    git("commit", "-q", "-m", "registry dependency");
    base = git("rev-parse", "HEAD");
    pinFixture(ws);
  });

  it("without the settings file pnpm stops at the policy check (the failure this row fixed): ERR_PNPM_NO_OFFLINE_META", () => {
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0" }, { description: "changed" }));
    const r = pnpm(["install", "--lockfile-only", "--offline", "--no-frozen-lockfile"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/ERR_PNPM_NO_OFFLINE_META/);
  });

  it("a description change updates (the lockfile is judged without the network) and the registry entry is untouched", async () => {
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0" }, { description: "changed" }));
    const r = subject();
    const outcome = await r.run();
    // A description is not recorded in the lockfile: pnpm ran to the end (no needs_network) and the file is byte for byte the same.
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(r.said).toEqual([]);
    expect(read("pnpm-lock.yaml")).toBe(registryLock);
  });

  it("known limit, unchanged by this row: a change that does alter the lockfile makes pnpm re-resolve the registry entries, which needs their metadata: needs_network, closed", async () => {
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0", "@x/b": "workspace:*" }));
    const r = subject({ timeoutMs: 45_000 });
    expect(await r.run()).toEqual({ kind: "failed", why: "needs_network" });
    expect(r.said[0]).toMatch(/NO_OFFLINE_META\] Failed to resolve left-pad@1\.3\.0/);
    // The policy check itself passed (it is what this row removes as a cause); only the re-resolution of that project is left.
    expect(r.said[0]).toContain("Lockfile passes supply-chain policies");
    expect(read("pnpm-lock.yaml")).toBe(registryLock);
  });

  it("a dependency that really is new still needs the network: needs_network, the lockfile back byte for byte", async () => {
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0", "is-odd": "3.0.1" }));
    const r = subject({ timeoutMs: 45_000 });
    expect(await r.run()).toEqual({ kind: "failed", why: "needs_network" });
    expect(read("pnpm-lock.yaml")).toBe(registryLock);
    expect(r.said[0]).toMatch(/lockfile_sync_failed: needs_network/);
  });

  it("the settings file sits in pnpm's config directory inside the run's own scratch (0600, one key), never in the workspace, and the scratch is removed afterwards", async () => {
    put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0" }, { description: "changed" }));
    const seen: Array<{ file: string; text: string; mode: number; underScratch: boolean }> = [];
    await subject({
      capture: async (_c, _a, env) => {
        const file = path.join(env.XDG_CONFIG_HOME ?? "", "pnpm", "config.yaml");
        seen.push({ file, text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777, underScratch: path.relative(scratch, file).startsWith("fx-locksync-") });
        expect(existsSync(path.join(env.HOME ?? "", ".npmrc"))).toBe(false);
        return { code: 0, timedOut: false, aborted: false, tail: "" };
      },
    }).run();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe("minimumReleaseAge: 0\n");
    expect(seen[0]!.mode).toBe(0o600);
    expect(seen[0]!.underScratch).toBe(true);
    expect(existsSync(path.join(ws, "pnpm", "config.yaml"))).toBe(false);
    expect(git("status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["M a/package.json"]);
    expect(readdirSync(scratch).filter((n) => n.startsWith("fx-locksync-"))).toEqual([]);
  });

  it("the check's home, which shares the settings-file helper, is unchanged: same path, same three keys, 0600", () => {
    const home = prepareCheckHome(scratch, "/the/store");
    const file = path.join(home, ".config", "pnpm", "config.yaml");
    expect(readFileSync(file, "utf8")).toBe('verifyDepsBeforeRun: false\nminimumReleaseAge: 0\nstoreDir: "/the/store"\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(home, ".npmrc"), "utf8")).toBe("");
    expect(readFileSync(path.join(prepareCheckHome(scratch, undefined), ".config", "pnpm", "config.yaml"), "utf8")).toBe("verifyDepsBeforeRun: false\nminimumReleaseAge: 0\n");
  });

  it("the command line still carries --offline and the pinned registry: the relaxation adds no network and no host", () => {
    const args = lockSyncArgs({ registry: "https://registry.npmjs.org/", storeDir: "/s", cacheDir: "/c" });
    expect(args).toContain("--offline");
    expect(args.some((a) => /release-age|trust-policy/i.test(a))).toBe(false);
    expect(LOCK_SYNC_SETTINGS).toEqual(["minimumReleaseAge: 0"]);
  });

  it("a repository that tries to set the policy, the network mode or another registry itself is refused before pnpm starts", async () => {
    const attempts: Array<[string, string]> = [
      ["pnpm-workspace.yaml", "packages:\n  - a\n  - b\nminimumReleaseAge: 10080\n"],
      ["pnpm-workspace.yaml", "packages:\n  - a\n  - b\noffline: false\n"],
      ["pnpm-workspace.yaml", "packages:\n  - a\n  - b\nregistry: https://evil.example/\n"],
      [".npmrc", "minimum-release-age=0\n"],
      [".npmrc", "offline=false\n"],
      [".npmrc", "trust-policy=off\n"],
    ];
    for (const [file, text] of attempts) {
      put("a/package.json", pkg("@x/a", { "left-pad": "1.3.0" }, { description: "changed" }));
      put(file, text);
      const calls: string[] = [];
      expect((await subject({ calls }).run()).kind).toBe("refused");
      expect(calls).toEqual([]);
      if (file === ".npmrc") rmSync(path.join(ws, file));
      else put(file, "packages:\n  - a\n  - b\n");
    }
  });
});

describe("what the update refuses or puts back", () => {
  /** A stand-in pnpm first on PATH, to make pnpm write a lockfile the real one would not. */
  function fakePnpm(body: string): void {
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const file = path.join(bin, "pnpm");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  }

  it("a lockfile pnpm wrote with a dependency from another host is refused and the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm(`cat > pnpm-lock.yaml <<'EOF'\nlockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      evil:\n        specifier: github:evil/evil\n        version: github.com/evil/evil/abc\nEOF`);
    const r = subject();
    const outcome = await r.run();
    expect(outcome).toMatchObject({ kind: "refused", check: "lockfile_after_content" });
    expect(read("pnpm-lock.yaml")).toBe(original);
    expect(r.said[0]).toMatch(/^fx-runner: lockfile update refused \(lockfile_sync_refused: /);
  });

  it("a pnpm that leaves a partial file and fails: the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    chmodSync(path.join(ws, "pnpm-lock.yaml"), 0o640);
    fakePnpm("echo half > pnpm-lock.yaml; exit 3");
    const r = subject();
    expect(await r.run()).toEqual({ kind: "failed", why: "exit" });
    expect(read("pnpm-lock.yaml")).toBe(original);
    expect(statSync(path.join(ws, "pnpm-lock.yaml")).mode & 0o777).toBe(0o640);
    expect(existsSync(path.join(ws, "pnpm-lock.yaml.fx-tmp"))).toBe(false);
  });

  it("a stuck pnpm is ended at the time limit and the lockfile is as it was", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm("echo half > pnpm-lock.yaml; exec sleep 60");
    expect(await subject({ timeoutMs: 400 }).run()).toEqual({ kind: "failed", why: "timeout" });
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a stop from the daemon ends it too", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm("exec sleep 60");
    const stop = new AbortController();
    const pending = subject().run(stop.signal);
    setTimeout(() => stop.abort(), 300);
    expect(await pending).toEqual({ kind: "failed", why: "aborted" });
  });

  it("a changed manifest that is a link, or sits behind one, is refused and pnpm never starts", async () => {
    const calls: string[] = [];
    rmSync(path.join(ws, "b/package.json"));
    symlinkSync("../a/package.json", path.join(ws, "b/package.json"));
    expect(await subject({ calls }).run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "changed_manifest_not_file" });
    expect(calls).toEqual([]);
  });

  it("a project directory the change added as a link to a directory outside the workspace is refused before pnpm starts, and nothing behind it is read", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "package.json"), pkg("@evil/outside"));
    mkdirSync(path.join(ws, "packages"));
    symlinkSync(outside, path.join(ws, "packages/x"));
    put("pnpm-workspace.yaml", "packages:\n  - a\n  - b\n  - packages/*\n");
    put("package.json", pkg("root", { "@evil/outside": "workspace:*" }, { private: true }));
    const original = read("pnpm-lock.yaml");
    const calls: string[] = [];
    const r = subject({ calls });
    expect(await r.run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "linked_project_dir" });
    expect(calls).toEqual([]);
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a package.json that is a link inside a real directory git ignores is refused before pnpm starts (git never lists it, so the changed-file list cannot see it)", async () => {
    const outsideFile = path.join(root, "outside-package.json");
    writeFileSync(outsideFile, pkg("@evil/b", { "left-pad": "1.3.0" }));
    put(".gitignore", "packages/b/\n");
    put("pnpm-workspace.yaml", "packages:\n  - a\n  - packages/*\n");
    mkdirSync(path.join(ws, "packages/b"), { recursive: true });
    symlinkSync(outsideFile, path.join(ws, "packages/b/package.json"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    expect(git("status", "--porcelain", "--", "packages")).toBe("");
    const original = read("pnpm-lock.yaml");
    const calls: string[] = [];
    expect(await subject({ calls }).run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "linked_pnpm_file" });
    expect(calls).toEqual([]);
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a linked package.yaml beside a regular package.json is refused before pnpm starts (pnpm reads that manifest too)", async () => {
    const outsideFile = path.join(root, "outside-package.yaml");
    writeFileSync(outsideFile, "name: '@evil/a'\ndependencies:\n  left-pad: 1.3.0\n");
    symlinkSync(outsideFile, path.join(ws, "a/package.yaml"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const original = read("pnpm-lock.yaml");
    const calls: string[] = [];
    expect(await subject({ calls }).run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "changed_manifest_not_file" });
    expect(calls).toEqual([]);
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a plain package.json5 or package.yaml next to the real package.json is refused too: this product uses package.json only", async () => {
    for (const name of ["package.json5", "package.yaml"]) {
      put(`a/${name}`, name === "package.yaml" ? "name: '@x/a'\n" : "{ name: '@x/a' }\n");
      put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
      const calls: string[] = [];
      expect(await subject({ calls }).run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "other_manifest_format" });
      expect(calls).toEqual([]);
      rmSync(path.join(ws, `a/${name}`));
    }
  });

  it("an importer with a manifest of another format that is a link or not a file is refused after pnpm wrote the lockfile", async () => {
    const original = read("pnpm-lock.yaml");
    const outsideFile = path.join(root, "outside-package.yaml");
    writeFileSync(outsideFile, "name: x\n");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm(`ln -s ${outsideFile} b/package.yaml\ncat > pnpm-lock.yaml <<'EOF'\nlockfileVersion: '9.0'\nimporters:\n  b: {}\nEOF`);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "importer_manifest" });
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a link named pnpm-workspace.yaml or .npmrc below the root is refused the same way", async () => {
    for (const name of ["pnpm-workspace.yaml", ".npmrc"]) {
      const target = path.join(root, `outside-${name}`);
      writeFileSync(target, "x: 1\n");
      symlinkSync(target, path.join(ws, "a", name));
      put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
      expect(await subject().run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: name === "pnpm-workspace.yaml" ? "changed_manifest_not_file" : "linked_pnpm_file" });
      rmSync(path.join(ws, "a", name));
    }
  });

  it("an importer whose package.json is a link in the lockfile pnpm wrote is refused and the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    // Reached after the walk: the link is made by the stand-in pnpm itself, as a process that outlived the walk could.
    const outsideFile = path.join(root, "outside-package.json");
    writeFileSync(outsideFile, pkg("@evil/b"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm(`rm b/package.json; ln -s ${outsideFile} b/package.json\ncat > pnpm-lock.yaml <<'EOF'\nlockfileVersion: '9.0'\nimporters:\n  b: {}\nEOF`);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "importer_manifest" });
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a link to a directory with no manifest is not a project and does not stop the update", async () => {
    const docs = path.join(root, "docs");
    mkdirSync(docs);
    symlinkSync(docs, path.join(ws, "docs"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    expect(await subject().run()).toEqual({ kind: "updated" });
  });

  it("a lockfile whose link: target runs through a link (or leaves the workspace) is refused after pnpm wrote it, and the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    const docs = path.join(root, "docs");
    mkdirSync(docs);
    symlinkSync(docs, path.join(ws, "docs"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    for (const target of ["../docs", "../../outside"]) {
      fakePnpm(`cat > pnpm-lock.yaml <<'EOF'\nlockfileVersion: '9.0'\nimporters:\n  a:\n    dependencies:\n      '@x/b':\n        specifier: link:${target}\n        version: link:${target}\nEOF`);
      const outcome = await subject().run();
      expect(outcome).toEqual(target === "../docs" ? { kind: "refused", reason: "workspace_unsafe", check: "new_project_path" } : { kind: "refused", reason: "unsafe_dependency", check: "lockfile_after_content" });
      expect(read("pnpm-lock.yaml")).toBe(original);
    }
  });

  it("a lockfile pnpm wrote with an importer that runs through a link is refused with check new_project_path, and the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    const docs = path.join(root, "docs");
    mkdirSync(docs);
    symlinkSync(docs, path.join(ws, "docs"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm(`cat > pnpm-lock.yaml <<'EOF'\nlockfileVersion: '9.0'\nimporters:\n  docs: {}\nEOF`);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "new_project_path" });
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a lockfile that is a link is refused with check lockfile_read before anything else is looked at", async () => {
    const target = path.join(root, "elsewhere.yaml");
    writeFileSync(target, read("pnpm-lock.yaml"));
    rmSync(path.join(ws, "pnpm-lock.yaml"));
    symlinkSync(target, path.join(ws, "pnpm-lock.yaml"));
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    expect(await subject().run()).toEqual({ kind: "refused", reason: "lockfile_not_regular", check: "lockfile_read" });
  });

  it("a pnpm that leaves a link where the lockfile was is refused with check lockfile_after, and the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    const target = path.join(root, "elsewhere.yaml");
    writeFileSync(target, "x: 1\n");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm(`rm pnpm-lock.yaml\nln -s ${target} pnpm-lock.yaml`);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "lockfile_not_regular", check: "lockfile_after" });
    expect(read("pnpm-lock.yaml")).toBe(original);
    expect(lstatSync(path.join(ws, "pnpm-lock.yaml")).isFile()).toBe(true);
  });

  it("a pnpm that is a corepack shim is refused with check pnpm_binary", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const shim = path.join(root, "corepack");
    mkdirSync(shim);
    writeFileSync(path.join(shim, "pnpm"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(shim, "pnpm"), 0o755);
    vi.stubEnv("PATH", `${shim}:${process.env.PATH ?? ""}`);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "corepack_shim", check: "pnpm_binary" });
  });

  it("a pnpm that would rewrite the lockfile in another format version is refused and the original is put back", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    fakePnpm(`sed -i "s/^lockfileVersion: .*/lockfileVersion: '10.0'/" pnpm-lock.yaml`);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "lockfile_version_changed", check: "lockfile_version" });
    expect(read("pnpm-lock.yaml")).toBe(original);
  });

  it("a capture that throws puts the lockfile back, removes the scratch and reports the closed failure without the error text", async () => {
    const original = read("pnpm-lock.yaml");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const r = subject({ capture: async (_c, _a, _e, cwd) => { writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "half\n"); throw new Error("spawn failed at /home/someone/secret"); } });
    expect(await r.run()).toEqual({ kind: "failed", why: "exit" });
    expect(read("pnpm-lock.yaml")).toBe(original);
    expect(readdirSync(scratch).filter((n) => n.startsWith("fx-locksync-"))).toEqual([]);
    expect(r.said.join("\n")).not.toContain("someone");
  });

  it("pnpm starts with pm-on-fail=ignore in its environment as well as on its command line", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const seen: Array<Record<string, string>> = [];
    await subject({ capture: async (_c, _a, env) => { seen.push(env); return { code: 0, timedOut: false, aborted: false, tail: "" }; } }).run();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pnpm_config_pm_on_fail).toBe("ignore");
    expect(seen[0]!.npm_config_manage_package_manager_versions).toBe("false");
  });

  it("a run that was stopped before the update began never starts pnpm", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const calls: string[] = [];
    const stop = new AbortController();
    stop.abort();
    expect(await subject({ calls }).run(stop.signal)).toEqual({ kind: "failed", why: "aborted" });
    expect(calls).toEqual([]);
  });

  it("a repo setting that moves the registry is refused before pnpm starts", async () => {
    put(".npmrc", "registry=https://evil.example/\n");
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const calls: string[] = [];
    const outcome = await subject({ calls }).run();
    expect(outcome.kind).toBe("refused");
    expect(calls).toEqual([]);
  });

  it("no pnpm on the machine is the closed failure tool_missing", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    // git stays reachable (it names the changed files); pnpm does not.
    const bin = path.join(root, "only-git");
    mkdirSync(bin);
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
    vi.stubEnv("PATH", bin);
    const r = subject();
    expect(await r.run()).toEqual({ kind: "failed", why: "tool_missing" });
    expect(r.said[0]).toContain("pnpm not found");
  });

  it("when git cannot name the changed files (the listing answers null) the lockfile is left alone, and a line says why", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    const r = subject({ changedFiles: async () => null });
    expect(await r.run()).toEqual({ kind: "none" });
    expect(r.said).toEqual(["fx-runner: lockfile update skipped (lockfile_sync_unknown_changes)"]);
  });

  it("when the git folder has no shape the sandbox leaves, the lockfile is refused and left alone, and a line says why", async () => {
    put("a/package.json", pkg("@x/a", { "@x/b": "workspace:*" }));
    rmSync(path.join(ws, ".git"), { recursive: true, force: true });
    const r = subject();
    expect(await r.run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "pin" });
    expect(r.said).toEqual(["fx-runner: lockfile update refused (lockfile_sync_refused: workspace_unsafe, check: pin)"]);
  });
});

/**
 * Run 352e6379 (an executor on this repository, 11-06): the sandbox leaves an empty `.claude-sandbox-noreplace` directory in `.git/info`, `.git/objects/info` and
 * `.git/objects/info/commit-graphs`. The host read of the workspace refused the `.git/info` one (workspace_git_refused), the lockfile step turned that into
 * `workspace_unsafe`, and the same check refused the run's publish. A normal pnpm monorepo must pass; each genuine unsafe shape must still refuse, and say which check did.
 */
describe("a monorepo shaped like this repository, with the sandbox's stubs in place", () => {
  const MARKER = ".claude-sandbox-noreplace";
  const lockNow = (): string => read("pnpm-lock.yaml");

  /** Replaces the fixture with packages/*, apps/*, a nested package, an ignored `node_modules` that holds links, and the sandbox's stubs. */
  function monorepo(): void {
    for (const rel of ["a", "b", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) rmSync(path.join(ws, rel), { recursive: true, force: true });
    put(".gitignore", "node_modules/\n");
    put("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n  - packages/*/examples/*\n");
    put("package.json", pkg("root", {}, { private: true }));
    put("packages/core/package.json", pkg("@x/core"));
    put("packages/ui/package.json", pkg("@x/ui", { "@x/core": "workspace:*" }));
    put("packages/core/examples/demo/package.json", pkg("@x/demo"));
    put("apps/web/package.json", pkg("@x/web"));
    put("apps/web/src/index.ts", "export const x = 1;\n");
    expect(pnpm(["install", "--lockfile-only", "--offline"]).code).toBe(0);
    // Links the way a real pnpm install leaves them: inside `node_modules`, which git ignores and the walk does not enter.
    mkdirSync(path.join(ws, "node_modules", ".pnpm"), { recursive: true });
    symlinkSync("../packages/core", path.join(ws, "node_modules", "core-link"));
    symlinkSync("../../../packages/ui", path.join(ws, "node_modules", ".pnpm", "ui-link"));
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    base = git("rev-parse", "HEAD");
    pinFixture(ws);
  }
  /** The empty shapes the sandbox makes in the git folder, as the kept workspace of run 352e6379 held them (the lockfile is the real one at this point). */
  function sandboxStubs(): void {
    const gitDir = path.join(ws, ".git");
    writeFileSync(path.join(gitDir, "commondir"), ".");
    writeFileSync(path.join(gitDir, "config.worktree"), "");
    for (const dir of ["modules", "worktrees", "glab-cli"]) mkdirSync(path.join(gitDir, dir));
    for (const parent of [".git/info", ".git/objects/info", ".git/objects/info/commit-graphs"]) mkdirSync(path.join(ws, parent, MARKER), { recursive: true });
    writeFileSync(path.join(ws, ".npmrc"), "");
    writeFileSync(path.join(ws, ".env"), "");
  }

  it("a dependency added to one package is brought into the lockfile, and the run is not refused", async () => {
    monorepo();
    sandboxStubs();
    put("apps/web/package.json", pkg("@x/web", { "@x/ui": "workspace:*" }));
    const r = subject();
    expect(await r.run()).toEqual({ kind: "updated" });
    expect(r.said).toEqual(["fx-runner: lockfile updated to match the changed manifests (lockfile_sync_updated)"]);
    expect(lockNow()).toContain("link:../../packages/ui");
  });

  it("the same change refuses when the marker directory has anything in it, and the line names the check", async () => {
    monorepo();
    sandboxStubs();
    writeFileSync(path.join(ws, ".git", "info", MARKER, "x"), "");
    put("apps/web/package.json", pkg("@x/web", { "@x/ui": "workspace:*" }));
    const r = subject();
    expect(await r.run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "git_dir_info_entry" });
    expect(r.said).toEqual(["fx-runner: lockfile update refused (lockfile_sync_refused: workspace_unsafe, check: git_dir_info_entry)"]);
  });

  it("a nested git folder, and a git config changed after the pin, are told apart from a bad git folder", async () => {
    monorepo();
    sandboxStubs();
    put("apps/web/package.json", pkg("@x/web", { "@x/ui": "workspace:*" }));
    mkdirSync(path.join(ws, "packages", "ui", ".git"));
    expect(await subject().run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "nested_dotgit" });
    rmSync(path.join(ws, "packages", "ui", ".git"), { recursive: true });
    execFileSync("git", ["-C", ws, "config", "core.hooksPath", "/tmp"]);
    expect(await subject().run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "pin" });
  });

  const CASES: Array<[string, string, () => void]> = [
    ["a project directory added as a link to another project", "linked_project_dir", () => symlinkSync("../packages/ui", path.join(ws, "apps", "evil"))],
    ["a link named .npmrc below the root", "linked_pnpm_file", () => symlinkSync("../../.npmrc", path.join(ws, "apps", "web", ".npmrc"))],
    ["a package.yaml next to a package.json", "other_manifest_format", () => put("packages/ui/package.yaml", "name: '@x/ui'\n")],
    ["a changed manifest that became a link", "changed_manifest_not_file", () => (rmSync(path.join(ws, "apps/web/package.json")), symlinkSync("../../packages/ui/package.json", path.join(ws, "apps/web/package.json")))],
    ["a changed manifest behind a linked directory", "changed_manifest_path", () => (rmSync(path.join(ws, "apps/web"), { recursive: true }), symlinkSync("../packages/ui", path.join(ws, "apps/web")))],
  ];
  for (const [name, check, make] of CASES) {
    it(`${name} is refused with check ${check}, and pnpm never starts`, async () => {
      monorepo();
      sandboxStubs();
      put("packages/core/package.json", pkg("@x/core", {}, { description: "changed" }));
      make();
      const calls: string[] = [];
      const r = subject({ calls });
      expect(await r.run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check });
      expect(calls).toEqual([]);
      expect(r.said).toEqual([`fx-runner: lockfile update refused (lockfile_sync_refused: workspace_unsafe, check: ${check})`]);
    });
  }

  it("a directory the walk cannot list is refused with check walk_unlistable (the changed list is given, so git's own listing does not hide it)", async () => {
    monorepo();
    put("packages/core/package.json", pkg("@x/core", {}, { description: "changed" }));
    mkdirSync(path.join(ws, "apps", "closed"));
    chmodSync(path.join(ws, "apps", "closed"), 0o000);
    try {
      const r = subject({ changedFiles: async () => ["packages/core/package.json"] });
      expect(await r.run()).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "walk_unlistable" });
    } finally {
      chmodSync(path.join(ws, "apps", "closed"), 0o755);
    }
  });

  it("a scratch directory that cannot be made is refused with check scratch_dir", async () => {
    monorepo();
    put("packages/core/package.json", pkg("@x/core", {}, { description: "changed" }));
    writeFileSync(path.join(root, "not-a-dir"), "");
    const said: string[] = [];
    const sync = createLockfileSync({ capture: async () => ({ code: 0, tail: "", timedOut: false, aborted: false }), envOptions: {}, changedFiles: async () => ["packages/core/package.json"], say: (l) => said.push(l), scratchRoot: path.join(root, "not-a-dir", "inner") });
    expect(await sync.run({ workspace: ws, base })).toEqual({ kind: "refused", reason: "workspace_unsafe", check: "scratch_dir" });
    expect(said).toEqual(["fx-runner: lockfile update refused (lockfile_sync_refused: workspace_unsafe, check: scratch_dir)"]);
  });

  it("a repo setting that moves the registry is refused with check settings_files, and a lockfile with another host's tarball with lockfile_content", async () => {
    monorepo();
    put("packages/core/package.json", pkg("@x/core", {}, { description: "changed" }));
    put(".npmrc", "registry=https://evil.example/\n");
    expect(await subject().run()).toMatchObject({ kind: "refused", check: "settings_files" });
    rmSync(path.join(ws, ".npmrc"));
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      evil:\n        specifier: github:evil/evil\n        version: github.com/evil/evil/abc\n");
    expect(await subject().run()).toMatchObject({ kind: "refused", check: "lockfile_content" });
  });
});

describe("the command line", () => {
  it("is offline, lockfile-only, with no scripts and no pnpmfile, and sets registry, store and cache itself", () => {
    const args = lockSyncArgs({ registry: "https://registry.npmjs.org/", storeDir: "/s", cacheDir: "/c" });
    expect(args.slice(0, 2)).toEqual(["install", "--lockfile-only"]);
    for (const flag of ["--offline", "--ignore-scripts", "--ignore-pnpmfile", "--registry=https://registry.npmjs.org/", "--config.store-dir=/s", "--config.cache-dir=/c", PM_ON_FAIL_FLAG]) expect(args).toContain(flag);
    // Explicit, so a pnpm that defaults to frozen (CI) still rewrites the file.
    expect(args).toContain("--no-frozen-lockfile");
    expect(args).not.toContain("--frozen-lockfile");
  });
});
