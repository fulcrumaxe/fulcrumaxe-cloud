import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHaltFile } from "../../src/engineBridge/halt.js";
import { ALLOWED_MAX_AGE_MS, startEngineBridge, type EngineBridge, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { saveBridgeSettings, type BridgedRepo } from "../../src/engineBridge/settings.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { acquireHostLock, BRIDGE_STATE_FILE, BRIDGE_STATE_MAX_AGE_MS, openHostLog, readBridgeState, removeBridgeState, writeBridgeState } from "../../src/engineHost/hostFiles.js";
import { createSupervisor } from "../../src/engineHost/supervisor.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

const REPO = 77;
const NAME = "acme/widgets";
const uid = process.getuid?.() ?? -1;

let root: string;
let runnerDir: string;
let stateDir: string;
let repoRoot: string;
let xdg: string;
let ingest: StrictEngineIngest;
let cmds: FakeCommands;
let clock: ManualClock;
let logs: string[];
let key: ReturnType<typeof generateRunnerKey>;
let bridge: EngineBridge | undefined;
let pids: number[];

const ports = (): EngineBridgePorts => ({
  halt: { handleControl: async () => undefined, readHostHandle: () => undefined, readHaltState: () => undefined },
  ceiling: { create: () => ({ run: async (signal) => void (await clock.sleep(1e9, signal)), controlsChanged: () => undefined, status: () => null }) },
});
const repoEntry = (): BridgedRepo => ({ repo_gh_id: REPO, full_name: NAME, state_dir: stateDir, repo_root: repoRoot });

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-eb59-"));
  runnerDir = path.join(root, "runner");
  stateDir = path.join(root, "engine-state");
  repoRoot = path.join(root, "repo");
  xdg = path.join(root, "x");
  for (const d of [runnerDir, stateDir, xdg]) mkdirSync(d, { mode: 0o700 });
  mkdirSync(path.join(repoRoot, "engine"), { recursive: true });
  writeFileSync(path.join(repoRoot, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3", files: {} }));
  key = generateRunnerKey();
  ingest = await startStrictEngineIngest();
  cmds = await startFakeCommands();
  ingest.trust(key.publicJwk);
  cmds.trust(key.publicJwk);
  clock = manualClock(Date.now());
  ingest.now = () => clock.now();
  cmds.now = () => clock.now();
  cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: NAME }];
  cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
  logs = [];
  pids = [];
  bridge = undefined;
});
afterEach(async () => {
  await bridge?.stop();
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // fx-swallow-ok: already gone
    }
  }
  await ingest.close();
  await cmds.close();
  rmSync(root, { recursive: true, force: true });
});

function start(): EngineBridge {
  const cloud = { origin: cmds.origin, key, now: () => clock.now(), fetchFn: fetch };
  bridge = startEngineBridge({
    runnerStateDir: runnerDir,
    uid,
    clock,
    runnerVersion: "0.1.1",
    cloud,
    keyring: cmds.keyring,
    runnerId: cmds.runnerId,
    send: createEventsUploader({ ...cloud, origin: ingest.origin }),
    wakeEpoch: () => null,
    accepted: () => true,
    xdgRuntimeDir: xdg,
    secrets: () => [],
    ports: ports(),
    log: (l) => logs.push(l),
  });
  return bridge;
}
const stateFile = (): string => path.join(stateDir, BRIDGE_STATE_FILE);
const written = (): boolean => {
  try {
    return readFileSync(stateFile(), "utf8").length > 0;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

/** What `engine-host start` checks first: the real supervisor, the real reader and the real halt file, with a stand-in process for the host. */
async function hostStart(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { sup } = makeSupervisor();
  const r = await sup.start();
  if (r.ok) await sup.stop("stopped_by_person");
  return r;
}

/** The real supervisor with its timers in the test's hands: `fire` runs the longest-waiting timer, `launches` counts the processes it started. */
function makeSupervisor(): { sup: ReturnType<typeof createSupervisor>; timers: Array<{ ms: number; fn: () => void; live: boolean }>; launches: () => number } {
  const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
  let launched = 0;
  const sup = createSupervisor({
    stateDir,
    uid,
    platform: "linux",
    claudePath: "/nonexistent/claude",
    readBridgeState: () => readBridgeState(stateDir, uid),
    env: { PATH: process.env.PATH ?? "" },
    log: openHostLog(stateDir, uid),
    emit: () => undefined,
    now: () => Date.now(),
    after: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    isAlive: () => false,
    startTimeOf: () => "t",
    isOurHost: () => false,
    acquireLock: () => acquireHostLock(stateDir, uid, { ownPid: process.pid, isAlive: () => false, startOf: () => "T0" }),
    scopeAvailable: async () => true,
    killHost: async (handle) => {
      try {
        process.kill(-handle.pid, "SIGKILL");
      } catch {
        // fx-swallow-ok: already gone
      }
    },
    killScope: async () => undefined,
    launch: () => {
      launched += 1;
      const child = spawn(process.execPath, ["-e", "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
      if (child.pid !== undefined) pids.push(child.pid);
      child.on("error", () => undefined);
      child.stdin.on("error", () => undefined);
      return { pid: child.pid, write: () => undefined, closeStdin: () => child.stdin.end(), onStdout: (cb) => child.stdout.on("data", cb), onStderr: (cb) => child.stderr.on("data", cb), onExit: (cb) => child.on("exit", () => cb()) };
    },
  });
  return { sup, timers, launches: () => launched };
}

describe("the daemon writes engine-bridge-state.json, and the engine host's start check reads it", () => {
  it("passes after a pull with operate on: exact shape, 0600, written by the daemon, and the start check accepts it", async () => {
    expect(written()).toBe(false);
    expect(await hostStart()).toEqual({ ok: false, reason: "bridge_disabled" }); // nothing else writes it
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(written, "the state file");
    expect(statSync(stateFile()).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["bridge_enabled", "operate_enabled", "repo_checkout", "repo_gh_id", "written_at"]);
    expect(body).toMatchObject({ repo_gh_id: String(REPO), bridge_enabled: true, operate_enabled: true, repo_checkout: repoRoot });
    expect(body.written_at).toBe(clock.now().getTime());
    expect(await hostStart()).toEqual({ ok: true });
    expect(readdirSync(stateDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses with operate off: the file says operate_enabled false", async () => {
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(written, "the state file");
    expect(readBridgeState(stateDir, uid)).toMatchObject({ bridge_enabled: true, operate_enabled: false });
    expect(await hostStart()).toEqual({ ok: false, reason: "operate_off" });
  });

  it("follows the cloud: a pull that carries no control for the repo flips the file to off", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(written, "the state file");
    expect(readBridgeState(stateDir, uid)?.operate_enabled).toBe(true);
    cmds.controls.delete(REPO);
    for (let done = 0; done < 11 * 60_000 && readBridgeState(stateDir, uid)?.operate_enabled !== false; done += 10_000) {
      await clock.advance(10_000, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitFor(() => readBridgeState(stateDir, uid)?.operate_enabled === false, "operate off in the file");
  });

  it("refuses while halted: the halt file the kill path writes still stops the start", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(written, "the state file");
    writeHaltFile(stateDir, { halted: true, halt_epoch: 3, at: "2026-11-18T10:00:00.000Z" }, uid);
    expect(await hostStart()).toEqual({ ok: false, reason: "halted" });
  });

  it("refuses once the repo is removed from the bridge: the file is removed, and absent reads as bridge_disabled", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(written, "the state file");
    saveBridgeSettings(runnerDir, []);
    void clock.advance(10_000, 10_000);
    await waitFor(() => !written(), "the file to go");
    expect(await hostStart()).toEqual({ ok: false, reason: "bridge_disabled" });
  });

  it("removes the file when the daemon stops", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(written, "the state file");
    await bridge!.stop();
    expect(written()).toBe(false);
  });

  it("does not write through a link at the name: the target is left alone, one fixed line says so, and the start check refuses the link", async () => {
    const victim = path.join(root, "victim.json");
    writeFileSync(victim, "untouched", { mode: 0o600 });
    symlinkSync(victim, stateFile());
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await waitFor(() => logs.some((l) => l.includes("bridge state file could not be written")), "the refusal line");
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(logs.join("\n")).not.toContain(root);
    expect(await hostStart()).toEqual({ ok: false, reason: "state_unreadable" });
  });

  it("the cap on age is the bridge's own freshness rule", () => {
    expect(BRIDGE_STATE_MAX_AGE_MS).toBe(ALLOWED_MAX_AGE_MS);
  });
});

describe("a halt comes before the file says operate on", () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const runPorts = (handleControl: EngineBridgePorts["halt"]["handleControl"]): EngineBridgePorts => ({ ...ports(), halt: { ...ports().halt, handleControl } });
  const startWith = (p: EngineBridgePorts): void => {
    const cloud = { origin: cmds.origin, key, now: () => clock.now(), fetchFn: fetch };
    bridge = startEngineBridge({ runnerStateDir: runnerDir, uid, clock, runnerVersion: "0.1.1", cloud, keyring: cmds.keyring, runnerId: cmds.runnerId, send: createEventsUploader({ ...cloud, origin: ingest.origin }), wakeEpoch: () => null, accepted: () => true, xdgRuntimeDir: xdg, secrets: () => [], ports: p, log: (l) => logs.push(l) });
  };

  it("writes nothing while the halt is still being handled, and writes once it is done", async () => {
    let release: () => void = () => undefined;
    let entered = false;
    const gate = new Promise<void>((r) => (release = r));
    saveBridgeSettings(runnerDir, [repoEntry()]);
    startWith(
      runPorts(async () => {
        entered = true;
        await gate;
        return undefined;
      }),
    );
    await waitFor(() => entered, "the halt to be handled");
    await settle(150);
    expect(written()).toBe(false); // the pull was answered and the halt is not done: the host must not be told to operate
    release();
    await waitFor(written, "the state file");
    expect(readBridgeState(stateDir, uid)?.operate_enabled).toBe(true);
  });

  it("when the halt cannot be completed, the file is removed and never written: start refuses, a running host stops at its next heartbeat, and nothing restarts it", async () => {
    // A file from an earlier, good pull: the host starts on it.
    writeBridgeState(stateDir, uid, { repo_gh_id: String(REPO), bridge_enabled: true, operate_enabled: true, repo_checkout: repoRoot }, clock.now().getTime());
    const host = makeSupervisor();
    expect(await host.sup.start()).toEqual({ ok: true });
    expect(host.launches()).toBe(1);
    let calls = 0;
    saveBridgeSettings(runnerDir, [repoEntry()]);
    startWith(
      runPorts(async () => {
        calls += 1;
        throw new Error("the halt file could not be written");
      }),
    );
    await waitFor(() => calls > 0 && !written(), "the failed halt to remove the file");
    await settle(150);
    expect(written()).toBe(false); // not rewritten with operate on after the failed halt
    // The real heartbeat finds no file and ends the host through the kill path, as "operate off".
    const beat = host.timers.filter((t) => t.live && t.ms === 60_000).at(-1);
    expect(beat).toBeDefined();
    beat!.fn();
    expect(await host.sup.stopped).toBe("operate_off");
    await settle(50);
    expect(host.launches()).toBe(1); // no crash-restart
    expect(host.timers.filter((t) => t.live && t.ms > 60_000)).toEqual([]);
    expect(await hostStart()).toEqual({ ok: false, reason: "bridge_disabled" });
  });
});

describe("readBridgeState and writeBridgeState", () => {
  const base = { repo_gh_id: "77", bridge_enabled: true, operate_enabled: true, repo_checkout: "/srv/acme" };
  it("treats a file older than the cap as off, and one stamped in the future too; a fresh one passes", () => {
    const now = 5_000_000_000;
    writeBridgeState(stateDir, uid, base, now);
    expect(readBridgeState(stateDir, uid, now + BRIDGE_STATE_MAX_AGE_MS)).toMatchObject({ repo_gh_id: "77" });
    expect(readBridgeState(stateDir, uid, now + BRIDGE_STATE_MAX_AGE_MS + 1)).toBeUndefined();
    expect(readBridgeState(stateDir, uid, now - 59_000)).toMatchObject({ repo_gh_id: "77" });
    expect(readBridgeState(stateDir, uid, now - 61_000)).toBeUndefined();
  });
  it("a stale file stops the engine host's start check, a fresh one lets it through", async () => {
    writeFileSync(stateFile(), JSON.stringify({ ...base, repo_checkout: repoRoot, written_at: Date.now() - BRIDGE_STATE_MAX_AGE_MS - 5_000 }), { mode: 0o600 });
    expect(await hostStart()).toEqual({ ok: false, reason: "bridge_disabled" });
    writeFileSync(stateFile(), JSON.stringify({ ...base, repo_checkout: repoRoot, written_at: Date.now() }), { mode: 0o600 });
    expect(await hostStart()).toEqual({ ok: true });
  });
  it("refuses a file with the wrong mode, a link, a wrong shape and a bad stamp", () => {
    writeFileSync(stateFile(), JSON.stringify({ ...base, written_at: Date.now() }), { mode: 0o600 });
    chmodSync(stateFile(), 0o644);
    expect(() => readBridgeState(stateDir, uid)).toThrow();
    rmSync(stateFile());
    writeFileSync(path.join(root, "t.json"), JSON.stringify({ ...base, written_at: Date.now() }), { mode: 0o600 });
    symlinkSync(path.join(root, "t.json"), stateFile());
    expect(() => readBridgeState(stateDir, uid)).toThrow();
    rmSync(stateFile());
    writeFileSync(stateFile(), JSON.stringify(base), { mode: 0o600 });
    expect(() => readBridgeState(stateDir, uid)).toThrow();
    writeFileSync(stateFile(), JSON.stringify({ ...base, written_at: "now" }), { mode: 0o600 });
    expect(() => readBridgeState(stateDir, uid)).toThrow();
    writeFileSync(stateFile(), JSON.stringify({ ...base, written_at: Date.now(), extra: 1 }), { mode: 0o600 });
    expect(() => readBridgeState(stateDir, uid)).toThrow();
  });
  it("a writer refuses a link at the name and a state the reader would refuse; an old wrong-mode file is replaced by a 0600 one", () => {
    symlinkSync(path.join(root, "nowhere"), stateFile());
    expect(() => writeBridgeState(stateDir, uid, base, 1)).toThrow();
    rmSync(stateFile());
    expect(() => writeBridgeState(stateDir, uid, { ...base, repo_checkout: "relative" }, 1)).toThrow();
    expect(() => writeBridgeState(stateDir, uid, { ...base, repo_gh_id: "0x1" }, 1)).toThrow();
    writeFileSync(stateFile(), "x", { mode: 0o666 });
    chmodSync(stateFile(), 0o666);
    writeBridgeState(stateDir, uid, base, Date.now());
    expect(statSync(stateFile()).mode & 0o777).toBe(0o600);
  });
  it("refuses a state directory open to others", () => {
    chmodSync(stateDir, 0o755);
    expect(() => writeBridgeState(stateDir, uid, base, 1)).toThrow();
  });
  it("is atomic: a reader holding the old file still sees all of it, the name points at a new file, and no temp file is left", () => {
    writeBridgeState(stateDir, uid, base, 1000);
    const before = statSync(stateFile()).ino;
    const old = openSync(stateFile(), "r");
    const oldText = readFileSync(stateFile(), "utf8");
    writeBridgeState(stateDir, uid, { ...base, operate_enabled: false }, 2000);
    const buf = Buffer.alloc(4096);
    const n = readSync(old, buf, 0, 4096, 0);
    closeSync(old);
    expect(buf.subarray(0, n).toString("utf8")).toBe(oldText);
    expect(statSync(stateFile()).ino).not.toBe(before);
    expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toMatchObject({ operate_enabled: false, written_at: 2000 });
    expect(readdirSync(stateDir).filter((x) => x.includes(".tmp"))).toEqual([]);
  });
  it("removeBridgeState removes a plain file, tolerates none and leaves a link alone", () => {
    removeBridgeState(stateDir);
    writeBridgeState(stateDir, uid, base, 1);
    removeBridgeState(stateDir);
    expect(() => statSync(stateFile())).toThrow();
    symlinkSync(path.join(root, "nowhere"), stateFile());
    expect(() => removeBridgeState(stateDir)).toThrow();
  });
});
