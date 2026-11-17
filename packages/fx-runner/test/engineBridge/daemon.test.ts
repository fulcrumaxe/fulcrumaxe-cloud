import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { WakeTracker } from "../../src/daemon/wake.js";
import type { Claimed } from "../../src/daemon/client.js";
import { PULL_PATH, type HaltOutcome } from "../../src/engineBridge/commands.js";
import { ALLOWED_MAX_AGE_MS, ALLOWED_PROBE_MS, ENGINE_EVENTS_FILE, PROBE_REPO_ID, parseAllowedRepos, readDaemonStatus, startEngineBridge, type EngineBridge, type EngineBridgeDeps, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { saveBridgeSettings, type BridgedRepo } from "../../src/engineBridge/settings.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, until, type ManualClock } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const REPO = 77;
const NAME = "acme/widgets";
const uid = process.getuid?.();
const line = (seq: number, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ v: 1, engine_instance_id: A, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5, ...extra })}\n`;

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

interface Calls {
  controls: Array<{ stateDir: string; handle: unknown; control: unknown; opts: unknown }>;
  keeper: { created: number; changed: number; runs: number };
}
let calls: Calls;
let halt: { outcome: HaltOutcome | undefined; haltedState: { halted: boolean } | undefined | "throw"; handle: { pid: number } | undefined | "throw" };

function fakePorts(): EngineBridgePorts {
  return {
    halt: {
      handleControl: async (dir, handle, control, opts) => {
        calls.controls.push({ stateDir: dir, handle, control, opts });
        return halt.outcome;
      },
      readHostHandle: () => {
        if (halt.handle === "throw") throw new Error("/secret/path unreadable");
        return halt.handle;
      },
      readHaltState: () => {
        if (halt.haltedState === "throw") throw new Error("/secret/path unreadable");
        return halt.haltedState;
      },
    },
    ceiling: {
      create: () => {
        calls.keeper.created++;
        return {
          run: async (signal) => {
            calls.keeper.runs++;
            await clock.sleep(1e9, signal);
          },
          controlsChanged: () => void calls.keeper.changed++,
          status: () => null,
        };
      },
    },
  };
}

const repoEntry = (over: Partial<BridgedRepo> = {}): BridgedRepo => ({ repo_gh_id: REPO, full_name: NAME, state_dir: stateDir, repo_root: repoRoot, ...over });
const manifest = (version: string | object): void => {
  mkdirSync(path.join(repoRoot, "engine"), { recursive: true });
  writeFileSync(path.join(repoRoot, "engine", "manifest.json"), JSON.stringify(typeof version === "string" ? { engine_version: version, files: {} } : version), { mode: 0o644 });
};

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-eb3c-"));
  runnerDir = path.join(root, "runner");
  stateDir = path.join(root, "engine-state");
  repoRoot = path.join(root, "repo");
  xdg = path.join(root, "x");
  for (const d of [runnerDir, stateDir, xdg]) mkdirSync(d, { mode: 0o700 });
  manifest("1.2.3");
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
  calls = { controls: [], keeper: { created: 0, changed: 0, runs: 0 } };
  halt = { outcome: undefined, haltedState: undefined, handle: undefined };
  bridge = undefined;
});
afterEach(async () => {
  await bridge?.stop();
  await ingest.close();
  await cmds.close();
  rmSync(root, { recursive: true, force: true });
});

function start(over: Partial<EngineBridgeDeps> = {}): EngineBridge {
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
    ports: fakePorts(),
    log: (l) => logs.push(l),
    ...over,
  });
  return bridge;
}
/** Moves the manual clock by `ms` in `stepMs` steps, letting the loops run for real between steps. */
async function passTime(ms: number, stepMs = 10_000): Promise<void> {
  for (let done = 0; done < ms; done += stepMs) {
    await clock.advance(stepMs, stepMs);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const running = (b: EngineBridge): boolean => b.status().repos.some((r) => r.run === "running");
async function advanceUntil(cond: () => boolean, stepMs = 2000, max = 60): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) {
    await clock.advance(stepMs, stepMs);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The virtual-time budget above is what the caller asked for. Real file and socket IO behind the last step can still be in flight on a loaded machine, so give it real time to land without moving the clock further.
  for (let since = Date.now(); !cond() && Date.now() - since < 15_000; ) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!cond()) throw new Error("condition never held");
}
const request = (socketPath: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/api/runner/engine/decide", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
const decide = { repo_gh_id: REPO, decision_type: "engine_spawn", request_key: "k1", subject: { role: "executor", discussion: 5 } };
const sock = (): string => path.join(xdg, "fx-runner", "engine-bridge.sock");

describe("starting, per repo, from the cloud's list", () => {
  it("starts the upload loop, the command puller and the ceiling keeper for an enabled repo that is on the cloud's list, with the manifest's version", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), `${line(0)}${line(1)}`, { mode: 0o600 });
    const c = cmds.command(REPO, 3);
    cmds.queue.push(c);
    const b = start();
    await advanceUntil(() => ingest.seqsOf(A).length === 2 && readdirSync(path.join(stateDir, "engine-inbox")).some((f) => f.startsWith("3-")));
    expect(ingest.seqsOf(A)).toEqual([0, 1]);
    expect(calls.keeper.created).toBe(1);
    expect(calls.keeper.runs).toBe(1);
    // Every upload says the engine version of the manifest; the bridge's own session says the runner's.
    expect(b.status().repos[0]).toMatchObject({ run: "running", reason: null, upload: { state: "uploading" } });
    expect(cmds.pulls.at(-1)).toMatchObject({ repo_gh_ids: [REPO] });
    expect(logs.join("\n")).not.toContain(root);
  });

  it("starts nothing until the hello kept engine_bridge_v1", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    let accepted = false;
    const b = start({ accepted: () => accepted });
    await clock.advance(30_000, 10_000);
    expect(running(b)).toBe(false);
    expect(cmds.pulls).toEqual([]);
    expect(b.status()).toMatchObject({ hello: false, repos: [{ run: "waiting", reason: "hello" }] });
    accepted = true;
    await advanceUntil(() => running(b));
  });

  it("asks the cloud with a probe id no repo has when nothing runs yet, and starts nothing for a repo that is not on the list it gets", async () => {
    cmds.allowedRepos = [{ repo_gh_id: 99, full_name: "acme/other" }];
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    const b = start();
    await advanceUntil(() => b.status().repos[0]?.run === "refused");
    expect(cmds.pulls[0]).toEqual({ repo_gh_ids: [PROBE_REPO_ID], after_seq: {} });
    expect(b.status().repos[0]).toMatchObject({ run: "refused", reason: "not_allowed", upload: null, pull: null });
    await clock.advance(30_000, 5_000);
    expect(ingest.seen).toEqual([]);
    expect(calls.keeper.created).toBe(0);
    // And no decide socket is served for a machine with nothing bridged.
    expect(b.status().socket).toBe("off");
  });

  it("refuses a repo whose id is listed under another name, and waits (does not start) while the cloud sends no list", async () => {
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: "acme/renamed" }];
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const b = start();
    await advanceUntil(() => b.status().repos[0]?.run === "refused");
    expect(b.status().repos[0]!.reason).toBe("not_allowed");
    // An older cloud without `allowed_repos`: the repo waits and nothing starts.
    cmds.allowedRepos = undefined;
    await b.stop();
    const b2 = start();
    await clock.advance(40_000, 10_000);
    expect(b2.status().repos[0]).toMatchObject({ run: "waiting", reason: "cloud_list" });
    expect(running(b2)).toBe(false);
  });

  it("stops a running repo when the cloud's list drops it, and when the person disables it", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const b = start();
    await advanceUntil(() => running(b));
    cmds.allowedRepos = [];
    await advanceUntil(() => !running(b), 5000);
    expect(b.status().repos[0]).toMatchObject({ run: "refused", reason: "not_allowed" });
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: NAME }];
    await advanceUntil(() => running(b), 5000, 90);
    saveBridgeSettings(runnerDir, []);
    await advanceUntil(() => b.status().repos.length === 0);
    expect(b.status().socket).toBe("off");
  });

  it("refuses a repo with no readable engine version, a manifest that is a link, and a runner version that is not a dotted number", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    manifest({ engine_version: "v1.2", files: {} });
    let b = start();
    await advanceUntil(() => b.status().repos[0]?.run === "refused");
    expect(b.status().repos[0]!.reason).toBe("engine_bad_version");
    await b.stop();
    rmSync(path.join(repoRoot, "engine", "manifest.json"));
    writeFileSync(path.join(root, "elsewhere.json"), JSON.stringify({ engine_version: "1.2.3" }));
    symlinkSync(path.join(root, "elsewhere.json"), path.join(repoRoot, "engine", "manifest.json"));
    b = start();
    await advanceUntil(() => b.status().repos[0]?.run === "refused");
    expect(b.status().repos[0]!.reason).toBe("engine_unsafe_manifest");
    await b.stop();
    rmSync(path.join(repoRoot, "engine", "manifest.json"));
    manifest("1.2.3");
    b = start({ runnerVersion: "0.1.1-rc1" });
    await advanceUntil(() => b.status().repos[0]?.run === "refused");
    expect(b.status().repos[0]!.reason).toBe("bridge_version");
    expect(ingest.seen).toEqual([]);
  });

  it("starts nothing from a settings file that lists one state directory twice", async () => {
    writeFileSync(path.join(runnerDir, "engine-bridge.json"), JSON.stringify({ version: 1, repos: [repoEntry(), repoEntry({ repo_gh_id: 78, full_name: "acme/other" })] }), { mode: 0o600 });
    const b = start();
    await clock.advance(30_000, 10_000);
    expect(b.status()).toMatchObject({ settings: "damaged", repos: [] });
    expect(cmds.pulls).toEqual([]);
  });
});

describe("the cloud's list: its identity, its age, and the hello", () => {
  it("refuses a repo whose enabled name is listed under another GitHub id: the id and the name must both match", async () => {
    cmds.allowedRepos = [{ repo_gh_id: 99, full_name: NAME }];
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    const b = start();
    await advanceUntil(() => b.status().repos[0]?.run === "refused");
    expect(b.status().repos[0]).toMatchObject({ run: "refused", reason: "not_allowed", upload: null, pull: null });
    await clock.advance(30_000, 5_000);
    expect(ingest.seen).toEqual([]);
    expect(calls.keeper.created).toBe(0);
    expect(b.status().socket).toBe("off");
  });

  it("stops a running repo when the list it runs on is older than 10 minutes, asks again with a probe, and starts again on a fresh list", async () => {
    expect(ALLOWED_MAX_AGE_MS).toBe(600_000);
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const b = start();
    await advanceUntil(() => running(b));
    // The cloud keeps answering, but with no list: nothing renews the one held.
    cmds.allowedRepos = undefined;
    await passTime(ALLOWED_MAX_AGE_MS - 120_000);
    expect(running(b)).toBe(true);
    await advanceUntil(() => !running(b), 10_000, 40);
    expect(b.status().repos[0]).toMatchObject({ run: "waiting", reason: "cloud_list", upload: null, pull: null });
    expect(b.status().socket).toBe("off");
    // It asks again (a probe pull) and stays stopped while the answers hold no list.
    const before = cmds.pulls.length;
    await passTime(180_000);
    expect(cmds.pulls.length).toBeGreaterThan(before);
    expect(cmds.pulls.slice(before).every((p) => p.repo_gh_ids[0] === PROBE_REPO_ID)).toBe(true);
    expect(running(b)).toBe(false);
    // A fresh list starts it again.
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: NAME }];
    await advanceUntil(() => running(b), 10_000, 40);
  });

  it("after the clock jumps back an hour, stops the repo, asks again within one probe period, and starts again on the fresh list", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const b = start();
    await advanceUntil(() => running(b));
    // The list was taken "an hour from now"; the clock steps back: the list's age is negative, which is no fresh list.
    cmds.allowedRepos = undefined;
    clock.jump(-3_600_000);
    await advanceUntil(() => !running(b), 10_000, 6);
    expect(b.status().repos[0]).toMatchObject({ run: "waiting", reason: "cloud_list" });
    // It asks at once (a probe), not an hour later, and the repo restarts when the answer holds the list.
    const before = cmds.pulls.length;
    await passTime(ALLOWED_PROBE_MS + 20_000);
    expect(cmds.pulls.length).toBeGreaterThan(before);
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: NAME }];
    await advanceUntil(() => running(b), 10_000, 12);
  });

  it("takes a list's age from when it was asked for: an answer asked before the clock stepped back and landing after it is no fresh list", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    // Every answer waits on the wire after its list is read.
    cmds.pullDelayMs = 200;
    const b = start();
    await advanceUntil(() => running(b));
    // The repo's own first pull has been answered with the list, and that answer is still on the wire when the list goes away and the clock steps back an hour.
    await until(() => cmds.pulls.some((p) => p.repo_gh_ids[0] === REPO));
    expect(calls.keeper.changed).toBe(0);
    cmds.allowedRepos = undefined;
    clock.jump(-3_600_000);
    cmds.pullDelayMs = 0;
    // The late answer lands (its controls reach the keeper) before the clock moves again.
    await until(() => calls.keeper.changed > 0);
    // It holds the list, but the list is as old as its ask: an hour "ahead", which is no fresh list, so the repo stops on the next supervising pass.
    await advanceUntil(() => !running(b), 10_000, 3);
    expect(b.status().repos[0]).toMatchObject({ run: "waiting", reason: "cloud_list" });
  });

  it("an older ask's late answer never replaces a newer list", async () => {
    const other = path.join(root, "other-repo");
    mkdirSync(path.join(other, "engine"), { recursive: true });
    writeFileSync(path.join(other, "engine", "manifest.json"), JSON.stringify({ engine_version: "2.0.0", files: {} }), { mode: 0o644 });
    const otherState = path.join(root, "other-state");
    mkdirSync(otherState, { mode: 0o700 });
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: NAME }, { repo_gh_id: 78, full_name: "acme/gadgets" }];
    cmds.controls.set(78, { halt_epoch: 0, halted: false, operate_enabled: true });
    saveBridgeSettings(runnerDir, [repoEntry(), repoEntry({ repo_gh_id: 78, full_name: "acme/gadgets", state_dir: otherState, repo_root: other })]);
    const b = start();
    const st = (id: number) => b.status().repos.find((r) => r.repo_gh_id === id)!;
    await advanceUntil(() => st(REPO).run === "running" && st(78).run === "running");
    // Only REPO's answers are held on the wire; its next ask reads the old list, with REPO on it.
    cmds.pullDelayFor = (ids) => (ids[0] === REPO ? 3000 : 0);
    const mark = cmds.pulls.length;
    await advanceUntil(() => cmds.pulls.slice(mark).some((p) => p.repo_gh_ids[0] === REPO), 1000, 30);
    // The cloud drops REPO; 78's later ask answers first with the new list.
    cmds.allowedRepos = [{ repo_gh_id: 78, full_name: "acme/gadgets" }];
    await advanceUntil(() => st(REPO).reason === "not_allowed", 2000, 15);
    // No later list arrives; the old ask's answer lands.
    cmds.allowedRepos = undefined;
    await until(() => cmds.lateAnswered > 0);
    const created = calls.keeper.created;
    await passTime(30_000);
    expect(calls.keeper.created).toBe(created);
    expect(st(REPO)).toMatchObject({ run: "refused", reason: "not_allowed" });
  });

  it("judges each repo on its own when a port throws for one: the other still starts, the failing one is refused, the bridge goes on", async () => {
    const other = path.join(root, "other-repo");
    mkdirSync(path.join(other, "engine"), { recursive: true });
    writeFileSync(path.join(other, "engine", "manifest.json"), JSON.stringify({ engine_version: "2.0.0" }), { mode: 0o644 });
    const otherState = path.join(root, "other-state");
    mkdirSync(otherState, { mode: 0o700 });
    cmds.allowedRepos = [
      { repo_gh_id: REPO, full_name: NAME },
      { repo_gh_id: 78, full_name: "acme/gadgets" },
    ];
    cmds.controls.set(78, { halt_epoch: 0, halted: false, operate_enabled: true });
    saveBridgeSettings(runnerDir, [repoEntry(), repoEntry({ repo_gh_id: 78, full_name: "acme/gadgets", state_dir: otherState, repo_root: other })]);
    const ports = fakePorts();
    const create = ports.ceiling.create;
    ports.ceiling.create = (...args) => {
      if (args[1].repoGhId === REPO) throw new Error("/secret/path ceiling port failed");
      return create(...args);
    };
    const b = start({ ports });
    await advanceUntil(() => b.status().repos.some((r) => r.repo_gh_id === 78 && r.run === "running"));
    expect(b.status().repos.find((r) => r.repo_gh_id === REPO)).toMatchObject({ run: "refused", reason: "unexpected" });
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("does not start a repo on a list older than 10 minutes", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const b = start();
    await advanceUntil(() => running(b));
    cmds.allowedRepos = undefined;
    saveBridgeSettings(runnerDir, []);
    await advanceUntil(() => b.status().repos.length === 0);
    await passTime(ALLOWED_MAX_AGE_MS + 60_000, 20_000);
    // The repo is enabled again; the list held is stale and the cloud still sends none: it waits.
    saveBridgeSettings(runnerDir, [repoEntry()]);
    await passTime(60_000);
    expect(running(b)).toBe(false);
    expect(b.status().repos[0]).toMatchObject({ run: "waiting", reason: "cloud_list" });
  });

  it("stops every running repo when a later hello drops engine_bridge_v1, and starts them again on one that keeps it", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    let accepted = true;
    const b = start({ accepted: () => accepted });
    await advanceUntil(() => b.status().socket === "serving");
    expect(running(b)).toBe(true);
    accepted = false;
    await advanceUntil(() => !running(b), 10_000, 10);
    expect(b.status()).toMatchObject({ hello: false, socket: "off", repos: [{ run: "waiting", reason: "hello", upload: null, pull: null }] });
    const pulls = cmds.pulls.length;
    await clock.advance(60_000, 10_000);
    expect(cmds.pulls.length).toBe(pulls);
    accepted = true;
    await advanceUntil(() => running(b));
  });

  it("judges each repo on its own: a repo root that is a file refuses that repo and the other one still starts", async () => {
    const other = path.join(root, "other-repo");
    mkdirSync(path.join(other, "engine"), { recursive: true });
    writeFileSync(path.join(other, "engine", "manifest.json"), JSON.stringify({ engine_version: "2.0.0" }), { mode: 0o644 });
    const otherState = path.join(root, "other-state");
    mkdirSync(otherState, { mode: 0o700 });
    const fileRoot = path.join(root, "a-file");
    writeFileSync(fileRoot, "not a directory");
    cmds.allowedRepos = [
      { repo_gh_id: REPO, full_name: NAME },
      { repo_gh_id: 78, full_name: "acme/gadgets" },
    ];
    cmds.controls.set(78, { halt_epoch: 0, halted: false, operate_enabled: true });
    saveBridgeSettings(runnerDir, [repoEntry({ repo_root: fileRoot }), repoEntry({ repo_gh_id: 78, full_name: "acme/gadgets", state_dir: otherState, repo_root: other })]);
    const b = start();
    await advanceUntil(() => b.status().repos.some((r) => r.repo_gh_id === 78 && r.run === "running"));
    expect(b.status().repos.find((r) => r.repo_gh_id === REPO)).toMatchObject({ run: "refused", reason: "engine_unsafe_manifest" });
    expect(logs.join("\n")).not.toContain("failed");
  });
});

describe("the command puller's bindings", () => {
  it("binds handleControl to the repo's state directory, the host handle and opts.repoGhId, and reports halt_applied through the bridge, method none included", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    halt.handle = { pid: 4242 };
    halt.outcome = { halt_epoch: 2, method: "none", survivors: 0 };
    cmds.controls.set(REPO, { halt_epoch: 2, halted: true, operate_enabled: true });
    const b = start();
    await advanceUntil(() => [...ingest.sessions.values()].some((s) => s.stored.some((e) => e.kind === "halt_applied")));
    expect(calls.controls[0]).toEqual({ stateDir, handle: { pid: 4242 }, control: { halt_epoch: 2, halted: true }, opts: { repoGhId: REPO } });
    const reported = [...ingest.sessions.values()].flatMap((s) => s.stored).filter((e) => e.kind === "halt_applied");
    // `none` is sent as group_only, and a count of 0 for a kill nothing checked is never sent: one survivor at least.
    expect(reported).toMatchObject([{ halt_epoch: 2, method: "group_only", survivors: 1 }]);
    expect(b.status().repos[0]!.pull).toMatchObject({ state: "idle" });
  });

  it("passes a host file that cannot be read as 'nothing could be checked', never a path", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    halt.handle = "throw";
    cmds.controls.set(REPO, { halt_epoch: 1, halted: true, operate_enabled: true });
    start();
    await advanceUntil(() => calls.controls.length > 0);
    expect(calls.controls[0]).toMatchObject({ handle: undefined, opts: { repoGhId: REPO, handleProblem: expect.not.stringContaining("secret") } });
  });

  it("binds localHalted to the halt-state reader and fails closed: a start-like command is refused halted while the file says so, and when it cannot be read", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    halt.haltedState = { halted: true };
    const first = cmds.command(REPO, 1, { kind: "start_day" });
    cmds.queue.push(first);
    start();
    await advanceUntil(() => cmds.acks.length === 1);
    expect(cmds.acks[0]).toEqual({ id: first.command_id, ack: { outcome: "refused", refusal: "halted" } });
    halt.haltedState = "throw";
    const second = cmds.command(REPO, 2, { kind: "start_day" });
    cmds.queue.push(second);
    await advanceUntil(() => cmds.acks.length === 2);
    expect(cmds.acks[1]).toEqual({ id: second.command_id, ack: { outcome: "refused", refusal: "halted" } });
    halt.haltedState = { halted: false };
    const third = cmds.command(REPO, 3, { kind: "pause_loop" });
    cmds.queue.push(third);
    await advanceUntil(() => readdirSync(path.join(stateDir, "engine-inbox")).some((f) => f.startsWith("3-")));
  });

  it("calls controlsChanged on the ceiling keeper after a pull whose controls changed, and not after one that did not", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    start();
    await advanceUntil(() => cmds.pulls.filter((p) => p.repo_gh_ids[0] === REPO).length >= 2);
    const settled = calls.keeper.changed;
    expect(settled).toBe(1);
    await advanceUntil(() => cmds.pulls.filter((p) => p.repo_gh_ids[0] === REPO).length >= 4);
    expect(calls.keeper.changed).toBe(settled);
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    await advanceUntil(() => calls.keeper.changed === settled + 1);
  });
});

describe("the decide socket", () => {
  it("serves only repos that run, and forwards a decision only while the last pull said operate is on", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const b = start();
    await advanceUntil(() => b.status().socket === "serving");
    await advanceUntil(() => b.status().repos[0]?.pull?.state === "idle" && cmds.pulls.some((p) => p.repo_gh_ids[0] === REPO));
    // A repo this runner does not bridge: refused here, nothing reaches the cloud.
    expect(await request(sock(), { ...decide, repo_gh_id: 5 })).toEqual({ status: 403, body: { error: "wrong_repo" } });
    expect(cmds.decides).toEqual([]);
    // A bridged repo with operate on goes to the cloud and the answer comes back.
    expect(await request(sock(), decide)).toMatchObject({ status: 200, body: { disposition: "act" } });
    expect(cmds.decides).toHaveLength(1);
    // Operate off at the last pull: refused locally.
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    for (let i = 0; i < 40; i++) {
      const r = await request(sock(), { ...decide, request_key: `k${i + 2}` });
      if (r.status === 403) {
        expect(r.body).toEqual({ error: "operate_off" });
        break;
      }
      await clock.advance(2000, 2000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (i === 39) throw new Error("operate never went off");
    }
    expect(cmds.decides.length).toBeLessThan(40);
    await b.stop();
    await expect(request(sock(), decide)).rejects.toBeDefined();
  });

  it("never forwards a decision while operate is unknown: before the first pull answers, and when the pull holds no control for the repo", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    // The cloud sends no control for the repo at all.
    cmds.controls.delete(REPO);
    const b = start();
    await advanceUntil(() => b.status().socket === "serving");
    await advanceUntil(() => cmds.pulls.some((p) => p.repo_gh_ids[0] === REPO) && b.status().repos[0]?.pull?.state === "idle");
    expect(await request(sock(), decide)).toEqual({ status: 403, body: { error: "operate_off" } });
    expect(cmds.decides).toEqual([]);
    // Once the cloud sends a control that says operate is on, it goes through.
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
    await advanceUntil(() => cmds.pulls.length > 4);
    for (let i = 0; i < 40 && cmds.decides.length === 0; i++) {
      await request(sock(), { ...decide, request_key: `n${i}` });
      await clock.advance(2000, 2000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cmds.decides.length).toBeGreaterThan(0);
  });

  it("keeps uploading when the socket cannot be served (no runtime directory)", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    const b = start({ xdgRuntimeDir: undefined });
    await advanceUntil(() => ingest.seqsOf(A).length === 1 && b.status().socket === "unavailable");
    expect(logs.filter((l) => l.includes("decide socket"))).toHaveLength(1);
  });
});

describe("independence from the claim loop, and the status file", () => {
  it("claims a job while the bridge is in backoff and the command pull is failing", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    const b = start();
    await advanceUntil(() => running(b));
    ingest.faults.push(...Array.from({ length: 30 }, () => ({ status: 500 }) as const));
    cmds.faults.push(...Array.from({ length: 30 }, () => ({ status: 500 }) as const));
    await advanceUntil(() => b.status().repos[0]?.upload?.state === "backoff" && b.status().repos[0]?.pull?.state === "backoff");
    const stop = new AbortController();
    const claimed: string[] = [];
    const queue: Claimed[] = [];
    const signed = signedJob({ role: "security-reviewer" as never });
    queue.push({ kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 });
    const poll = pollLoop({
      client: { claim: async () => queue.shift() ?? { kind: "idle", retryAfter: 60 } },
      clock,
      gate: OPEN_GATE,
      signal: stop.signal,
      onClaimed: async (c) => void claimed.push(c.runId),
      random: () => 1,
    });
    await until(() => claimed.length === 1);
    expect(b.status().repos[0]!.upload!.state).toBe("backoff");
    stop.abort();
    await poll;
  });

  it("gives the command puller the wake epoch the claim loop last saw", () => {
    const tracker = new WakeTracker();
    expect(tracker.seenEpoch()).toBeNull();
    tracker.onWake({ epoch: 7, dueAt: null }, 0);
    expect(tracker.seenEpoch()).toBe(7);
  });

  it("writes a status file of closed words and numbers that `status` reads, with its age, and no path or event content", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    const b = start();
    await advanceUntil(() => readDaemonStatus(runnerDir, clock.now().getTime())?.status.repos[0]?.upload?.lastAckedSeq === 0);
    await clock.advance(90_000, 10_000);
    const read = readDaemonStatus(runnerDir, clock.now().getTime())!;
    expect(read.status.repos[0]).toMatchObject({ repo_gh_id: REPO, full_name: NAME, run: "running", upload: { state: "uploading", lastAckedSeq: 0 } });
    expect(read.ageS).toBeLessThanOrEqual(60);
    const text = JSON.stringify(read.status);
    expect(text).not.toContain(root);
    expect(text).not.toContain("loop_tick");
    await b.stop();
  });
});

describe("the cloud's list", () => {
  it("is read strictly: an entry with another key, a bad name, an id of 0 or more than 100 entries make it no list", () => {
    const ok = { repo_gh_id: 1, full_name: "acme/w" };
    expect(parseAllowedRepos({ allowed_repos: [ok] })).toEqual([ok]);
    expect(parseAllowedRepos({})).toBeUndefined();
    for (const bad of [{ ...ok, extra: 1 }, { repo_gh_id: 0, full_name: "acme/w" }, { repo_gh_id: 1, full_name: "../x" }, { repo_gh_id: 1.5, full_name: "acme/w" }]) expect(parseAllowedRepos({ allowed_repos: [ok, bad] })).toBeUndefined();
    expect(parseAllowedRepos({ allowed_repos: Array.from({ length: 101 }, () => ok) })).toBeUndefined();
    expect(PULL_PATH).toBe("/api/runner/engine/commands/pull");
  });
});
