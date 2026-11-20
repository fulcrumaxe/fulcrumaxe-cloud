import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HaltOutcome } from "../../src/engineBridge/commands.js";
import { ENGINE_EVENTS_FILE, startEngineBridge, type EngineBridge, type EngineBridgeDeps, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { saveBridgeSettings, type BridgedRepo } from "../../src/engineBridge/settings.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
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

/**
 * D#845 watch mode through the daemon, over real HTTP to the fakes: the hello's protocol gates it (ruling 13), the on-demand events wait in the spool until a signed `watch` command
 * arrives, that command is applied even though operate is off (ruling 11) and writes nothing to the engine's inbox, and the events then go out in a session of their own.
 */
const sessionKinds = (): Array<{ id: string; kinds: string[] }> => [...ingest.sessions].map(([id, s]) => ({ id, kinds: s.stored.map((e) => e.kind) }));
const withKind = (kind: string) => sessionKinds().filter((s) => s.kinds.includes(kind));
// Stamped with the test clock: a catch-up reaches back 24 h, and the fixed stamp of `line` is days before it.
const lines = (): string => {
  const ts = clock.now().toISOString();
  return `${line(0, { ts })}${line(1, { ts })}${line(2, { ts })}${line(3, { ts, kind: "merged", pr: 12, closes: false, origin: undefined, duration_s: undefined })}`;
};
const watchCommand = (seq: number, aheadMs: number) => {
  const issued = clock.now();
  return cmds.command(REPO, seq, { kind: "watch", issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(), args: { until: new Date(issued.getTime() + aheadMs).toISOString() } } as never);
};
// A folder that does not exist is the same as one with no spool files: the plain bridge may never make it.
const spoolIn = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.includes(".detail."));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};
const inboxJson = (): string[] => readdirSync(path.join(stateDir, "engine-inbox")).filter((f) => f.endsWith(".json"));

describe("watch mode in the daemon", () => {
  it("with the cloud at the watch protocol, an unwatched repo uploads its always-on kinds and a slim status, and keeps the rest on the machine", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), lines(), { mode: 0o600 });
    start({ cloudWatchMode: () => true });
    await advanceUntil(() => withKind("merged").length === 1 && withKind("slim_status").length === 1);
    expect(withKind("loop_tick")).toEqual([]);
    expect(withKind("bridge_heartbeat")).toEqual([]);
    expect(ingest.seqsOf(A)).toEqual([3]);
    expect(readdirSync(path.join(runnerDir, "engine-bridge")).filter((f) => f.includes(".detail."))).toHaveLength(2);
  });

  it("with a cloud that has not said 23, the plain bridge sends everything and the heartbeat, and makes no spool", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), lines(), { mode: 0o600 });
    start({ cloudWatchMode: () => false });
    await advanceUntil(() => withKind("merged").length === 1 && withKind("bridge_heartbeat").length === 1);
    expect(ingest.seqsOf(A)).toEqual([0, 1, 2, 3]);
    expect(withKind("slim_status")).toEqual([]);
    expect(spoolIn(path.join(runnerDir, "engine-bridge"))).toEqual([]);
  });

  it("a signed watch command, with operate off, starts the catch-up in the detail session, is acked applied and never reaches the engine's inbox", async () => {
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), lines(), { mode: 0o600 });
    start({ cloudWatchMode: () => true });
    await advanceUntil(() => withKind("merged").length === 1);
    expect(withKind("loop_tick")).toEqual([]);
    const watch = watchCommand(1, 300_000);
    cmds.queue.push(watch);
    await advanceUntil(() => withKind("loop_tick").length === 1 && cmds.acks.some((a) => a.id === watch.command_id));
    const detail = withKind("loop_tick")[0]!;
    expect(detail.id).not.toBe(A);
    expect(detail.kinds).toEqual(["loop_tick", "loop_tick", "loop_tick"]);
    expect(cmds.acks.find((a) => a.id === watch.command_id)!.ack).toEqual({ outcome: "applied" });
    expect(inboxJson()).toEqual([]);
    // The engine's own session never got a loop_tick.
    expect(ingest.seqsOf(A)).toEqual([3]);
    expect(logs.join("\n")).not.toContain(root);
  });

  it("a disconnect leaves no detail on the machine: when the repo leaves the settings the loop is stopped first and the spool is removed after it, and a running loop cannot write it back", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), lines(), { mode: 0o600 });
    const b = start({ cloudWatchMode: () => true });
    await advanceUntil(() => withKind("merged").length === 1);
    const spoolFiles = (): string[] => spoolIn(path.join(runnerDir, "engine-bridge"));
    expect(spoolFiles()).toHaveLength(2);
    saveBridgeSettings(runnerDir, []);
    await advanceUntil(() => !running(b));
    expect(spoolFiles()).toEqual([]);
    // More lines arrive and time passes: nothing writes the spool again.
    appendFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), lines().split("\n").slice(0, 1).join("\n") + "\n");
    await clock.advance(60_000, 10_000);
    expect(spoolFiles()).toEqual([]);
  });

  it("at start it sweeps the spools of repos that are no longer bridged (disabled by hand while no daemon ran), and leaves a bridged repo's and any other file alone", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const dir = path.join(runnerDir, "engine-bridge");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of ["99.detail.jsonl", "99.detail.json", `${REPO}.detail.jsonl`, `${REPO}.detail.json`, "99.cursor.json", "notes.detail.json"]) writeFileSync(path.join(dir, name), "", { mode: 0o600 });
    start({ cloudWatchMode: () => true });
    await advanceUntil(() => !readdirSync(dir).includes("99.detail.jsonl"));
    expect(readdirSync(dir).sort()).toEqual(["99.cursor.json", `${REPO}.detail.json`, `${REPO}.detail.jsonl`, "notes.detail.json"].sort());
  });

  it("a repo whose settings only change binding keeps its spool (it is not a disconnect)", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), lines(), { mode: 0o600 });
    const b = start({ cloudWatchMode: () => true });
    await advanceUntil(() => withKind("merged").length === 1);
    const before = readdirSync(path.join(runnerDir, "engine-bridge")).filter((f) => f.includes(".detail.")).sort();
    saveBridgeSettings(runnerDir, [repoEntry({ repo_root: path.join(root, "elsewhere") })]);
    await clock.advance(40_000, 10_000);
    expect(b.status().settings).toBe("ok");
    expect(readdirSync(path.join(runnerDir, "engine-bridge")).filter((f) => f.includes(".detail.")).sort()).toEqual(before);
  });

  it("a watch does not lift what operate gates: with operate off a start_day is still refused operate_off", async () => {
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    start({ cloudWatchMode: () => true });
    const watch = watchCommand(1, 300_000);
    const startDay = cmds.command(REPO, 2, { kind: "start_day", args: {} });
    cmds.queue.push(watch, startDay);
    await advanceUntil(() => cmds.acks.length === 2);
    expect(cmds.acks.map((a) => [a.id === watch.command_id ? "watch" : "start_day", a.ack])).toEqual([["watch", { outcome: "applied" }], ["start_day", { outcome: "refused", refusal: "operate_off" }]]);
    expect(inboxJson()).toEqual([]);
  });
});
