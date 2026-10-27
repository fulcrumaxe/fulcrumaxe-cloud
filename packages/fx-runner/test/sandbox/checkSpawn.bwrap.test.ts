import { pinFixture } from "../helpers/pinFixture.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
import { findOnPath } from "../helpers/findOnPath.js";
import { testLaunch } from "../helpers/launch.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 RUNNER-CHECK-SPAWN-1: a check that starts child processes, under real bubblewrap and the production seccomp filter, launched by `HostSandbox.checkLaunch` and
 * started through the production kit's install capture. Every Node child-process start makes its stdio pipes with `socketpair(AF_UNIX, SOCK_STREAM)`; the filter used to
 * refuse that, so `node --test` failed on its first file with `spawn EPERM`. The forbidden things are proved still refused by the kernel here (perl's `socket`,
 * `socketpair` and raw `syscall` reach the calls directly), each beside a control run of the same program without the filter.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = process.platform === "linux" && BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);
const CALLS: Record<string, { unshare: number } | undefined> = { x64: { unshare: 272 }, arm64: { unshare: 97 } };
const calls = CALLS[os.arch()];
const CLONE_NEWUSER = 0x10000000;
const EPERM = 1;
const ENOSYS = 38;

let root: string;
let workspace: string;
let base: string;
let handle: SandboxHandle;
let host: ReturnType<typeof createHostSandbox>;
let perl: string | undefined;

const kit = createClaudeKit(spawn, { launch: testLaunch() });
const captureLarge = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048);

function launchOf(argv: readonly string[]) {
  const launch = host.checkLaunch(handle, argv, false);
  if (launch === undefined || "refused" in launch) throw new Error("no launch");
  return launch;
}

/** The check as the daemon runs it, filter fed on descriptor 3. */
async function filtered(argv: readonly string[]) {
  const launch = launchOf(argv);
  return kit.installCapture!(launch.tool, launch.args, launch.env, workspace, 20_000, 4096, undefined, launch.feed);
}

/** Control: the same launch with `--seccomp 3` left out and nothing fed. */
async function unfiltered(argv: readonly string[]) {
  const launch = launchOf(argv);
  expect(launch.args.slice(0, 2)).toEqual(["--seccomp", "3"]);
  return kit.installCapture!(launch.tool, launch.args.slice(2), launch.env, workspace, 20_000, 4096, undefined, undefined);
}

function runCheck(argv: string[]) {
  const step = createCheckStep({ capture: kit.installCapture!, now: () => new Date(), vcsState: createVcsState(captureLarge, {}) });
  const input: CheckStepInput = { check: { argv, dev_shell: false, timeout_s: 30 }, workspace, base, baseDir: workspace, baseFile: createBaseFile(captureLarge, {}), launch: (vector, devShell) => host.checkLaunch(handle, vector, devShell) };
  return step(input);
}

/** A perl one-liner that prints `<label>=ok` or `<label>=errno<N>` for each probe. */
const perlProbe = (body: string): string[] => [perl!, "-MSocket", "-e", body];

describe.skipIf(!usable)("RUNNER-CHECK-SPAWN-1: a check that starts child processes, under real bubblewrap and the seccomp filter", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpRoot(), "check-spawn-"));
    const home = path.join(root, "home");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
    const stateDir = path.join(home, ".fx-runner");
    for (const dir of [workspace, tempRoot, stateDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    const git = (...args: string[]): string => execFileSync("git", ["-C", workspace, "-c", "user.email=a@b", "-c", "user.name=a", ...args], { encoding: "utf8" }).trim();
    // A `node --test` file that itself starts a child with piped stdio, the way the failing suite did.
    writeFileSync(
      path.join(workspace, "spawns.test.mjs"),
      [
        'import { test } from "node:test";',
        'import { execFileSync } from "node:child_process";',
        `test("a child with piped stdio", () => { if (execFileSync(${JSON.stringify(process.execPath)}, ["-e", "process.stdout.write('child-ran')"], { encoding: "utf8" }) !== "child-ran") throw new Error("no output"); });`,
        "",
      ].join("\n"),
    );
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    base = git("rev-parse", "HEAD");
    pinFixture(workspace);
    const runtime = {
      start: async () => ({ handle: { runId: "r1", done: Promise.resolve({ status: "done" }) } as unknown as AgentHandle }),
      stop: async () => undefined,
    } as unknown as InterruptibleRuntime;
    host = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => runtime, home, stateDir, binaryDir: path.join(root, "bin"), tempRoot, workspaceRoot: path.dirname(workspace), packageStoreRoot: path.join(home, ".cache", "fx-runner", "pnpm-store") });
    handle = await host.createSandbox({ sandboxName: "rn-r1", retention: { persistent: false }, timeoutMs: 600_000 });
    const started = host.startDetached(handle, { runId: "r1", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined } as never);
    await started.hookFired.catch(() => undefined);
    perl = findOnPath("perl", launchOf(["true"]).env.PATH ?? "");
  });
  afterAll(async () => {
    await host.deleteSandbox(handle);
    rmSync(root, { recursive: true, force: true });
  });

  it("a shell starts external commands and pipelines", async () => {
    const out = await filtered(["sh", "-c", "echo piped | cat; env true && echo forked"]);
    expect(out.code).toBe(0);
    expect(out.tail).toContain("piped");
    expect(out.tail).toContain("forked");
  });

  it("node starts children with piped stdio, synchronously and not, and over an IPC channel", async () => {
    const program = [
      'const cp = require("child_process");',
      'if (cp.execFileSync("sh", ["-c", "echo sync"], { encoding: "utf8" }).trim() !== "sync") process.exit(2);',
      'const c = cp.spawn(process.execPath, ["-e", "process.send(\'ipc\')"], { stdio: ["pipe", "pipe", "pipe", "ipc"] });',
      'c.on("message", (m) => console.log("message " + m));',
      'c.on("error", (e) => { console.log("error " + e.code); process.exit(3); });',
      'c.on("exit", (code) => { console.log("sync ok, async exit " + code); process.exit(code); });',
    ].join("\n");
    const out = await filtered([process.execPath, "-e", program]);
    expect(out.tail).not.toContain("EPERM");
    expect(out.code).toBe(0);
    expect(out.tail).toContain("message ipc");
    expect(out.tail).toContain("sync ok, async exit 0");
  });

  it("the check step runs `node --test` on a file that spawns, and it passes", async () => {
    const out = await runCheck([process.execPath, "--test", "spawns.test.mjs"]);
    expect(out.body.summary).not.toContain("EPERM");
    expect(out.body.exit_code).toBe(0);
    expect(out.passed).toBe(true);
  });

  it("a Unix socket that could reach another endpoint is still refused: socket(AF_UNIX) and a SOCK_DGRAM pair; a SOCK_STREAM pair is allowed", async () => {
    expect(perl, "perl on the check's PATH").toBeDefined();
    const body = [
      'print "unix=", (socket(my $s, AF_UNIX, SOCK_STREAM, 0) ? "ok" : "errno" . ($! + 0)), "\\n";',
      'print "dgram=", (socketpair(my $a, my $b, AF_UNIX, SOCK_DGRAM, 0) ? "ok" : "errno" . ($! + 0)), "\\n";',
      'print "stream=", (socketpair(my $c, my $d, AF_UNIX, SOCK_STREAM, 0) ? "ok" : "errno" . ($! + 0)), "\\n";',
      'print "netlink=", (socket(my $n, 16, SOCK_RAW, 0) ? "ok" : "errno" . ($! + 0)), "\\n";',
    ].join("");
    const control = await unfiltered(perlProbe(body));
    expect(control.tail).toContain("unix=ok");
    expect(control.tail).toContain("dgram=ok");
    const out = await filtered(perlProbe(body));
    expect(out.tail).toContain(`unix=errno${String(EPERM)}`);
    expect(out.tail).toContain(`dgram=errno${String(EPERM)}`);
    expect(out.tail).toContain(`netlink=errno${String(EPERM)}`);
    expect(out.tail).toContain("stream=ok");
  });

  it.skipIf(calls === undefined)("no new namespace can be made, io_uring is refused, and clone3 answers ENOSYS (so libc falls back to clone)", async () => {
    expect(perl, "perl on the check's PATH").toBeDefined();
    const body = [
      `print "userns=", (syscall(${String(calls!.unshare)}, ${String(CLONE_NEWUSER)}) == 0 ? "ok" : "errno" . ($! + 0)), "\\n";`,
      'print "uring=", (syscall(425, 1, 0) >= 0 ? "ok" : "errno" . ($! + 0)), "\\n";',
      'print "clone3=", (syscall(435, 0, 0) >= 0 ? "ok" : "errno" . ($! + 0)), "\\n";',
    ].join("");
    // Without the filter a user namespace can be made inside the check's own, and clone3 is a real call (it answers EINVAL to a null argument, not ENOSYS).
    const control = await unfiltered(perlProbe(body));
    expect(control.tail).toContain("userns=ok");
    expect(control.tail).not.toContain(`clone3=errno${String(ENOSYS)}`);
    const out = await filtered(perlProbe(body));
    expect(out.tail).toContain(`userns=errno${String(EPERM)}`);
    expect(out.tail).toContain(`uring=errno${String(EPERM)}`);
    expect(out.tail).toContain(`clone3=errno${String(ENOSYS)}`);
  });
});

/**
 * D#6 RUNNER-CHECK-SPAWN-1, browser tier: the site-kit checks launch Chromium with the options of `launchOptions` (their Playwright driver). Chromium's own sandbox needs
 * user namespaces, which the filter refuses, so `checkLaunch` marks the check with `FX_RUNNER_CHECK=1` and the driver then turns that sandbox off. Here the options are
 * built from the env of the real launch and Chromium is started with them inside the real, filtered check.
 */
const SITEKIT = path.resolve(import.meta.dirname, "../../../sitekit-checks");
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH;

/**
 * Where the driver's Playwright lives, found here in the test process (the way the site-kit package itself resolves it) and handed to the check as absolute real paths: the
 * package's `node_modules` entry is a link into the package store, and where that store sits depends on the checkout. Undefined when it cannot be found.
 */
function resolvePlaywright(): { core: string; executable: string } | undefined {
  try {
    const sitekitRequire = createRequire(path.join(SITEKIT, "package.json"));
    const core = realpathSync(path.dirname(sitekitRequire.resolve("playwright-core/package.json")));
    const executable = (sitekitRequire(core) as { chromium: { executablePath(): string } }).chromium.executablePath();
    return { core, executable };
  } catch {
    return undefined;
  }
}
const playwright = BROWSERS !== undefined && existsSync(BROWSERS) ? resolvePlaywright() : undefined;
const browserReady = playwright !== undefined && existsSync(playwright.executable);

describe.skipIf(!usable || !browserReady)("RUNNER-CHECK-SPAWN-1: Chromium starts in the filtered check with the site-kit driver's launch options", () => {
  let program: string;
  /** Set when the check's own view cannot read the package or the browser (e.g. the checkout sits where the check hides it); the test then skips with this reason. */
  let notVisible: string | undefined;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpRoot(), "check-spawn-browser-"));
    const home = path.join(root, "home");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
    const stateDir = path.join(home, ".fx-runner");
    for (const dir of [workspace, tempRoot, stateDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    const runtime = {
      start: async () => ({ handle: { runId: "r1", done: Promise.resolve({ status: "done" }) } as unknown as AgentHandle }),
      stop: async () => undefined,
    } as unknown as InterruptibleRuntime;
    host = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => runtime, home, stateDir, binaryDir: path.join(root, "bin"), tempRoot, workspaceRoot: path.dirname(workspace), packageStoreRoot: path.join(home, ".cache", "fx-runner", "pnpm-store") });
    handle = await host.createSandbox({ sandboxName: "rn-r1", retention: { persistent: false }, timeoutMs: 600_000 });
    const started = host.startDetached(handle, { runId: "r1", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined } as never);
    await started.hookFired.catch(() => undefined);
    program = [
      "const { chromium } = require(process.argv[1]);",
      "(async () => {",
      "  const b = await chromium.launch(JSON.parse(process.argv[2]));",
      "  const p = await b.newPage();",
      '  await p.setContent("<p id=x>up</p>");',
      '  console.log("chromium=" + (await p.textContent("#x")));',
      "  await b.close();",
      '})().catch((e) => { console.log("chromium=failed " + String(e.message).split("\\n")[0]); process.exit(1); });',
    ].join("\n");
    // Can the check read what it is about to be given? A checkout the check's view hides is a skip, never a pass and never a failure of the filter.
    const probe = 'try { require(process.argv[1]); require("fs").accessSync(process.argv[2], 1); console.log("visible=yes"); } catch (e) { console.log("visible=no " + String(e.message).split("\\n")[0]); }';
    const seen = await filtered(["env", `PLAYWRIGHT_BROWSERS_PATH=${BROWSERS!}`, process.execPath, "-e", probe, playwright!.core, playwright!.executable]);
    if (!seen.tail.includes("visible=yes")) notVisible = seen.tail.split("\n").find((line) => line.includes("visible=")) ?? seen.tail.slice(0, 200);
  });
  afterAll(async () => {
    await host.deleteSandbox(handle);
    rmSync(root, { recursive: true, force: true });
  });

  it("the check carries the marker, and the driver's options under it start Chromium; the sandbox-on options do not start under the filter", async (ctx) => {
    if (notVisible !== undefined) {
      console.warn(`SKIPPED: playwright-core or the Chromium binary is not readable inside the check's view of this checkout (${notVisible})`);
      ctx.skip();
    }
    const launch = launchOf(["true"]);
    expect(launch.env.FX_RUNNER_CHECK).toBe("1");
    const { launchOptions } = await import("../../../sitekit-checks/test/browser/playwright-driver.js");
    const chromiumHome = path.join(workspace, "chromium-home");
    mkdirSync(chromiumHome, { recursive: true });
    const marked = launchOptions(launch.env, chromiumHome);
    expect(marked.chromiumSandbox).toBe(false);
    const run = (opts: unknown) => filtered(["env", `PLAYWRIGHT_BROWSERS_PATH=${BROWSERS!}`, process.execPath, "-e", program, playwright!.core, JSON.stringify(opts)]);
    const started = await run(marked);
    expect(started.tail).toContain("chromium=up");
    expect(started.code).toBe(0);
    // The refusal still stands: Chromium's own sandbox (what the default options ask for) cannot get a user namespace here.
    const unmarked = launchOptions({}, chromiumHome);
    expect(unmarked.chromiumSandbox).toBe(true);
    const refused = await run(unmarked);
    expect(refused.tail).toContain("chromium=failed");
    expect(refused.code).not.toBe(0);
  });
});
