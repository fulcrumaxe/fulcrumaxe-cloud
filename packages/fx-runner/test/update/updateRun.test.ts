import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRegistration } from "../../src/config.js";
import type { CommandContext } from "../../src/context.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import { EXIT_RESTART_FOR_UPDATE, runCommand, type RunHost } from "../../src/commands/run.js";
import { updatesLine } from "../../src/commands/update.js";
import { linkedVersion, loadUpdateState, saveUpdateState } from "../../src/update/versions.js";
import { fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { until } from "../helpers/manualClock.js";
import { KEYRING } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { program, updateWorld, type UpdateWorld } from "../helpers/updateWorld.js";

/**
 * The composed daemon with self-update (D#6 R6-2b): the claim loop is the real one against a strict fake cloud, the release client is a
 * counting stand-in, the programs and the link are real files.
 */

let w: UpdateWorld;
let home: string;
let cloud: StrictRunnerCloud;
let fake: Fake;
let toolbin: string;

beforeEach(async () => {
  w = updateWorld();
  home = path.join(w.root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  cloud = await startStrictRunnerCloud();
  fake = makeFake({ stream: fixtureText("stream.subscription.jsonl").split("\n")[0]! + "\n" });
  toolbin = path.join(w.root, "toolbin");
  mkdirSync(toolbin);
  for (const name of ["bwrap", "socat"]) {
    writeFileSync(path.join(toolbin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(toolbin, name), 0o755);
  }
  symlinkSync(fake.binary, path.join(toolbin, "claude"));
  const key = generateRunnerKey();
  saveRunnerKey(w.stateDir, key);
  saveRegistration(w.stateDir, { version: 1, cloud_origin: cloud.origin, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
  cloud.trust(key.publicJwk);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cloud.close();
  rmSync(fake.dir, { recursive: true, force: true });
});

const claims = (): number => cloud.seen.filter((s) => s.path === "/api/runner/claim").length;
const T = (v: string): string => `v${v}/fx-runner-linux-x64`;

function start(hostOver: Partial<UpdateWorld["host"]> = {}) {
  const signals = new EventEmitter() as unknown as RunHost["signals"] & EventEmitter;
  const out: string[] = [];
  const ctx: CommandContext = { stateDir: w.stateDir, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(), fetchFn: fetch };
  const host: RunHost = { home, platform: "linux", signals, pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), engine: createClaudeKit(spawn), sandbox: fakeSandboxHost() };
  const done = runCommand(ctx, host, { keyrings: { [originHash(cloud.origin)!]: KEYRING }, searchPath: toolbin, updateTuf: w.tuf }, { ...w.host, ...hostOver });
  return { signals, out, done };
}

describe("self-update in the claim loop", () => {
  it("in the foreground: applies between jobs, prints the restart line, and keeps claiming on the old process", async () => {
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const run = start();
    await until(() => claims() >= 1);
    expect(linkedVersion(w.stateDir)).toBe("1.1.0");
    expect(run.out.join("\n")).toContain("Updated to 1.1.0. Restart `fx-runner run` to use it.");
    expect(w.tuf.fetchCalls).toEqual([T("1.1.0")]);
    run.signals.emit("SIGTERM");
    expect(await run.done).toBe(0);
    // it does not try to apply the same version again
    expect(w.tuf.fetchCalls).toHaveLength(1);
  });

  it("under the service unit: exits 75 right after the switch, before the next claim", async () => {
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const run = start({ inService: true });
    expect(await run.done).toBe(EXIT_RESTART_FOR_UPDATE);
    expect(EXIT_RESTART_FOR_UPDATE).toBe(75);
    expect(linkedVersion(w.stateDir)).toBe("1.1.0");
    expect(claims()).toBe(0);
    expect(run.out.join("\n")).toContain("updated to 1.1.0; restarting on it");
  });

  it("an expired timestamp leaves jobs claimable, and doctor shows 'paused' with the reason", async () => {
    w.tuf.listOutcome = { ok: false, state: "paused", code: "metadata_expired", expiredOn: "2026-10-01", message: "updates paused: release metadata expired on 2026-10-01" };
    const run = start();
    await until(() => claims() >= 1);
    expect(w.tuf.listCalls).toBe(1);
    expect(w.tuf.fetchCalls).toEqual([]);
    const line = updatesLine(w.stateDir, { version: "1.0.0", execPath: w.host.execPath }, true);
    expect(line.level).toBe("WARN");
    expect(line.detail).toContain("updates paused: release metadata expired on 2026-10-01");
    run.signals.emit("SIGTERM");
    expect(await run.done).toBe(0);
  });

  it("a Homebrew path never stages or switches, and claims as usual", async () => {
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const run = start({ execPath: "/opt/homebrew/Cellar/fx-runner/1.0.0/bin/fx-runner", inService: true });
    await until(() => claims() >= 1);
    expect(w.tuf.listCalls).toBe(0);
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
    run.signals.emit("SIGTERM");
    expect(await run.done).toBe(0);
  });

  it("automatic updates off, or a pin, mean no call; a failed update does not stop claiming", async () => {
    w.tuf.add(T("1.1.0"), program("1.1.0", { versionLine: "fx-runner 0.0.1" }));
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: false });
    const off = start();
    await until(() => claims() >= 1);
    expect(w.tuf.listCalls).toBe(0);
    off.signals.emit("SIGTERM");
    await off.done;

    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true });
    const bad = start();
    await until(() => claims() >= 2);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(loadUpdateState(w.stateDir).failed).toBe("1.1.0");
    bad.signals.emit("SIGTERM");
    expect(await bad.done).toBe(0);
  });

  it("start removes what an interrupted update left, before the first claim", async () => {
    mkdirSync(path.join(w.stateDir, "versions", "1.1.0"));
    writeFileSync(path.join(w.stateDir, "versions", "1.1.0", "fx-runner"), "partial");
    mkdirSync(path.join(w.stateDir, "versions", ".staging-deadbeef"));
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: false, applying: { version: "1.1.0", from: "1.0.0" } });
    const run = start();
    await until(() => claims() >= 1);
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    run.signals.emit("SIGTERM");
    expect(await run.done).toBe(0);
  });
});
