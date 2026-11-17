import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import { ACK_CHECK_MS, CommandPuller, NO_WAKE_PULL_MS, PULL_PATH, SAFETY_PULL_MS, type InboxLoopDeps } from "../../src/engineBridge/commands.js";
import { Inbox } from "../../src/engineBridge/inbox.js";
import { BridgeLoop, HEARTBEAT_MS, UNWATCHED_COALESCE_MS, WATCHED_COALESCE_MS } from "../../src/engineBridge/loop.js";
import { EngineTail } from "../../src/engineBridge/tail.js";
import type { SendOutcome } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, until, type ManualClock } from "../helpers/manualClock.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { createCloudPost } from "../../src/engineBridge/commands.js";

/**
 * The bridge's timers against a fake clock: how many requests an hour reach the cloud (each one is a database request there), when asks and halts go, and how long
 * a command takes to arrive. Every request is counted at the runner's two doors: the upload (`send`) and the command pull (`post`). The dial keeper's own 5-minute
 * refresh (`ceiling.ts`) is a third source and is not part of these loops.
 */
const REPO = 77;
const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const BRIDGE = "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d";
const uid = process.getuid?.();
const HOUR_MS = 3_600_000;

let dir: string;
let clock: ManualClock;
let file: string;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb-timers-"));
  chmodSync(dir, 0o700);
  clock = manualClock(Date.now());
  file = path.join(dir, "engine-events.jsonl");
  seq = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function emit(kind: string, extra: Record<string, unknown> = {}): void {
  const base = { v: 1, engine_instance_id: A, seq: seq++, ts: clock.now().toISOString() };
  const body: Record<string, unknown> =
    kind === "loop_tick" ? { kind, origin: "cron", duration_s: 5 } : kind === "ask_raised" ? { kind, ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log" } : kind === "host_heartbeat" ? { kind, reason: "periodic" } : { kind };
  appendFileSync(file, `${JSON.stringify({ ...base, ...body, ...extra })}\n`, { mode: 0o600 });
}

interface Upload {
  at: number;
  kinds: string[];
  instance: string;
}
/** A cloud that takes every upload and remembers when it last heard from the runner (what the Team app calls `heard_age_s`). */
function makeLoop(over: { coalesceMs?: () => number } = {}) {
  const uploads: Upload[] = [];
  let heardAt: number | null = null;
  const send = async (message: EngineEventsMessage): Promise<SendOutcome> => {
    uploads.push({ at: clock.now().getTime(), kinds: message.events.map((e) => e.kind), instance: message.session.engine_instance_id });
    heardAt = clock.now().getTime();
    return { kind: "accepted", last: message.events[message.events.length - 1]!.seq };
  };
  const tail = new EngineTail({ eventsPath: file, cursorPath: path.join(dir, "cursor.json"), uid, secrets: () => [], log: () => undefined });
  const loop = new BridgeLoop({ tail, send, clock, repoGhId: REPO, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined, newInstanceId: () => BRIDGE, ...over });
  return { loop, uploads, heard: () => heardAt };
}

function makePuller(over: Partial<InboxLoopDeps> & { epoch?: () => number | null } = {}) {
  const pulls: number[] = [];
  const post: InboxLoopDeps["post"] = async (p) => {
    if (p === PULL_PATH) pulls.push(clock.now().getTime());
    return { status: 200, body: { commands: [], controls: [{ repo_gh_id: REPO, halt_epoch: 0, halted: false, operate_enabled: true }] }, retryAfter: undefined, protectedDeployment: false };
  };
  const { epoch, ...rest } = over;
  const puller = new CommandPuller({
    post,
    inbox: new Inbox(dir, uid),
    keyring: {} as InboxLoopDeps["keyring"],
    runnerId: "rn_test",
    clock,
    bridgedRepos: () => [REPO],
    wakeEpoch: epoch ?? (() => 1),
    localHalted: () => false,
    handleControl: async () => undefined,
    reportHalt: () => undefined,
    log: () => undefined,
    ...rest,
  });
  return { puller, pulls };
}

async function runFor(ms: number, loop: BridgeLoop, puller: CommandPuller, each?: () => void): Promise<void> {
  const stop = new AbortController();
  const done = Promise.all([loop.run(stop.signal), puller.run(stop.signal)]);
  for (let t = 0; t < ms; t += 1000) {
    await clock.advance(1000, 1000);
    each?.();
  }
  stop.abort();
  await done;
}

describe("requests an hour", () => {
  it("an idle engine makes a status upload every 5 minutes and a safety pull every 10, and nothing else (it made about 300 an hour at 20 s, 60 s and 2 s)", async () => {
    const { loop, uploads } = makeLoop();
    const { puller, pulls } = makePuller();
    await runFor(HOUR_MS, loop, puller);
    // A status at start and every 5 minutes (12-13 an hour), a safety pull at start and every 10 (6-7): at most 20 in all.
    expect(uploads.map((u) => u.kinds)).toEqual(Array.from({ length: uploads.length }, () => ["bridge_heartbeat"]));
    expect(uploads.length).toBeGreaterThanOrEqual(12);
    expect(uploads.length).toBeLessThanOrEqual(13);
    expect(pulls.length).toBeGreaterThanOrEqual(6);
    expect(pulls.length).toBeLessThanOrEqual(7);
    expect(uploads.length + pulls.length).toBeLessThanOrEqual(20);
    // Evenly spaced, never closer than the status interval.
    for (let i = 1; i < uploads.length; i++) expect(uploads[i]!.at - uploads[i - 1]!.at).toBeGreaterThanOrEqual(HEARTBEAT_MS - 2_000);
    for (let i = 1; i < pulls.length; i++) expect(pulls[i]! - pulls[i - 1]!).toBeGreaterThanOrEqual(SAFETY_PULL_MS - 2_000);
  });

  it("an engine with 150 events an hour makes at most one upload a minute, and a pull every 10", async () => {
    const { loop, uploads } = makeLoop();
    const { puller, pulls } = makePuller();
    let n = 0;
    await runFor(HOUR_MS, loop, puller, () => {
      // One loop_tick every 24 s: 150 in the hour.
      if (++n % 24 === 0) emit("loop_tick");
    });
    const engine = uploads.filter((u) => u.instance === A);
    expect(engine.length).toBeLessThanOrEqual(HOUR_MS / UNWATCHED_COALESCE_MS + 1);
    expect(engine.length).toBeGreaterThanOrEqual(45);
    // An upload of events is a sign of life: no separate heartbeat after the first.
    expect(uploads.filter((u) => u.instance === BRIDGE && u.kinds.includes("bridge_heartbeat")).length).toBeLessThanOrEqual(2);
    const total = uploads.length + pulls.length;
    expect(total).toBeGreaterThanOrEqual(50);
    expect(total).toBeLessThanOrEqual(165);
    // Every event arrived, once, in order.
    expect(engine.flatMap((u) => u.kinds).length).toBeGreaterThanOrEqual(140);
  });

  it("holds events that are not asks for the window, and sends them together", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle(); // the start-up status
    uploads.length = 0;
    emit("loop_tick");
    for (let t = 0; t < UNWATCHED_COALESCE_MS - 2_000; t += 2_000) {
      await clock.advance(2_000, 2_000);
      await loop.cycle();
    }
    expect(uploads).toEqual([]);
    emit("loop_tick");
    await clock.advance(4_000, 2_000);
    await loop.cycle();
    expect(uploads.map((u) => u.kinds)).toEqual([["loop_tick", "loop_tick"]]);
  });

  it("holds them only 10 seconds while someone watches", async () => {
    const { loop, uploads } = makeLoop({ coalesceMs: () => WATCHED_COALESCE_MS });
    await loop.cycle();
    uploads.length = 0;
    emit("loop_tick");
    for (let t = 0; t < WATCHED_COALESCE_MS - 2_000; t += 2_000) {
      await loop.cycle();
      await clock.advance(2_000, 2_000);
    }
    await loop.cycle();
    expect(uploads).toEqual([]);
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(uploads).toHaveLength(1);
  });

  it("holds a batch of nothing but the engine's and host's heartbeats for the status interval, and counts it as the status", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle();
    uploads.length = 0;
    let sentBefore = 0;
    for (let t = 0; t < HEARTBEAT_MS - 2_000; t += 2_000) {
      if (t % 60_000 === 0) {
        emit("host_heartbeat");
        emit("engine_heartbeat", { origin: "cron" });
      }
      await clock.advance(2_000, 2_000);
      await loop.cycle();
      sentBefore = uploads.length;
    }
    expect(sentBefore).toBe(0);
    await clock.advance(4_000, 2_000);
    await loop.cycle();
    // One request at the status time, and it is the engine's own heartbeats: no bridge heartbeat after it.
    expect(uploads.map((u) => u.instance)).toEqual([A]);
    expect(uploads[0]!.kinds.every((k) => k === "host_heartbeat" || k === "engine_heartbeat")).toBe(true);
  });
});

describe("safety events are never held", () => {
  it("sends ask_raised within one tick of its landing in the file, and the held events with it", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle();
    uploads.length = 0;
    emit("loop_tick");
    await clock.advance(10_000, 2_000);
    await loop.cycle();
    expect(uploads).toEqual([]);
    const landed = clock.now().getTime();
    emit("ask_raised");
    await loop.cycle();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.kinds).toEqual(["loop_tick", "ask_raised"]);
    expect(uploads[0]!.at - landed).toBeLessThanOrEqual(2_000);
  });

  it("sends ask_cleared within one tick of its landing in the file, and the held events with it", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle();
    uploads.length = 0;
    emit("loop_tick");
    await clock.advance(10_000, 2_000);
    await loop.cycle();
    expect(uploads).toEqual([]);
    const landed = clock.now().getTime();
    emit("ask_cleared", { ask_id: "0123456789abcdef", how: "answered_cloud" });
    await loop.cycle();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.kinds).toEqual(["loop_tick", "ask_cleared"]);
    expect(uploads[0]!.at - landed).toBeLessThanOrEqual(2_000);
  });

  it("run() reads the file every 2 seconds, so an ask is sent at most 2 s after it lands, from idle", async () => {
    const { loop, uploads } = makeLoop();
    const { puller } = makePuller();
    const stop = new AbortController();
    const done = Promise.all([loop.run(stop.signal), puller.run(stop.signal)]);
    await clock.advance(100_000, 1_000);
    uploads.length = 0;
    const landed = clock.now().getTime();
    emit("ask_raised");
    await clock.advance(2_000, 1_000);
    stop.abort();
    await done;
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.kinds).toEqual(["ask_raised"]);
    expect(uploads[0]!.at - landed).toBeLessThanOrEqual(2_000);
  });

  it("sends a halt_applied the engine's own file carries within one tick, and the held events with it", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle();
    uploads.length = 0;
    emit("loop_tick");
    await clock.advance(10_000, 2_000);
    await loop.cycle();
    expect(uploads).toEqual([]);
    const landed = clock.now().getTime();
    emit("halt_applied", { halt_epoch: 3, method: "scope", survivors: 0 });
    await loop.cycle();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.kinds).toEqual(["loop_tick", "halt_applied"]);
    expect(uploads[0]!.at - landed).toBeLessThanOrEqual(2_000);
  });

  it("sends halt_applied at once, with nothing held for it", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle();
    uploads.length = 0;
    loop.reportHalt({ halt_epoch: 2, method: "scope", survivors: 0 });
    await loop.cycle();
    expect(uploads.map((u) => u.kinds)).toEqual([["halt_applied"]]);
  });

  it("a notice of lost lines rides the next heartbeat or the window, never a request of its own at once", async () => {
    const { loop, uploads } = makeLoop();
    await loop.cycle();
    uploads.length = 0;
    appendFileSync(file, "not json\n", { mode: 0o600 });
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(uploads).toEqual([]);
    await clock.advance(UNWATCHED_COALESCE_MS, 2_000);
    await loop.cycle();
    expect(uploads.map((u) => u.kinds)).toEqual([["bridge_dropped"]]);
  });
});

describe("liveness of a quiet machine", () => {
  it("the cloud hears from an idle runner at least every status interval, which is longer than the 180 s the Team app reads as live", async () => {
    const { loop, heard } = makeLoop();
    const { puller } = makePuller();
    let widest = 0;
    await runFor(2 * HOUR_MS, loop, puller, () => {
      const at = heard();
      if (at !== null) widest = Math.max(widest, clock.now().getTime() - at);
    });
    // Pinned so the cloud's side cannot drift from it unnoticed: `LIVE_WITHIN_S` (core `engine/panels.ts`) and `STALE_HEARD_S` (the Team app's model) are 180 and would read this
    // machine as stale for 2 of every 5 minutes. They must be at least this plus the status interval's own slack before the slim status ships.
    expect(widest).toBeGreaterThan(180_000);
    expect(widest).toBeLessThanOrEqual(HEARTBEAT_MS + 5_000);
  });
});

describe("commands", () => {
  let cloud: FakeCommands;
  beforeEach(async () => {
    cloud = await startFakeCommands();
    const key = generateRunnerKey();
    cloud.trust(key.publicJwk);
    cloud.now = () => clock.now();
    cloud.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
    postFor = createCloudPost({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch });
  });
  afterEach(async () => {
    await cloud.close();
  });
  let postFor: ReturnType<typeof createCloudPost>;
  const real = (over: Partial<InboxLoopDeps>) =>
    new CommandPuller({ post: (p, b) => postFor(p, b), inbox: new Inbox(dir, uid), keyring: cloud.keyring, runnerId: cloud.runnerId, clock, bridgedRepos: () => [REPO], wakeEpoch: () => 1, localHalted: () => false, handleControl: async () => undefined, reportHalt: () => undefined, log: () => undefined, ...over });
  const inboxFiles = (): string[] => (existsSync(path.join(dir, "engine-inbox")) ? readdirSync(path.join(dir, "engine-inbox")).filter((f) => f.endsWith(".json")) : []);

  it("a command reaches the inbox within 22 s of the cloud marking work, through the wake check (20 s) and the 1 s epoch look, with no safety pull due", async () => {
    // The wake check as the claim loop runs it: every 20 s it reads the cloud's epoch. The command is queued at the worst moment, just after a check.
    let cloudEpoch = 1;
    let seen = 1;
    const stop = new AbortController();
    const puller = real({ wakeEpoch: () => seen });
    const done = puller.run(stop.signal);
    await until(() => cloud.pulls.length === 1);
    let lastCheck = clock.now().getTime();
    await clock.advance(1_000, 1_000);
    cloud.queue.push(cloud.command(REPO, 1));
    cloudEpoch = 2;
    const queuedAt = clock.now().getTime();
    let delivered: number | null = null;
    for (let t = 0; t < 40_000 && delivered === null; t += 1_000) {
      await clock.advance(1_000, 1_000);
      if (clock.now().getTime() - lastCheck >= 20_000) {
        lastCheck = clock.now().getTime();
        seen = cloudEpoch;
      }
      for (let k = 0; seen === cloudEpoch && k < 400 && inboxFiles().length === 0; k++) await new Promise((resolve) => setTimeout(resolve, 5));
      if (inboxFiles().length > 0) delivered = clock.now().getTime() - queuedAt;
    }
    stop.abort();
    await done;
    expect(delivered).not.toBeNull();
    expect(delivered!).toBeLessThanOrEqual(22_000);
    // One pull at start and one for the wake: the safety pull (10 minutes) was not what delivered it.
    expect(cloud.pulls).toHaveLength(2);
  });

  it("pulls at once on start and again as soon as the epoch moves, and not in between", async () => {
    let epoch: number | null = 1;
    const stop = new AbortController();
    const puller = real({ wakeEpoch: () => epoch });
    const done = puller.run(stop.signal);
    await until(() => cloud.pulls.length === 1);
    await clock.advance(SAFETY_PULL_MS - 10_000, 1_000);
    expect(cloud.pulls).toHaveLength(1);
    epoch = 2;
    await clock.advance(1_000, 1_000);
    await until(() => cloud.pulls.length === 2);
    stop.abort();
    await done;
  });

  it("falls back to the 20 s pull while the wake path has told it nothing (no epoch seen), and keeps the 10 minute pull once it has", async () => {
    const epoch: number | null = null;
    const stop = new AbortController();
    const puller = real({ wakeEpoch: () => epoch });
    const done = puller.run(stop.signal);
    await until(() => cloud.pulls.length === 1);
    await clock.advance(NO_WAKE_PULL_MS, 1_000);
    await until(() => cloud.pulls.length === 2);
    stop.abort();
    await done;
  });

  it("retries a failed pull on its back-off (2 s), not after the 10 minute interval", async () => {
    cloud.faults.push({ status: 500 });
    // The reply is on the wire for 25 real ms after the cloud has recorded the pull, so the window between "the cloud saw it" and "the puller read it" is always open here,
    // not only on a loaded host.
    cloud.pullDelayMs = 25;
    const stop = new AbortController();
    const puller = real({});
    const done = puller.run(stop.signal);
    await until(() => cloud.pulls.length === 0 && puller.status().state === "backoff");
    await clock.advance(4_000, 1_000);
    await until(() => cloud.pulls.length === 1);
    // The fake cloud records the pull when the request arrives; the puller leaves its back-off only when it has read the reply. Wait for that state, not for a time.
    await until(() => puller.status().state === "idle");
    expect(puller.status().state).toBe("idle");
    stop.abort();
    await done;
  });

  it("acks an outcome the engine wrote within the ack check, not at the next safety pull", async () => {
    const stop = new AbortController();
    const puller = real({});
    const done = puller.run(stop.signal);
    await until(() => cloud.pulls.length === 1);
    const c = cloud.command(REPO, 1);
    cloud.queue.push(c);
    const second = real({});
    await second.pullOnce();
    const inbox = path.join(dir, "engine-inbox");
    const name = `1-${c.command_id}`;
    mkdirSync(path.join(inbox, "done"), { recursive: true });
    writeFileSync(path.join(inbox, "done", `${name}.outcome.json`), JSON.stringify({ outcome: "refused", refusal: "unknown_agent" }), { mode: 0o600 });
    renameSync(path.join(inbox, `${name}.json`), path.join(inbox, "done", `${name}.json`));
    await clock.advance(ACK_CHECK_MS + 2_000, 1_000);
    await until(() => cloud.acks.length === 1);
    expect(cloud.acks[0]!.id).toBe(c.command_id);
    stop.abort();
    await done;
  });
});
