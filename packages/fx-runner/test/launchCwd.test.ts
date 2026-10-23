/**
 * D#6 RUNNER-CWD-1: every program the runner starts without a directory of its own (the CLI's short questions, git, the sandbox probe, the tmux
 * client) starts in a fresh, empty, 0700 directory under the runner's launch root, removed afterwards; a launch that would land in the home
 * directory, the process's own directory or outside the launch root starts nothing. A real-contract fake CLI that makes the placeholder files
 * the real 2.1.309 build makes shows that the daemon's preflight and `doctor` leave the home directory and the caller's directory as they were.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand, type DoctorHost } from "../src/commands/doctor.js";
import type { CommandContext } from "../src/context.js";
import { authPresent } from "../src/engines/claude/authStatus.js";
import { runCapture, type SpawnFn } from "../src/engines/claude/capture.js";
import { createClaudeKit } from "../src/engines/claude/kit.js";
import { storedBinarySource } from "../src/engines/claude/pin.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { LaunchRefused, assertLaunchDir, ensureLaunchRoot, openLaunchDir, prepareDaemonDir, type LaunchPlace } from "../src/launchDir.js";
import { FULL_HELP } from "./engines/claude/harness.js";
import { fakeSandboxHost } from "./helpers/fakeSandboxHost.js";
import { fakeBwrapDir, makeStubbingClaude, treeOf } from "./helpers/stubbingClaude.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

let root: string;
let home: string;
let caller: string;
let place: LaunchPlace;
const HOST_PATH = process.env.PATH ?? "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpRoot(), "fxr-launch-cwd-"));
  home = path.join(root, "home");
  // The directory a person runs `doctor` in, or a service manager starts `run` in: a checkout, with a `.git`.
  caller = path.join(root, "checkout");
  for (const dir of [home, path.join(caller, ".git", "info")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(caller, ".git", "info", "exclude"), "# git ls-files --others --exclude-from=.git/info/exclude\n");
  writeFileSync(path.join(home, ".bashrc"), "export X=1\n");
  place = { root: path.join(home, ".cache", "fx-runner", "launch"), home, processCwd: () => caller, uid: process.getuid?.() };
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A spawn that records the working directory of each start, checks it at that moment, and answers like the CLI. */
function recordingSpawn(): { spawn: SpawnFn; starts: Array<{ args: string[]; cwd: unknown; env: Record<string, string>; emptyOwn0700: boolean }> } {
  const starts: Array<{ args: string[]; cwd: unknown; env: Record<string, string>; emptyOwn0700: boolean }> = [];
  const fn = ((_command: string, args: readonly string[], opts: { cwd?: unknown; env: Record<string, string> }) => {
    const cwd = opts.cwd;
    let emptyOwn0700 = false;
    if (typeof cwd === "string") {
      const info = lstatSync(cwd);
      emptyOwn0700 = info.isDirectory() && (info.mode & 0o777) === 0o700 && readdirSync(cwd).length === 0;
    }
    starts.push({ args: [...args], cwd, env: opts.env, emptyOwn0700 });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: () => true, pid: 1 });
    const text = args[0] === "--version" ? "2.1.309 (Claude Code)\n" : args[0] === "--help" ? FULL_HELP : args[0] === "auth" ? '{"authMethod":"claude.ai"}' : "";
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(text));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawn: fn, starts };
}

const strictlyUnder = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

describe("the launch directory and its refusals", () => {
  it("is a fresh, empty, 0700 directory strictly under the launch root, a new one each time, removed afterwards", () => {
    const a = openLaunchDir(place);
    const b = openLaunchDir(place);
    expect(a.dir).not.toBe(b.dir);
    for (const dir of [a.dir, b.dir]) {
      expect(strictlyUnder(place.root!, dir)).toBe(true);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual([]);
    }
    writeFileSync(path.join(a.dir, "package.json"), "");
    a.remove();
    b.remove();
    expect(readdirSync(place.root!)).toEqual([]);
    expect(lstatSync(place.root!).mode & 0o777).toBe(0o700);
  });

  it("refuses a launch with no launch root, a root that is or holds the home directory, and a root that is not a real directory", () => {
    expect(() => openLaunchDir({ ...place, root: undefined })).toThrow(LaunchRefused);
    expect(() => openLaunchDir({ ...place, root: home })).toThrow(LaunchRefused);
    expect(() => openLaunchDir({ ...place, root })).toThrow(LaunchRefused);
    expect(() => openLaunchDir({ ...place, root: "relative/launch" })).toThrow(LaunchRefused);
    const linked = path.join(root, "linked-launch");
    symlinkSync(home, linked);
    expect(() => openLaunchDir({ ...place, root: linked })).toThrow(LaunchRefused);
    expect(readdirSync(home)).toEqual([".bashrc"]);
  });

  it("refuses a directory that is the home directory, the process's own directory, outside the root, not empty, or wider than 0700", () => {
    const rootReal = ensureLaunchRoot(place);
    expect(() => assertLaunchDir(place, rootReal, home)).toThrow(LaunchRefused);
    expect(() => assertLaunchDir(place, rootReal, caller)).toThrow(LaunchRefused);
    const inside = path.join(rootReal, "l-cwd");
    mkdirSync(inside, { mode: 0o700 });
    expect(() => assertLaunchDir({ ...place, processCwd: () => inside }, rootReal, inside)).toThrow(LaunchRefused);
    expect(() => assertLaunchDir(place, rootReal, rootReal)).toThrow(LaunchRefused);
    const full = path.join(rootReal, "l-full");
    mkdirSync(full, { mode: 0o700 });
    writeFileSync(path.join(full, "x"), "");
    expect(() => assertLaunchDir(place, rootReal, full)).toThrow(LaunchRefused);
    const wide = path.join(rootReal, "l-wide");
    mkdirSync(wide);
    chmodSync(wide, 0o755);
    expect(() => assertLaunchDir(place, rootReal, wide)).toThrow(LaunchRefused);
    // control: the same checks pass a fresh empty 0700 directory
    const ok = path.join(rootReal, "l-ok");
    mkdirSync(ok, { mode: 0o700 });
    expect(() => assertLaunchDir(place, rootReal, ok)).not.toThrow();
  });

  it("runCapture starts nothing when the launch is refused, and answers as for a program that could not start", async () => {
    const { spawn: fn, starts } = recordingSpawn();
    const out = await runCapture(fn, { ...place, root: home }, "/bin/claude", ["--version"], {}, 5000);
    expect(starts).toEqual([]);
    expect(out).toMatchObject({ code: null, stdout: "", timedOut: false, launchRefused: true });
  });

  it("runCapture runs a real program in the launch directory and removes what it left there", async () => {
    const out = await runCapture(spawn, place, "/bin/sh", ["-c", "pwd; ls -A; : > package.json; mkdir -p .git/info"], { PATH: "/usr/bin:/bin:/run/current-system/sw/bin" }, 10_000);
    expect(out.code).toBe(0);
    const [dir, listing] = out.stdout.split("\n");
    expect(strictlyUnder(place.root!, dir!) || strictlyUnder(ensureLaunchRoot(place), dir!)).toBe(true);
    expect(listing).toBe("");
    expect(existsSync(dir!)).toBe(false);
    expect(readdirSync(place.root!)).toEqual([]);
    expect(treeOf(caller)).toEqual([".git/", ".git/info/", ".git/info/exclude"]);
  });

  it("the daemon's own directory is <launch root>/daemon, 0700, and refused the same way", () => {
    const dir = prepareDaemonDir(place);
    expect(dir).toBe(path.join(ensureLaunchRoot(place), "daemon"));
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(prepareDaemonDir(place)).toBe(dir);
    expect(() => prepareDaemonDir({ ...place, root })).toThrow(LaunchRefused);
  });
});

describe("every start the engine kit makes for itself is in a fresh empty runner-owned directory (fake spawn)", () => {
  it("doctor's inspect (--version, --help, auth status), git's captures, the probe's capture and the tmux client", async () => {
    const { spawn: fn, starts } = recordingSpawn();
    const kit = createClaudeKit(fn, { launch: place });
    const report = await kit.inspect({ binaryPath: "/opt/claude", envOptions: {}, stateDir: path.join(root, "state"), loginMode: "subscription" });
    expect(report).toMatchObject({ version: "2.1.309", login: "yes" });
    await kit.capture("git", ["--version"], {}, 5000);
    await kit.captureLarge!("nix", ["print-dev-env"], {}, 5000);
    await kit.captureWithStderr("/bin/sh", ["-c", "true"], {}, 5000);
    await kit.foreground("tmux", ["attach"], {});
    expect(starts.map((s) => s.args[0])).toEqual(["--version", "--help", "auth", "--version", "print-dev-env", "-c", "attach"]);
    const dirs = new Set<string>();
    for (const start of starts) {
      expect(typeof start.cwd, start.args.join(" ")).toBe("string");
      const cwd = start.cwd as string;
      expect(strictlyUnder(ensureLaunchRoot(place), cwd), cwd).toBe(true);
      expect(start.emptyOwn0700, cwd).toBe(true);
      expect([home, caller]).not.toContain(cwd);
      expect(existsSync(cwd), cwd).toBe(false);
      dirs.add(cwd);
    }
    expect(dirs.size).toBe(starts.length);
    // The three short questions of the CLI run with subprocess scrubbing off; the rest of the run's environment is kept.
    for (const start of starts.slice(0, 3)) expect(start.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("0");
  });

  it("the per-job preflight (the stored binary's checks and the login question) starts in launch directories too, with scrubbing off", async () => {
    const { spawn: fn, starts } = recordingSpawn();
    const modelEnv = cleanEnv({ mode: "subscription" });
    expect(modelEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    const bin = path.join(root, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    await storedBinarySource({ storedPath: bin, cacheDir: path.join(root, "cache"), spawn: fn, launch: place })(modelEnv);
    await authPresent("subscription", { binaryPath: bin, env: modelEnv, spawn: fn, launch: place });
    expect(starts.map((s) => s.args.join(" "))).toEqual(["--version", "--help", "auth status"]);
    for (const start of starts) {
      expect(strictlyUnder(ensureLaunchRoot(place), start.cwd as string)).toBe(true);
      expect(start.emptyOwn0700).toBe(true);
      expect(start.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("0");
    }
    expect(modelEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });

  it("the instruction canary's model turn runs in a scratch directory under the launch root, removed afterwards", async () => {
    const seen: string[] = [];
    const fn = ((_c: string, _a: readonly string[], opts: { cwd: string }) => {
      seen.push(opts.cwd);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end: () => undefined }), kill: () => true, pid: undefined });
      setImmediate(() => child.emit("close", 1));
      return child;
    }) as unknown as SpawnFn;
    const kit = createClaudeKit(fn, { instructionCanary: true, launch: place });
    expect(await kit.instructionCanary!({ binaryPath: "/opt/claude", credentials: { mode: "subscription" }, envOptions: {} })).toEqual({ ok: false, reason: "instruction_canary_inconclusive" });
    expect(seen).toHaveLength(1);
    expect(strictlyUnder(ensureLaunchRoot(place), seen[0]!)).toBe(true);
    expect(readdirSync(ensureLaunchRoot(place))).toEqual([]);
    // no launch root: no model turn at all
    const none = createClaudeKit(fn, { instructionCanary: true, launch: { ...place, root: undefined } });
    expect(await none.instructionCanary!({ binaryPath: "/opt/claude", credentials: { mode: "subscription" }, envOptions: {} })).toEqual({ ok: false, reason: "instruction_canary_inconclusive" });
    expect(seen).toHaveLength(1);
  });
});

describe("a real-contract fake CLI that makes the 2.1.309 start-up placeholders", () => {
  let fakeDir: string;
  beforeEach(() => {
    fakeDir = path.join(root, "fake");
    vi.stubEnv("PATH", `${path.join(fakeDir, "bin")}:${fakeBwrapDir(root)}:${HOST_PATH}`);
  });

  it("control: started in a directory with scrubbing on, it makes the placeholders there and in HOME, .git/commondir included (the incident)", async () => {
    const fake = makeStubbingClaude(fakeDir);
    const out = await new Promise<number | null>((resolve) => {
      const child = spawn(fake.binary, ["--version"], { cwd: caller, env: { ...cleanEnv({ mode: "subscription" }) }, stdio: "ignore" });
      child.on("close", resolve);
    });
    expect(out).toBe(0);
    expect(existsSync(path.join(caller, ".git", "commondir"))).toBe(true);
    expect(existsSync(path.join(caller, "package.json"))).toBe(true);
    expect(existsSync(path.join(home, ".netrc"))).toBe(true);
  });

  it("the daemon's preflight (stored binary checks + login question, model-run environment) leaves HOME and the caller's directory exactly as they were", async () => {
    const fake = makeStubbingClaude(fakeDir);
    const homeBefore = treeOf(home);
    const callerBefore = treeOf(caller);
    const modelEnv = cleanEnv({ mode: "subscription" });
    const binary = await storedBinarySource({ storedPath: fake.binary, cacheDir: path.join(root, "state"), spawn, launch: place })(modelEnv);
    expect(binary.version).toBe("2.1.309");
    expect((await authPresent("subscription", { binaryPath: fake.binary, env: modelEnv, spawn, launch: place })).present).toBe(true);
    expect(treeOf(home)).toEqual([...homeBefore, ".cache/", ".cache/fx-runner/", ".cache/fx-runner/launch/"].sort());
    expect(treeOf(caller)).toEqual(callerBefore);
    expect(existsSync(path.join(caller, ".git", "commondir"))).toBe(false);
    const calls = fake.calls();
    expect(calls.map((c) => c.args)).toEqual(["--version ", "--help ", "auth status"]);
    for (const call of calls) {
      expect(strictlyUnder(ensureLaunchRoot(place), call.cwd)).toBe(true);
      expect(call.scrub).toBe("0");
    }
  });

  it("doctor (the real kit and the fake on PATH) leaves HOME and its own directory exactly as they were, and warns about placeholders left there before", async () => {
    const fake = makeStubbingClaude(fakeDir);
    const homeBefore = treeOf(home);
    const callerBefore = treeOf(caller);
    const lines: string[] = [];
    const ctx: CommandContext = { stateDir: path.join(root, "state"), uid: process.getuid?.(), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: (async () => new Response("", { status: 200 })) as typeof fetch };
    const host: DoctorHost = { platform: "linux", shellVars: [], engine: createClaudeKit(spawn, { launch: place }), home, cwd: caller, sandbox: fakeSandboxHost(), scopeSupport: { ok: true, tools: { systemdRun: "/x/systemd-run", systemctl: "/x/systemctl", env: "/x/env" }, runtimeDir: "/run/user/1000" } };
    await doctorCommand(ctx, host);
    expect(lines.join("\n")).toContain("Claude version:    2.1.309");
    expect(lines.some((l) => l.includes("CLI stubs"))).toBe(false);
    expect(treeOf(home)).toEqual([...homeBefore, ".cache/", ".cache/fx-runner/", ".cache/fx-runner/launch/"].sort());
    expect(treeOf(caller)).toEqual(callerBefore);
    expect(existsSync(path.join(caller, ".git", "commondir"))).toBe(false);

    // What an older runner left: doctor names it, as a warning, and deletes nothing.
    const old = await new Promise<number | null>((resolve) => {
      const child = spawn(fake.binary, ["--version"], { cwd: caller, env: { ...cleanEnv({ mode: "subscription" }) }, stdio: "ignore" });
      child.on("close", resolve);
    });
    expect(old).toBe(0);
    const leftHome = treeOf(home);
    const leftCaller = treeOf(caller);
    lines.length = 0;
    await doctorCommand(ctx, host);
    const warns = lines.filter((l) => l.includes("CLI stubs:"));
    expect(warns).toHaveLength(2);
    expect(warns.every((l) => l.startsWith("WARN"))).toBe(true);
    expect(warns[0]).toContain(`Your home directory (${home}) holds empty files the Claude CLI makes when it starts: `);
    expect(warns[0]).toContain(".netrc");
    expect(warns[0]).not.toContain(".bashrc"); // a real, non-empty start-up file is not a placeholder
    expect(warns[1]).toContain(`The directory doctor runs in (${caller})`);
    expect(warns[1]).toContain(".git/commondir");
    expect(warns[1]).toContain("package.json");
    expect(warns[1]).toContain("did not delete them");
    expect(treeOf(home)).toEqual(leftHome);
    expect(treeOf(caller)).toEqual(leftCaller);
  });
});
