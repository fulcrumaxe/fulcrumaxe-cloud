import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelloMessage } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../../src/cliError.js";
import { saveRegistration } from "../../src/config.js";
import { BRIDGE_STATUS_FILE, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { saveBridgeSettings } from "../../src/engineBridge/settings.js";
import type { CommandContext } from "../../src/context.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import type { ResourceProbe } from "../../src/daemon/resources.js";
import { runCommand, type RunHooks, type RunHost } from "../../src/commands/run.js";
import { fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { manualClock, until } from "../helpers/manualClock.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { KEYRING } from "../helpers/signedJob.js";
import { shellSandboxUsable, testLaunch } from "../helpers/launch.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

let root: string;
let home: string;
let stateDir: string;
let cloud: StrictRunnerCloud;
let fake: Fake;
let toolbin: string;
let key: ReturnType<typeof generateRunnerKey>;
const children: Array<ReturnType<typeof spawn>> = [];

function register(origin: string): void {
  key = generateRunnerKey();
  saveRunnerKey(stateDir, key);
  saveRegistration(stateDir, { version: 1, cloud_origin: origin, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
  cloud.trust(key.publicJwk);
}

beforeEach(async () => {
  // socketTmpRoot, not tmpdir: a long TMPDIR (a job's, or a nested one) is long enough that the watch's socket path under it would pass the limit, and the daemon then (rightly) runs without one.
  root = mkdtempSync(path.join(socketTmpRoot(), "fxr-run-"));
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
const hostWith = (signals: RunHost["signals"]): RunHost => ({ home, platform: "linux", signals, pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), chdir: () => undefined, engine: createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }), sandbox: fakeSandboxHost(), managedServer: () => true });

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


const ports = (): EngineBridgePorts => ({
  halt: { handleControl: async () => undefined, readHostHandle: () => undefined, readHaltState: () => undefined },
  ceiling: { create: () => ({ run: async () => undefined, controlsChanged: () => undefined, status: () => null }) },
});
const repoRoot = (): string => path.join(root, "engine-repo");
const enable = (): void => {
  mkdirSync(path.join(repoRoot(), "engine"), { recursive: true });
  writeFileSync(path.join(repoRoot(), "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }));
  mkdirSync(path.join(root, "engine-state"), { mode: 0o700 });
  saveBridgeSettings(stateDir, [{ repo_gh_id: 77, full_name: "acme/widgets", state_dir: path.join(root, "engine-state"), repo_root: repoRoot() }]);
};
const statusFile = (): { hello: boolean; repos: Array<{ run: string; reason: string | null }> } | undefined => {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, BRIDGE_STATUS_FILE), "utf8"));
  } catch {
    return undefined;
  }
};
const hellos = (): Array<{ path: string; body: unknown }> => cloud.seen.filter((s) => s.path === "/api/runner/hello");

describe("the engine bridge in the composed daemon", () => {
  it("advertises engine_bridge_v1 on the hello, starts the bridge beside the claim loop once the hello kept it, and stops it with the daemon", async () => {
    enable();
    const run = start({ host: { engineBridge: ports() } });
    await until(() => claims() >= 1 && statusFile() !== undefined);
    expect(HelloMessage.parse(hellos()[0]!.body).capabilities).toContain("engine_bridge_v1");
    // The strict stand-in has no engine routes, so the cloud's list never arrives: the repo waits for it, and claiming went on regardless.
    expect(statusFile()).toMatchObject({ hello: true, repos: [{ run: "waiting", reason: "cloud_list" }] });
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("never starts the bridge on a hello that dropped engine_bridge_v1 (an older cloud), and the claim loop is not held up", async () => {
    enable();
    // sandbox_commands_v1 (D#587 B-7b) is refused first, then machine_login_v1 (D#845 MC-8b), then watch_mode_v1 (D#845), then engine_bridge_v1.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const run = start({ host: { engineBridge: ports() } });
    await until(() => claims() >= 1 && statusFile() !== undefined);
    // sandbox_commands_v1 goes first, then machine_login_v1, then watch_mode_v1, then engine_bridge_v1: the fifth hello is the same without both.
    expect(hellos()).toHaveLength(5);
    expect(HelloMessage.parse(hellos()[3]!.body).capabilities).toContain("engine_bridge_v1");
    expect(HelloMessage.parse(hellos()[4]!.body).capabilities).not.toContain("engine_bridge_v1");
    expect(HelloMessage.parse(hellos()[4]!.body).capabilities).toContain("overlap_facts_v1");
    expect(statusFile()).toMatchObject({ hello: false, repos: [{ run: "waiting", reason: "hello" }] });
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("starts nothing, and writes no status, when the entry point supplied no bridge ports", async () => {
    enable();
    const clock = manualClock();
    const run = start({ hooks: { clock } });
    await until(() => claims() >= 1);
    await clock.advance(30_000);
    expect(statusFile()).toBeUndefined();
    expect(await stop(run)).toMatchObject({ code: 0 });
  });
});
