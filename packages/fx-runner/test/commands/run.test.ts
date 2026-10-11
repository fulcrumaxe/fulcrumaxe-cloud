import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelloMessage } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../../src/cliError.js";
import { readHostFacts } from "../../src/hostFacts.js";
import { RUNNER_VERSION } from "../../src/version.js";
import { loadRegistration, saveRegistration } from "../../src/config.js";
import { writeApiKey } from "../../src/credentials.js";
import type { CommandContext } from "../../src/context.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { PINNED_JOB_KEYS, keyringFor, originHash } from "../../src/keyring.js";
import { runCli } from "../../src/cli.js";
import type { ResourceProbe } from "../../src/daemon/resources.js";
import { pidIsAlive, runCommand, type RunHooks, type RunHost } from "../../src/commands/run.js";
import { readEntries, requestTakeover, takeoverState } from "../../src/watch/layout.js";
import { authText, fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { until } from "../helpers/manualClock.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { KEY_ID, KEYRING, OTHER_KEYRING, signedJob } from "../helpers/signedJob.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";

let root: string;
let home: string;
let stateDir: string;
let cloud: StrictRunnerCloud;
let fake: Fake;
let toolbin: string;
let key: ReturnType<typeof generateRunnerKey>;
const children: Array<ReturnType<typeof spawn>> = [];

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function register(origin: string): void {
  key = generateRunnerKey();
  saveRunnerKey(stateDir, key);
  saveRegistration(stateDir, { version: 1, cloud_origin: origin, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
  cloud.trust(key.publicJwk);
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-run-"));
  home = path.join(root, "home");
  stateDir = path.join(home, ".fx-runner");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  cloud = await startStrictRunnerCloud();
  // One init line and then the agent waits, so a run is "in hand" until it is stopped.
  fake = makeFake({ stream: fixtureText("stream.subscription.jsonl").split("\n")[0]! + "\n" });
  toolbin = path.join(root, "toolbin");
  mkdirSync(toolbin);
  for (const name of ["bwrap", "socat"]) {
    writeFileSync(path.join(toolbin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(toolbin, name), 0o755);
  }
  symlinkSync(fake.binary, path.join(toolbin, "claude"));
  register(cloud.origin);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(fake.dir, { recursive: true, force: true });
});

type Signals = EventEmitter & RunHost["signals"];
/** A stand-in for the process's signal source: `emit("SIGTERM")` is what the operating system's signal would do. */
const newSignals = (): Signals => new EventEmitter() as unknown as Signals;

/** What the program's entry point hands `run`: the real pid, the real kill and the real process start. */
const hostWith = (signals: RunHost["signals"]): RunHost => ({ home, platform: "linux", signals, pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), engine: createClaudeKit(spawn), sandbox: fakeSandboxHost() });

/** A machine with room for everything: the composed-daemon tests are about other things than this machine's free memory. */
const GB = 1024 ** 3;
const ROOMY: ResourceProbe = { read: () => ({ totalMemBytes: 64 * GB, availMemBytes: 60 * GB, load1: 0, cores: 32, freeDiskBytes: 500 * GB }) };

const claims = (): number => cloud.seen.filter((s) => s.path === "/api/runner/claim").length;

function ctxOf(over: Partial<CommandContext> = {}): { ctx: CommandContext; out: string[] } {
  const out: string[] = [];
  return { ctx: { stateDir, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(), fetchFn: fetch, ...over }, out };
}

interface Started {
  signals: Signals;
  /** Every line the command printed so far. */
  out: string[];
  done: Promise<{ code: number; message: string; out: string[] }>;
}

/** Starts `run` in the background; `signals` is where a test sends SIGTERM. */
function start(over: { host?: Partial<RunHost>; hooks?: RunHooks; ctx?: Partial<CommandContext> } = {}): Started {
  const signals = newSignals();
  const { ctx, out } = ctxOf(over.ctx);
  const host: RunHost = { ...hostWith(signals), ...over.host };
  const hooks: RunHooks = { keyrings: { [originHash(cloud.origin)!]: KEYRING }, searchPath: toolbin, probe: ROOMY, jobLimits: { enforced: true }, ...over.hooks };
  const done = runCommand(ctx, host, hooks).then(
    (code) => ({ code, message: "", out }),
    (error: unknown) => {
      if (!(error instanceof CliError)) throw error;
      return { code: error.exitCode, message: error.message, out };
    },
  );
  return { signals, done, out };
}

async function stop(run: Started): Promise<{ code: number; message: string }> {
  run.signals.emit("SIGTERM");
  return run.done;
}

describe("1. the keyring is pinned in the build", () => {
  it("an address with no pinned keys refuses before the first claim, with the fixed code", async () => {
    register("https://cloud.example.test");
    const fetchFn = vi.fn(async () => new Response("{}"));
    const result = await start({ ctx: { fetchFn: fetchFn as unknown as typeof fetch }, hooks: { keyrings: {} } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("job_keyring_missing");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the committed table pins nothing for production yet, so run refuses a production address", async () => {
    register("https://cloud.example.test");
    const fetchFn = vi.fn(async () => new Response("{}"));
    const { hooks } = { hooks: { searchPath: toolbin } };
    const { ctx } = ctxOf({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(runCommand(ctx, hostWith(newSignals()), hooks)).rejects.toThrow(/job_keyring_missing/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a job signed by a key outside the pinned set is refused job_signature_invalid and nothing is run", async () => {
    const job = signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    const run = start({ hooks: { keyrings: { [originHash(cloud.origin)!]: OTHER_KEYRING } } });
    await until(() => cloud.runs.get(job.job.run_id)?.endedBy !== undefined);
    expect(cloud.runs.get(job.job.run_id)!.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "job_signature_invalid" });
    expect(await stop(run)).toMatchObject({ code: 0 });
    expect(fake.spawnCount()).toBe(0);
    expect(existsSync(path.join(stateDir, "jobs"))).toBe(false);
    expect(existsSync(path.join(home, ".cache", "fx-runner", "workspaces"))).toBe(false);
  });
});

describe("1-hello. the machine's facts are sent once on start (D#605 FL-2)", () => {
  const hellos = (): Array<{ path: string; body: unknown }> => cloud.seen.filter((s) => s.path === "/api/runner/hello");

  it("sends one hello before the first claim, in the strict protocol shape, with facts read from this machine", async () => {
    const run = start();
    await until(() => claims() >= 1);
    expect(hellos()).toHaveLength(1);
    expect(cloud.seen.findIndex((s) => s.path === "/api/runner/hello")).toBeLessThan(cloud.seen.findIndex((s) => s.path === "/api/runner/claim"));
    const sent = HelloMessage.parse(hellos()[0]!.body);
    expect(sent).toMatchObject({ protocol_version: 1, isolation: "host_sandbox", binary_version: RUNNER_VERSION });
    expect(sent.facts).toEqual(readHostFacts());
    expect(sent.facts).toMatchObject({ os: "linux", sandbox_engine: "os_sandbox" });
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("keeps claiming when the cloud refuses the hello (a cloud that predates facts answers 400, an older still 404)", async () => {
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const run = start();
    await until(() => claims() >= 1);
    expect(hellos()).toHaveLength(1);
    expect(await stop(run)).toMatchObject({ code: 0 });
  });
});

describe("1a. the toolchain is found once at start (D#6 R4d-3)", () => {
  it("prints what it found, and what is missing, on the search path the run was given", async () => {
    register(cloud.origin);
    const nodeDir = path.join(root, "store", "nodejs", "bin");
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(path.join(nodeDir, "node"), "#!/bin/sh\n");
    chmodSync(path.join(nodeDir, "node"), 0o755);
    const run = start({ hooks: { searchPath: `${toolbin}:${nodeDir}` } });
    await until(() => run.signals.listenerCount("SIGTERM") > 0);
    const stopped = await stop(run);
    expect(stopped.code).toBe(0);
    const out = (await run.done).out;
    expect(out).toContain("fx-runner: toolchain: found node");
    expect(out.join("\n")).not.toContain("node not found");
  });

  it.skipIf(process.platform !== "linux")("a claimed job's agent starts with the toolchain directory at the end of its PATH, and the settings file keeps the home directory hidden", async () => {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    fake.set("hang", "");
    register(cloud.origin);
    const prefix = path.join(home, ".nvm", "versions", "node", "v22.1.0");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    writeFileSync(path.join(prefix, "bin", "node"), "#!/bin/sh\n");
    chmodSync(path.join(prefix, "bin", "node"), 0o755);
    cloud.enqueue(signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    const run = start({ hooks: { searchPath: `${toolbin}:${path.join(prefix, "bin")}`, remoteUrl: () => pathToFileURL(remote).href } });
    // env.txt exists as soon as the shell opens it, before `env` has written it; stdin.txt is opened only after `env` has finished, so the file is whole by then.
    await until(() => existsSync(path.join(fake.dir, "stdin.txt")), 20_000);
    const pathLine = fake.envText().split("\n").find((line) => line.startsWith("PATH="));
    expect(pathLine?.split("=")[1]?.split(":").pop()).toBe(path.join(prefix, "bin"));
    expect(readFileSync(path.join(fake.dir, "argv.txt"), "utf8")).toContain("--settings");
    await stop(run);
  }, 60_000);

  it("with no node anywhere, it says projects that need it cannot run their tests", async () => {
    register(cloud.origin);
    const run = start();
    await until(() => run.signals.listenerCount("SIGTERM") > 0);
    await stop(run);
    expect((await run.done).out).toContain("fx-runner: node not found: projects that need it cannot run their tests");
  });
});

describe("1b. nothing at run time changes the keyring", () => {

  it("setting FX_RUNNER_* variables leaves the answer for every address unchanged", () => {
    const origins = ["https://cloud.example.test", "http://127.0.0.1:1", "https://staging.example.test"];
    const before = origins.map((o) => keyringFor(o));
    vi.stubEnv("FX_RUNNER_JOB_SIGNER_ID", KEY_ID);
    vi.stubEnv("FX_RUNNER_JOB_SIGNING_KEY_PEM", "not-a-key");
    vi.stubEnv("FX_RUNNER_JOB_PUBLIC_KEYS", JSON.stringify(KEYRING));
    vi.stubEnv("FX_RUNNER_KEYRING", JSON.stringify(KEYRING));
    expect(origins.map((o) => keyringFor(o))).toEqual(before);
    expect(origins.map((o) => keyringFor(o))).toEqual([undefined, undefined, undefined]);
  });

  it("the keyring module names no environment, file or flag, and the entry point never passes one", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "keyring.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(text).not.toMatch(/process|\benv\b|node:fs|readFile|argv/);
    for (const file of ["bin/fx-runner.mjs", "src/cli.ts"]) expect(readFileSync(path.join(PACKAGE_DIR, file), "utf8"), file).not.toMatch(/keyring/i);
  });

  it("only public halves are committed: every pinned entry is a bare Ed25519 JWK", () => {
    for (const set of Object.values(PINNED_JOB_KEYS)) {
      for (const jwk of Object.values(set)) expect(Object.keys(jwk as object).sort()).toEqual(["crv", "kty", "x"]);
    }
    expect(Object.isFrozen(PINNED_JOB_KEYS)).toBe(true);
  });

  const STAGING_HASH = "c99106f0f3e8720c0d2d5f275f8d341a21367d193ffbb416e7a73a9ebb00fe0f";
  const STAGING_KEY = { "staging-2026-10": { kty: "OKP", crv: "Ed25519", x: "FJkPp3H78wE-VIwcXU1bOt7XZDswNqr13ogaq-8tzdo" } };

  it("the staging entry is keyed by a hash and holds exactly the staging key; no committed table key is an address", () => {
    expect(Object.keys(PINNED_JOB_KEYS)).toEqual([STAGING_HASH]);
    expect(PINNED_JOB_KEYS[STAGING_HASH]).toEqual(STAGING_KEY);
    for (const name of Object.keys(PINNED_JOB_KEYS)) expect(name).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an address resolves when the hash of its origin is in the table, and not by address text", () => {
    const table = { [originHash("https://keyring-test.invalid")!]: KEYRING };
    expect(keyringFor("https://keyring-test.invalid", table)).toBe(KEYRING);
    expect(keyringFor("https://keyring-test.invalid", {})).toBeUndefined();
    expect(keyringFor("https://other.invalid", table)).toBeUndefined();
    expect(keyringFor("https://keyring-test.invalid", { "https://keyring-test.invalid": KEYRING })).toBeUndefined();
  });

  it("normalisation: a trailing slash, upper case and the default port are the same origin; another port or scheme is not", () => {
    const table = { [originHash("https://keyring-test.invalid")!]: KEYRING };
    for (const same of ["https://keyring-test.invalid/", "https://KEYRING-TEST.invalid", "https://keyring-test.invalid:443"]) expect(keyringFor(same, table), same).toBe(KEYRING);
    for (const other of ["https://keyring-test.invalid:8443", "http://keyring-test.invalid", "https://sub.keyring-test.invalid", "not an address", ""]) expect(keyringFor(other, table), other).toBeUndefined();
  });

  it("production-style and unpinned origins refuse, in the table and in the command", async () => {
    for (const other of ["https://fulcrumaxe.dev", "https://cloud.fulcrumaxe.dev", "https://fulcrumaxe.app", "https://keyring-test.invalid"]) expect(keyringFor(other), other).toBeUndefined();
    register("https://fulcrumaxe.dev");
    const { ctx } = ctxOf({ fetchFn: (async () => { throw new Error("no network"); }) as unknown as typeof fetch });
    await expect(runCommand(ctx, hostWith(newSignals()), { searchPath: toolbin })).rejects.toThrow(/job_keyring_missing/);
  });

  it("an inherited name is not an entry", () => {
    const hash = originHash("https://keyring-test.invalid")!;
    expect(keyringFor("https://keyring-test.invalid", Object.create({ [hash]: KEYRING }) as Record<string, never>)).toBeUndefined();
    expect(keyringFor("https://keyring-test.invalid", { [hash]: {} })).toBeUndefined();
  });
});

describe("2. the ledger: this process's pid, a real liveness check, one run per state directory", () => {
  const lockFile = (): string => path.join(stateDir, "jobs.ledger.lock");
  const exited = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve) => child.once("close", () => resolve()));

  it("pidIsAlive: this process and another user's process (EPERM, or success as root) are alive; a finished child is not", async () => {
    expect(pidIsAlive(process.kill, process.pid)).toBe(true);
    expect(pidIsAlive(process.kill, 1)).toBe(true);
    const child = spawn("true");
    await exited(child);
    expect(pidIsAlive(process.kill, child.pid!)).toBe(false);
  });

  it("a second run on the same state directory exits non-zero, makes no claim, and the first one is undisturbed", async () => {
    const first = start();
    await until(() => claims() >= 1);
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
    const before = claims();
    // A stale leftover is cleaned before the lock is looked at, also by the run that then fails to take it.
    const stale = path.join(stateDir, "jobs.ledger.0123456789ab.tmp");
    writeFileSync(stale, "x");
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, old, old);
    const second = await start().done;
    expect(second.code).not.toBe(0);
    expect(second.message).toBe("another fx-runner run is using this state directory");
    expect(claims()).toBe(before);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(lockFile())).toBe(true);
    expect(await stop(first)).toMatchObject({ code: 0 });
    expect(existsSync(lockFile())).toBe(false);
  });

  it("a lock held by a live process of another user (pid 1) or another live process refuses; no claim is made", async () => {
    const sleeper = spawn("sleep", ["30"]);
    children.push(sleeper);
    for (const pid of [1, sleeper.pid!]) {
      writeFileSync(lockFile(), `${pid}\n`, { mode: 0o600 });
      const result = await start().done;
      expect(result.code, `pid ${pid}`).not.toBe(0);
      expect(result.message).toContain("another fx-runner run");
      expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(pid));
    }
    expect(claims()).toBe(0);
  });

  it("a lock left by a process that is gone is taken over, and the run claims", async () => {
    const dead = spawn("true");
    await exited(dead);
    writeFileSync(lockFile(), `${dead.pid}\n`, { mode: 0o600 });
    const run = start();
    await until(() => claims() >= 1);
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
    expect(await stop(run)).toMatchObject({ code: 0 });
  });
});

describe("3. a closed ledger makes no claim and exits non-zero once", () => {
  it("a damaged ledger file: zero claim requests, non-zero exit, the lock released, the file moved aside", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "jobs.ledger"), "{ this is not json", { mode: 0o600 });
    const result = await start().done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("ledger_closed");
    expect(claims()).toBe(0);
    expect(cloud.seen).toEqual([]);
    expect(existsSync(path.join(stateDir, "jobs.ledger.lock"))).toBe(false);
    expect(readdirSync(stateDir).some((n) => n.startsWith("jobs.ledger.damaged-"))).toBe(true);
  });

  it("a ledger that is missing next to a moved-aside one is closed too", async () => {
    writeFileSync(path.join(stateDir, "jobs.ledger.damaged-1-abc"), "{}");
    const result = await start().done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("ledger_closed");
    expect(claims()).toBe(0);
  });
});

describe("4. the git path gets the real state directory and a mirrors root that overlaps nothing", () => {
  it("a mirrors root inside the state directory refuses to start, before the ledger is taken and before any claim", async () => {
    const result = await start({ host: { xdgCacheHome: path.join(stateDir, "cache") } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("mirrors_root_overlap");
    expect(claims()).toBe(0);
    expect(existsSync(path.join(stateDir, "jobs.ledger.lock"))).toBe(false);
  });

  it("a mirrors root reached through a link into the state directory refuses too", async () => {
    mkdirSync(stateDir, { recursive: true });
    const alias = path.join(root, "alias");
    symlinkSync(stateDir, alias);
    const result = await start({ host: { xdgCacheHome: path.join(alias, "cache") } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("mirrors_root_overlap");
    expect(claims()).toBe(0);
  });
});

/** The ports this process is listening on, from the kernel's tables and this process's own descriptors (Linux). */
function listeningPorts(): number[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`));
      if (m) inodes.add(m[1]!);
    } catch {
      // fx-swallow-ok: a descriptor that closed while listing
    }
  }
  const ports: number[] = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const line of readFileSync(`/proc/net/${table}`, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "0A" && inodes.has(cols[9]!)) ports.push(parseInt(cols[1]!.split(":")[1]!, 16));
    }
  }
  return ports.sort();
}

describe("5. the composed daemon: a signal stops the job within 5 seconds and reports runner_shutdown", () => {
  it.skipIf(process.platform !== "linux")("a real SIGTERM, a local git remote and an agent that waits; the mirror is outside the state directory; no listening socket", async () => {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    fake.set("hang", "");
    const job = signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    const before = listeningPorts();
    expect(before).toEqual([Number(new URL(cloud.origin).port)]);

    const { ctx, out } = ctxOf();
    const finished = runCommand(ctx, hostWith(process), { keyrings: { [originHash(cloud.origin)!]: KEYRING }, searchPath: toolbin, probe: ROOMY, jobLimits: { enforced: true }, remoteUrl: () => pathToFileURL(remote).href });
    await until(() => existsSync(path.join(fake.dir, "argv.txt")), 20_000);
    expect(listeningPorts()).toEqual(before);

    const signalledAt = Date.now();
    process.kill(process.pid, "SIGTERM");
    expect(await finished).toBe(0);
    expect(Date.now() - signalledAt).toBeLessThan(5_000);
    expect(cloud.runs.get(job.job.run_id)!.endedBy).toMatchObject({ type: "run_ended", reason: "runner_shutdown" });
    expect(cloud.seen.some((s) => s.path.endsWith("/done"))).toBe(false);
    expect(out.join("\n")).toContain(`claimed ${job.job.run_id}`);
    // The mirror is where the git path was told to put it, and the state directory holds none.
    expect(existsSync(path.join(home, ".cache", "fx-runner", "mirrors", `${job.job.repo.id}.git`))).toBe(true);
    expect(readdirSync(stateDir).filter((n) => /mirror/i.test(n))).toEqual([]);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  }, 60_000);
});

describe("6. the claim gate in the composed daemon (D#6 R4a-6, C16 section 1.3)", () => {
  const claimBodies = (): unknown[] => cloud.seen.filter((s) => s.path === "/api/runner/claim").map((s) => s.body);
  const queuedJob = () => signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });

  it("a failing probe: the poll carries the reason, a queued job is not leased, nothing runs, the machine is told, and a stop is clean", async () => {
    const sandbox = fakeSandboxHost({ outcome: { code: 1, stdout: "", stderr: "bwrap: setting up uid map: Permission denied", timedOut: false }, sysctls: { "kernel.apparmor_restrict_unprivileged_userns": "1" } });
    const job = queuedJob();
    cloud.enqueue(job);
    const run = start({ host: { sandbox } });
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toEqual({ sandbox_unavailable: "apparmor_userns_restricted" });
    expect(cloud.runs.size).toBe(0);
    expect(fake.spawnCount()).toBe(0);
    expect(sandbox.calls).toHaveLength(1);
    const result = await stop(run);
    expect(result).toMatchObject({ code: 0 });
    expect(cloud.runs.size).toBe(0);
    // Nothing but the status polls and the one hello (D#605 FL-2: the machine says what it is even when its sandbox is down); no heartbeat, events or done.
    expect(cloud.seen.filter((s) => !s.path.endsWith("/claim") && !s.path.endsWith("/hello"))).toEqual([]);
    const said = (await run.done).out.join("\n");
    expect(said).toContain("the sandbox does not work on this machine (apparmor_userns_restricted)");
    expect(said).toContain("fx-runner doctor");
    expect(said).not.toContain(`claimed ${job.job.run_id}`);
  });

  it("a probe that cannot run at all fails closed: the reason is probe_failed_other and no job is taken", async () => {
    const sandbox = fakeSandboxHost();
    sandbox.run = async () => {
      throw new Error("spawn exploded at /secret/path");
    };
    cloud.enqueue(queuedJob());
    const run = start({ host: { sandbox } });
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toEqual({ sandbox_unavailable: "probe_failed_other" });
    expect(cloud.runs.size).toBe(0);
    expect(JSON.stringify(cloud.seen)).not.toContain("/secret/path");
    expect((await stop(run)).code).toBe(0);
  });

  it.each(["5.15.167.4-microsoft-standard-WSL2", "4.4.0-19041-Microsoft"])("a %s kernel refuses to start run by name: no claim, no probe, no stall", async (release) => {
    const sandbox = fakeSandboxHost();
    cloud.enqueue(queuedJob());
    const result = await start({ host: { sandbox, osrelease: release } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toMatch(/^wsl[12]_unsupported: fx-runner does not support Windows yet, including WSL2\. Linux and macOS are supported\.; fx-runner cannot run jobs here$/);
    expect(claims()).toBe(0);
    expect(sandbox.calls).toEqual([]);
    expect(cloud.runs.size).toBe(0);
  });

  it("a machine without bubblewrap starts, reports bwrap_missing, and does not exit (it used to refuse to start)", async () => {
    unlinkSync(path.join(toolbin, "bwrap"));
    const sandbox = fakeSandboxHost();
    cloud.enqueue(queuedJob());
    const run = start({ host: { sandbox } });
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toEqual({ sandbox_unavailable: "bwrap_missing" });
    expect(sandbox.calls).toEqual([]);
    expect(cloud.runs.size).toBe(0);
    expect((await stop(run)).code).toBe(0);
  });

  it("socat missing reports socat_missing the same way", async () => {
    unlinkSync(path.join(toolbin, "socat"));
    const run = start({ host: { sandbox: fakeSandboxHost() } });
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toEqual({ sandbox_unavailable: "socat_missing" });
    expect((await stop(run)).code).toBe(0);
  });

  it("a passing probe: the first poll is an ordinary claim with an empty body, and the queued job is leased", async () => {
    const sandbox = fakeSandboxHost();
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    const run = start({ host: { sandbox } });
    await until(() => cloud.runs.has(job.job.run_id), 20_000);
    // An ordinary claim: no sandbox reason, and the capacity this machine could take (D#6 C43-4).
    expect(claimBodies()[0]).toEqual({ capacity: { light: { limit: 8, in_use: 0 }, heavy: { limit: 4, in_use: 0 }, limited_by: null } });
    expect(sandbox.calls).toHaveLength(1);
    expect((await stop(run)).code).toBe(0);
  });

  it("where per-job limits cannot be enforced the claim declares the held-back ceilings (2 jobs, 1 heavy) and the runner says why (D#6 C43-5)", async () => {
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    const run = start({ hooks: { jobLimits: { enforced: false, reason: "no systemd user manager is running for this user" } } });
    await until(() => cloud.runs.has(job.job.run_id), 20_000);
    expect(claimBodies()[0]).toEqual({ capacity: { light: { limit: 2, in_use: 0 }, heavy: { limit: 1, in_use: 0 }, limited_by: null } });
    expect(run.out).toContain("fx-runner: per-job limits not enforced on this machine; concurrency capped (heavy 1, total 2) (no systemd user manager is running for this user)");
    expect((await stop(run)).code).toBe(0);
  });

  it("a machine whose free memory is below its reserve declares only the floor (one light slot) and refuses a heavy job a misbehaving cloud hands over (D#6 C43-4)", async () => {
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    const tight: ResourceProbe = { read: () => ({ ...ROOMY.read(), availMemBytes: 3 * GB }) };
    const run = start({ hooks: { probe: tight } });
    await until(() => run.out.some((line) => line.includes(`refused ${job.job.run_id}`)), 20_000);
    expect(claimBodies()[0]).toEqual({ capacity: { light: { limit: 1, in_use: 0 }, heavy: { limit: 0, in_use: 0 }, limited_by: null } });
    // The agent never started and the run was never held: no heartbeat, no events.
    expect(existsSync(path.join(fake.dir, "argv.txt"))).toBe(false);
    expect(cloud.seen.some((s) => s.path.endsWith("/heartbeat") || s.path.endsWith("/events"))).toBe(false);
    expect((await stop(run)).code).toBe(0);
  });

  it("the daemon passes a gate to the poll loop and builds the probe from the one shared function (no loop without a gate)", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");
    expect(text).toMatch(/pollLoop\(\{[^}]*\bgate\b/s);
    expect(text).toContain("probeMachine(");
    const loop = readFileSync(path.join(PACKAGE_DIR, "src", "daemon", "pollLoop.ts"), "utf8");
    expect(loop).toMatch(/gate: SandboxGate;/);
    expect(loop).not.toMatch(/gate\?:/);
  });
});

describe("the command line wiring", () => {
  const run = async (host: RunHost | undefined) => {
    let err = "";
    const code = await runCli({ argv: ["run"], home, stateDirOverride: stateDir, stdout: () => undefined, stderr: (t) => (err += t), ...(host === undefined ? {} : { host }) });
    return { code, err };
  };

  it("run without the program's host facts, or with an unregistered state directory, exits 1 with a plain message", async () => {
    expect(await run(undefined)).toMatchObject({ code: 1, err: expect.stringContaining("only available") });
    rmSync(stateDir, { recursive: true });
    expect(await run(hostWith(newSignals()))).toMatchObject({ code: 1, err: expect.stringContaining("not registered") });
  });

  it("run takes no options", async () => {
    let err = "";
    const code = await runCli({ argv: ["run", "--keyring", "x"], home, stateDirOverride: stateDir, stdout: () => undefined, stderr: (t) => (err += t) });
    expect(code).toBe(2);
    expect(err).toContain("unknown option");
  });

  it("the daemon files open no listening socket", () => {
    for (const file of ["src/commands/run.ts", "src/keyring.ts", "src/daemon/staleTemp.ts"]) {
      const text = readFileSync(path.join(PACKAGE_DIR, file), "utf8");
      expect(text, file).not.toMatch(/from\s+["'](?:node:)?(?:net|http|https|http2|tls|dgram)["']/);
      expect(text, file).not.toMatch(/\.listen\s*\(/);
    }
  });

  it("every code this command adds is on the telemetry allowlist", () => {
    const list = readFileSync(path.join(PACKAGE_DIR, "..", "telemetry", "src", "errorCodes.ts"), "utf8");
    const used = [...readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8").matchAll(/"([a-z_]+): /g)].map((m) => m[1]!);
    expect(used.sort()).toEqual(["job_keyring_missing", "ledger_closed", "mirrors_root_overlap"]);
    // The key file's own codes are thrown from src/credentials.ts.
    for (const code of [...used, "api_key_not_configured", "api_key_format", "api_key_unsafe"]) expect(list).toContain(`"${code}"`);
  });
});

describe("6. the composed daemon with a tmux watch (D#6 R4a-7)", () => {
  /** A `tmux` that only writes its arguments, one call per line, to a file. */
  function fakeTmux(): string {
    const log = path.join(root, "tmux.log");
    writeFileSync(path.join(toolbin, "tmux"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
    chmodSync(path.join(toolbin, "tmux"), 0o755);
    return log;
  }
  const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  /** A local bare repository the git path fetches from instead of the real host. */
  function localRemote(): () => string {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    return () => pathToFileURL(remote).href;
  }

  it.skipIf(process.platform !== "linux")("each job gets a watch session; a take-over request stops the agent, records taken_over, sends done with no result, swaps the pane and pushes nothing", async () => {
    const log = fakeTmux();
    fake.set("hang", "");
    const job = signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    const runId = job.job.run_id;
    const run = start({ host: { selfCommand: ["/opt/fx/node", "/opt/fx/fx-runner.mjs"], term: "xterm" }, hooks: { searchPath: toolbin, remoteUrl: localRemote() } });
    await until(() => existsSync(path.join(fake.dir, "argv.txt")), 20_000);
    await until(() => lines(log).some((l) => l.includes("new-session")), 5_000);
    const created = lines(log).find((l) => l.includes("new-session"))!;
    expect(created).toContain(`-S ${path.join(stateDir, "tmux", "s")}`);
    expect(created).toContain(`-s fx-${runId.slice(0, 8)}`);
    expect(created).toContain(`/opt/fx/node /opt/fx/fx-runner.mjs __watch ${runId}`);
    expect(readEntries(stateDir).map((e) => e.run_id)).toEqual([runId]);
    expect((lstatSync(path.join(stateDir, "tmux")).mode & 0o777).toString(8)).toBe("700");

    const asked = Date.now();
    expect(requestTakeover(stateDir, runId)).toBe(true);
    await until(() => takeoverState(stateDir, runId) === "ready", 20_000);
    // The agent ended on SIGINT, not on the sandbox stop that follows 10 seconds later for an agent that ignores it.
    expect(Date.now() - asked).toBeLessThan(5_000);
    const events = cloud.runs.get(runId)!.events;
    expect(events.at(-1)).toMatchObject({ type: "taken_over" });
    expect(Object.keys(events.at(-1)!).sort()).toEqual(["seq", "ts", "type"]);
    const done = cloud.seen.filter((s) => s.path.endsWith("/done"));
    expect(done).toHaveLength(1);
    expect(Object.keys(done[0]!.body as object).sort()).toEqual(["lease_generation", "run_id"]);
    expect(lines(log).some((l) => l.includes(`respawn-pane -k -t fx-${runId.slice(0, 8)} /opt/fx/node /opt/fx/fx-runner.mjs __takeover ${runId}`))).toBe(true);
    // The person's session stays: it is not killed with the job, and its record says it was handed over.
    expect(lines(log).some((l) => l.includes("kill-session"))).toBe(false);
    expect(readEntries(stateDir)).toEqual([expect.objectContaining({ run_id: runId, taken_over: true })]);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

  it("without tmux the job runs and no watch files are made", async () => {
    const job = signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    fake.set("stream.jsonl", fixtureText("stream.subscription.jsonl"));
    const run = start({ host: { selfCommand: ["/opt/fx/node", "/opt/fx/fx-runner.mjs"] }, hooks: { remoteUrl: localRemote() } });
    await until(() => cloud.seen.some((s) => s.path.endsWith("/done")), 20_000);
    expect(existsSync(path.join(stateDir, "tmux"))).toBe(false);
    expect(existsSync(path.join(stateDir, "watch"))).toBe(false);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);
});

describe("7. an api_key runner in the composed daemon (D#6 R5b-3)", () => {
  const KEY = ["sk-ant-", "api03-", "COMPOSEDKEY0123456789abcd"].join(""); // gitleaks:allow
  const uid = process.getuid!();
  const apiKeyRegistration = (): void => saveRegistration(stateDir, { ...loadRegistration(stateDir)!, credential_mode: "api_key" });
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const seeded = () => signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  function localRemote(): () => string {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    return () => pathToFileURL(remote).href;
  }
  /** The fake agent reports an API key as its credential source, as the real one does for ANTHROPIC_API_KEY. */
  function asApiKeyAgent(): void {
    fake.set("stream.jsonl", fixtureText("stream.subscription.jsonl").replace('"none"', '"ANTHROPIC_API_KEY"'));
    fake.set("auth.json", authText("auth.api_key.json"));
  }

  it("with no key file it refuses to start with api_key_not_configured and the set-api-key hint, and claims and starts nothing", async () => {
    apiKeyRegistration();
    const result = await start({ ctx: { uid } }).done;
    expect(result.code).toBe(1);
    expect(result.message).toContain("api_key_not_configured");
    expect(result.message).toContain("fx-runner credentials set-api-key");
    expect(claims()).toBe(0);
    expect(fake.spawnCount()).toBe(0);
  });

  it("a key file that is unsafe refuses to start with api_key_unsafe", async () => {
    apiKeyRegistration();
    writeApiKey(stateDir, uid, KEY);
    chmodSync(path.join(stateDir, "credentials", "anthropic-api-key"), 0o644);
    const result = await start({ ctx: { uid } }).done;
    expect(result.message).toContain("api_key_unsafe");
    expect(result.message).not.toContain("COMPOSEDKEY");
    expect(claims()).toBe(0);
  });

  it("a job gets the key in the agent's environment only: not in argv, standard input, the tmux calls, the ledger, the logs, the terminal or the cloud", async () => {
    apiKeyRegistration();
    writeApiKey(stateDir, uid, KEY);
    asApiKeyAgent();
    const tmuxLog = path.join(root, "tmux.log");
    writeFileSync(path.join(toolbin, "tmux"), `#!/bin/sh\necho "$*" >> '${tmuxLog}'\nexit 0\n`);
    chmodSync(path.join(toolbin, "tmux"), 0o755);
    cloud.enqueue(seeded());
    const run = start({ ctx: { uid }, host: { selfCommand: ["/opt/fx/node", "/opt/fx/fx-runner.mjs"], term: "xterm" }, hooks: { remoteUrl: localRemote() } });
    await until(() => cloud.seen.some((s) => s.path.endsWith("/done")), 20_000);
    run.signals.emit("SIGTERM");
    const ended = await run.done;
    expect(ended.code).toBe(0);
    expect(fake.envText().split("\n")).toContain(`ANTHROPIC_API_KEY=${KEY}`);
    expect(fake.envText().split(KEY)).toHaveLength(2);
    const everywhereElse = [fake.argv().join("\n"), fake.stdin(), readFileSync(tmuxLog, "utf8"), JSON.stringify(cloud.seen), ...ended.out, ...files(stateDir).filter((f) => !f.includes(`${path.sep}credentials${path.sep}`)).map((f) => readFileSync(f, "utf8"))];
    expect(files(stateDir).some((f) => f.endsWith("jobs.ledger"))).toBe(true);
    for (const text of everywhereElse) expect(text).not.toContain("COMPOSEDKEY");
  }, 60_000);

  it("a subscription runner never hands a stored key file to the agent", async () => {
    writeApiKey(stateDir, uid, KEY);
    fake.set("stream.jsonl", fixtureText("stream.subscription.jsonl"));
    cloud.enqueue(seeded());
    const run = start({ ctx: { uid }, hooks: { remoteUrl: localRemote() } });
    await until(() => cloud.seen.some((s) => s.path.endsWith("/done")), 20_000);
    expect((await stop(run)).code).toBe(0);
    expect(fake.envText()).not.toContain("COMPOSEDKEY");
    expect(fake.envText()).not.toContain("ANTHROPIC_API_KEY");
  }, 60_000);
});
