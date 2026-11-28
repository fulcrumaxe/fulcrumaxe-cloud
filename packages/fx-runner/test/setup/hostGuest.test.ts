import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { listenOnSocket } from "../../src/vm/egress/proxy.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import type { InstallCapture } from "../../src/daemon/engineKit.js";
import { setupHandlerFor } from "../../src/setup/projectSetup.js";
import { unixSocketFilter } from "../../src/sandbox/checkSeccomp.js";
import { USER_RUNTIME_ROOT } from "../../src/sandbox/hostSandbox.js";
import { createSandboxHost } from "../../src/sandbox/probeHost.js";
import { createHostGuest, createHostSetupVm, HostGuestRefused, type HostGuestDeps } from "../../src/setup/hostGuest.js";
import { guestEnvOf } from "../../src/vm/sandboxd/guestEnv.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#845 ON-8e, the host guest without a real sandbox: what it asks the process start to run (the rules, the environment, the wrapper), what it refuses, and how it keeps files below its root. The real bubblewrap
 * suite is `hostGuest.bwrap.test.ts`.
 */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Started {
  tool: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  feed?: Buffer;
}

function world(options: { code?: number | null; chunks?: Array<["stdout" | "stderr", Buffer]>; platform?: NodeJS.Platform; selfCommand?: string[] } = {}) {
  const base = mkdtempSync(path.join(socketTmpRoot(), "fxhgu-"));
  roots.push(base);
  const home = path.join(base, "home");
  const stateDir = path.join(home, ".fx-runner");
  const binDir = path.join(base, "bin");
  const jobsRoot = path.join(base, "jobs");
  for (const dir of [home, stateDir, binDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(binDir, "x"));
  const bwrap = path.join(binDir, "bwrap");
  const socat = path.join(binDir, "socat");
  for (const tool of [bwrap, socat]) {
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);
  }
  const started: Started[] = [];
  const start: InstallCapture = async (tool, args, env, cwd, _limit, _tail, _signal, feed, _onLine, onData) => {
    started.push({ tool, args: [...args], env, cwd, ...(feed === undefined ? {} : { feed }) });
    for (const [stream, chunk] of options.chunks ?? []) onData?.(stream, chunk);
    return { code: options.code === undefined ? 0 : options.code, tail: "", timedOut: false, aborted: false };
  };
  const deps: HostGuestDeps = {
    start,
    host: createSandboxHost(async () => ({ code: null, stdout: "", stderr: "", timedOut: false })),
    platform: options.platform ?? "linux",
    home,
    stateDir,
    binaryDir: path.join(base, "engine-bin"),
    jobsRoot,
    cacheDir: base,
    searchPath: binDir,
    selfCommand: options.selfCommand ?? ["/opt/fictional runner/fx runner", "it's.mjs"],
    uid: process.getuid?.(),
  };
  return { deps, started, base, home, stateDir, jobsRoot, egressRoot: path.join(base, "setup-egress") };
}

function guestOf(w: ReturnType<typeof world>) {
  mkdirSync(w.jobsRoot, { recursive: true, mode: 0o700 });
  const root = path.join(w.jobsRoot, "g-test");
  mkdirSync(root, { mode: 0o700 });
  return { ...createHostGuest(w.deps, "su-1", root), root };
}

async function drain(command: Awaited<ReturnType<ReturnType<typeof guestOf>["guest"]["runCommand"]>>): Promise<{ out: string; exit: number }> {
  let out = "";
  for await (const chunk of command.logs()) out += `${chunk.stream}:${String(chunk.data)}`;
  return { out, exit: (await command.wait()).exitCode };
}

describe("D#587 B-9d: WSL2 networking mode", () => {
  const machine = (nat: boolean): NonNullable<HostGuestDeps["wsl"]> => ({ interopEntry: () => false, mountinfo: () => "26 1 8:16 / / rw,relatime - ext4 /dev/sdb rw\n", clearance: { denyPaths: ["/mnt"], nat } });

  it("a machine job on a clearance that was not granted for NAT (the microVM exemption, then a switch to os_sandbox) starts nothing, as an ordinary job does; a NAT clearance runs it", async () => {
    const refused = world();
    refused.deps.wsl = machine(false);
    await expect(guestOf(refused).guest.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ code: "wsl_mirrored_networking" });
    expect(refused.started).toEqual([]);
    const allowed = world();
    allowed.deps.wsl = machine(true);
    await guestOf(allowed).guest.runCommand({ cmd: "true", detached: true });
    expect(allowed.started).toHaveLength(1);
  });
});

describe("what a command is started with", () => {
  it("runs under bubblewrap with the settings' rules: no write outside the job root, the home, state and agent directories hidden, the shared temp directories hidden, no network", async () => {
    const w = world();
    const g = guestOf(w);
    await g.guest.runCommand({ cmd: "echo", args: ["a b"], detached: true });
    const run = w.started[0] as Started;
    expect(path.basename(run.tool)).toBe("bwrap");
    const args = run.args;
    expect(args).toEqual(expect.arrayContaining(["--unshare-net", "--unshare-pid", "--unshare-user", "--die-with-parent", "--new-session"]));
    const binds = (flag: string): string[] => args.flatMap((arg, i) => (arg === flag ? [args[i + 1] as string] : []));
    // the only writable places are the root and its own temp directory
    expect(binds("--bind-try").sort()).toEqual([g.root, path.join(g.root, "tmp")].sort());
    for (const hidden of [w.home, w.stateDir, w.jobsRoot, path.join(w.base, "engine-bin"), "/tmp", "/var/tmp", "/dev/shm"]) {
      if (existsSync(hidden)) expect(binds("--tmpfs").some((dir) => hidden === dir || hidden.startsWith(`${dir}/`)), hidden).toBe(true);
    }
    // the command is the wrapper, then the host's words as separate arguments
    const tail = args.slice(args.indexOf("--") + 1);
    expect(tail.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(tail.slice(3, 4)).toEqual(["fx-egress"]);
    // the socket is NOT below the root the command can write: it is in the runner's own egress directory, which the sandbox is given read-only
    expect(tail.slice(4)).toEqual([path.join(w.egressRoot, "g-test", "v.sock_5253"), run.tool, "echo", "a b"]);
    expect(path.join(w.egressRoot, "g-test", "v.sock_5253").startsWith(`${g.root}${path.sep}`)).toBe(false);
    expect(binds("--bind-try").some((dir) => w.egressRoot.startsWith(dir) || dir.startsWith(w.egressRoot))).toBe(false);
    expect(binds("--ro-bind-try")).toContain(path.join(w.egressRoot, "g-test"));
    expect(binds("--tmpfs").some((dir) => w.egressRoot === dir || w.egressRoot.startsWith(`${dir}/`))).toBe(true);
    expect(run.cwd).toBe(g.root);
  });

  it("puts the runner's own program words in the wrapper single-quoted, so a space or a quote in a path is one word", async () => {
    const w = world();
    const g = guestOf(w);
    await g.guest.runCommand({ cmd: "true", detached: true });
    const script = (w.started[0] as Started).args[(w.started[0] as Started).args.indexOf("--") + 3] as string;
    expect(script).toContain(`'/opt/fictional runner/fx runner' 'it'\\''s.mjs' __egress-serve "$SOCK"`);
    // the forwarder is started before, and without, the filter's fd; the command is the second bubblewrap that loads it
    expect(script).toContain('__egress-serve "$SOCK" >/dev/null 2>&1 3<&- &');
    // readiness is the loopback port answering, never a file (a file the forwarder can write is a file the command can write)
    expect(script).toContain(`'/opt/fictional runner/fx runner' 'it'\\''s.mjs' __egress-wait`);
    expect(script).not.toMatch(/READY|ready/);
    // the command is in a process-id namespace of its own with its own /proc: the forwarder is not in it
    expect(script).toContain('"$BW" --seccomp 3 --die-with-parent --unshare-pid --dev-bind / / --proc /proc -- "$@"; RC=$?');
    expect(script.indexOf("__egress-serve")).toBeLessThan(script.indexOf("--seccomp"));
  });

  it("feeds the Unix-socket filter to the command and hides the user's runtime directory (the session bus), as the check's sandbox does", async () => {
    const w = world();
    const g = guestOf(w);
    await g.guest.runCommand({ cmd: "true", detached: true });
    const run = w.started[0] as Started;
    expect(run.feed?.equals(unixSocketFilter() as Buffer)).toBe(true);
    if (existsSync(USER_RUNTIME_ROOT)) {
      const tmpfs = run.args.flatMap((arg, i) => (arg === "--tmpfs" ? [run.args[i + 1]] : []));
      expect(tmpfs).toContain(USER_RUNTIME_ROOT);
      // the hiding is part of the outer sandbox's own rules, before the command
      expect(run.args.lastIndexOf(USER_RUNTIME_ROOT)).toBeLessThan(run.args.indexOf("--"));
    }
  });

  it("starts nothing when this machine has no filter program (fail closed)", async () => {
    const w = world();
    const g = guestOf(w);
    // the filter is built for os.arch(); an architecture it does not know gives none
    const spy = vi.spyOn(os, "arch").mockReturnValue("riscv64");
    try {
      await expect(g.guest.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ code: "sandbox_unavailable" });
    } finally {
      spy.mockRestore();
    }
    expect(w.started).toEqual([]);
  });

  it("gives the command the host's PATH and a HOME and TMPDIR inside the root, the microVM table's pinned names, and no USER or LOGNAME", async () => {
    const w = world();
    const g = guestOf(w);
    await g.guest.runCommand({ cmd: "true", env: guestEnvOf({}), detached: true });
    const env = (w.started[0] as Started).env;
    expect(env["PATH"]).toBe(w.deps.searchPath);
    expect(env["HOME"]).toBe(path.join(g.root, "tmp"));
    expect(env["TMPDIR"]).toBe(path.join(g.root, "tmp"));
    expect(env["HTTPS_PROXY"]).toBe("http://127.0.0.1:5253");
    expect(env).not.toHaveProperty("USER");
    expect(env).not.toHaveProperty("LOGNAME");
    // the pinned git rewrite names are the only ones with "KEY" in them
    expect(Object.keys(env).filter((name) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && !/^GIT_CONFIG_KEY_\d$/.test(name))).toEqual([]);
  });

  it("refuses a name outside the microVM's table or a pinned name with another value, and a working directory outside the root", async () => {
    const w = world();
    const g = guestOf(w);
    await expect(g.guest.runCommand({ cmd: "true", env: { ANTHROPIC_API_KEY: "x" }, detached: true })).rejects.toMatchObject({ code: "env_refused" });
    await expect(g.guest.runCommand({ cmd: "true", env: { HTTPS_PROXY: "http://example.test:1" }, detached: true })).rejects.toMatchObject({ code: "env_refused" });
    await expect(g.guest.runCommand({ cmd: "true", cwd: w.home, detached: true })).rejects.toMatchObject({ code: "path_refused" });
    expect(w.started).toEqual([]);
  });

  it("starts nothing when the sandbox tool is missing", async () => {
    const w = world();
    rmSync(path.join(w.deps.searchPath, "bwrap"));
    const g = guestOf(w);
    await expect(g.guest.runCommand({ cmd: "true", detached: true })).rejects.toBeInstanceOf(HostGuestRefused);
    expect(w.started).toEqual([]);
  });

  it("on macOS lays loopback and the proxy's one socket over the profile's denial of the network", async () => {
    const w = world({ platform: "darwin" });
    // this machine has no Seatbelt tool: a stand-in answers the tool check
    w.deps.host = { ...w.deps.host, isFile: (target: string) => target.endsWith("/sandbox-exec") };
    const g = guestOf(w);
    await g.guest.runCommand({ cmd: "true", detached: true });
    const run = w.started[0] as Started;
    expect(path.basename(run.tool)).toBe("sandbox-exec");
    const profile = run.args[1] as string;
    expect(profile).toContain("(deny network*)");
    // only the forwarder's one port, in and out: not every loopback port
    expect(profile.indexOf('(local ip "localhost:5253")')).toBeGreaterThan(profile.indexOf("(deny network*)"));
    expect(profile).toContain('(allow network* (local ip "localhost:5253") (remote ip "localhost:5253"))');
    expect(profile).not.toContain("localhost:*");
    expect(profile).toContain(`(path-literal "${path.join(w.egressRoot, "g-test", "v.sock_5253")}")`);
    expect(profile).toContain(`(allow file-write* (subpath "${g.root}")`);
  });
});

describe("the output and the exit code", () => {
  it("hands each chunk to logs() with its stream, whole multi-byte characters across chunks, and ends on the exit code", async () => {
    const euro = Buffer.from("€", "utf8");
    const w = world({ code: 3, chunks: [["stdout", Buffer.from("a")], ["stdout", euro.subarray(0, 1)], ["stdout", euro.subarray(1)], ["stderr", Buffer.from("e")]] });
    const g = guestOf(w);
    const done = await drain(await g.guest.runCommand({ cmd: "true", detached: true }));
    expect(done).toEqual({ out: "stdout:astdout:€stderr:e", exit: 3 });
  });

  it("reads a command that was killed (no exit code) as 137", async () => {
    const w = world({ code: null });
    const g = guestOf(w);
    expect((await drain(await g.guest.runCommand({ cmd: "true", detached: true }))).exit).toBe(137);
  });
});

describe("files go in only below the root, and never through a link", () => {
  it("writes with the given mode, makes missing parents, and refuses a path outside, a relative one and a dot-dot", async () => {
    const w = world();
    const g = guestOf(w);
    await g.guest.writeFiles([{ path: path.join(g.root, "stage", "a", "b.txt"), content: "x€", mode: 0o600 }]);
    expect(readFileSync(path.join(g.root, "stage", "a", "b.txt"), "utf8")).toBe("x€");
    expect(lstatSync(path.join(g.root, "stage", "a", "b.txt")).mode & 0o777).toBe(0o600);
    for (const bad of [path.join(w.home, "x"), "relative.txt", `${g.root}/../escape.txt`, g.root]) {
      await expect(g.guest.writeFiles([{ path: bad, content: "x" }]), bad).rejects.toMatchObject({ code: "path_refused" });
    }
    expect(existsSync(path.join(w.base, "escape.txt"))).toBe(false);
  });

  it("refuses a parent that is a link and a last name that is a link, and writes nothing through either", async () => {
    const w = world();
    const g = guestOf(w);
    const outside = path.join(w.base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "target.txt"), "keep");
    symlinkSync(outside, path.join(g.root, "linked-dir"));
    symlinkSync(path.join(outside, "target.txt"), path.join(g.root, "linked-file"));
    await expect(g.guest.writeFiles([{ path: path.join(g.root, "linked-dir", "target.txt"), content: "pwn" }])).rejects.toMatchObject({ code: "path_refused" });
    await expect(g.guest.writeFiles([{ path: path.join(g.root, "linked-file"), content: "pwn" }])).rejects.toThrow();
    expect(readFileSync(path.join(outside, "target.txt"), "utf8")).toBe("keep");
  });

  it("refuses everything after close", async () => {
    const w = world();
    const g = guestOf(w);
    await g.guest.close();
    await expect(g.guest.writeFiles([{ path: path.join(g.root, "a"), content: "x" }])).rejects.toMatchObject({ code: "closed" });
    await expect(g.guest.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ code: "closed" });
  });
});

describe("the egress policy", () => {
  it("starts no proxy before a policy is given, refuses one it cannot read (the guest keeps no way out), and replaces the proxy when a new one is given", async () => {
    const w = world();
    const g = guestOf(w);
    const socket = path.join(w.egressRoot, "g-test", "v.sock_5253");
    expect(existsSync(socket)).toBe(false);
    await expect(g.guest.updateNetworkPolicy({ allow: ["*.example.test"] })).rejects.toThrow();
    expect(existsSync(socket)).toBe(false);
    await g.guest.updateNetworkPolicy({ allow: ["pypi.org"] });
    expect(lstatSync(socket).isSocket()).toBe(true);
    // the standard tier's socket is never chmod-ed by name: it keeps the mode bind gave it (0777 less the umask), which its owner can connect to
    expect(lstatSync(socket).mode & 0o777).toBe(0o777 & ~process.umask());
    expect(lstatSync(path.join(w.egressRoot, "g-test")).mode & 0o7777).toBe(0o1770);
    expect(existsSync(path.join(g.root, "egress"))).toBe(false);
    await g.guest.updateNetworkPolicy({ allow: ["registry.npmjs.org"] });
    expect(lstatSync(socket).isSocket()).toBe(true);
    await g.guest.close();
    expect(existsSync(socket)).toBe(false);
    // the directory goes with the guest
    expect(existsSync(path.join(w.egressRoot, "g-test"))).toBe(false);
  });
});

describe("a link swapped in for the socket's name after the bind", () => {
  /** `listen` as the real one, except that the socket file is replaced by a link to `victim` the moment the bind is done (what a guest sharing the directory would do). */
  function swapping(victim: string): http.Server {
    const server = http.createServer();
    const real = server.listen.bind(server) as (...args: unknown[]) => http.Server;
    (server as unknown as { listen: (...args: unknown[]) => http.Server }).listen = (socketPath: unknown, done: unknown) =>
      real(socketPath, () => {
        rmSync(socketPath as string, { force: true });
        symlinkSync(victim, socketPath as string);
        (done as () => void)();
      });
    return server;
  }

  for (const ownerOnly of [true, false]) {
    it(`${ownerOnly ? "the standard tier's" : "the default"} listener refuses, and the file the link points to keeps its mode`, async () => {
      const dir = mkdtempSync(path.join(socketTmpRoot(), "fxchm-"));
      roots.push(dir);
      const victim = path.join(dir, "victim.txt");
      writeFileSync(victim, "keep", { mode: 0o600 });
      const server = swapping(victim);
      await expect(listenOnSocket(server, path.join(dir, "s.sock"), process.getuid?.() ?? 0, ownerOnly)).rejects.toThrow(/not a socket of this user/);
      expect(lstatSync(victim).mode & 0o777).toBe(0o600);
      server.close();
    });
  }
});

describe("the job roots", () => {
  it("makes one root per sandbox name, with the guest paths known from the name alone, removes it with the guest, and sweeps a root a crash left", async () => {
    const w = world();
    mkdirSync(w.jobsRoot, { mode: 0o700 });
    mkdirSync(path.join(w.jobsRoot, "g-left-by-a-crash", "locked"), { recursive: true });
    mkdirSync(w.egressRoot, { mode: 0o700 });
    mkdirSync(path.join(w.egressRoot, "g-left-by-a-crash"));
    chmodSync(path.join(w.jobsRoot, "g-left-by-a-crash", "locked"), 0o500);
    const vm = createHostSetupVm(w.deps);
    const paths = vm.pathsOf("su-job-1");
    const port = vm.lifecycle.port as Exclude<typeof vm.lifecycle.port, (...args: never[]) => unknown>;
    await port.create("su-job-1", "agent");
    expect(existsSync(path.join(w.jobsRoot, "g-left-by-a-crash"))).toBe(false);
    expect(existsSync(path.join(w.egressRoot, "g-left-by-a-crash"))).toBe(false);
    expect(path.dirname(paths.workspace)).toBe(path.dirname(paths.stage));
    expect(path.dirname(path.dirname(paths.stage))).toBe(w.jobsRoot);
    const guest = await vm.guestOf({ runId: "", sandboxName: "su-job-1", sessionId: "" });
    await guest.writeFiles([{ path: path.join(paths.stage, "f"), content: "x" }]);
    expect(existsSync(path.join(paths.stage, "f"))).toBe(true);
    await port.delete("su-job-1");
    expect(existsSync(path.dirname(paths.stage))).toBe(false);
    await expect(vm.guestOf({ runId: "", sandboxName: "su-job-1", sessionId: "" })).rejects.toBeInstanceOf(HostGuestRefused);
  });

  it("waits for the command's process group to end before the root is walked", async () => {
    const w = world();
    let ended = false;
    let release: (() => void) | undefined;
    w.deps.start = async (_tool, _args, _env, _cwd, _limit, _tail, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal?.addEventListener("abort", () => setTimeout(resolve, 300), { once: true });
      });
      ended = true;
      return { code: null, tail: "", timedOut: false, aborted: true };
    };
    const vm = createHostSetupVm(w.deps);
    const port = vm.lifecycle.port as Exclude<typeof vm.lifecycle.port, (...args: never[]) => unknown>;
    await port.create("su-wait", "agent");
    const guest = await vm.guestOf({ runId: "", sandboxName: "su-wait", sessionId: "" });
    await guest.runCommand({ cmd: "sleep", args: ["1000"], detached: true });
    const root = path.dirname(vm.pathsOf("su-wait").stage);
    await port.delete("su-wait");
    // `delete` returned only after the command's process group ended, and only then was the root removed
    expect(ended).toBe(true);
    expect(existsSync(root)).toBe(false);
    release?.();
  });

  it("never walks or changes anything through a link left in the root", async () => {
    const w = world();
    const outside = path.join(w.base, "outside");
    mkdirSync(path.join(outside, "inner"), { recursive: true });
    chmodSync(path.join(outside, "inner"), 0o500);
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    const vm = createHostSetupVm(w.deps);
    const port = vm.lifecycle.port as Exclude<typeof vm.lifecycle.port, (...args: never[]) => unknown>;
    await port.create("su-link", "agent");
    const root = path.dirname(vm.pathsOf("su-link").stage);
    symlinkSync(outside, path.join(root, "dir-link"));
    symlinkSync(path.join(outside, "keep.txt"), path.join(root, "file-link"));
    mkdirSync(path.join(root, "locked"));
    chmodSync(path.join(root, "locked"), 0o500);
    await port.delete("su-link");
    expect(existsSync(root)).toBe(false);
    // the target of the link is untouched: still there, its mode not widened, its contents not removed
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(lstatSync(path.join(outside, "inner")).mode & 0o777).toBe(0o500);
    chmodSync(path.join(outside, "inner"), 0o700);
  });

  it("refuses a jobs root that is not a private directory of this user", async () => {
    const w = world();
    mkdirSync(w.jobsRoot, { mode: 0o755 });
    chmodSync(w.jobsRoot, 0o755);
    const vm = createHostSetupVm(w.deps);
    const port = vm.lifecycle.port as Exclude<typeof vm.lifecycle.port, (...args: never[]) => unknown>;
    await expect(port.create("su-job-2", "agent")).rejects.toMatchObject({ code: "root_unusable" });
  });

  it("admits one guest at a time", async () => {
    const w = world();
    const vm = createHostSetupVm(w.deps);
    expect(vm.lifecycle.caps?.maxVms).toBe(1);
  });
});

describe("choosing the guest by the engine", () => {
  const context = (reports: unknown[]) => ({ job: {} as never, signal: new AbortController().signal, reporter: { closed: false, report: async (step: unknown) => (reports.push(step), "recorded" as const) } });

  it("runs the microVM handler on microvm and the standard one on os_sandbox, asking the engine for each job", async () => {
    const ran: string[] = [];
    let engine: "microvm" | "os_sandbox" = "os_sandbox";
    const handler = setupHandlerFor({ microvm: async () => void ran.push("microvm"), standard: async () => void ran.push("standard") }, () => engine);
    await handler?.(context([]));
    engine = "microvm";
    await handler?.(context([]));
    expect(ran).toEqual(["standard", "microvm"]);
  });

  it("reports engine_unsupported (and starts nothing) when the engine's guest is not in this build, and has no handler at all when there are neither", async () => {
    const reports: unknown[] = [];
    await setupHandlerFor({ microvm: async () => undefined, standard: undefined }, () => "os_sandbox")?.(context(reports));
    expect(reports).toEqual([{ sub_step: "engine_fetch", state: "failed", failure_code: "engine_unsupported", failure_reason: "no_guest" }]);
    expect(setupHandlerFor({ microvm: undefined, standard: undefined }, () => "os_sandbox")).toBeUndefined();
  });
});

describe("the __egress-serve command", () => {
  it("is a hidden command that wants one absolute socket, and starts nothing without it", async () => {
    const out: string[] = [];
    for (const argv of [["__egress-serve"], ["__egress-serve", "relative.sock"]]) {
      expect(await runCli({ argv, home: "/home/fictional", stdout: (t) => void out.push(t), stderr: (t) => void out.push(t) }), argv.join(" ")).toBe(2);
    }
    expect(out.join("")).toContain("an absolute socket");
    const help: string[] = [];
    expect(await runCli({ argv: ["--help"], home: "/home/fictional", stdout: (t) => void help.push(t), stderr: () => undefined })).toBe(0);
    expect(help.join("")).not.toContain("__egress-serve");
    expect(help.join("")).not.toContain("__egress-wait");
  });
});
