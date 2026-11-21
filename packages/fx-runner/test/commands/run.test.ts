import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION, HelloMessage, SANDBOX_COMMAND_PURPOSE, sha256Text, type SandboxCommand } from "@fulcrumaxe/runner-protocol";
import { spillRootFor } from "../../src/job/spillFiles.js";
import { CliError } from "../../src/cliError.js";
import { readHostFacts } from "../../src/hostFacts.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_VERSION } from "../../src/version.js";
import { loadRegistration, saveRegistration } from "../../src/config.js";
import { writeApiKey } from "../../src/credentials.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { SETTINGS_FILE, setSetting } from "../../src/runnerSettings.js";
import { setPlaywrightLoader } from "../../src/verifyBrowser/loadPlaywright.js";
import type { CommandContext } from "../../src/context.js";
import { claimBlockReason, readCanaryState } from "../../src/instructionCanaryState.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { PINNED_JOB_KEYS, keyringFor, originHash } from "../../src/keyring.js";
import { runCli } from "../../src/cli.js";
import type { ResourceProbe } from "../../src/daemon/resources.js";
import { localTools, pidIsAlive, runCommand, type RunHooks, type RunHost } from "../../src/commands/run.js";
import { readEntries, requestTakeover, takeoverState } from "../../src/watch/layout.js";
import { authText, fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { manualClock, until } from "../helpers/manualClock.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { WSL2_KERNEL, fakeWslMachine, type WslMachineOptions } from "../helpers/fakeWslMachine.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { KEY_ID, KEYRING, OTHER_KEYRING, signedJob, signedSandboxCommand } from "../helpers/signedJob.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { shellSandboxUsable, testLaunch } from "../helpers/launch.js";
import { VERCEL_PROTECTED_BODY } from "../helpers/vercelProtected.js";
import { makeRig, runCleanups } from "../vm/sandboxd/helpers.js";
import { scriptedRuntime } from "../sandboxPortContract.js";
import type { LiveMicrovm, LiveMicrovmParts } from "../../src/vm/sandboxd/live.js";
import type { VmHostFacts } from "../../src/vm/limits.js";
import { RESTART_LINE, UNWIRED_LINE } from "../../src/vm/engineGate.js";

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
// D#845 ON-6b: the hello now reads the CLI's sign-in through `inspect`, which starts the fake CLI; the default host answers it without a spawn so the tests that count spawns still count jobs only. Tests of the reading itself pass their own `inspect`.
const quietInspect = (kit: RunHost["engine"]): RunHost["engine"] => ({ ...kit, inspect: async () => ({ version: "2.1.0", minimumVersion: "2.0.0", versionSupported: true, login: "yes" }) as Awaited<ReturnType<RunHost["engine"]["inspect"]>> });
const hostWith = (signals: RunHost["signals"]): RunHost => ({ home, platform: "linux", signals, pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), chdir: () => undefined, engine: quietInspect(createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable })), sandbox: fakeSandboxHost() });

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
    expect(sent).toMatchObject({ protocol_version: CURRENT_PROTOCOL_VERSION, isolation: "host_sandbox", binary_version: RUNNER_VERSION });
    expect(sent.protocol_version).toBe(CURRENT_PROTOCOL_VERSION);
    expect(sent.facts).toEqual(readHostFacts());
    expect(sent.facts).toMatchObject({ os: "linux", sandbox_engine: "os_sandbox" });
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("keeps claiming when the cloud refuses the hello (a cloud that predates facts answers 400, an older still 404)", async () => {
    // A 400 invalid_message is taken as a cloud from before a newer capability: the hello goes again without ordered_facts_v1, then conflict_facts_v1, then discovery_analyst, then plane_merge_queue_v1, then memory_limit_v1, then plane_merge_v1, then, if still refused, wake_v1 too (the first three refusals here, so four hellos in all: ordered_facts_v1, conflict_facts_v1 and discovery_analyst go).
    for (let i = 0; i < 4; i++) cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const run = start();
    await until(() => claims() >= 1);
    expect(hellos()).toHaveLength(5);
    expect(await stop(run)).toMatchObject({ code: 0 });
    cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } });
    const again = start();
    await until(() => claims() >= 2);
    expect(hellos()).toHaveLength(6);
    expect(await stop(again)).toMatchObject({ code: 0 });
  });

  // D#483 S5-j2c2: a hello that was never answered must not leave the capability off until the next start.
  it("a hello that failed is said again on a later poll; once answered, the ordering fact (and the other values the hello decides) follow that answer", async () => {
    const ordered: boolean[] = [];
    const conflict: boolean[] = [];
    const clock = manualClock();
    const hooks = { clock, onOrderedFactsAccepted: (a: boolean) => void ordered.push(a), onConflictFactsAccepted: (a: boolean) => void conflict.push(a) };
    cloud.force.hello.push({ status: 503, body: { error: { code: "unavailable", message: "unavailable" } } });
    const run = start({ hooks });
    await until(() => claims() >= 1);
    // Still failed closed, and no second hello yet: the retry rides the poll loop's own pacing.
    expect(ordered).toEqual([false]);
    expect(hellos()).toHaveLength(1);
    while (ordered.length < 2) await clock.advance(5000);
    expect(ordered).toEqual([false, true]);
    expect(conflict).toEqual([false, true]);
    expect(hellos()).toHaveLength(2);
    // The retry waited for a later pass: the first claim was made before it, and no hello is said once one is answered.
    expect(cloud.seen.findIndex((s) => s.path === "/api/runner/claim")).toBeLessThan(cloud.seen.map((s) => s.path).lastIndexOf("/api/runner/hello"));
    await clock.advance(120_000);
    expect(hellos()).toHaveLength(2);
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("a hello answered late keeps a refused capability off: the retry's own dropped list decides", async () => {
    const ordered: boolean[] = [];
    const conflict: boolean[] = [];
    const clock = manualClock();
    const hooks = { clock, onOrderedFactsAccepted: (a: boolean) => void ordered.push(a), onConflictFactsAccepted: (a: boolean) => void conflict.push(a) };
    cloud.force.hello.push({ status: 503, body: { error: { code: "unavailable", message: "unavailable" } } });
    // The newest capability (overlap_facts_v1) goes first, then mem_proposal_v1, then tip_publish_v1, then ordered_facts_v1: three refusals.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#587 B-7b: sandbox_commands_v1 is advertised after the build capabilities and goes before all of them: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#842 EB-3c: engine_bridge_v1 is the first build capability a cloud that does not know it refuses, so each older-cloud case starts with one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#845 watch mode: watch_mode_v1 is the newest capability, so it goes first: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const run = start({ hooks });
    await until(() => claims() >= 1);
    while (ordered.length < 2) await clock.advance(5000);
    expect(ordered).toEqual([false, false]);
    expect(conflict).toEqual([false, true]);
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  // D#483 S5-j2f: a hello the cloud keeps refusing with a 4xx goes out as the whole ladder of dropped capabilities each time (one POST per droppable capability, plus the last one that has nothing left to drop); said on every pass that is a flood.
  it("a hello that keeps being refused with a 4xx is said again less and less often, not on every pass", async () => {
    // Every capability but the base role (`proposal_verifier`, which the ladder never drops) is droppable, so the count follows the list and a new capability does not break this test.
    const droppable = RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "proposal_verifier").length;
    // sandbox_commands_v1 (D#587 B-7b) is advertised beside the build list and is droppable too.
    const perAttempt = droppable + 2;
    expect(droppable).toBeGreaterThan(0);
    const refusal = { status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } };
    for (let i = 0; i < 400; i++) cloud.force.hello.push(refusal);
    const clock = manualClock();
    const run = start({ hooks: { clock } });
    await until(() => claims() >= 1);
    const first = hellos().length;
    expect(first).toBe(perAttempt);
    const from = claims();
    while (claims() < from + 20) await clock.advance(5000);
    const later = hellos().length - first;
    // The retry is not given up on (a cloud that is fixed later still gets its hello), and it is not made on every one of the 20 passes (20 attempts' worth of POSTs).
    expect(later).toBeGreaterThanOrEqual(perAttempt);
    expect(later).toBeLessThanOrEqual(perAttempt * 5);
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  // D#519 MQ4-e2-a: a merge report carries the conflict verdict only when the cloud's hello kept `conflict_facts_v1`; the dropped list is the whole signal.
  it("the conflict verdict is allowed only when the hello kept conflict_facts_v1: a cloud that dropped it, one that refused the hello, and one that kept it", async () => {
    const answers: boolean[] = [];
    const hooks = { onConflictFactsAccepted: (a: boolean) => void answers.push(a) };
    // The first 400 drops the newest capability (mem_proposal_v1), the second tip_publish_v1, the third ordered_facts_v1, the fourth conflict_facts_v1.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#587 B-7b: sandbox_commands_v1 is advertised after the build capabilities and goes before all of them: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#842 EB-3c: engine_bridge_v1 is the first build capability a cloud that does not know it refuses, so each older-cloud case starts with one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#845 watch mode: watch_mode_v1 is the newest capability, so it goes first: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const dropped = start({ hooks });
    await until(() => answers.length >= 1);
    expect(hellos()[0]!.body).toMatchObject({ capabilities: expect.arrayContaining(["conflict_facts_v1"]) });
    expect(HelloMessage.parse(hellos()[8]!.body).capabilities).not.toContain("conflict_facts_v1");
    expect(answers).toEqual([false]);
    expect(await stop(dropped)).toMatchObject({ code: 0 });
    // A hello that failed outright leaves it unsent too.
    cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } });
    const failed = start({ hooks });
    await until(() => answers.length >= 2);
    expect(answers).toEqual([false, false]);
    expect(await stop(failed)).toMatchObject({ code: 0 });
    // A cloud that knows it keeps it.
    const kept = start({ hooks });
    await until(() => answers.length >= 3);
    expect(answers).toEqual([false, false, true]);
    expect(await stop(kept)).toMatchObject({ code: 0 });
  });

  // D#483 S5-j2c2: the ordering fact is computed and sent only when the hello kept `ordered_facts_v1`; the dropped list is the whole signal.
  it("the ordering fact is allowed only when the hello kept ordered_facts_v1: a cloud that dropped it (and kept conflict_facts_v1), one that refused the hello, and one that kept it", async () => {
    const ordered: boolean[] = [];
    const conflict: boolean[] = [];
    const hooks = { onOrderedFactsAccepted: (a: boolean) => void ordered.push(a), onConflictFactsAccepted: (a: boolean) => void conflict.push(a) };
    // The first 400 drops the newest capability (mem_proposal_v1), the second tip_publish_v1, the third ordered_facts_v1 alone: the conflict verdict stays allowed.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#587 B-7b: sandbox_commands_v1 is advertised after the build capabilities and goes before all of them: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#842 EB-3c: engine_bridge_v1 is the first build capability a cloud that does not know it refuses, so each older-cloud case starts with one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#845 watch mode: watch_mode_v1 is the newest capability, so it goes first: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const dropped = start({ hooks });
    await until(() => ordered.length >= 1);
    expect(HelloMessage.parse(hellos()[0]!.body).capabilities).toContain("ordered_facts_v1");
    expect(HelloMessage.parse(hellos()[7]!.body).capabilities).not.toContain("ordered_facts_v1");
    expect(HelloMessage.parse(hellos()[7]!.body).capabilities).toContain("conflict_facts_v1");
    expect([ordered, conflict]).toEqual([[false], [true]]);
    expect(await stop(dropped)).toMatchObject({ code: 0 });
    cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } });
    const failed = start({ hooks });
    await until(() => ordered.length >= 2);
    expect(ordered).toEqual([false, false]);
    expect(await stop(failed)).toMatchObject({ code: 0 });
    const kept = start({ hooks });
    await until(() => ordered.length >= 3);
    expect(ordered).toEqual([false, false, true]);
    expect(await stop(kept)).toMatchObject({ code: 0 });
  });

  // D#598 P1g-3a-3: a fix round that added no commit asks to publish the branch tip only when the hello kept `tip_publish_v1`; the dropped list is the whole signal.
  it("the branch tip is asked for only when the hello kept tip_publish_v1: a cloud that dropped it, one that failed the hello, and one that kept it", async () => {
    const tip: boolean[] = [];
    const hooks = { onTipPublishAccepted: (a: boolean) => void tip.push(a) };
    // The first 400 drops the newest capability, mem_proposal_v1; the second drops tip_publish_v1.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#587 B-7b: sandbox_commands_v1 is advertised after the build capabilities and goes before all of them: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#842 EB-3c: engine_bridge_v1 is the first build capability a cloud that does not know it refuses, so each older-cloud case starts with one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#845 watch mode: watch_mode_v1 is the newest capability, so it goes first: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const dropped = start({ hooks });
    await until(() => tip.length >= 1);
    expect(HelloMessage.parse(hellos()[0]!.body).capabilities).toContain("tip_publish_v1");
    expect(HelloMessage.parse(hellos()[6]!.body).capabilities).not.toContain("tip_publish_v1");
    expect(tip).toEqual([false]);
    expect(await stop(dropped)).toMatchObject({ code: 0 });
    cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } });
    const failed = start({ hooks });
    await until(() => tip.length >= 2);
    expect(tip).toEqual([false, false]);
    expect(await stop(failed)).toMatchObject({ code: 0 });
    const kept = start({ hooks });
    await until(() => tip.length >= 3);
    expect(tip).toEqual([false, false, true]);
    expect(await stop(kept)).toMatchObject({ code: 0 });
  });

  // D#601 MEM-6: a finished run's memory proposals are offered only when the hello kept `mem_proposal_v1`; the dropped list is the whole signal.
  it("memory proposals are offered only when the hello kept mem_proposal_v1: a cloud that dropped it, one that failed the hello, and one that kept it", async () => {
    const offered: boolean[] = [];
    // The wired `enabled` is the function the offer reads: it is called here, as the offer calls it, after each hello is answered.
    const wired: boolean[] = [];
    let built: { enabled: () => boolean; interactive: boolean } | undefined;
    const hooks = { onMemProposalAccepted: (a: boolean) => void offered.push(a), onMemoryOfferBuilt: (d: { enabled: () => boolean; interactive: boolean }) => void (built = d) };
    // The first 400 drops the newest capability, mem_proposal_v1, and only it.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#587 B-7b: sandbox_commands_v1 is advertised after the build capabilities and goes before all of them: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#842 EB-3c: engine_bridge_v1 is the first build capability a cloud that does not know it refuses, so each older-cloud case starts with one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#845 watch mode: watch_mode_v1 is the newest capability, so it goes first: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const dropped = start({ hooks });
    await until(() => offered.length >= 1);
    expect(HelloMessage.parse(hellos()[0]!.body).capabilities).toContain("mem_proposal_v1");
    expect(HelloMessage.parse(hellos()[5]!.body).capabilities).not.toContain("mem_proposal_v1");
    expect(HelloMessage.parse(hellos()[5]!.body).capabilities).toContain("tip_publish_v1");
    expect(offered).toEqual([false]);
    wired.push(built!.enabled());
    expect(built!.interactive).toBe(false);
    expect(await stop(dropped)).toMatchObject({ code: 0 });
    cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } });
    const failed = start({ hooks });
    await until(() => offered.length >= 2);
    expect(offered).toEqual([false, false]);
    wired.push(built!.enabled());
    expect(await stop(failed)).toMatchObject({ code: 0 });
    const kept = start({ hooks });
    await until(() => offered.length >= 3);
    expect(offered).toEqual([false, false, true]);
    wired.push(built!.enabled());
    expect(wired).toEqual([false, false, true]);
    expect(await stop(kept)).toMatchObject({ code: 0 });
  });

  // D#598 P1g-3a-3: the hook the command builds is handed the same answer the hello set. Driving that hook (not a copy of it) is what catches a call that forgets or hard-codes `tipPublish`.
  it("the plane-push hook the command builds asks for the branch tip only when the hello kept tip_publish_v1", async () => {
    const BASE = "a".repeat(40);
    const TIP = "b".repeat(40);
    const runIds = [randomUUID(), randomUUID()];
    const driveOnce = async (dropCapability: boolean, runId: string): Promise<{ tokenBodies: unknown[]; reports: unknown[]; outcome: unknown }> => {
      const tokenBodies: unknown[] = [];
      const reports: unknown[] = [];
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
        if (url.endsWith("/api/runner/plane-push-token")) {
          tokenBodies.push(body);
          return new Response(JSON.stringify({ error: { code: "not_paired", message: "not_paired" } }), { status: 403, headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/api/runner/plane-push-report")) {
          reports.push(body);
          return new Response(JSON.stringify({ recorded: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return fetch(input, init);
      }) as typeof fetch;
      let built: Parameters<NonNullable<RunHooks["onPlanePushBuilt"]>>[0] | undefined;
      const tip: boolean[] = [];
      // mem_proposal_v1 is newer than tip_publish_v1, so it goes first: two refusals take the hello down past the tip capability.
      if (dropCapability) for (let i = 0; i < 6; i++) cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
      const run = start({ ctx: { fetchFn }, hooks: { onPlanePushBuilt: (p) => void (built = p), onTipPublishAccepted: (a) => void tip.push(a) } });
      await until(() => tip.length >= 1 && built !== undefined);
      expect(tip).toEqual([!dropCapability]);
      built!.baseLedger.record(runId, BASE);
      const outcome = await built!.run({ runId, leaseGeneration: 1, repo: { owner: "o", name: "r" }, mirrorDir: path.join(root, "mirror"), privateHead: undefined, tipHead: TIP });
      expect(await stop(run)).toMatchObject({ code: 0 });
      return { tokenBodies, reports, outcome };
    };
    // A cloud that dropped the capability: nothing is asked, the round is reported as one that changed nothing.
    const dropped = await driveOnce(true, runIds[0]!);
    expect(dropped.tokenBodies).toEqual([]);
    expect(dropped.outcome).toEqual({ kind: "no_change" });
    // A cloud that kept it: the token request names the tip.
    const kept = await driveOnce(false, runIds[1]!);
    expect(kept.tokenBodies).toEqual([{ run_id: runIds[1], lease_generation: 1, at_tip: true }]);
  });

  it("D#6 RUNNER-WAKE: on an older cloud that refuses wake_v1 it says hello again without it and claims as before, with no wake check", async () => {
    cloud.wake.oldCloud = true;
    cloud.wake.enabled = true;
    const run = start();
    await until(() => claims() >= 1);
    const sent = hellos().map((h) => HelloMessage.parse(h.body).capabilities);
    expect(sent).toEqual([["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1", "mem_proposal_v1", "overlap_facts_v1", "engine_bridge_v1", "watch_mode_v1", "sandbox_commands_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1", "mem_proposal_v1", "overlap_facts_v1", "engine_bridge_v1", "watch_mode_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1", "mem_proposal_v1", "overlap_facts_v1", "engine_bridge_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1", "mem_proposal_v1", "overlap_facts_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1", "mem_proposal_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1"], ["proposal_verifier", "wake_v1"], ["proposal_verifier"]]);
    expect(cloud.seen.some((s) => s.path === "/api/runner/wake")).toBe(false);
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  // D#845 ON-6c: `facts.kvm` is a handshake. The first hello never carries it; it goes on the hello after a reply that listed `kvm_fact`, to a cloud that takes it.
  describe("hello facts carry the KVM reading only after the cloud listed kvm_fact", () => {
    const vmFacts = (kvm: "present" | "absent" | "unreadable"): RunHost["vmFacts"] => async () => ({ kvm, helperSocket: "absent", helperSocketPath: "fictional-helper.sock", readMemAvailableBytes: async () => undefined }) as never;
    const kvmOfHello = (n: number): unknown => (hellos()[n]!.body as { facts?: Record<string, unknown> }).facts?.kvm;
    const declared = (n: number): boolean => ((hellos()[n]!.body as { capabilities?: string[] }).capabilities ?? []).includes("kvm_fact_v1");

    it("a cloud that lists kvm_fact: the first hello declares it and carries no kvm, the second carries it (present and absent)", async () => {
      cloud.kvmCloud = "listed";
      for (const kvm of ["present", "absent"] as const) {
        cloud.seen.length = 0;
        const run = start({ host: { vmFacts: vmFacts(kvm) } });
        await until(() => hellos().length >= 2, 20_000);
        expect(declared(0)).toBe(true);
        expect(hellos()[0]!.body as object).toHaveProperty("facts");
        expect(kvmOfHello(0)).toBeUndefined();
        expect(kvmOfHello(1)).toBe(kvm);
        expect(await stop(run)).toMatchObject({ code: 0 });
      }
    });

    it("a cloud built before it (strict, refuses the capability and the key): the runner never sends kvm, and the hello is the old one, byte for byte", async () => {
      cloud.kvmCloud = "old";
      const run = start({ host: { vmFacts: vmFacts("present") } });
      await until(() => claims() >= 1);
      const sent = hellos();
      // The first hello declared the capability and was refused; the ladder then went again without it; no hello of any step carries kvm.
      expect(declared(0)).toBe(true);
      expect(sent.some((h) => "kvm" in ((h.body as { facts?: object }).facts ?? {}))).toBe(false);
      const accepted = sent[sent.length - 1]!.body as { capabilities: string[] };
      expect(accepted.capabilities).not.toContain("kvm_fact_v1");
      expect(sent.filter((h) => (h.body as { capabilities?: string[] }).capabilities?.includes("kvm_fact_v1") !== true)).toHaveLength(1);
      // Exactly one retry (kvm_fact_v1 alone dropped): the accepted list is the one a runner with no KVM reading sends, sandbox_commands_v1 included.
      expect(sent).toHaveLength(2);
      expect(await stop(run)).toMatchObject({ code: 0 });
      cloud.seen.length = 0;
      cloud.kvmCloud = "unlisted";
      const plain = start({ host: { vmFacts: vmFacts("unreadable") } });
      await until(() => claims() >= 1);
      const baseline = (hellos()[0]!.body as { capabilities: string[] }).capabilities;
      expect(await stop(plain)).toMatchObject({ code: 0 });
      expect(baseline).toContain("sandbox_commands_v1");
      expect(accepted.capabilities).toEqual(baseline);
    });

    it("a cloud that knows the field but does not list it: no hello carries kvm", async () => {
      cloud.kvmCloud = "unlisted";
      const run = start({ host: { vmFacts: vmFacts("present") } });
      await until(() => claims() >= 1);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(hellos()).toHaveLength(1);
      expect(hellos().some((h) => "kvm" in ((h.body as { facts?: object }).facts ?? {}))).toBe(false);
      expect(await stop(run)).toMatchObject({ code: 0 });
    });

    it("says nothing when the device could not be read or no reading is made, even to a cloud that lists kvm_fact", async () => {
      cloud.kvmCloud = "listed";
      for (const over of [{ vmFacts: vmFacts("unreadable") }, {}] as Array<Partial<RunHost>>) {
        cloud.seen.length = 0;
        const run = start({ host: over });
        await until(() => claims() >= 1);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(hellos().some((h) => "kvm" in ((h.body as { facts?: object }).facts ?? {}))).toBe(false);
        expect(hellos()).toHaveLength(1);
        expect(declared(0)).toBe(false);
        expect(await stop(run)).toMatchObject({ code: 0 });
      }
    });
  });

  // D#845 ON-6b: a subscription runner says it holds model credentials while the doctor's own Claude check passes (present, supported version, signed in).
  describe("model_auth_present follows the doctor's Claude check in subscription mode", () => {
    type Report = Awaited<ReturnType<RunHost["engine"]["inspect"]>>;
    const reportOf = (over: Partial<Report>): Report => ({ version: "2.1.0", minimumVersion: "2.0.0", versionSupported: true, login: "yes", ...over }) as Report;
    const withInspect = (inspect: () => Promise<Report>): { host: Partial<RunHost> } => ({ host: { engine: { ...createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }), inspect } } });
    const authOf = (i: number): unknown => (hellos()[i]!.body as { model_auth_present: boolean }).model_auth_present;
    const firstHelloWith = async (inspect: () => Promise<Report>): Promise<unknown> => {
      const run = start(withInspect(inspect));
      await until(() => claims() >= 1);
      const sent = authOf(0);
      expect(await stop(run)).toMatchObject({ code: 0 });
      return sent;
    };

    it("is true when the CLI is signed in on a supported version", async () => {
      expect(await firstHelloWith(async () => reportOf({}))).toBe(true);
    });
    it("is false when signed out, unknown, too old, unreadable, or when the check fails", async () => {
      expect(await firstHelloWith(async () => reportOf({ login: "no" }))).toBe(false);
      cloud.seen.length = 0;
      expect(await firstHelloWith(async () => reportOf({ login: "unknown" }))).toBe(false);
      cloud.seen.length = 0;
      expect(await firstHelloWith(async () => reportOf({ versionSupported: false }))).toBe(false);
      cloud.seen.length = 0;
      expect(await firstHelloWith(async () => reportOf({ version: undefined, versionSupported: false, login: "unknown" }))).toBe(false);
      cloud.seen.length = 0;
      expect(await firstHelloWith(async () => { throw new Error("no claude"); })).toBe(false);
    });
    it("stays true for an API-key runner without running the check", async () => {
      saveRegistration(stateDir, { ...loadRegistration(stateDir)!, credential_mode: "api_key" });
      writeApiKey(stateDir, process.getuid!(), ["sk-ant-", "api03-", "COMPOSEDKEY0123456789abcd"].join("")); // gitleaks:allow
      const inspect = vi.fn(async () => reportOf({ login: "no" }));
      const run = start({ ...withInspect(inspect), ctx: { uid: process.getuid!() } });
      await until(() => claims() >= 1);
      expect(authOf(0)).toBe(true);
      expect(inspect).not.toHaveBeenCalled();
      expect(await stop(run)).toMatchObject({ code: 0 });
    });
    it("says the change again on a later hello when the person signs in or out", async () => {
      let login: "yes" | "no" = "no";
      const clock = manualClock();
      const run = start({ ...withInspect(async () => reportOf({ login })), hooks: { clock } });
      await until(() => claims() >= 1);
      expect(authOf(0)).toBe(false);
      login = "yes";
      while (hellos().length < 2) await clock.advance(5000);
      expect(authOf(1)).toBe(true);
      login = "no";
      while (hellos().length < 3) await clock.advance(5000);
      expect(authOf(2)).toBe(false);
      expect(await stop(run)).toMatchObject({ code: 0 });
    });
  });
});

describe("1-cwd. the daemon leaves the directory it was started in before it starts anything (D#6 RUNNER-CWD-1)", () => {
  it("changes into <cache>/fx-runner/launch/daemon (0700, empty) first, and every program the kit then starts runs elsewhere", async () => {
    const order: string[] = [];
    const counting = ((command: string, ...rest: unknown[]) => {
      order.push(`spawn ${path.basename(command)}`);
      return (spawn as unknown as (...args: unknown[]) => ReturnType<typeof spawn>)(command, ...rest);
    }) as typeof spawn;
    const run = start({ host: { chdir: (dir) => order.push(`chdir ${dir}`), engine: createClaudeKit(counting, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }) } });
    await until(() => claims() >= 1);
    const daemonDir = path.join(home, ".cache", "fx-runner", "launch", "daemon");
    expect(order[0]).toBe(`chdir ${realpathSync(daemonDir)}`);
    expect(order.filter((step) => step.startsWith("chdir"))).toHaveLength(1);
    expect(statSync(daemonDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(daemonDir)).toEqual([]);
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("a launch root that cannot be made stops the command before anything is started", async () => {
    // The cache directory's place is taken by a file.
    writeFileSync(path.join(home, ".cache"), "");
    const order: string[] = [];
    const result = await start({ host: { chdir: (dir) => order.push(dir) } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("working directory");
    expect(order).toEqual([]);
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

  it.skipIf(process.platform !== "linux")("on a cleared WSL2 machine the claimed job's settings file denies the Windows side for reads and writes", async () => {
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
    cloud.enqueue(signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    const run = start({ host: { sandbox: fakeWslMachine(), osrelease: WSL2_KERNEL }, hooks: { remoteUrl: () => pathToFileURL(remote).href } });
    await until(() => existsSync(path.join(fake.dir, "argv.txt")), 20_000);
    const argv = readFileSync(path.join(fake.dir, "argv.txt"), "utf8").split("\n");
    const settingsFile = argv[argv.indexOf("--settings") + 1]!;
    const filesystem = (JSON.parse(readFileSync(settingsFile, "utf8")) as { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } } }).sandbox.filesystem;
    for (const entry of ["/mnt", "/run/WSL"]) {
      expect(filesystem.denyRead).toContain(entry);
      expect(filesystem.denyWrite).toContain(entry);
    }
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

  it("D#600 CX-4b: at start, run directories a crash left under the spill root are removed (links as links); anything else there, and the targets of links, stay", async () => {
    const shared = path.join(home, ".cache", "fx-runner", "spill");
    const spill = spillRootFor(shared, stateDir);
    const otherDaemon = path.join(spillRootFor(shared, path.join(home, ".other-state")), "7d2a8e3c-4b6f-4c9a-9e53-0f8b2c3d4e5f");
    mkdirSync(otherDaemon, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(otherDaemon, "note.md"), "another daemon's live run");
    const stale = path.join(spill, "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d");
    const outside = path.join(stateDir, "outside-of-spill");
    mkdirSync(stale, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stale, "findings.md"), "left by a crash", { mode: 0o444 });
    mkdirSync(outside);
    writeFileSync(path.join(outside, "victim.md"), "keep me");
    symlinkSync(outside, path.join(spill, "6c1f7d2b-3a5e-4b8f-8d42-9e7a1b2c3d4e"));
    mkdirSync(path.join(spill, "not-a-run-id"));
    const run = start();
    await until(() => claims() >= 1);
    expect(readdirSync(spill).sort()).toEqual(["not-a-run-id"]);
    expect(readFileSync(path.join(outside, "victim.md"), "utf8")).toBe("keep me");
    // A daemon with another state directory shares the cache directory and its spill root: its run directory is not this daemon's to remove.
    expect(readFileSync(path.join(otherDaemon, "note.md"), "utf8")).toBe("another daemon's live run");
    expect(await stop(run)).toMatchObject({ code: 0 });
  });

  it("D#600 CX-4b: a second start on a locked state directory exits without sweeping: the first run's live spill directory is still there", async () => {
    const first = start();
    await until(() => claims() >= 1);
    const live = path.join(spillRootFor(path.join(home, ".cache", "fx-runner", "spill"), stateDir), "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d");
    mkdirSync(live, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(live, "findings.md"), "a live run's full text");
    const second = await start().done;
    expect(second.message).toBe("another fx-runner run is using this state directory");
    expect(readFileSync(path.join(live, "findings.md"), "utf8")).toBe("a live run's full text");
    expect(await stop(first)).toMatchObject({ code: 0 });
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

describe("6b. the instruction-file canary holds claiming (D#601 MEM-7)", () => {
  const claimBodies = (): unknown[] => cloud.seen.filter((s) => s.path === "/api/runner/claim").map((s) => s.body);
  const withCanary = (result: { ok: true } | { ok: false; reason: "instruction_file_loaded" }): Partial<RunHost> => ({
    engine: { ...createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }), instructionCanary: async () => result, instructionCanaryKey: () => "test-key" },
  });

  it("a build that loads the file: the claim declares no room, a job the cloud hands over anyway is refused unstarted, the named reason is said and stored for `status`", async () => {
    const job = signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    const run = start({ host: withCanary({ ok: false, reason: "instruction_file_loaded" }) });
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toMatchObject({ capacity: { light: { limit: 0 }, heavy: { limit: 0 } } });
    // Stop only after the loop has answered the handed-over job, or a stop that lands mid-claim reads "discarded" instead of "refused".
    await until(() => run.out.some((line) => line.includes("(class_full)")));
    await stop(run);
    const said = (await run.done).out.join("\n");
    expect(said).toContain("instruction_file_loaded");
    expect(said).toContain(`refused ${job.job.run_id} (class_full)`);
    // Nothing of the run reached the cloud: no heartbeat, events or done.
    expect(cloud.seen.filter((s) => /\/(heartbeat|events|done)$/.test(s.path))).toEqual([]);
    expect(readCanaryState(stateDir)).toMatchObject({ status: "blocked", reason: "instruction_file_loaded" });
    expect(claimBlockReason(stateDir)).toBe("instruction_file_loaded");
  }, 30_000);

  it("a passing check stores the pass and holds nothing", async () => {
    const run = start({ host: withCanary({ ok: true }) });
    await until(() => claims() >= 1);
    await stop(run);
    expect(readCanaryState(stateDir)).toMatchObject({ status: "passed" });
    expect(claimBlockReason(stateDir)).toBeUndefined();
  }, 30_000);
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

  it("a custom-named kernel with the WSLInterop entry is WSL2: run refuses to start, with no claim", async () => {
    const sandbox = fakeSandboxHost({ wsl: { interop: true } });
    cloud.enqueue(queuedJob());
    const result = await start({ host: { sandbox, osrelease: "6.6.0-custom" } }).done;
    expect(result.message).toMatch(/^wsl2_unsupported: /);
    expect(claims()).toBe(0);
  });

  it("with no kernel string given, the interop entry alone refuses run to start (the real os.release() path)", async () => {
    const sandbox = fakeSandboxHost({ wsl: { interop: true } });
    cloud.enqueue(queuedJob());
    const result = await start({ host: { sandbox } }).done;
    expect(result.message).toMatch(/^wsl2_unsupported: .*; fx-runner cannot run jobs here$/);
    expect(claims()).toBe(0);
  });

  it("the tier check itself is given the interop entry: the refusal comes before the agent CLI is looked for", () => {
    const host = { ...hostWith(process), sandbox: fakeSandboxHost({ wsl: { interop: true } }) };
    expect(() => localTools(host, "")).toThrow(/^wsl2_unsupported: /);
    expect(() => localTools({ ...host, sandbox: fakeSandboxHost() }, "")).not.toThrow(/^wsl2_unsupported/);
  });

  it("a WSL2 machine whose checks and probes all pass starts, claims, and hands the jobs' sandbox the Windows-side denies", async () => {
    const sandbox = fakeWslMachine({ networking: "nat" });
    const run = start({ host: { sandbox, osrelease: WSL2_KERNEL } });
    await until(() => claims() >= 1);
    expect(sandbox.wsl?.clearance).toEqual({ denyPaths: ["/mnt", "/mnt/c", "/run/WSL"], loopback: true });
    expect(sandbox.calls.some((call) => call.command === "wslinfo" || call.args[1]?.includes("wslinfo"))).toBe(true);
    expect((await stop(run)).code).toBe(0);
  });

  it.each([["no Windows drive to test with", { drive: false }, "wsl_no_windows_drive"], ["a sandbox that does not hide the canary", { honoursDenies: false }, "wsl_canary_readable"], ["a probe that cannot run", { throws: true }, "wsl_probe_unrun"]] as Array<[string, WslMachineOptions, string]>)("a WSL2 machine with %s refuses to start: no claim, the failing code on the terminal", async (_name, options, code) => {
    const sandbox = fakeWslMachine(options);
    cloud.enqueue(queuedJob());
    const result = await start({ host: { sandbox, osrelease: WSL2_KERNEL } }).done;
    expect(result.message).toMatch(/^wsl2_unsupported: /);
    expect(result.out.join("\n")).toContain(`fx-runner: WSL2 ${code}: `);
    expect(claims()).toBe(0);
    expect(sandbox.wsl?.clearance).toBeUndefined();
  });

  it.each([["5.15.167.4-microsoft-standard-WSL2", "wsl2_unsupported: fx-runner on WSL2 starts only when every safety check and live probe passes, and one has not\\. Run fx-runner doctor to see which, then fix it\\."], ["4.4.0-19041-Microsoft", "wsl1_unsupported: fx-runner does not support WSL1\\. Convert the distribution with: wsl --set-version <distro> 2 "]])("a %s kernel refuses to start run by name: no claim, no probe, no stall", async (release, text) => {
    const sandbox = fakeSandboxHost();
    cloud.enqueue(queuedJob());
    const result = await start({ host: { sandbox, osrelease: release } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toMatch(new RegExp(`^${text}.*; fx-runner cannot run jobs here$`));
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

  const partialMicrovm = (engine: "microvm" | "os_sandbox"): void => {
    setSetting(stateDir, "sandbox_engine", engine);
    for (const [key, value] of [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", path.join(home, "snaps")]] as const) setSetting(stateDir, key, value);
  };

  it("D#587 B-6a: microvm mode with a missing limit takes no job even with one queued: the claim says it is paused and nothing starts", async () => {
    partialMicrovm("microvm");
    cloud.enqueue(queuedJob());
    fake.set("hang", "");
    const run = start();
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toMatchObject({ capacity: { limited_by: "paused" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.spawnCount()).toBe(0);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

  it("D#587 B-5a part 3: microvm mode with every limit set but no machine facts (so no KVM) takes no job: the claim names microvm_no_kvm, and the OS sandbox is not used instead", async () => {
    partialMicrovm("microvm");
    setSetting(stateDir, "microvm.snapshot_quota_bytes", "1073741824");
    cloud.enqueue(queuedJob());
    fake.set("hang", "");
    const run = start();
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toEqual({ sandbox_unavailable: "microvm_no_kvm" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.spawnCount()).toBe(0);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

  it("D#587 B-6a: the same incomplete limits in os_sandbox mode are ignored and the queued job is taken", async () => {
    partialMicrovm("os_sandbox");
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    const run = start();
    await until(() => cloud.runs.has(job.job.run_id), 20_000);
    expect(claimBodies()[0]).toMatchObject({ capacity: { light: { limit: 8, in_use: 0 } } });
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

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
    expect(claimBodies()[0]).toEqual({ capacity: { light: { limit: 1, in_use: 0 }, heavy: { limit: 0, in_use: 0 }, limited_by: "memory" } });
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

describe("the lockfile update wiring (BUILD-LOCKFILE-ON-DEP-ADD)", () => {
  it("the daemon hands the job handler a lockfile update built on the process-group capture and the guarded git listing, run after the placeholders are cleared and before the check", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");
    expect(text).toContain("...lockfileSyncFor(host.engine, envOptions,");
    const handler = readFileSync(path.join(PACKAGE_DIR, "src", "daemon", "jobHandler.ts"), "utf8");
    expect(handler.indexOf("clearStubs(workspace);")).toBeGreaterThan(-1);
    expect(handler.indexOf("deps.lockfileSync.run(")).toBeGreaterThan(handler.indexOf("clearStubs(workspace);"));
    expect(handler.indexOf("const check = job.check;")).toBeGreaterThan(handler.indexOf("deps.lockfileSync.run("));
  });
});

describe("the scope test wiring (SCOPE-IN-JOB)", () => {
  it("the daemon hands the job handler the guarded listing of changed files, and the handler tests the job's scope after the check's merge-base pin and before the check starts", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");
    expect(text).toMatch(/baseFile: createBaseFile\(host\.engine\.captureLarge, envOptions\), changedFiles: createChangedFiles\(host\.engine\.captureLarge, envOptions\)/);
    const handler = readFileSync(path.join(PACKAGE_DIR, "src", "daemon", "jobHandler.ts"), "utf8");
    const at = handler.indexOf("scopeVerdict({");
    expect(at).toBeGreaterThan(handler.indexOf("git.checkBase?.(job, started.base)"));
    expect(at).toBeLessThan(handler.indexOf("check started (time limit"));
  });
});

describe("the verify browser's protection bypass wiring", () => {
  it("createVerifyLocal is handed the bypass file and the cloud origin when the bypass is set up, and the job handler gets the HEAD readers the derived-file check needs", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");
    expect(text).toMatch(/createVerifyLocal\(\{[^\n]*\.\.\.\(ctx\.bypass\?\.kind === "ok" && ctx\.bypassFile !== undefined \? \{ bypass: \{ file: ctx\.bypassFile, cloudOrigin: registration\.cloud_origin \} \} : \{\}\) \}\);/);
    expect(text).toMatch(/changedFiles: createChangedFiles\(host\.engine\.captureLarge, envOptions\), headBlob: createHeadBlob\(host\.engine\.captureLarge, envOptions\), indexHidesChanges: createIndexHidesChanges\(host\.engine\.captureLarge, envOptions\)/);
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

// D#6 CARD-OOM-CAUSE-WORDS: the composed daemon sends the scope's memory cap on a resource_limit end only to a cloud whose hello kept memory_limit_v1.
describe("7. the memory cap on a resource_limit end follows the hello (D#6 CARD-OOM-CAUSE-WORDS)", () => {
  const CAP = 6 * GB;
  /** A scope that wraps nothing, says the kernel killed the job, and remembers a cap of 6 GB for it. */
  const killedScope = {
    wrap: (_job: { runId: string; role: string }, command: string, args: readonly string[], env: Record<string, string>) => ({ command, args: [...args], env }),
    exceeded: async () => true,
    memoryCap: () => CAP,
  };

  async function endOfKilledJob(prepare: () => void): Promise<Record<string, unknown>> {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    fake.set("exit-code", "137");
    prepare();
    const job = signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    const run = start({ hooks: { jobLimits: { enforced: true, limits: killedScope }, remoteUrl: () => pathToFileURL(remote).href } });
    await until(() => cloud.runs.get(job.job.run_id)?.endedBy !== undefined, 20_000);
    await stop(run);
    return cloud.runs.get(job.job.run_id)!.endedBy as unknown as Record<string, unknown>;
  }

  it.skipIf(process.platform !== "linux")("a cloud that kept memory_limit_v1 gets the cap", async () => {
    expect(await endOfKilledJob(() => undefined)).toMatchObject({ type: "run_ended", reason: "resource_limit", memory_limit_bytes: CAP });
  }, 60_000);

  it.skipIf(process.platform !== "linux")("a cloud that refused memory_limit_v1 on the hello (but took the rest) gets no cap", async () => {
    // The overlap capability (D#483 S5-j2e-RUNNER) goes first, then the memory-proposal capability (D#601 MEM-6), then the tip-publish capability (D#598 P1g-3a-3), then the ordering capability (D#483 S5-j2c2), then the conflict capability (D#519 MQ4-e2-a), then the analyst capability (D#483 S4-f4), then the queue capability (D#694 B7-1), so eight refusals take the hello down to the memory capability being dropped too.
    const ended = await endOfKilledJob(() => {
      for (let i = 0; i < 11; i++) cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    });
    expect(ended).toMatchObject({ type: "run_ended", reason: "resource_limit" });
    expect(ended).not.toHaveProperty("memory_limit_bytes");
  }, 60_000);

  it.skipIf(process.platform !== "linux")("a hello that failed leaves it unsent too", async () => {
    const ended = await endOfKilledJob(() => cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } }));
    expect(ended).toMatchObject({ type: "run_ended", reason: "resource_limit" });
    expect(ended).not.toHaveProperty("memory_limit_bytes");
  }, 60_000);
});

// D#6 RUNNER-401-MESSAGE: a 401 from the cloud's own routes means the key is refused; Vercel's Deployment Protection 401 means a missing or stale bypass. Both reach the run command over real HTTP.
describe("a 401 on the claim poll", () => {
  const SECRET = "bypass-secret-value-0123456789";
  const headers = { server: "Vercel" };
  it("the cloud's own 401 says the key is refused and names the revoke step", async () => {
    cloud.force.claim.push({ status: 401, body: { error: { code: "runner_revoked", message: "runner_revoked" } }, headers });
    const result = await start().done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("no longer accepts this runner's key");
    expect(result.message).toContain("fx-runner revoke --local");
  });

  it.each([{ label: "a stale bypass", bypass: { kind: "ok" as const, secret: SECRET }, says: "was not accepted" }, { label: "no bypass", bypass: undefined, says: "is not set" }])("Vercel's protection 401 with $label names the setting, never suggests revoking, and prints no secret", async ({ bypass, says }) => {
    cloud.force.claim.push({ status: 401, body: VERCEL_PROTECTED_BODY, headers });
    const result = await start({ ctx: { bypass } }).done;
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("FX_RUNNER_PROTECTION_BYPASS_FILE");
    expect(result.message).toContain(says);
    expect(result.message).not.toMatch(/revoke --local|register again|no longer accepts/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(claims()).toBe(1);
  });
});

// D#749 V2c-2b (fix round): the two wires `run` makes from the machine to the engine and back: the verify server settings (verifyServer) and the answer file (verifyAnswer). The agent is the
// fake binary (the claude CLI is never run); it copies a prepared answer into the job's folder the way the fxverify server would.
describe("a playwright deploy verifier job in the composed daemon (D#749 V2c-2b)", () => {
  const ENVELOPE = { journeys: [{ id: "counter", result: "pass", steps: [{ did: "looked", dom_fact: "count is 1", number: 1 }], console_errors: 0, undo_checked: true, reloaded: true }], signed_in_as: "octo-cat" };
  afterEach(() => setPlaywrightLoader(undefined));

  it("builds the fxverify entry from the machine's verify settings (verifyServer), and reports the answer file, not the model's text (verifyAnswer)", async () => {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    const head = git("-C", seed, "rev-parse", "HEAD").trim();
    // a machine that passes the playwright probe
    const exe = path.join(root, "chromium");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    const verifyDir = path.join(home, ".config", "fx-runner", "verify");
    mkdirSync(verifyDir, { recursive: true, mode: 0o700 });
    const state = path.join(verifyDir, "storage-state.json");
    writeFileSync(state, JSON.stringify({ cookies: [{ name: "__Host-fx_session", value: "v", domain: "app.example.test", path: "/", expires: -1 }], origins: [] }), { mode: 0o600 });
    chmodSync(state, 0o600);
    setSetting(stateDir, "verify.test_account", "fx-test-user");
    setSetting(stateDir, "verify.browser.base_url", "https://app.example.test");
    setSetting(stateDir, "verify.browser.executable", exe);
    setPlaywrightLoader({ available: () => true, load: async () => ({}) });
    // the fake agent: ends with the fixture's result, after copying the prepared answer into the folder its settings file sits in
    // Its init line lists the fxverify server as connected, as the CLI does once the server answered its start-up (an init line without it ends the job verify_browser_unavailable).
    fake.set("stream.jsonl", fixtureText("stream.subscription.jsonl").replace('"mcp_servers":[]', '"mcp_servers":[{"name":"fxverify","status":"connected"}]'));
    fake.set("answer.src", JSON.stringify(ENVELOPE));
    const script = readFileSync(fake.binary, "utf8").replace('cat "$D/stream.jsonl"', () => 'J="$(printf \'%s\\n\' "$@" | grep \'/settings.json$\' | head -1)"; [ -f "$D/answer.src" ] && { cp "$D/answer.src" "${J%/settings.json}/answer.json"; chmod 600 "${J%/settings.json}/answer.json"; }\ncat "$D/stream.jsonl"');
    writeFileSync(fake.binary, script);
    const job = signedJob({ role: "deploy-verifier", browser_method: "playwright_runner", task: { kind: "review", prompt: "Check the deploy.\n", prompt_sha256: sha256Text("Check the deploy.\n") }, role_tools_sha256: roleToolsDigest("deploy-verifier", "playwright_runner"), review: { head_sha: head }, issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    cloud.enqueue(job);
    const run = start({ host: { selfCommand: ["/opt/fx/fx-runner", "--flag"], uid: process.getuid!(), username: "tester", env: { PATH: process.env.PATH } }, hooks: { searchPath: toolbin, remoteUrl: () => pathToFileURL(remote).href } });
    await until(() => cloud.seen.some((s) => s.path.endsWith("/done")), 20_000);
    const argv = fake.argv();
    expect(argv).toContain("--no-chrome");
    expect(argv).toContain("mcp__fxverify__submit_answer");
    const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers["fxverify"]?.command).toBe("/opt/fx/fx-runner");
    expect(mcp.mcpServers["fxverify"]?.args).toEqual(expect.arrayContaining(["--flag", "verify-browser-server", "--base-url", "https://app.example.test/", "--executable", exe, "--storage-state", state]));
    const done = cloud.seen.filter((s) => s.path.endsWith("/done"));
    expect((done[0]!.body as { agentOutput?: unknown }).agentOutput).toEqual(ENVELOPE);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);
});

describe("D#587 B-5b-3a: the microVM engine in the composed daemon", () => {
  afterEach(runCleanups);
  const claimBodies = (): Array<Record<string, unknown>> => cloud.seen.filter((s) => s.path === "/api/runner/claim").map((s) => s.body as Record<string, unknown>);
  const queuedJob = () => signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const enableMicrovm = (engine: "microvm" | "os_sandbox"): void => {
    setSetting(stateDir, "sandbox_engine", engine);
    for (const [key, value] of [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", path.join(home, "snaps")], ["microvm.snapshot_quota_bytes", "1073741824"]] as const) setSetting(stateDir, key, value);
  };
  /** Fakes at the host-fact and helper seams: a machine with KVM and a ready helper. */
  const goodFacts: VmHostFacts = { kvm: "present", helperSocket: "present", helperSocketPath: "/fake/helper.sock", helperState: "ready", totalMemMb: 16384, cpus: 8, readMemAvailableBytes: () => 8 * GB };
  const wiredParts = (over: Partial<LiveMicrovmParts> = {}, wrapHelper?: (helper: ReturnType<typeof makeRig>["deps"]["helper"]) => ReturnType<typeof makeRig>["deps"]["helper"]): LiveMicrovmParts => {
    const rig = makeRig();
    const { boot, ...deps } = rig.deps;
    return {
      deps: wrapHelper === undefined ? deps : { ...deps, helper: wrapHelper(deps.helper) },
      boot,
      template: "fx-agent",
      memMb: 256,
      uid: 4711,
      egress: { startProxy: async () => ({ close: async () => undefined }), startReverse: async () => ({ close: async () => undefined }) },
      makeRuntime: () => scriptedRuntime(),
      ...over,
    };
  };
  const sentHello = () => HelloMessage.parse(cloud.seen.find((s) => s.path === "/api/runner/hello")!.body);

  it("a wired microvm runner reports microvm, and its claim lists the daemon's rows: a VM started through the port is there under sb- and 32 hex, and gone after it is deleted", async () => {
    enableMicrovm("microvm");
    let live: LiveMicrovm | undefined;
    const clock = manualClock();
    const run = start({ host: { vmFacts: async () => goodFacts, microvm: wiredParts() }, hooks: { clock, onMicrovmBuilt: (built) => (live = built) } });
    const polls = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; !condition() && i < 200; i++) {
        await clock.advance(5000);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(condition()).toBe(true);
    };
    await until(() => claims() >= 1);
    expect(sentHello().facts).toMatchObject({ sandbox_engine: "microvm" });
    expect(claimBodies()[0]).toMatchObject({ sandboxes: [] });
    const handle = await live!.port.createSandbox({ sandboxName: "rn-run-branch-derived", retention: { persistent: false }, timeoutMs: 60_000 });
    await polls(() => claimBodies().some((b) => Array.isArray(b["sandboxes"]) && (b["sandboxes"] as unknown[]).length === 1));
    const rows = claimBodies().map((b) => b["sandboxes"] as Array<{ name: string }> | undefined).find((r) => r?.length === 1)!;
    expect(rows[0]!.name).toMatch(/^sb-[0-9a-f]{32}$/);
    expect(JSON.stringify(claimBodies())).not.toContain("branch-derived");
    await live!.port.stop(handle);
    await live!.port.deleteSandbox(handle);
    await polls(() => (claimBodies().at(-1)?.["sandboxes"] as unknown[] | undefined)?.length === 0);
    expect(fake.spawnCount()).toBe(0);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

  it("an os_sandbox runner with a complete live stack still reports os_sandbox and sends no sandboxes block: its claim is the one it always sent", async () => {
    enableMicrovm("os_sandbox");
    let built = false;
    const run = start({ host: { vmFacts: async () => goodFacts, microvm: wiredParts() }, hooks: { onMicrovmBuilt: () => (built = true) } });
    await until(() => claims() >= 1);
    expect(built).toBe(true);
    expect(sentHello().facts).toMatchObject({ sandbox_engine: "os_sandbox" });
    expect(Object.keys(claimBodies()[0]!)).toEqual(["capacity"]);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

  it("a microvm runner on a build that lacks a part claims nothing: paused, no reason sent, os_sandbox reported, its queued job never run, and it says so", async () => {
    enableMicrovm("microvm");
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    // each part left out in turn: the guest runtime and the boot facts are the two this build really lacks
    for (const missing of ["makeRuntime", "boot", undefined] as const) {
      const before = claims();
      const parts = missing === undefined ? undefined : { ...wiredParts(), [missing]: undefined };
      const run = start({ host: { vmFacts: async () => goodFacts, ...(parts === undefined ? {} : { microvm: parts }) } });
      await until(() => claims() >= before + 1);
      expect(claimBodies().at(-1), String(missing)).toMatchObject({ capacity: { limited_by: "paused" } });
      expect(claimBodies().at(-1), String(missing)).not.toHaveProperty("sandbox_unavailable");
      expect(claimBodies().at(-1), String(missing)).not.toHaveProperty("sandboxes");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fake.spawnCount()).toBe(0);
      const result = await stop(run);
      expect(result.code).toBe(0);
      expect((await run.done).out).toContain(UNWIRED_LINE);
    }
    const hellos = cloud.seen.filter((s) => s.path === "/api/runner/hello").map((s) => HelloMessage.parse(s.body));
    for (const hello of hellos) expect(hello.facts).toMatchObject({ sandbox_engine: "os_sandbox" });
  }, 60_000);

  it("microvm limits missing or a missing machine fact still win over the unwired block: the claim names the microvm_* reason, as before", async () => {
    enableMicrovm("microvm");
    const run = start({ host: { microvm: { ...wiredParts(), makeRuntime: undefined } } });
    await until(() => claims() >= 1);
    expect(claimBodies()[0]).toEqual({ sandbox_unavailable: "microvm_no_kvm" });
    expect((await stop(run)).code).toBe(0);
  }, 60_000);

  const seedRemote = (): string => {
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    return remote;
  };
  /** Moves the claim loop on until `condition` holds (a bounded number of 5 s polls, each one letting the loop run). */
  const pollsUntil = async (clock: ReturnType<typeof manualClock>, condition: () => boolean): Promise<void> => {
    for (let i = 0; !condition() && i < 200; i++) {
      await clock.advance(5000);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(condition()).toBe(true);
  };
  const lastBodyIsPaused = (): boolean => (claimBodies().at(-1)?.["capacity"] as { limited_by?: string } | undefined)?.limited_by === "paused";

  // No downgrade: the engine is chosen once at start, the setting is read at every claim; a runner set to microvm never runs a job in the OS sandbox, whichever way the two came apart.
  it.skipIf(process.platform !== "linux")("facts that throw once at start (so the run chose os_sandbox) while the setting is microvm: a wired build claims nothing, runs no job, and says it needs a restart", async () => {
    enableMicrovm("microvm");
    const remote = seedRemote();
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    let calls = 0;
    const vmFacts = async (): Promise<VmHostFacts> => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return goodFacts;
    };
    const clock = manualClock();
    const run = start({ host: { vmFacts, microvm: wiredParts() }, hooks: { clock, remoteUrl: () => pathToFileURL(remote).href } });
    await until(() => claims() >= 1);
    await pollsUntil(clock, () => claims() >= 4);
    expect(sentHello().facts).toMatchObject({ sandbox_engine: "os_sandbox" });
    expect(lastBodyIsPaused()).toBe(true);
    for (const body of claimBodies()) expect(body).not.toHaveProperty("sandbox_unavailable");
    expect(cloud.runs.get(job.job.run_id)?.endedBy).toBeUndefined();
    expect(fake.spawnCount()).toBe(0);
    await stop(run);
    expect((await run.done).out).toContain(RESTART_LINE);
  }, 60_000);

  it.skipIf(process.platform !== "linux")("a runner started on os_sandbox whose setting is changed to microvm while it runs stops claiming at the next claim: no job runs in the OS sandbox", async () => {
    enableMicrovm("os_sandbox");
    const remote = seedRemote();
    const clock = manualClock();
    const run = start({ host: { vmFacts: async () => goodFacts, microvm: wiredParts() }, hooks: { clock, remoteUrl: () => pathToFileURL(remote).href } });
    await until(() => claims() >= 1);
    expect(sentHello().facts).toMatchObject({ sandbox_engine: "os_sandbox" });
    expect(lastBodyIsPaused()).toBe(false);
    fake.set("hang", "");
    enableMicrovm("microvm"); // the person runs `fx-runner config set sandbox_engine microvm` (and its limits) while the runner runs
    const job = queuedJob();
    cloud.enqueue(job);
    const before = claims();
    await pollsUntil(clock, () => claims() >= before + 2 && lastBodyIsPaused());
    expect(cloud.runs.get(job.job.run_id)?.endedBy).toBeUndefined();
    expect(fake.spawnCount()).toBe(0);
    await stop(run);
    expect((await run.done).out).toContain(RESTART_LINE);
  }, 60_000);

  it("control: a microvm run whose facts read fine at start is not blocked by the engine check, and says nothing about a restart", async () => {
    enableMicrovm("microvm");
    const run = start({ host: { vmFacts: async () => goodFacts, microvm: wiredParts() } });
    await until(() => claims() >= 1);
    expect(sentHello().facts).toMatchObject({ sandbox_engine: "microvm" });
    expect(lastBodyIsPaused()).toBe(false);
    expect((await stop(run)).code).toBe(0);
    expect((await run.done).out).not.toContain(RESTART_LINE);
  }, 60_000);

  // Threat item 5: only a microvm run gets the daemon's lifecycle. An os_sandbox run with a complete stack answers a signed command as a runner without VMs does.
  describe("signed sandbox commands reach the daemon only on a microvm run", () => {
    type Ack = { outcome: string; refusal?: string };
    const sandboxId = `sb-${"ab".repeat(16)}`;
    const commandsFor = (): ReturnType<typeof signedSandboxCommand>[] => {
      const base = { purpose: SANDBOX_COMMAND_PURPOSE, runner_id: loadRegistration(stateDir)!.runner_id, exp: new Date(Date.now() + 600_000).toISOString() }; // a fresh runner has no nonce history, so a command must outlive its start by the longest command life
      return [
        signedSandboxCommand({ ...base, kind: "stop_sandbox", name: sandboxId, nonce: randomUUID() } as SandboxCommand),
        signedSandboxCommand({ ...base, kind: "delete_sandbox", name: sandboxId, nonce: randomUUID() } as SandboxCommand),
        signedSandboxCommand({ ...base, kind: "reap_sandboxes", nonce: randomUUID() } as SandboxCommand),
      ];
    };
    const acksOf = (): Ack[] => claimBodies().flatMap((b) => (b["sandbox_acks"] as Ack[] | undefined) ?? []);
    /** Runs one runner on `engine` with a complete stack, hands it the three commands, and returns the acks it sends back and every call that reached the daemon's helper after the commands arrived. */
    async function withCommands(engine: "microvm" | "os_sandbox"): Promise<{ acks: Ack[]; helperCalls: string[] }> {
      enableMicrovm(engine);
      const helperCalls: string[] = [];
      let recording = false;
      const spy = (helper: ReturnType<typeof makeRig>["deps"]["helper"]) =>
        new Proxy(helper, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === "function" ? (...args: unknown[]) => (recording && helperCalls.push(String(prop)), (value as (...a: unknown[]) => unknown).apply(target, args)) : value;
          },
        });
      const clock = manualClock();
      const run = start({ host: { vmFacts: async () => goodFacts, microvm: wiredParts({}, spy as never) }, hooks: { clock } });
      await until(() => claims() >= 1);
      expect(sentHello().facts).toMatchObject({ sandbox_engine: engine });
      recording = true;
      cloud.force.claim.push({ status: 200, body: { retry_after: 5, sandbox_commands: commandsFor() } });
      await pollsUntil(clock, () => acksOf().length >= 3);
      const result = { acks: acksOf(), helperCalls: [...helperCalls] };
      await stop(run);
      return result;
    }

    it("an os_sandbox runner with a complete stack refuses a stop, a delete and a reap as unsupported and touches no VM or helper", async () => {
      const { acks, helperCalls } = await withCommands("os_sandbox");
      expect(acks).toHaveLength(3);
      for (const ack of acks) expect(ack).toMatchObject({ outcome: "refused", refusal: "unsupported" });
      expect(helperCalls).toEqual([]);
    }, 60_000);

    it("control: the same commands on a microvm runner do reach the daemon (a reap of nothing is applied), so the refusal above is the engine's doing", async () => {
      const { acks } = await withCommands("microvm");
      expect(acks.some((ack) => ack.outcome === "applied")).toBe(true);
      expect(acks.every((ack) => !(ack.outcome === "refused" && ack.refusal === "unsupported"))).toBe(true);
    }, 60_000);
  });

  it("a settings file that cannot be read stops claiming, whatever it used to say, and never claims as os_sandbox", async () => {
    mkdirSync(stateDir, { recursive: true });
    for (const text of ["{not json", "[]", "null"]) {
      writeFileSync(path.join(stateDir, SETTINGS_FILE), text);
      const before = claims();
      cloud.enqueue(queuedJob());
      const run = start({});
      await until(() => claims() >= before + 1);
      expect(claimBodies().at(-1), text).toMatchObject({ capacity: { limited_by: "paused" } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fake.spawnCount(), text).toBe(0);
      expect((await stop(run)).code).toBe(0);
    }
  }, 60_000);

  it.skipIf(process.platform !== "linux")("a VM that cannot be started ends the job with a closed code and never starts it in the OS sandbox", async () => {
    enableMicrovm("microvm");
    const remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    const job = queuedJob();
    cloud.enqueue(job);
    fake.set("hang", "");
    const refusing = (helper: ReturnType<typeof makeRig>["deps"]["helper"]) => ({
      ...helper,
      prepare: async () => {
        throw new Error("the helper is gone: /private/path/leaks?");
      },
    });
    const run = start({ host: { vmFacts: async () => goodFacts, microvm: wiredParts({}, refusing as never) }, hooks: { remoteUrl: () => pathToFileURL(remote).href } });
    await until(() => cloud.runs.get(job.job.run_id)?.endedBy !== undefined, 30_000);
    const ended = cloud.runs.get(job.job.run_id)!.endedBy as Record<string, unknown>;
    // 3c restores `sandbox_unavailable` here once `run` wires `deps.vm`; until then the job handler's missing-`deps.vm` refusal is the first closed code.
    expect(ended).toMatchObject({ type: "run_ended", reason: "runner_setup", detail: "workspace_failed" });
    expect(JSON.stringify(ended)).not.toContain("private");
    expect(fake.spawnCount()).toBe(0);
    expect(existsSync(path.join(fake.dir, "argv.txt"))).toBe(false);
    expect((await stop(run)).code).toBe(0);
  }, 60_000);
});
