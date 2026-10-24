import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentHandle } from "@fulcrumaxe/runner-protocol";
import { createBaseFile, createCheckStep, createVcsState, type CheckStepInput } from "../../src/daemon/checkStep.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { createHostSandbox, type InterruptibleRuntime } from "../../src/sandbox/hostSandbox.js";
import type { SandboxHandle } from "../../src/sandbox/port.js";
import { bwrapCanCreateNamespaces } from "../helpers/bwrapProbe.js";
import { testLaunch } from "../helpers/launch.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 RUNNER-SECCOMP-FD-1: the check launched end to end the way the daemon does it, with real bubblewrap. The launch comes from `HostSandbox.checkLaunch`, the
 * check step is `createCheckStep`, and the process start is the production kit's own `installCapture` (`createClaudeKit`), not a lambda written here. The kit used to
 * drop the seccomp filter bytes on the way to `runInstall`, so bubblewrap was told `--seccomp 3` with nothing open on descriptor 3 and every check failed at once
 * ("Can't read seccomp data"); the other suites hand the descriptor over themselves, which is why none of them saw it.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);

let root: string;
let workspace: string;
let base: string;
let handle: SandboxHandle;
let host: ReturnType<typeof createHostSandbox>;

const kit = createClaudeKit(spawn, { launch: testLaunch() });
const captureLarge = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048);

function launchOf(argv: readonly string[], devShell: boolean) {
  const launch = host.checkLaunch(handle, argv, devShell);
  if (launch === undefined || "refused" in launch) throw new Error("no launch");
  return launch;
}

function runCheck(argv: string[], over: { timeout_s?: number; signal?: AbortSignal } = {}) {
  const installCapture = kit.installCapture;
  if (installCapture === undefined) throw new Error("the kit has no install capture");
  const step = createCheckStep({ capture: installCapture, now: () => new Date(), vcsState: createVcsState(captureLarge, {}) });
  const input: CheckStepInput = { check: { argv, dev_shell: false, timeout_s: over.timeout_s ?? 30 }, workspace, base, baseDir: workspace, baseFile: createBaseFile(captureLarge, {}), launch: (vector, devShell) => host.checkLaunch(handle, vector, devShell), ...(over.signal === undefined ? {} : { signal: over.signal }) };
  return step(input);
}

describe.skipIf(!usable)("RUNNER-SECCOMP-FD-1: the check under real bubblewrap through the production kit", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpRoot(), "seccomp-fd-"));
    const home = path.join(root, "home");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
    const stateDir = path.join(home, ".fx-runner");
    for (const dir of [workspace, tempRoot, stateDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    const git = (...args: string[]): string => execFileSync("git", ["-C", workspace, "-c", "user.email=a@b", "-c", "user.name=a", ...args], { encoding: "utf8" }).trim();
    writeFileSync(path.join(workspace, "README"), "x\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    base = git("rev-parse", "HEAD");
    const runtime = {
      start: async () => ({ handle: { runId: "r1", done: Promise.resolve({ status: "done" }) } as unknown as AgentHandle }),
      stop: async () => undefined,
    } as unknown as InterruptibleRuntime;
    host = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => runtime, home, stateDir, binaryDir: path.join(root, "bin"), tempRoot, workspaceRoot: path.dirname(workspace), packageStoreRoot: path.join(home, ".cache", "fx-runner", "pnpm-store") });
    handle = await host.createSandbox({ sandboxName: "rn-r1", retention: { persistent: false }, timeoutMs: 600_000 });
    const started = host.startDetached(handle, { runId: "r1", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined } as never);
    await started.hookFired.catch(() => undefined);
  });
  afterAll(async () => {
    await host.deleteSandbox(handle);
    rmSync(root, { recursive: true, force: true });
  });

  it("the launch asks bubblewrap for a filter on descriptor 3 and carries the filter bytes", () => {
    const launch = launchOf(["true"], false);
    expect(launch.args.slice(0, 2)).toEqual(["--seccomp", "3"]);
    expect(launch.feed?.length ?? 0).toBeGreaterThan(0);
  });

  it("the kit's install capture hands the filter to bubblewrap: a trivial check exits 0 and bubblewrap does not complain", async () => {
    const launch = launchOf(["sh", "-c", "echo ran-under-the-filter"], false);
    const out = await kit.installCapture!(launch.tool, launch.args, launch.env, workspace, 20_000, 4096, undefined, launch.feed);
    expect(out.tail).not.toContain("seccomp");
    expect(out.code).toBe(0);
    expect(out.tail).toContain("ran-under-the-filter");
  });

  it("the check step runs the check and it passes", async () => {
    const out = await runCheck(["sh", "-c", "echo check-ran"]);
    expect(out.body.summary).not.toContain("seccomp");
    expect(out.passed).toBe(true);
    expect(out.body.exit_code).toBe(0);
    expect(out.body.summary).toContain("check-ran");
  });

  /** Processes on this host whose command line holds `marker`: the check's own tree is visible from outside its process namespace. */
  const alive = (marker: string): number => {
    const found = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return found.status === 0 ? found.stdout.split("\n").filter((line) => line.trim() !== "").length : 0;
  };
  /** A program that does what pnpm did in the live stall: it waits on a retry timer for a network that is not there, and keeps a child waiting too. */
  const waiting = (marker: string): string[] => ["sh", "-c", `sleep 3000 # ${marker} &\n${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000) /* ${marker} */'`];

  it("a check blocked waiting for the network is ended by its own time cap, with everything it started, and is reported as timed out", async () => {
    const marker = `fx-chk-cap-${Math.random().toString(36).slice(2)}`;
    let runningBefore = 0;
    setTimeout(() => {
      runningBefore = alive(marker);
    }, 1000);
    const started = Date.now();
    const out = await runCheck(waiting(marker), { timeout_s: 2 });
    expect(runningBefore).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(out.passed).toBe(false);
    expect(out.body).toMatchObject({ exit_code: null, timed_out: true });
    expect(alive(marker)).toBe(0);
  });

  it("a check blocked waiting for the network is ended when the run is stopped (the cloud's stop reaches it through the signal), and is not reported as timed out", async () => {
    const marker = `fx-chk-stop-${Math.random().toString(36).slice(2)}`;
    const stop = new AbortController();
    let runningBefore = 0;
    setTimeout(() => {
      runningBefore = alive(marker);
      stop.abort();
    }, 1500);
    const started = Date.now();
    const out = await runCheck(waiting(marker), { timeout_s: 600, signal: stop.signal });
    // Control: the processes really were up when the stop came, so "none left" below is the stop's doing.
    expect(runningBefore).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(out.passed).toBe(false);
    expect(out.body).toMatchObject({ exit_code: null, timed_out: false });
    expect(alive(marker)).toBe(0);
  });

  it("the check's pnpm is told to work offline and not to look up release ages (set after the job's own environment, which has no such name in its allowlist)", () => {
    const launch = launchOf(["true"], false);
    expect(launch.env).toMatchObject({ pnpm_config_offline: "true", pnpm_config_minimum_release_age: "0" });
  });

  it("the filter is applied: a Unix-domain socket is refused in the check, though the same program connects without the filter", async () => {
    // The socket lives in the workspace, which the check can see, so only the filter stands between the program and the listener.
    const sock = path.join(workspace, "s.sock");
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end("hi");
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const program = `const s=require("net").connect(${JSON.stringify(sock)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",(e)=>{console.log("error "+e.code);process.exit(1)})`;
      const argv = [process.execPath, "-e", program];
      // Control: the same launch with the filter left out (and nothing fed), through the same kit, connects.
      const launch = launchOf(argv, false);
      const unfiltered = await kit.installCapture!(launch.tool, launch.args.slice(2), launch.env, workspace, 20_000, 4096, undefined, undefined);
      expect(unfiltered.tail).toContain("connected");
      const filtered = await runCheck(argv);
      expect(filtered.passed).toBe(false);
      expect(filtered.body.exit_code).toBe(1);
      expect(filtered.body.summary).not.toContain("seccomp");
      expect(filtered.body.summary).toMatch(/error (EPERM|EACCES)/);
    } finally {
      server.close();
      rmSync(sock, { force: true });
    }
  });
});
