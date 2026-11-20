import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_EVENT_CLASSES, type EngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import { DetailSpool } from "../../src/engineBridge/detailSpool.js";
import { BridgeLoop, FLUSH_MS, HEARTBEAT_MS } from "../../src/engineBridge/loop.js";
import { EngineTail } from "../../src/engineBridge/tail.js";
import type { SendOutcome } from "../../src/engineBridge/upload.js";
import { WatchState } from "../../src/engineBridge/watchState.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";

/**
 * D#845 watch mode at the upload loop (follow-up 12): what an unwatched repo uploads, the slim status in place of the heartbeats, what a watch start sends and within which limits,
 * the 15-minute grace, the cloud's `watch_until`, and the capability gate (ruling 15) that keeps the legacy bridge until the cloud's hello reply lists `watch_mode`.
 */
const REPO = 77;
const ENGINE = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const BRIDGE = "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d";
const DETAIL = "6a1d4c0e-7b2f-8e8a-9c3d-5f1a2b3c4d5e";
const uid = process.getuid?.();
const HOUR = 3_600_000;
const MIN = 60_000;

let dir: string;
let clock: ManualClock;
let file: string;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-watch-mode-"));
  chmodSync(dir, 0o700);
  clock = manualClock(Date.parse("2026-11-20T12:00:00.000Z"));
  file = path.join(dir, "engine-events.jsonl");
  seq = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function emit(kind: "loop_tick" | "merged" | "engine_heartbeat" | "ask_raised" | "team_log_line", at = clock.now().getTime()): void {
  const base = { v: 1, engine_instance_id: ENGINE, seq: seq++, ts: new Date(at).toISOString() };
  const body: Record<string, unknown> =
    kind === "loop_tick" ? { kind, origin: "cron", duration_s: 5 }
    : kind === "merged" ? { kind, pr: 12, closes: false }
    : kind === "engine_heartbeat" ? { kind, origin: "host" }
    : kind === "team_log_line" ? { kind, line_id: "0123456789abcdef", actor_role: "team-lead", category: "other" }
    : { kind, ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log" };
  appendFileSync(file, `${JSON.stringify({ ...base, ...body })}\n`, { mode: 0o600 });
}

interface Upload {
  at: number;
  instance: string;
  kinds: string[];
  seqs: number[];
  events: EngineEventsMessage["events"];
}
function harness(over: { advertised?: boolean; reply?: () => string | undefined; slimStatusMs?: number } = {}) {
  const uploads: Upload[] = [];
  const logs: string[] = [];
  let advertised = over.advertised ?? true;
  /** The cloud's own rule for the sessions it holds: the engine's and the bridge's take a seq strictly in order (a first seq at or below the last stored one is a 409 with the last), the detail session takes any order. */
  const last = new Map<string, number>();
  const cloud = { down: false };
  const send = async (message: EngineEventsMessage): Promise<SendOutcome> => {
    if (cloud.down) return { kind: "retry", why: "network" };
    const id = message.session.engine_instance_id;
    const held = last.get(id);
    if (id !== DETAIL && held !== undefined && message.events[0]!.seq <= held) return { kind: "conflict", last: held };
    last.set(id, id === DETAIL ? Math.max(held ?? -1, message.events[message.events.length - 1]!.seq) : message.events[message.events.length - 1]!.seq);
    uploads.push({ at: clock.now().getTime(), instance: message.session.engine_instance_id, kinds: message.events.map((e) => e.kind), seqs: message.events.map((e) => e.seq), events: message.events });
    const watchUntil = over.reply?.();
    return { kind: "accepted", last: message.events[message.events.length - 1]!.seq, ...(watchUntil === undefined ? {} : { watchUntil }) };
  };
  const tail = new EngineTail({ eventsPath: file, cursorPath: path.join(dir, "cursor.json"), uid, secrets: () => [], log: () => undefined });
  const spool = new DetailSpool({ file: path.join(dir, "detail.jsonl"), statePath: path.join(dir, "detail.json"), uid, now: () => clock.now().getTime(), newInstanceId: () => DETAIL });
  const state = new WatchState(() => clock.now().getTime());
  const loop = new BridgeLoop({
    tail, send, clock, repoGhId: REPO, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: (l) => logs.push(l), newInstanceId: () => BRIDGE,
    watch: { state, spool, advertised: () => advertised },
    ...(over.slimStatusMs === undefined ? {} : { slimStatusMs: over.slimStatusMs }),
  });
  const stop = new AbortController();
  const done = loop.run(stop.signal);
  return {
    loop, uploads, logs, spool, state, cloud,
    advertise: (v: boolean) => void (advertised = v),
    forInstance: (id: string) => uploads.filter((u) => u.instance === id),
    async run(ms: number, each?: (t: number) => void): Promise<void> {
      for (let t = 0; t < ms; t += 1000) {
        await clock.advance(1000, 1000);
        each?.(t);
      }
    },
    async end(): Promise<void> {
      stop.abort();
      await done;
    },
  };
}
const kindsOf = (uploads: Upload[]): string[] => uploads.flatMap((u) => u.kinds);

describe("the cloud's hello capability gates watch mode (ruling 15)", () => {
  it("with no watch_mode listed the bridge is the legacy one: every kind in the engine's session, bridge_heartbeat and no slim_status, and no spool", async () => {
    const h = harness({ advertised: false });
    emit("loop_tick");
    emit("engine_heartbeat");
    emit("merged");
    await h.run(2 * HEARTBEAT_MS);
    expect(kindsOf(h.forInstance(ENGINE)).sort()).toEqual(["engine_heartbeat", "loop_tick", "merged"]);
    expect(kindsOf(h.forInstance(BRIDGE)).every((k) => k === "bridge_heartbeat")).toBe(true);
    expect(kindsOf(h.uploads)).not.toContain("slim_status");
    expect(existsSync(path.join(dir, "detail.jsonl"))).toBe(false);
    await h.end();
  });

  it("switches to watch mode the moment the hello reply lists it, not before", async () => {
    const h = harness({ advertised: false });
    await h.run(10 * 1000);
    expect(kindsOf(h.forInstance(BRIDGE))).toEqual(["bridge_heartbeat"]);
    h.advertise(true);
    emit("loop_tick");
    await h.run(HEARTBEAT_MS + 10_000);
    expect(kindsOf(h.uploads)).toContain("slim_status");
    expect(h.forInstance(ENGINE).flatMap((u) => u.kinds)).not.toContain("loop_tick");
    await h.end();
  });

  it("an advertisement that is taken back (a later hello reply without watch_mode) puts the plain bridge back: heartbeats and every kind in the engine's session, and nothing more spooled", async () => {
    const h = harness();
    emit("loop_tick");
    await h.run(10_000);
    expect(h.spool.size().events).toBe(1);
    h.advertise(false);
    emit("loop_tick");
    emit("merged");
    await h.run(HEARTBEAT_MS + 70_000);
    expect(kindsOf(h.forInstance(ENGINE)).sort()).toEqual(["loop_tick", "merged"]);
    expect(kindsOf(h.forInstance(BRIDGE))).toContain("bridge_heartbeat");
    expect(h.spool.size().events).toBe(1);
    await h.end();
  });

  it("a source that throws is not an advertisement", async () => {
    const h = harness();
    (h.loop as unknown as { deps: { watch: { advertised: () => boolean } } }).deps.watch.advertised = () => {
      throw new Error("x");
    };
    emit("loop_tick");
    await h.run(HEARTBEAT_MS + 5_000);
    expect(kindsOf(h.uploads)).not.toContain("slim_status");
    expect(h.forInstance(ENGINE).flatMap((u) => u.kinds)).toContain("loop_tick");
    await h.end();
  });
});

describe("unwatched, in watch mode", () => {
  it("an engine at 150 events an hour uploads only the always-on kinds, and the slim status stands in for the heartbeats", async () => {
    const h = harness();
    let n = 0;
    await h.run(HOUR, () => {
      n++;
      if (n % 24 === 0) emit("loop_tick");
      if (n % 60 === 0) emit("engine_heartbeat");
      if (n % 360 === 0) emit("merged");
    });
    // The last merged event is held for the 60 s window, and the events read with it are spooled when it goes.
    await h.run(65_000);
    const engine = h.forInstance(ENGINE);
    const classes = ENGINE_EVENT_CLASSES.always_on as readonly string[];
    expect(engine.length).toBeGreaterThan(0);
    for (const k of kindsOf(engine)) expect(classes, k).toContain(k);
    expect(kindsOf(h.uploads)).not.toContain("loop_tick");
    expect(kindsOf(h.uploads)).not.toContain("engine_heartbeat");
    expect(kindsOf(h.uploads)).not.toContain("bridge_heartbeat");
    const slim = h.forInstance(BRIDGE);
    expect(slim.length).toBeGreaterThanOrEqual(10);
    expect(slim.length).toBeLessThanOrEqual(13);
    expect(kindsOf(slim).every((k) => k === "slim_status")).toBe(true);
    // The on-demand events wait on the machine: all 150 are in the spool, none was uploaded.
    expect(h.spool.size().events).toBe(150);
    expect(h.forInstance(DETAIL)).toEqual([]);
    await h.end();
  });

  it("the slim status goes every 5 minutes at the longest and never closer than 60 s, even when asked for more", async () => {
    const slow = harness();
    await slow.run(HOUR);
    const at = slow.forInstance(BRIDGE).map((u) => u.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(HEARTBEAT_MS - 2_000);
    await slow.end();
    const fast = harness({ slimStatusMs: 1_000 });
    await fast.run(10 * MIN);
    const fastAt = fast.forInstance(BRIDGE).map((u) => u.at);
    expect(fastAt.length).toBeGreaterThan(5);
    for (let i = 1; i < fastAt.length; i++) expect(fastAt[i]! - fastAt[i - 1]!).toBeGreaterThanOrEqual(60_000 - 2_000);
    await fast.end();
  });

  it("the slim status says how long ago each source was last seen: whole seconds, null when never, the bridge's own age 0", async () => {
    const h = harness();
    emit("engine_heartbeat");
    await h.run(HEARTBEAT_MS + 2_000);
    const slim = h.forInstance(BRIDGE).flatMap((u) => u.events).filter((e) => e.kind === "slim_status");
    expect(slim.length).toBeGreaterThanOrEqual(1);
    const last = slim[slim.length - 1]! as { sources: { bridge: number; host: number | null; engine: number | null }; reason: string };
    expect(last.reason).toBe("unwatched");
    expect(last.sources.bridge).toBe(0);
    expect(last.sources.host).toBeNull();
    // The engine's heartbeat was read at the start, 5 minutes before: the age is that, as a whole number, and under the day's cap.
    expect(Number.isInteger(last.sources.engine)).toBe(true);
    expect(last.sources.engine!).toBeGreaterThanOrEqual(HEARTBEAT_MS / 1000 - 5);
    expect(last.sources.engine!).toBeLessThanOrEqual(86_400);
    // The first slim status, sent before the engine said anything, had never seen it.
    expect((slim[0]! as { sources: { engine: number | null } }).sources.engine).toBeNull();
    await h.end();
  });

  it("asks and halts still go at once, and an ask is in the engine's session while the on-demand events around it are not", async () => {
    const h = harness();
    emit("loop_tick");
    emit("ask_raised");
    emit("team_log_line");
    await h.run(4_000);
    const engine = h.forInstance(ENGINE);
    expect(kindsOf(engine)).toEqual(["ask_raised"]);
    expect(engine[0]!.at - clock.now().getTime()).toBeGreaterThanOrEqual(-4_000);
    expect(h.spool.size().events).toBe(2);
    await h.end();
  });
});

describe("a watch", () => {
  async function spooled(h: ReturnType<typeof harness>, count: number, fromAgoMs: number, toAgoMs = 0): Promise<void> {
    const now = clock.now().getTime();
    for (let i = 0; i < count; i++) emit("loop_tick", now - fromAgoMs + Math.floor(((fromAgoMs - toAgoMs) * i) / Math.max(1, count)));
    await h.run(Math.ceil(count / 100) * 2_000 + 2_000);
  }

  it("a start sends the newest events within 24 h in the detail session, in up to 4 requests of at most 100 events, and the older ones stay on the machine", async () => {
    const h = harness();
    await spooled(h, 1_000, 20 * HOUR);
    expect(h.forInstance(DETAIL)).toEqual([]);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(10_000);
    const detail = h.forInstance(DETAIL);
    expect(detail).toHaveLength(4);
    expect(detail.every((u) => u.seqs.length <= 100)).toBe(true);
    expect(detail.flatMap((u) => u.seqs)).toEqual(Array.from({ length: 400 }, (_, i) => 600 + i));
    expect(kindsOf(detail).every((k) => k === "loop_tick")).toBe(true);
    // Nothing of it went through the engine's own session, and the cursor of the engine's file is past all 1,000.
    expect(h.forInstance(ENGINE)).toEqual([]);
    expect(h.spool.uploadedThrough()).toBe(999);
    await h.end();
  });

  it("a catch-up reaches back 24 h and no further: events older than that stay on the machine", async () => {
    const h = harness();
    const now = clock.now().getTime();
    for (let i = 0; i < 20; i++) emit("loop_tick", now - 30 * HOUR + i * 1000);
    for (let i = 0; i < 10; i++) emit("loop_tick", now - 2 * HOUR + i * 1000);
    await h.run(6_000);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(6_000);
    expect(h.forInstance(DETAIL).flatMap((u) => u.seqs)).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i));
    await h.end();
  });

  it("while it lasts, a new on-demand event goes out within one flush, in the detail session, never in the engine's", async () => {
    const h = harness();
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(3_000);
    emit("loop_tick");
    emit("team_log_line");
    const before = clock.now().getTime();
    await h.run(FLUSH_MS + 2_000);
    const detail = h.forInstance(DETAIL);
    expect(kindsOf(detail)).toEqual(["loop_tick", "team_log_line"]);
    expect(detail[0]!.at - before).toBeLessThanOrEqual(FLUSH_MS + 1_000);
    expect(h.forInstance(ENGINE)).toEqual([]);
    await h.end();
  });

  it("the engine's heartbeats are detail while watched (the readers want them) and nothing at all while not", async () => {
    const h = harness();
    emit("engine_heartbeat");
    await h.run(5_000);
    expect(h.spool.size().events).toBe(0);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    emit("engine_heartbeat");
    await h.run(5_000);
    expect(kindsOf(h.forInstance(DETAIL))).toEqual(["engine_heartbeat"]);
    await h.end();
  });

  it("the runner returns to slim 15 minutes after watch_until: detail flushes until then, the slim status again after, and events spool again", async () => {
    const h = harness();
    const t0 = clock.now().getTime();
    h.state.extend(t0 + 10 * MIN);
    await h.run(5_000);
    emit("loop_tick");
    await h.run(10 * MIN + 15 * MIN - 60_000 - 5_000);
    // 14 minutes after the until: still watched. No slim status yet, and a new event goes out.
    expect(h.state.watched()).toBe(true);
    emit("loop_tick");
    await h.run(4_000);
    expect(h.forInstance(DETAIL).flatMap((u) => u.kinds)).toEqual(["loop_tick", "loop_tick"]);
    expect(kindsOf(h.uploads)).not.toContain("slim_status");
    await h.run(2 * MIN);
    expect(h.state.watched()).toBe(false);
    const sent = h.forInstance(DETAIL).length;
    emit("loop_tick");
    await h.run(HEARTBEAT_MS + 10_000);
    expect(h.forInstance(DETAIL)).toHaveLength(sent);
    expect(kindsOf(h.forInstance(BRIDGE))).toContain("slim_status");
    expect(h.spool.hasPending()).toBe(true);
    await h.end();
  });

  it("the cloud's watch_until on an accepted reply starts the watch and extends it, so keeping a watch costs no extra request", async () => {
    const cloud: { until?: string } = {};
    const h = harness({ reply: () => cloud.until });
    emit("merged");
    await h.run(4_000);
    expect(h.state.watched()).toBe(false);
    cloud.until = new Date(clock.now().getTime() + 5 * MIN).toISOString();
    emit("merged");
    await h.run(65_000);
    expect(h.state.watched()).toBe(true);
    emit("loop_tick");
    await h.run(4_000);
    expect(kindsOf(h.forInstance(DETAIL))).toEqual(["loop_tick"]);
    await h.end();
  });

  it("a watch_until already over, or one far in the future, does not hold the runner watched", async () => {
    let until: string | undefined = new Date(clock.now().getTime() - 60_000).toISOString();
    const h = harness({ reply: () => until });
    emit("merged");
    await h.run(65_000);
    expect(h.state.watched()).toBe(false);
    until = new Date(clock.now().getTime() + 10 * 24 * HOUR).toISOString();
    emit("merged");
    await h.run(65_000);
    expect(h.state.watched()).toBe(true);
    expect(h.state.until()! - clock.now().getTime()).toBeLessThanOrEqual(10 * MIN);
    await h.end();
  });

  it("a before asks for the events older than it, sent in the detail session without moving what a catch-up has sent", async () => {
    const h = harness();
    await spooled(h, 300, 3 * HOUR);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(10_000);
    const through = h.spool.uploadedThrough();
    expect(through).toBe(299);
    const before = h.forInstance(DETAIL).length;
    h.loop.requestOlder(150);
    await h.run(8_000);
    const older = h.forInstance(DETAIL).slice(before);
    expect(older.flatMap((u) => u.seqs)).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(h.spool.uploadedThrough()).toBe(through);
    // The same ask twice sends once; a bad cursor sends nothing.
    h.loop.requestOlder(-1);
    h.loop.requestOlder(1.5);
    await h.run(8_000);
    expect(h.forInstance(DETAIL).length).toBe(before + older.length);
    await h.end();
  });

  it("a restart keeps what was sent: only the events after the last upload are caught up", async () => {
    const h = harness();
    await spooled(h, 50, HOUR);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(6_000);
    await h.end();
    const second = harness();
    emit("loop_tick");
    await second.run(6_000);
    second.state.extend(clock.now().getTime() + 5 * MIN);
    await second.run(6_000);
    expect(second.forInstance(DETAIL).flatMap((u) => u.seqs)).toEqual([50]);
    await second.end();
  });
});

describe("the plan at a watch start", () => {
  const plan = (id: string, i: number, n: number, at: number): void => {
    appendFileSync(file, `${JSON.stringify({ v: 1, engine_instance_id: ENGINE, seq: seq++, ts: new Date(at).toISOString(), kind: "plan_snapshot", snapshot_id: id, chunk_index: i, chunk_count: n, plan_date: "2026-11-17", items: [{ discussion: 5, ordinal: 0, state: "planned" }], roadmap: [] })}\n`, { mode: 0o600 });
  };
  const planUploads = (h: ReturnType<typeof harness>): Upload[] => h.forInstance(DETAIL).filter((u) => u.kinds.includes("plan_snapshot"));
  const ids = (u: Upload): string[] => u.events.map((e) => `${(e as { snapshot_id: string }).snapshot_id}/${(e as { chunk_index: number }).chunk_index}`);

  it("is sent first and whole: every chunk of the latest complete snapshot in one request, ahead of the catch-up, however old it is", async () => {
    const h = harness();
    const old = clock.now().getTime() - 3 * 24 * HOUR;
    plan("older", 0, 1, old - HOUR);
    plan("latest", 0, 2, old);
    plan("latest", 1, 2, old + 1000);
    emit("loop_tick");
    await h.run(6_000);
    expect(h.forInstance(DETAIL)).toEqual([]);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(6_000);
    const detail = h.forInstance(DETAIL);
    expect(ids(detail[0]!)).toEqual(["latest/0", "latest/1"]);
    // The catch-up behind it holds the tick; the plan's own old lines (3 days) are outside 24 h and are not sent a second time.
    expect(kindsOf(detail.slice(1))).toEqual(["loop_tick"]);
    // New seqs: a cloud keeps each seq once, so only a new one is a new send.
    const all = detail.flatMap((u) => u.seqs);
    expect(new Set(all).size).toBe(all.length);
    await h.end();
  });

  it("is sent again at each watch start, and not on a renewal of a watch that is going", async () => {
    const h = harness();
    plan("p1", 0, 1, clock.now().getTime());
    await h.run(4_000);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(6_000);
    expect(planUploads(h)).toHaveLength(1);
    h.state.extend(clock.now().getTime() + 9 * MIN);
    await h.run(6_000);
    expect(planUploads(h)).toHaveLength(1);
    await h.run(30 * MIN);
    expect(h.state.watched()).toBe(false);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(6_000);
    expect(planUploads(h)).toHaveLength(2);
    await h.end();
  });

  it("a plan bigger than one request goes over as many requests as it needs, every chunk, in order, each within 100 events and 256 KiB, ahead of the catch-up; and it is not written to the spool again at each start", async () => {
    const h = harness();
    const at = clock.now().getTime() - HOUR;
    const big = (i: number): void => {
      appendFileSync(file, `${JSON.stringify({ v: 1, engine_instance_id: ENGINE, seq: seq++, ts: new Date(at + i).toISOString(), kind: "plan_snapshot", snapshot_id: "huge", chunk_index: i, chunk_count: 8, plan_date: "2026-11-20", items: Array.from({ length: 300 }, (_, k) => ({ discussion: 1_000 + k, ordinal: k, state: "planned" })), roadmap: Array.from({ length: 500 }, (_, k) => ({ row_key: `r${k}`, status: "in_progress", planned_prs: 1 })) })}\n`, { mode: 0o600 });
    };
    for (let i = 0; i < 8; i++) big(i);
    emit("loop_tick");
    await h.run(12_000);
    const spooled = h.spool.size();
    expect(spooled.bytes).toBeGreaterThan(8 * 40_000);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(10_000);
    const detail = h.forInstance(DETAIL);
    const planRequests = detail.filter((u) => u.kinds.includes("plan_snapshot"));
    expect(planRequests.length).toBeGreaterThanOrEqual(2);
    for (const u of detail) expect(Buffer.byteLength(JSON.stringify({ session: { engine_instance_id: DETAIL, repo_gh_id: REPO, engine_version: "0.1.1" }, events: u.events }))).toBeLessThanOrEqual(262_144);
    const sentChunks = planRequests.flatMap((u) => u.events.map((e) => (e as { chunk_index: number }).chunk_index));
    // The catch-up's own copies of those chunks (they are within 24 h) are not sent a second time as plain lines.
    expect(sentChunks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(detail.findIndex((u) => u.kinds.includes("loop_tick"))).toBeGreaterThan(detail.map((u) => u.kinds.includes("plan_snapshot")).lastIndexOf(true));
    // Not spooled again: only the seq counter moved.
    expect(h.spool.size()).toEqual(spooled);
    const seqs = detail.flatMap((u) => u.seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    await h.end();
  });

  it("never sends half a snapshot: one whose chunks are not all in the spool is passed over for the latest complete one", async () => {
    const h = harness();
    plan("whole", 0, 1, clock.now().getTime() - 2 * HOUR);
    plan("partial", 0, 3, clock.now().getTime() - HOUR);
    plan("partial", 2, 3, clock.now().getTime() - HOUR + 1000);
    await h.run(4_000);
    h.state.extend(clock.now().getTime() + 5 * MIN);
    await h.run(6_000);
    expect(ids(planUploads(h)[0]!)).toEqual(["whole/0"]);
    await h.end();
  });
});

describe("the spool is written before anything is sent", () => {
  it("while the cloud is down, an on-demand event is already in the spool (a catch-up has it when the cloud is back), and a retry does not spool it twice", async () => {
    const h = harness();
    h.cloud.down = true;
    emit("merged");
    emit("loop_tick");
    await h.run(70_000);
    expect(h.spool.size().events).toBe(1);
    h.cloud.down = false;
    await h.run(120_000);
    expect(h.spool.size().events).toBe(1);
    expect(kindsOf(h.forInstance(ENGINE))).toEqual(["merged"]);
    await h.end();
  });

  it("the fake cloud holds the engine's session to its strict order: a resent batch is trimmed, never stored twice", async () => {
    const h = harness({ advertised: false });
    emit("merged");
    await h.run(70_000);
    h.cloud.down = true;
    emit("merged");
    await h.run(80_000);
    h.cloud.down = false;
    await h.run(80_000);
    expect(h.forInstance(ENGINE).flatMap((u) => u.seqs)).toEqual([0, 1]);
    await h.end();
  });
});

describe("lines of the engine's files that claim to be the bridge's own", () => {
  const V8 = "0b9b3a52-6c1e-8c53-9d5f-1f3f2a6f7a10";
  const line = (instance: string, body: Record<string, unknown>, n: number): string => `${JSON.stringify({ v: 1, engine_instance_id: instance, seq: n, ts: clock.now().toISOString(), ...body })}\n`;

  it.each(["engine", "host"] as const)("are dropped from the %s file: a slim_status, and any line with a version-8 instance id; nothing is sent or spooled", async (which) => {
    const hostFile = path.join(dir, "host.jsonl");
    const h = harness();
    if (which === "host") (h.loop as unknown as { tails: unknown[] }).tails.push(new EngineTail({ eventsPath: hostFile, cursorPath: path.join(dir, "host-cursor.json"), uid, secrets: () => [], log: () => undefined }));
    (h.loop as unknown as { seenAt: unknown[] }).seenAt.push(null);
    appendFileSync(which === "engine" ? file : hostFile, [
      line(ENGINE, { kind: "slim_status", sources: { bridge: 0, host: null, engine: 7777 }, reason: "unwatched" }, 0),
      line(V8, { kind: "merged", pr: 1, closes: false }, 1),
      line(V8, { kind: "loop_tick", origin: "cron", duration_s: 1 }, 2),
    ].join(""), { mode: 0o600 });
    await h.run(70_000);
    const sent = h.uploads.flatMap((u) => u.events);
    expect(sent.some((e) => e.kind === "merged" || e.kind === "loop_tick")).toBe(false);
    expect(sent.some((e) => e.kind === "slim_status" && (e as { sources: { engine: number | null } }).sources.engine === 7777)).toBe(false);
    expect(h.uploads.some((u) => u.instance === V8)).toBe(false);
    expect(h.spool.size().events).toBe(0);
    await h.end();
  });
});

describe("a spool that cannot be used", () => {
  it("ends watch mode with one fixed line, and the bridge sends everything in the engine's session as it did before (nothing is lost)", async () => {
    const elsewhere = path.join(dir, "elsewhere");
    writeFileSync(elsewhere, "", { mode: 0o600 });
    symlinkSync(elsewhere, path.join(dir, "detail.jsonl"));
    const h = harness();
    emit("loop_tick");
    emit("merged");
    // The first pass fails at the spool; the next is the legacy bridge, whose coalescing window (60 s) a merged event waits out.
    await h.run(70_000);
    expect(kindsOf(h.forInstance(ENGINE)).sort()).toEqual(["loop_tick", "merged"]);
    const lines = h.logs.filter((l) => l.includes("detail spool"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^engine-bridge: the detail spool could not be (read|written); the bridge sends everything as it did before$/);
    expect(kindsOf(h.uploads)).not.toContain("slim_status");
    await h.end();
  });
});
