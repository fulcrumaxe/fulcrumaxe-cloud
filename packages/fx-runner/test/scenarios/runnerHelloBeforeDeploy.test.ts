import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelloMessage, OVERLAP_FACTS_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../../src/cliError.js";
import { saveRegistration } from "../../src/config.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import { runCommand, type RunHooks, type RunHost } from "../../src/commands/run.js";
import type { CommandContext } from "../../src/context.js";
import type { ResourceProbe } from "../../src/daemon/resources.js";
import { fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { manualClock, until } from "../helpers/manualClock.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { KEYRING } from "../helpers/signedJob.js";
import { shellSandboxUsable, testLaunch } from "../helpers/launch.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 5: a runner said hello to a cloud that did not yet know a capability, and the cloud was then deployed with it.
 *
 * The runner is the real daemon (`runCommand`) over the strict runner-cloud fake of fx-runner's tests, which enforces the protocol's message shapes. The older cloud
 * refuses the hello that lists the newest capabilities (400 invalid_message, as a cloud whose schema predates them does): `engine_bridge_v1` (D#842 EB-3c) is the newest and goes first, then `overlap_facts_v1`, so the runner's
 * hello goes again without each and the overlap verdict is held back (`dropped` names it). The test then lets the cloud "deploy": the strict cloud now answers every hello in full.
 *
 * What this asserts is TODAY's behaviour: nothing in the poll loop notices the cloud changed, so the overlap verdict stays off until the runner restarts.
 * The desired behaviour is the todo at the end (RUNNER-REHELLO-ON-CLOUD-CHANGE).
 */
describe("scenario: a runner's hello predates a cloud deploy that added a capability", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let cloud: StrictRunnerCloud;
  let fake: Fake;
  let toolbin: string;
  const GB = 1024 ** 3;
  const ROOMY: ResourceProbe = { read: () => ({ totalMemBytes: 64 * GB, availMemBytes: 60 * GB, load1: 0, cores: 32, freeDiskBytes: 500 * GB }) };
  type Signals = EventEmitter & RunHost["signals"];

  beforeEach(async () => {
    root = mkdtempSync(path.join(socketTmpRoot(), "fxr-scn-"));
    home = path.join(root, "home");
    stateDir = path.join(home, ".fx-runner");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    cloud = await startStrictRunnerCloud();
    fake = makeFake({ stream: fixtureText("stream.subscription.jsonl").split("\n")[0]! + "\n" });
    toolbin = path.join(root, "toolbin");
    mkdirSync(toolbin);
    for (const name of ["bwrap", "socat"]) {
      writeFileSync(path.join(toolbin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(toolbin, name), 0o755);
    }
    symlinkSync(fake.binary, path.join(toolbin, "claude"));
    const key = generateRunnerKey();
    saveRunnerKey(stateDir, key);
    saveRegistration(stateDir, { version: 1, cloud_origin: cloud.origin, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
    cloud.trust(key.publicJwk);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await cloud.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  });

  const claims = (): number => cloud.seen.filter((s) => s.path === "/api/runner/claim").length;
  const hellos = () => cloud.seen.filter((s) => s.path === "/api/runner/hello");

  function start(hooks: RunHooks) {
    const signals = new EventEmitter() as Signals;
    const out: string[] = [];
    const ctx: CommandContext = { stateDir, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(), fetchFn: fetch };
    const host: RunHost = { home, platform: "linux", signals, pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), chdir: () => undefined, engine: createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }), sandbox: fakeSandboxHost(), managedServer: () => true };
    const done = runCommand(ctx, host, { keyrings: { [originHash(cloud.origin)!]: KEYRING }, searchPath: toolbin, probe: ROOMY, jobLimits: { enforced: true }, ...hooks }).then(
      (code) => ({ code }),
      (error: unknown) => {
        if (!(error instanceof CliError)) throw error;
        return { code: error.exitCode };
      },
    );
    return { signals, done };
  }
  const stop = (run: ReturnType<typeof start>) => (run.signals.emit("SIGTERM"), run.done);
  const listed = (body: unknown): string[] => HelloMessage.parse(body).capabilities ?? [];

  it("a cloud that predates the capability drops it at hello; the cloud's deploy is not noticed by the running poll loop; only a restart picks it up", async () => {
    const overlap: boolean[] = [];
    // The sign-in reading (`modelAuth`) bounds itself with a 12 s sleep on the injected clock. Here time moves in whole seconds per tick while the reading spawns a real process, so a
    // virtual 12 s can pass before the process answers: the reading then times out (fail closed, model_auth_present false) and a sixth hello is said for THAT, which this scenario is not about.
    // That wait is therefore kept on real time; every other wait stays on the manual clock.
    const manual = manualClock();
    const clock: typeof manual = Object.assign(Object.create(manual) as typeof manual, {
      sleep: (ms: number, signal: AbortSignal) => (ms === 12_000 ? new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }) : manual.sleep(ms, signal)),
    });
    // The cloud before the deploy: it refuses the hello that lists the newest capability (sandbox_commands_v1, D#587 B-7b), then the one that still lists watch_mode_v1, then the one that still lists engine_bridge_v1, then the one that still lists overlap_facts_v1.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    // D#845 MC-8b: machine_login_v1 sits between sandbox_commands_v1 and watch_mode_v1 on the ladder: one more refusal.
    cloud.force.hello.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const run = start({ clock, onOverlapFactsAccepted: (a: boolean) => void overlap.push(a) });
    await until(() => claims() >= 1);
    // The first hello listed every capability and was refused; the second dropped only the newest (sandbox_commands_v1) and was refused; the third also dropped watch_mode_v1 (which sits just ahead of engine_bridge_v1 on the ladder) and was refused; the fourth also dropped engine_bridge_v1 and was refused; the fifth went without overlap_facts_v1 and was answered.
    expect(hellos()).toHaveLength(6);
    expect(listed(hellos()[0]!.body)).toContain("sandbox_commands_v1");
    expect(listed(hellos()[1]!.body)).not.toContain("sandbox_commands_v1");
    expect(listed(hellos()[1]!.body)).toContain("machine_login_v1");
    expect(listed(hellos()[2]!.body)).not.toContain("machine_login_v1");
    expect(listed(hellos()[2]!.body)).toContain("watch_mode_v1");
    expect(listed(hellos()[3]!.body)).not.toContain("watch_mode_v1");
    expect(listed(hellos()[3]!.body)).toContain("engine_bridge_v1");
    expect(listed(hellos()[4]!.body)).toContain(OVERLAP_FACTS_CAPABILITY);
    expect(listed(hellos()[4]!.body)).not.toContain("engine_bridge_v1");
    expect(listed(hellos()[5]!.body)).not.toContain(OVERLAP_FACTS_CAPABILITY);
    expect(listed(hellos()[5]!.body)).not.toContain("engine_bridge_v1");
    expect(overlap).toEqual([false]);

    // The cloud is deployed with the capability (nothing is forced any more: every hello would now be answered in full). The runner keeps polling for a long while.
    const before = claims();
    while (claims() < before + 30) await clock.advance(5000);
    await clock.advance(10 * 60_000);
    // Today: no new hello is said, so the overlap verdict is still held back. (RUNNER-REHELLO-ON-CLOUD-CHANGE is the todo below.)
    expect(hellos()).toHaveLength(6);
    expect(overlap).toEqual([false]);
    expect(await stop(run)).toMatchObject({ code: 0 });

    // A restart is a fresh hello to the deployed cloud, which keeps the capability.
    const restarted = start({ clock: manualClock(), onOverlapFactsAccepted: (a: boolean) => void overlap.push(a) });
    await until(() => hellos().length >= 7 && overlap.length >= 2);
    expect(listed(hellos()[6]!.body)).toContain(OVERLAP_FACTS_CAPABILITY);
    expect(listed(hellos()[6]!.body)).toContain("sandbox_commands_v1");
    expect(overlap).toEqual([false, true]);
    expect(await stop(restarted)).toMatchObject({ code: 0 });
  });

  it.todo("RUNNER-REHELLO-ON-CLOUD-CHANGE: a running runner says hello again when a claim reply shows the cloud's capability set changed, so the overlap verdict is sent without a restart");
});
