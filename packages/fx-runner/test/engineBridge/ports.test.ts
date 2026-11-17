import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CEILING_FILE } from "../../src/engineBridge/ceiling.js";
import { startEngineBridge, type EngineBridge } from "../../src/engineBridge/daemon.js";
import { ENGINE_HALT_FILE, haltDepsFrom } from "../../src/engineBridge/halt.js";
import { createEngineBridgePorts } from "../../src/engineBridge/ports.js";
import { saveBridgeSettings } from "../../src/engineBridge/settings.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { startStrictEngineDials, type StrictEngineDials } from "../helpers/strictEngineDials.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

/** The real halt path and ceiling keeper behind `EngineBridgePorts` (waits on the kill-path and dial-ceiling changes it binds). */
const uid = process.getuid!();
const REPO = 77;
let root: string;
let stateDir: string;
let clock: ManualClock;

/** A host with no process table: every program fails to start, so a halt can prove nothing about processes (method none, one survivor) but still writes its file. */
const haltDeps = () =>
  haltDepsFrom({
    platform: "linux",
    uid,
    ownPid: process.pid,
    runFile: ((_file: string, _args: string[], _options: unknown, callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void) => callback(Object.assign(new Error("no such program"), { code: "ENOENT" }), "")) as never,
    readFile: () => {
      throw new Error("no file");
    },
    readPidCgroup: () => undefined,
    cgroupProcsFile: () => "/nonexistent",
    terminateGroup: async () => undefined,
    env: {},
  });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fx-eb3c-ports-"));
  stateDir = path.join(root, "engine-state");
  mkdirSync(stateDir, { mode: 0o700 });
  clock = manualClock(Date.now());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the halt port", () => {
  it("reads the halt file's state: none is not halted, a halted file is, a link and a garbled file are refused (so the bridge fails closed)", () => {
    const { halt } = createEngineBridgePorts(haltDeps());
    expect(halt.readHaltState(stateDir, uid)).toBeUndefined();
    writeFileSync(path.join(stateDir, ENGINE_HALT_FILE), JSON.stringify({ halted: true, halt_epoch: 3, at: "2026-11-16T15:00:00.000Z" }), { mode: 0o600 });
    expect(halt.readHaltState(stateDir, uid)).toMatchObject({ halted: true });
    rmSync(path.join(stateDir, ENGINE_HALT_FILE));
    writeFileSync(path.join(root, "target.json"), JSON.stringify({ halted: false, halt_epoch: 0, at: "x" }), { mode: 0o600 });
    symlinkSync(path.join(root, "target.json"), path.join(stateDir, ENGINE_HALT_FILE));
    expect(() => halt.readHaltState(stateDir, uid)).toThrow();
    rmSync(path.join(stateDir, ENGINE_HALT_FILE));
    writeFileSync(path.join(stateDir, ENGINE_HALT_FILE), "{garbled", { mode: 0o600 });
    expect(() => halt.readHaltState(stateDir, uid)).toThrow();
  });

  it("applies a halt control through the real kill path: the halt file first, and an outcome that proved nothing is method none with one survivor", async () => {
    const { halt } = createEngineBridgePorts(haltDeps());
    const outcome = await halt.handleControl(stateDir, undefined, { halt_epoch: 4, halted: true }, { repoGhId: REPO });
    expect(outcome).toMatchObject({ halt_epoch: 4, method: "none", survivors: 1 });
    expect(JSON.parse(readFileSync(path.join(stateDir, ENGINE_HALT_FILE), "utf8"))).toMatchObject({ halted: true, halt_epoch: 4 });
    expect(halt.readHaltState(stateDir, uid)).toMatchObject({ halted: true });
    // The same control again changes nothing and reports nothing.
    expect(await halt.handleControl(stateDir, undefined, { halt_epoch: 4, halted: true }, { repoGhId: REPO })).toBeUndefined();
  });

  it("reads no host handle when none is recorded, and refuses a malformed one", () => {
    const { halt } = createEngineBridgePorts(haltDeps());
    expect(halt.readHostHandle(stateDir, uid)).toBeUndefined();
    writeFileSync(path.join(stateDir, "engine-host.json"), JSON.stringify({ pid: 1 }), { mode: 0o600 });
    expect(() => halt.readHostHandle(stateDir, uid)).toThrow();
    writeFileSync(path.join(stateDir, "engine-host.json"), JSON.stringify({ pid: 4242, unit: "fx-engine-host-77.scope" }), { mode: 0o600 });
    expect(halt.readHostHandle(stateDir, uid)).toEqual({ pid: 4242, unit: "fx-engine-host-77.scope" });
  });
});

describe("the ceiling port", () => {
  let dials: StrictEngineDials;
  beforeEach(async () => {
    dials = await startStrictEngineDials();
  });
  afterEach(() => dials.close());

  it("builds a keeper that fetches the repo's dials with the runner's key and writes the ceiling file, and writes it again on controlsChanged", async () => {
    const key = generateRunnerKey();
    dials.trust(key.publicJwk);
    dials.covered.add(REPO);
    dials.now = () => clock.now();
    const keeper = createEngineBridgePorts(haltDeps()).ceiling.create({ origin: dials.origin, key, now: () => clock.now(), fetchFn: fetch }, { stateDir, uid, clock, repoGhId: REPO, log: () => undefined });
    const stop = new AbortController();
    const done = keeper.run(stop.signal);
    for (let i = 0; i < 100 && keeper.status() === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(keeper.status()).toBe("written");
    expect(existsSync(path.join(stateDir, CEILING_FILE))).toBe(true);
    const before = dials.seen.length;
    keeper.controlsChanged();
    for (let i = 0; i < 100 && dials.seen.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    expect(dials.seen.length).toBeGreaterThan(before);
    stop.abort();
    await done;
  });
});

describe("the bindings, end to end through the daemon", () => {
  let ingest: StrictEngineIngest;
  let cmds: FakeCommands;
  let bridge: EngineBridge | undefined;
  beforeEach(async () => {
    ingest = await startStrictEngineIngest();
    cmds = await startFakeCommands();
  });
  afterEach(async () => {
    await bridge?.stop();
    await ingest.close();
    await cmds.close();
  });

  it("a halt control kills through the real path and writes the halt file before any command of that pull reaches the inbox; a start-like command is then refused halted", async () => {
    const key = generateRunnerKey();
    ingest.trust(key.publicJwk);
    cmds.trust(key.publicJwk);
    ingest.now = () => clock.now();
    cmds.now = () => clock.now();
    const repoRoot = path.join(root, "repo");
    mkdirSync(path.join(repoRoot, "engine"), { recursive: true });
    writeFileSync(path.join(repoRoot, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }));
    const runner = path.join(root, "runner");
    mkdirSync(runner, { mode: 0o700 });
    saveBridgeSettings(runner, [{ repo_gh_id: REPO, full_name: "acme/widgets", state_dir: stateDir, repo_root: repoRoot }]);
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: "acme/widgets" }];
    cmds.controls.set(REPO, { halt_epoch: 5, halted: true, operate_enabled: true });
    const start = cmds.command(REPO, 1, { kind: "start_day", halt_epoch: 5 });
    cmds.queue.push(start);
    const cloud = { origin: cmds.origin, key, now: () => clock.now(), fetchFn: fetch };
    bridge = startEngineBridge({ runnerStateDir: runner, uid, clock, runnerVersion: "0.1.1", cloud, keyring: cmds.keyring, runnerId: cmds.runnerId, send: createEventsUploader({ ...cloud, origin: ingest.origin }), wakeEpoch: () => null, accepted: () => true, xdgRuntimeDir: undefined, secrets: () => [], ports: createEngineBridgePorts(haltDeps()), log: () => undefined });
    for (let i = 0; i < 60 && cmds.acks.length === 0; i++) {
      await clock.advance(2000, 2000);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(JSON.parse(readFileSync(path.join(stateDir, ENGINE_HALT_FILE), "utf8"))).toMatchObject({ halted: true, halt_epoch: 5 });
    expect(cmds.acks).toEqual([{ id: start.command_id, ack: { outcome: "refused", refusal: "halted" } }]);
    expect(existsSync(path.join(stateDir, "engine-inbox", `1-${start.command_id}.json`))).toBe(false);
    // The cloud was told: halt_applied in the bridge's own session, never a clean zero for a kill that checked nothing.
    for (let i = 0; i < 60 && ![...ingest.sessions.values()].some((s) => s.stored.some((e) => e.kind === "halt_applied")); i++) {
      await clock.advance(2000, 2000);
      await new Promise((r) => setTimeout(r, 5));
    }
    const halts = [...ingest.sessions.values()].flatMap((s) => s.stored).filter((e) => e.kind === "halt_applied");
    expect(halts[0]).toMatchObject({ halt_epoch: 5, method: "group_only", survivors: 1 });
  });
});
