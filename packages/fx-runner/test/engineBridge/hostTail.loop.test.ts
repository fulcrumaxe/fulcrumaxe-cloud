import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineEventsMessage, type EngineEventsMessage as Message } from "@fulcrumaxe/runner-protocol";
import { CommandPuller, PULL_PATH, type InboxLoopDeps } from "../../src/engineBridge/commands.js";
import { loadCursor } from "../../src/engineBridge/cursor.js";
import { Inbox } from "../../src/engineBridge/inbox.js";
import { createBridgeTails } from "../../src/engineBridge/daemon.js";
import { BridgeLoop, HEARTBEAT_MS, mergeByTs, UNWATCHED_COALESCE_MS } from "../../src/engineBridge/loop.js";
import { EngineTail } from "../../src/engineBridge/tail.js";
import type { SendOutcome } from "../../src/engineBridge/upload.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";

/**
 * Two tails in one loop: the engine's own events file and the engine host's, each a real `EngineTail` over a real file with a cursor file of its own. The cloud is a
 * fake that holds the real ingest's rules for what the bridge touches: one session per `engine_instance_id` in every request, `seq` strictly increasing, an event it
 * already holds answered by `last_accepted_seq` and never stored twice, and the body checked by the protocol's own `EngineEventsMessage`.
 */
const ENGINE = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const HOST = "7c2d8e4f-3a1b-4c5d-8e6f-9a0b1c2d3e4f";
const BRIDGE = "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d";
const REPO = 77;
const uid = process.getuid?.();
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const HOUR_MS = 3_600_000;

let dir: string;
let engineFile: string;
let hostFile: string;
let engineCursor: string;
let hostCursor: string;
let clock: ManualClock;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb3c2-"));
  chmodSync(dir, 0o700);
  for (const d of ["ec", "hc"]) mkdirSync(path.join(dir, d), { mode: 0o700 });
  engineFile = path.join(dir, "engine-events.jsonl");
  hostFile = path.join(dir, "engine-host-events.jsonl");
  engineCursor = path.join(dir, "ec", "engine.cursor.json");
  hostCursor = path.join(dir, "hc", "host.cursor.json");
  clock = manualClock(T0);
});
afterEach(() => {
  chmodSync(path.join(dir, "hc"), 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const ts = (ms: number): string => new Date(T0 + ms).toISOString();
function engineLine(seq: number, atMs: number, kind = "loop_tick"): string {
  const body = kind === "ask_raised" ? { kind, ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log" } : kind === "engine_heartbeat" ? { kind, origin: "cron" } : { kind, origin: "cron", duration_s: 5 };
  return `${JSON.stringify({ v: 1, engine_instance_id: ENGINE, seq, ts: ts(atMs), ...body })}\n`;
}
function hostLine(seq: number, atMs: number, kind = "tick_started"): string {
  const body = kind === "ask_raised" ? { kind, ask_id: "fedcba9876543210", ask_kind: "owner_decision", source: "team_log" } : kind === "host_heartbeat" || kind === "host_started" ? { kind } : kind === "tick_started" ? { kind, tick_kind: "loop", outcome: "ok" } : { kind };
  return `${JSON.stringify({ v: 1, engine_instance_id: HOST, seq, ts: ts(atMs), ...body })}\n`;
}
const put = (file: string, text: string): void => appendFileSync(file, text, { mode: 0o600 });

interface Stored {
  instance: string;
  seq: number;
  kind: string;
  count?: number;
  reason?: string;
}
/** A cloud with the ingest's rules. `failAt` makes the n-th request (from 0) answer a retryable failure once. */
function makeCloud(failAt: number[] = []) {
  const last = new Map<string, number>();
  const stored: Stored[] = [];
  const requests: Array<{ at: number; instance: string; seqs: number[]; kinds: string[] }> = [];
  let n = 0;
  const send = async (message: Message): Promise<SendOutcome> => {
    const parsed = EngineEventsMessage.parse(message);
    const instance = parsed.session.engine_instance_id;
    const index = n++;
    requests.push({ at: clock.now().getTime(), instance, seqs: parsed.events.map((e) => e.seq), kinds: parsed.events.map((e) => e.kind) });
    if (failAt.includes(index)) return { kind: "retry", why: "unexpected" };
    for (const event of parsed.events) {
      if (event.seq <= (last.get(instance) ?? -1)) continue;
      last.set(instance, event.seq);
      stored.push({ instance, seq: event.seq, kind: event.kind, ...("count" in event && typeof event.count === "number" ? { count: event.count } : {}), ...("reason" in event && typeof event.reason === "string" ? { reason: event.reason } : {}) });
    }
    return { kind: "accepted", last: last.get(instance) ?? null };
  };
  return { send, stored, requests, last };
}

function makeTails(over: { hostUid?: number | undefined } = {}) {
  const engine = new EngineTail({ eventsPath: engineFile, cursorPath: engineCursor, uid, secrets: () => [], log: () => undefined });
  const host = new EngineTail({ eventsPath: hostFile, cursorPath: hostCursor, uid: "hostUid" in over ? over.hostUid : uid, secrets: () => [], log: () => undefined });
  return { engine, host };
}
function makeLoop(send: (m: Message) => Promise<SendOutcome>, over: { coalesceMs?: () => number } = {}) {
  const { engine, host } = makeTails();
  const loop = new BridgeLoop({ tail: engine, tails: [host], send, clock, repoGhId: REPO, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined, newInstanceId: () => BRIDGE, ...over });
  return loop;
}
const order = (stored: Stored[]): string[] => stored.filter((s) => s.instance !== BRIDGE).map((s) => `${s.instance === ENGINE ? "E" : "H"}${s.seq}`);

describe("merging two sources into one stream", () => {
  it("sends each source in its own order, one request per session, and the same input always gives the same order", async () => {
    put(engineFile, engineLine(0, 0) + engineLine(1, 20) + engineLine(2, 40) + engineLine(3, 60));
    put(hostFile, hostLine(0, 10) + hostLine(1, 30) + hostLine(2, 50) + hostLine(3, 70));
    const cloud = makeCloud();
    await makeLoop(cloud.send, { coalesceMs: () => 0 }).cycle();
    // Sessions are grouped (the cloud keeps each session's seq apart): the engine's, then the host's, each in its own order, in one request each.
    expect(order(cloud.stored)).toEqual(["E0", "E1", "E2", "E3", "H0", "H1", "H2", "H3"]);
    expect(cloud.requests.map((r) => `${r.instance === ENGINE ? "E" : "H"}${r.seqs.length}`)).toEqual(["E4", "H4"]);
  });

  it("keeps each source's own order even when a source's clock steps back, and breaks a tie by source (engine first)", async () => {
    put(engineFile, engineLine(0, 50) + engineLine(1, 10) + engineLine(2, 100));
    put(hostFile, hostLine(0, 50) + hostLine(1, 60));
    const cloud = makeCloud();
    await makeLoop(cloud.send, { coalesceMs: () => 0 }).cycle();
    const e = cloud.stored.filter((s) => s.instance === ENGINE).map((s) => s.seq);
    const h = cloud.stored.filter((s) => s.instance === HOST).map((s) => s.seq);
    expect(e).toEqual([0, 1, 2]);
    expect(h).toEqual([0, 1]);
    // Whatever the engine's clock says, its events keep their own order; the first session in the merge (the engine's, on the tie) is sent first.
    expect(order(cloud.stored)).toEqual(["E0", "E1", "E2", "H0", "H1"]);
  });

  it("mergeByTs is a pure, stable merge (same sources, same result; per-source order kept)", () => {
    const ev = (instance: string, seq: number, at: number) => ({ v: 1 as const, engine_instance_id: instance, seq, ts: ts(at), kind: "compaction_detected" as const });
    const a = [ev(ENGINE, 0, 5), ev(ENGINE, 1, 1)];
    const b = [ev(HOST, 0, 5), ev(HOST, 1, 9)];
    const once = mergeByTs([a, b]).map((m) => `${m.src}:${m.event.seq}`);
    expect(once).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(mergeByTs([a, b]).map((m) => `${m.src}:${m.event.seq}`)).toEqual(once);
    expect(mergeByTs([[], []])).toEqual([]);
  });
});

describe("a cursor for each source", () => {
  it("each tail moves its own cursor file past its own events only", async () => {
    put(engineFile, engineLine(0, 0) + engineLine(1, 20));
    put(hostFile, hostLine(0, 10));
    const cloud = makeCloud();
    await makeLoop(cloud.send, { coalesceMs: () => 0 }).cycle();
    expect(loadCursor(engineCursor, undefined, uid)).toMatchObject({ engine_instance_id: ENGINE, last_acked_seq: 1 });
    expect(loadCursor(hostCursor, undefined, uid)).toMatchObject({ engine_instance_id: HOST, last_acked_seq: 0 });
  });

  it("a crash in the middle of a batch: each tail resumes at its own cursor, no event twice in the cloud and none missing", async () => {
    put(engineFile, engineLine(0, 0) + engineLine(1, 20));
    put(hostFile, hostLine(0, 10) + hostLine(1, 30));
    // Requests are the engine's (E0, E1) and then the host's (H0, H1). The cloud takes the first and then the runner "dies": the second answer is lost to a failure and nothing is acked.
    const cloud = makeCloud([1]);
    const first = makeLoop(cloud.send, { coalesceMs: () => 0 });
    await first.cycle();
    expect(order(cloud.stored)).toEqual(["E0", "E1"]);
    expect(loadCursor(engineCursor, undefined, uid)).toBeNull();
    expect(loadCursor(hostCursor, undefined, uid)).toBeNull();
    // Restart with new tails over the same cursor files; new events keep arriving in both files.
    put(engineFile, engineLine(2, 40));
    put(hostFile, hostLine(2, 50));
    const second = makeLoop(cloud.send, { coalesceMs: () => 0 });
    await second.cycle();
    expect(order(cloud.stored)).toEqual(["E0", "E1", "E2", "H0", "H1", "H2"]);
    expect(loadCursor(engineCursor, undefined, uid)).toMatchObject({ last_acked_seq: 2 });
    expect(loadCursor(hostCursor, undefined, uid)).toMatchObject({ last_acked_seq: 2 });
  });

  it("when only one cursor could be saved, the restart resumes the saved one past its events and the other from where it was", async () => {
    put(engineFile, engineLine(0, 0));
    put(hostFile, hostLine(0, 10));
    const cloud = makeCloud();
    // The host's cursor directory cannot be written: its ack throws after the engine's ack went through.
    chmodSync(path.join(dir, "hc"), 0o500);
    const first = makeLoop(cloud.send, { coalesceMs: () => 0 });
    await first.cycle().catch(() => undefined);
    expect(loadCursor(engineCursor, undefined, uid)).toMatchObject({ last_acked_seq: 0 });
    chmodSync(path.join(dir, "hc"), 0o700);
    expect(loadCursor(hostCursor, undefined, uid)).toBeNull();
    const before = cloud.requests.length;
    const second = makeLoop(cloud.send, { coalesceMs: () => 0 });
    await second.cycle();
    const resent = cloud.requests.slice(before);
    // The engine's event is not sent again; the host's is (the cloud holds it and drops it by its seq).
    expect(resent.flatMap((r) => r.seqs.map((s) => `${r.instance === ENGINE ? "E" : "H"}${s}`))).toEqual(["H0"]);
    expect(order(cloud.stored)).toEqual(["E0", "H0"]);
    expect(loadCursor(hostCursor, undefined, uid)).toMatchObject({ last_acked_seq: 0 });
  });
});

describe("the host's file, kind by kind", () => {
  it("an ask in the host's file goes out within one tick, with whatever else waited, while an ordinary host event waits for the window", async () => {
    const cloud = makeCloud();
    const loop = makeLoop(cloud.send);
    await loop.cycle(); // start-up status
    cloud.requests.length = 0;
    put(hostFile, hostLine(0, 0));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(cloud.requests).toEqual([]);
    put(hostFile, hostLine(1, 3_000, "ask_raised"));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(cloud.requests.map((r) => r.kinds)).toEqual([["tick_started", "ask_raised"]]);
    expect(UNWATCHED_COALESCE_MS).toBe(60_000);
  });

  it("an ordinary event from either source waits for the window and then goes in one pass", async () => {
    const cloud = makeCloud();
    const loop = makeLoop(cloud.send);
    await loop.cycle();
    cloud.requests.length = 0;
    put(engineFile, engineLine(0, 0));
    put(hostFile, hostLine(0, 1));
    for (let t = 0; t < UNWATCHED_COALESCE_MS - 2_000; t += 2_000) {
      await clock.advance(2_000, 2_000);
      await loop.cycle();
    }
    expect(cloud.requests).toEqual([]);
    await clock.advance(4_000, 2_000);
    await loop.cycle();
    expect(order(cloud.stored)).toEqual(["E0", "H0"]);
  });

  it("a host file that is missing is just waited for, and its events go once it appears", async () => {
    const cloud = makeCloud();
    const loop = makeLoop(cloud.send, { coalesceMs: () => 0 });
    put(engineFile, engineLine(0, 0));
    await loop.cycle();
    expect(order(cloud.stored)).toEqual(["E0"]);
    put(hostFile, hostLine(0, 10));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(order(cloud.stored)).toEqual(["E0", "H0"]);
  });

  it("a refused host file (a link, open permissions, another owner) sends nothing of it and never stops the engine's events", async () => {
    // The same refusals as the engine file, from the same open: here the three of them on the host's file.
    const victim = path.join(dir, "victim.jsonl");
    writeFileSync(victim, hostLine(0, 10), { mode: 0o600 });
    put(engineFile, engineLine(0, 0));
    for (const make of ["link", "mode", "owner"] as const) {
      rmSync(hostFile, { force: true });
      if (make === "link") symlinkSync(victim, hostFile);
      else writeFileSync(hostFile, hostLine(0, 10), { mode: make === "mode" ? 0o666 : 0o600 });
      if (make === "mode") chmodSync(hostFile, 0o666);
      const cloud = makeCloud();
      rmSync(engineCursor, { force: true });
      const engine = new EngineTail({ eventsPath: engineFile, cursorPath: engineCursor, uid, secrets: () => [], log: () => undefined });
      const logs: string[] = [];
      const host = new EngineTail({ eventsPath: hostFile, cursorPath: hostCursor, uid: make === "owner" && uid !== undefined ? uid + 1 : uid, secrets: () => [], log: (l) => logs.push(l) });
      const loop = new BridgeLoop({ tail: engine, tails: [host], send: cloud.send, clock, repoGhId: REPO, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined, newInstanceId: () => BRIDGE, coalesceMs: () => 0 });
      await loop.cycle();
      expect(order(cloud.stored)).toEqual(["E0"]);
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatch(make === "link" ? /link/ : make === "mode" ? /open_permissions/ : /foreign_owner/);
    }
  });

  it("a line over the line cap and a line of an unknown kind are dropped and counted, as in the engine's file, and the next events go", async () => {
    const huge = `${JSON.stringify({ v: 1, engine_instance_id: HOST, seq: 5, ts: ts(0), kind: "tick_started", tick_kind: "loop", outcome: "ok", pad: "x".repeat(70_000) })}\n`;
    const unknown = `${JSON.stringify({ v: 1, engine_instance_id: HOST, seq: 1, ts: ts(1), kind: "made_up_kind" })}\n`;
    const forged = `${JSON.stringify({ v: 1, engine_instance_id: HOST, seq: 2, ts: ts(2), kind: "bridge_heartbeat" })}\n`;
    put(hostFile, hostLine(0, 0) + unknown + forged + huge + hostLine(3, 5));
    const cloud = makeCloud();
    await makeLoop(cloud.send, { coalesceMs: () => 0 }).cycle();
    expect(cloud.stored.filter((s) => s.instance === HOST).map((s) => s.seq)).toEqual([0, 3]);
    // The three dropped lines are owed as notices in the bridge's own session, one count per reason, sent with the next heartbeat.
    const loop = makeLoop(cloud.send, { coalesceMs: () => 0 });
    await loop.cycle();
    await clock.advance(HEARTBEAT_MS, 2_000);
    await loop.cycle();
    const notices = cloud.stored.filter((s) => s.kind === "bridge_dropped").map((s) => `${s.reason}:${s.count}`).sort();
    // The unknown kind and the forged bridge_heartbeat are two schema drops; the over-long line is one oversize drop.
    expect(notices).toEqual(["oversize:1", "schema:2"]);
  });
});

/** A loop over the two tails as the daemon builds them (`createBridgeTails`). */
function wired(send: (m: Message) => Promise<SendOutcome>, over: { coalesceMs?: () => number } = {}) {
  const logs: string[] = [];
  const { tail, hostTail } = createBridgeTails({ stateDir: dir, runnerStateDir: path.join(dir, "rs"), repoGhId: REPO, uid, secrets: () => [], log: (l) => logs.push(l) });
  const loop = new BridgeLoop({ tail, tails: [hostTail], send, clock, repoGhId: REPO, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined, newInstanceId: () => BRIDGE, ...over });
  return { loop, logs };
}
function makePuller(pulls: number[]): CommandPuller {
  const post: InboxLoopDeps["post"] = async (p) => {
    if (p === PULL_PATH) pulls.push(clock.now().getTime());
    return { status: 200, body: { commands: [], controls: [{ repo_gh_id: REPO, halt_epoch: 0, halted: false, operate_enabled: true }] }, retryAfter: undefined, protectedDeployment: false };
  };
  return new CommandPuller({ post, inbox: new Inbox(dir, uid), keyring: {} as InboxLoopDeps["keyring"], runnerId: "rn_test", clock, bridgedRepos: () => [REPO], wakeEpoch: () => 1, localHalted: () => false, handleControl: async () => undefined, reportHalt: () => undefined, log: () => undefined });
}
/** Runs the loop and the puller for `ms`, calling `each` every second of virtual time. */
async function runIdle(ms: number, loop: BridgeLoop, puller: CommandPuller, each: (t: number) => void): Promise<void> {
  const stop = new AbortController();
  const done = Promise.all([loop.run(stop.signal), puller.run(stop.signal)]);
  for (let t = 0; t < ms; t += 1000) {
    await clock.advance(1000, 1000);
    each(t);
  }
  stop.abort();
  await done;
}

describe("requests an hour with both sources", () => {
  it("two idle hours with both files saying 'alive' every minute: the engine's session is heard at least every 302 s, at most 20 requests an hour, no host seq lost", async () => {
    const cloud = makeCloud();
    const pulls: number[] = [];
    const { loop } = wired(cloud.send);
    let eSeq = 0;
    let hSeq = 0;
    await runIdle(2 * HOUR_MS, loop, makePuller(pulls), (t) => {
      if (t % 60_000 === 0) {
        put(engineFile, engineLine(eSeq++, t, "engine_heartbeat"));
        put(hostFile, hostLine(hSeq++, t, "host_heartbeat"));
      }
    });
    for (const hour of [0, 1]) {
      const inHour = (at: number): boolean => at - T0 >= hour * HOUR_MS && at - T0 < (hour + 1) * HOUR_MS;
      expect(cloud.requests.filter((r) => inHour(r.at)).length + pulls.filter(inHour).length).toBeLessThanOrEqual(20);
    }
    const engineAt = cloud.requests.filter((r) => r.instance === ENGINE).map((r) => r.at);
    expect(engineAt.length).toBeGreaterThan(20);
    for (let i = 1; i < engineAt.length; i++) expect(engineAt[i]! - engineAt[i - 1]!).toBeLessThanOrEqual(302_000);
    expect(T0 + 2 * HOUR_MS - engineAt[engineAt.length - 1]!).toBeLessThanOrEqual(302_000);
    // The host's events are not lost: what arrived is its own events from seq 0 with none missing.
    const host = cloud.stored.filter((s) => s.instance === HOST).map((s) => s.seq);
    expect(host.length).toBeGreaterThan(50);
    expect(host).toEqual(Array.from({ length: host.length }, (_, i) => i));
  });

  it("engine events stamped far in the future do not starve a source: both sources' events are delivered", async () => {
    const cloud = makeCloud();
    const pulls: number[] = [];
    const { loop } = wired(cloud.send);
    let eSeq = 0;
    let hSeq = 0;
    const far = 4_000_000_000_000;
    await runIdle(HOUR_MS, loop, makePuller(pulls), (t) => {
      if (t % 60_000 === 0) {
        put(engineFile, engineLine(eSeq++, far, "engine_heartbeat"));
        put(hostFile, hostLine(hSeq++, t, "host_heartbeat"));
      }
    });
    expect(cloud.stored.filter((s) => s.instance === ENGINE).length).toBeGreaterThan(40);
    const host = cloud.stored.filter((s) => s.instance === HOST).map((s) => s.seq);
    expect(host).toEqual(Array.from({ length: host.length }, (_, i) => i));
  });

  it("a batch of 100 engine and 100 host events whose times alternate is two requests, not two hundred", async () => {
    let e = "";
    let h = "";
    for (let i = 0; i < 100; i++) {
      e += engineLine(i, i * 2);
      h += hostLine(i, i * 2 + 1);
    }
    put(engineFile, e);
    put(hostFile, h);
    const cloud = makeCloud();
    const { loop } = wired(cloud.send, { coalesceMs: () => 0 });
    await loop.cycle();
    const events = cloud.requests.filter((r) => r.instance !== BRIDGE);
    expect(events.length).toBe(2);
    expect(cloud.stored.filter((s) => s.instance !== BRIDGE).length).toBe(200);
    for (const r of events) expect(r.seqs).toEqual([...r.seqs].sort((a, b) => a - b));
  });
});

describe("one file cannot claim the other's session", () => {
  it("a host line that carries the engine's instance is dropped and counted; both files' real events and a later ask still go", async () => {
    const forged = `${JSON.stringify({ v: 1, engine_instance_id: ENGINE, seq: 0, ts: ts(5), kind: "tick_started", tick_kind: "loop", outcome: "ok" })}\n`;
    put(engineFile, engineLine(0, 0) + engineLine(1, 10));
    put(hostFile, forged + hostLine(0, 6));
    const cloud = makeCloud();
    const { loop } = wired(cloud.send, { coalesceMs: () => 0 });
    await loop.cycle();
    expect(order(cloud.stored)).toEqual(["E0", "E1", "H0"]);
    put(hostFile, hostLine(1, 20, "ask_raised"));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(cloud.stored.at(-1)).toMatchObject({ instance: HOST, kind: "ask_raised" });
    await clock.advance(HEARTBEAT_MS, 2_000);
    await loop.cycle();
    expect(cloud.stored.filter((s) => s.kind === "bridge_dropped").map((s) => `${s.reason}:${s.count}`)).toEqual(["schema:1"]);
  });

  it("an engine line that carries the host's instance is dropped; the host's seq space is not moved, and a later ask goes", async () => {
    put(hostFile, hostLine(0, 0));
    const cloud = makeCloud();
    const { loop } = wired(cloud.send, { coalesceMs: () => 0 });
    await loop.cycle();
    const forged = `${JSON.stringify({ v: 1, engine_instance_id: HOST, seq: 900, ts: ts(5), kind: "loop_tick", origin: "cron", duration_s: 5 })}\n`;
    put(engineFile, forged + engineLine(0, 6));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    put(engineFile, engineLine(1, 20, "ask_raised"));
    put(hostFile, hostLine(1, 21));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(order(cloud.stored).sort()).toEqual(["E0", "E1", "H0", "H1"]);
    expect(cloud.stored.some((s) => s.seq === 900)).toBe(false);
  });

  it("a restart knows the other tail's instance from its saved cursor, before it has read anything", async () => {
    put(hostFile, hostLine(0, 0));
    const cloud = makeCloud();
    const first = wired(cloud.send, { coalesceMs: () => 0 });
    await first.loop.cycle();
    const forged = `${JSON.stringify({ v: 1, engine_instance_id: HOST, seq: 900, ts: ts(5), kind: "loop_tick", origin: "cron", duration_s: 5 })}\n`;
    put(engineFile, forged);
    const second = wired(cloud.send, { coalesceMs: () => 0 });
    await second.loop.cycle();
    expect(cloud.stored.some((s) => s.seq === 900)).toBe(false);
  });

  const HOST2 = "9e8d7c6b-5a49-4382-b1a0-0f1e2d3c4b5a";
  const ENGINE2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const lineOf = (instance: string, seq: number, atMs: number, kind: "loop_tick" | "tick_started"): string =>
    `${JSON.stringify({ v: 1, engine_instance_id: instance, seq, ts: ts(atMs), kind, ...(kind === "loop_tick" ? { origin: "cron", duration_s: 5 } : { tick_kind: "loop", outcome: "ok" }) })}\n`;

  it("an id belongs to the file it first appears in: after the host restarts, the engine file cannot take over the host's old or new session", async () => {
    put(engineFile, lineOf(ENGINE, 0, 0, "loop_tick"));
    put(hostFile, lineOf(HOST, 0, 1, "tick_started"));
    const cloud = makeCloud();
    const { loop } = wired(cloud.send, { coalesceMs: () => 0 });
    await loop.cycle();
    // The host restarts: a new session follows in the host's file.
    put(hostFile, lineOf(HOST2, 0, 100, "tick_started") + lineOf(HOST2, 1, 100, "tick_started"));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    // The engine's file now names the host's old session, and the new one: both dropped; the engine's own next event and an ask go.
    put(engineFile, lineOf(HOST, 50, 101, "loop_tick") + lineOf(HOST2, 50, 102, "loop_tick") + engineLine(1, 103, "ask_raised"));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(cloud.stored.filter((s) => s.instance === HOST).map((s) => s.seq)).toEqual([0]);
    expect(cloud.stored.filter((s) => s.instance === HOST2).map((s) => s.seq)).toEqual([0, 1]);
    expect(cloud.stored.filter((s) => s.instance === ENGINE).map((s) => s.seq)).toEqual([0, 1]);
  });

  it("and the other way: after the engine restarts, the host file cannot take over the engine's old or new session", async () => {
    put(engineFile, lineOf(ENGINE, 0, 0, "loop_tick"));
    put(hostFile, lineOf(HOST, 0, 1, "tick_started"));
    const cloud = makeCloud();
    const { loop } = wired(cloud.send, { coalesceMs: () => 0 });
    await loop.cycle();
    put(engineFile, lineOf(ENGINE2, 0, 100, "loop_tick") + lineOf(ENGINE2, 1, 100, "loop_tick"));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    put(hostFile, lineOf(ENGINE, 50, 101, "tick_started") + lineOf(ENGINE2, 50, 102, "tick_started") + hostLine(1, 103, "ask_raised"));
    await clock.advance(2_000, 2_000);
    await loop.cycle();
    expect(cloud.stored.filter((s) => s.instance === ENGINE).map((s) => s.seq)).toEqual([0]);
    expect(cloud.stored.filter((s) => s.instance === ENGINE2).map((s) => s.seq)).toEqual([0, 1]);
    expect(cloud.stored.filter((s) => s.instance === HOST).map((s) => s.seq)).toEqual([0, 1]);
  });
});
