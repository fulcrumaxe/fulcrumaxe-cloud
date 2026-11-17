import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_EVENTS_BODY_MAX_BYTES, EngineEvent, EngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import type { Claimed } from "../../src/daemon/client.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { loadCursor } from "../../src/engineBridge/cursor.js";
import { BACKOFF_MAX_S, BridgeLoop, type BridgeLoopDeps, FLUSH_MS, HEARTBEAT_MS, OFF_RETRY_S, splitBatch } from "../../src/engineBridge/loop.js";
import { EngineTail } from "../../src/engineBridge/tail.js";
import { bodyBytes, classify, createEventsUploader } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, until, type ManualClock } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const BRIDGE = "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d";
const SECRET = "sk-test-secret-value-1234567890";
const line = (seq: number, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ v: 1, engine_instance_id: A, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5, ...extra })}\n`;
const lines = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => line(from + i)).join("");

let dir: string;
let cloud: StrictEngineIngest;
let clock: ManualClock;
let logs: string[];
let eventsFile: string;
let cursorFile: string;
let key: ReturnType<typeof generateRunnerKey>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb3b-"));
  eventsFile = path.join(dir, "engine-events.jsonl");
  cursorFile = path.join(dir, "cursor.json");
  cloud = await startStrictEngineIngest();
  key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  clock = manualClock(Date.now());
  cloud.now = () => clock.now();
  logs = [];
});
afterEach(async () => {
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(over: { secrets?: string[]; send?: BridgeLoopDeps["send"] } = {}) {
  const tail = new EngineTail({ eventsPath: eventsFile, cursorPath: cursorFile, uid: process.getuid?.(), secrets: () => over.secrets ?? [], log: (l) => logs.push(l) });
  const send = over.send ?? createEventsUploader({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch });
  const loop = new BridgeLoop({ tail, send, clock, repoGhId: 77, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: (l) => logs.push(l), newInstanceId: () => BRIDGE, coalesceMs: () => 0 });
  return { tail, loop };
}
const acked = (): number | null => loadCursor(cursorFile, undefined, process.getuid?.())?.last_acked_seq ?? null;
const heartbeats = (): number => (cloud.sessions.get(BRIDGE)?.stored ?? []).filter((e) => e.kind === "bridge_heartbeat").length;

describe("signed upload to a strict ingest", () => {
  it("sends a batch signed with the runner key, stores it in order, and moves the cursor only after", async () => {
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    const { loop } = make();
    expect(await loop.cycle()).toBe(FLUSH_MS);
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4]);
    expect(acked()).toBe(4);
    expect(loop.status()).toMatchObject({ state: "uploading", lastAckedSeq: 4 });
    // The first request carried a real signature that the cloud's verifier accepted (a bad one is 401 and stores nothing).
    expect(cloud.seen.every((s) => s.status === 200)).toBe(true);
    expect(cloud.seen[0]!.headers["signature"]).toBeDefined();
    // Idle: the next pass reads nothing and sends nothing but (not yet due) no heartbeat.
    const before = cloud.seen.length;
    expect(await loop.cycle()).toBe(FLUSH_MS);
    expect(cloud.seen.length).toBe(before);
  });

  it("answers 401 when the key is not the registered one, and the events stay unacked", async () => {
    writeFileSync(eventsFile, lines(0, 2), { mode: 0o600 });
    const other = generateRunnerKey();
    const send = createEventsUploader({ origin: cloud.origin, key: other, now: () => clock.now(), fetchFn: fetch });
    const { loop } = make({ send });
    expect(await loop.cycle()).toBe(2000);
    expect(cloud.seen[0]!.status).toBe(401);
    expect(cloud.seqsOf(A)).toEqual([]);
    expect(acked()).toBeNull();
    expect(loop.status().state).toBe("backoff");
  });

  it("cuts a batch into requests that each fit 256 KiB, and acks only after the last", async () => {
    const big = Array.from({ length: 15 }, (_, i) => EngineEvent.parse({ v: 1, engine_instance_id: A, seq: i, ts: "2026-11-16T15:00:00.000Z", kind: "plan_snapshot", snapshot_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a11", chunk_index: 0, chunk_count: 1, plan_date: "2026-11-16", items: [], roadmap: Array.from({ length: 450 }, (_, r) => ({ row_key: `R${r}`, status: "in_progress", planned_prs: 3 })) }));
    const session = { engine_instance_id: A, repo_gh_id: 77, engine_version: "1.2.3" };
    const chunks = splitBatch(session, big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.events.map((e) => e.seq))).toEqual(big.map((e) => e.seq));
    for (const chunk of chunks) {
      const message = { session, events: chunk.events };
      expect(bodyBytes(message)).toBe(Buffer.byteLength(JSON.stringify(message)));
      expect(bodyBytes(message)).toBeLessThanOrEqual(ENGINE_EVENTS_BODY_MAX_BYTES);
      expect(EngineEventsMessage.safeParse(message).success).toBe(true);
    }
    // Through the loop and the strict server: every request under the cap, one cursor move at the end.
    writeFileSync(eventsFile, big.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    const { loop } = make();
    await loop.cycle();
    const engineRequests = cloud.seen.filter((s) => s.instance === A);
    expect(engineRequests.length).toBeGreaterThan(1);
    expect(engineRequests.every((s) => s.status === 200 && s.rawBytes <= ENGINE_EVENTS_BODY_MAX_BYTES)).toBe(true);
    expect(cloud.seqsOf(A)).toEqual(big.map((e) => e.seq));
    expect(acked()).toBe(14);
  });

  it("flushes a full batch of 100 at once and the rest after the 2 second tick", async () => {
    writeFileSync(eventsFile, lines(0, 249), { mode: 0o600 });
    const { loop } = make();
    expect(await loop.cycle()).toBe(0);
    expect(await loop.cycle()).toBe(0);
    expect(await loop.cycle()).toBe(FLUSH_MS);
    expect(cloud.seqsOf(A)).toHaveLength(250);
    expect(cloud.seen.filter((s) => s.instance === A).map((s) => s.seqs.length)).toEqual([100, 100, 50]);
  });

  it("sends a heartbeat every 60 seconds while idle, in the bridge's own session", async () => {
    const { loop } = make();
    await loop.cycle();
    expect(heartbeats()).toBe(1);
    await clock.advance(HEARTBEAT_MS - 1000);
    await loop.cycle();
    expect(heartbeats()).toBe(1);
    for (let n = 2; n <= 4; n++) {
      await clock.advance(n === 2 ? 1000 : HEARTBEAT_MS);
      await loop.cycle();
      expect(heartbeats()).toBe(n);
    }
    const own = cloud.sessions.get(BRIDGE)!.stored;
    expect(own.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(own.every((e) => e.engine_instance_id === BRIDGE && e.kind === "bridge_heartbeat")).toBe(true);
    expect(cloud.sessions.has(A)).toBe(false);
  });
});

describe("the cloud's answers", () => {
  it("trims a 409 to what the cloud lacks and sends only that", async () => {
    cloud.sessions.set(A, { lastSeq: 9, stored: [], gaps: [] });
    writeFileSync(eventsFile, lines(5, 14), { mode: 0o600 });
    const { loop } = make();
    await loop.cycle();
    const sent = cloud.seen.filter((s) => s.instance === A);
    expect(sent.map((s) => [s.status, s.seqs[0], s.seqs.at(-1)])).toEqual([[409, 5, 14], [200, 10, 14]]);
    expect(cloud.seqsOf(A)).toEqual([10, 11, 12, 13, 14]);
    expect(acked()).toBe(14);
  });

  it("a 409 that covers the whole batch only advances the cursor", async () => {
    cloud.sessions.set(A, { lastSeq: 20, stored: [], gaps: [] });
    writeFileSync(eventsFile, lines(0, 3), { mode: 0o600 });
    const { loop } = make();
    await loop.cycle();
    expect(cloud.seen.filter((s) => s.instance === A)).toHaveLength(1);
    expect(acked()).toBe(3);
  });

  it("a 409 that says nothing useful is a failure, not a loop", async () => {
    cloud.faults.push({ status: 409, body: { error: "seq_not_increasing", last_accepted_seq: null } });
    writeFileSync(eventsFile, lines(0, 3), { mode: 0o600 });
    const { loop } = make();
    expect(await loop.cycle()).toBe(2000);
    expect(acked()).toBeNull();
  });

  it("403 stops uploads for 5 minutes, keeps the cursor, and resumes with a continuous seq", async () => {
    cloud.watchEnabled = false;
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    const { loop } = make();
    expect(await loop.cycle()).toBe(OFF_RETRY_S * 1000);
    expect(loop.status().state).toBe("off");
    expect(acked()).toBeNull();
    expect(cloud.seqsOf(A)).toEqual([]);
    // More lines arrive while it is off; nothing is sent until the 5 minutes are over, however often it is asked.
    appendFileSync(eventsFile, lines(5, 9));
    const requests = cloud.seen.length;
    await clock.advance((OFF_RETRY_S - 5) * 1000);
    expect(await loop.cycle()).toBe(5000);
    expect(cloud.seen.length).toBe(requests);
    cloud.watchEnabled = true;
    await clock.advance(5000);
    await loop.cycle();
    await loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cloud.sessions.get(A)!.gaps).toEqual([]);
    expect(acked()).toBe(9);
    expect(logs.filter((l) => l.includes("paused"))).toHaveLength(1);
  });

  it("the repo switch is the same: off, then back", async () => {
    cloud.repoEnabled = false;
    writeFileSync(eventsFile, lines(0, 1), { mode: 0o600 });
    const { loop } = make();
    expect(await loop.cycle()).toBe(OFF_RETRY_S * 1000);
    expect(loop.status().state).toBe("off");
    cloud.repoEnabled = true;
    await clock.advance(OFF_RETRY_S * 1000);
    await loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0, 1]);
    expect(loop.status().state).toBe("uploading");
  });

  it("429 waits retry_after_s, then goes on; the header is used when the body has none", async () => {
    cloud.quota = 3;
    cloud.quotaRetryAfterS = 120;
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    const { loop } = make();
    expect(await loop.cycle()).toBe(120_000);
    expect(loop.status().state).toBe("quota");
    // The cloud took 3 of the 5 and said 429: nothing is acked, and what it holds is trimmed away on the retry.
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2]);
    expect(acked()).toBeNull();
    cloud.quota = null;
    await clock.advance(120_000);
    await loop.cycle();
    expect(acked()).toBe(4);
    expect(classify(429, {}, 45)).toEqual({ kind: "quota", waitS: 45 });
    expect(classify(429, undefined, 10_000_000)).toEqual({ kind: "quota", waitS: 86_400 });
  });

  it("any other reply is a retry, never an ack", () => {
    expect(classify(200, { accepted: 1 }, undefined)).toEqual({ kind: "retry", why: "unexpected" });
    expect(classify(200, undefined, undefined)).toEqual({ kind: "retry", why: "unexpected" });
    expect(classify(400, { error: "invalid_message" }, undefined)).toEqual({ kind: "retry", why: "refused" });
    expect(classify(403, { error: "something_else" }, undefined)).toEqual({ kind: "retry", why: "unauthorized" });
    expect(classify(502, undefined, undefined)).toEqual({ kind: "retry", why: "server" });
    expect(classify(302, undefined, undefined)).toEqual({ kind: "retry", why: "unexpected" });
  });
});

describe("a cloud that is down", () => {
  it("backs off 2, 4, 8 ... and never past 300 seconds, loses nothing, and sends each event once when it returns", async () => {
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    const { loop } = make();
    for (let i = 0; i < 14; i++) cloud.faults.push("drop");
    const waits: number[] = [];
    for (let i = 0; i < 14; i++) {
      waits.push(await loop.cycle());
      await clock.advance(waits.at(-1)!);
      expect(acked()).toBeNull();
    }
    expect(waits.slice(0, 9)).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, BACKOFF_MAX_S * 1000]);
    expect(Math.max(...waits)).toBe(BACKOFF_MAX_S * 1000);
    expect(loop.status().state).toBe("backoff");
    // It returns: the same events go through, once.
    await loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4]);
    expect(acked()).toBe(4);
    expect(loop.status().state).toBe("uploading");
    expect(logs.filter((l) => l.includes("did not take"))).toHaveLength(1);
  });

  it("a request that was stored but whose reply was lost is not stored twice, and an acked event is never sent again", async () => {
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    cloud.faults.push("store_then_drop");
    const { loop } = make();
    const wait = await loop.cycle();
    expect(wait).toBe(2000);
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4]);
    expect(acked()).toBeNull();
    await clock.advance(wait);
    await loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4]);
    expect(acked()).toBe(4);
    // New events: only they are sent.
    appendFileSync(eventsFile, lines(5, 6));
    await loop.cycle();
    const afterAck = cloud.seen.filter((s) => s.instance === A).slice(2);
    expect(afterAck.map((s) => s.seqs)).toEqual([[5, 6]]);
  });

  it("a killed bridge picks up from the saved cursor: nothing acked is re-read", async () => {
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    await make().loop.cycle();
    appendFileSync(eventsFile, lines(5, 7));
    cloud.faults.push("drop");
    const second = make();
    await second.loop.cycle();
    expect(acked()).toBe(4);
    // A new process: new tail, same cursor file.
    await make().loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(cloud.seen.filter((s) => s.instance === A).every((s) => s.seqs[0]! >= 0)).toBe(true);
  });

  it("an unreadable 200 is not an ack", async () => {
    writeFileSync(eventsFile, lines(0, 1), { mode: 0o600 });
    cloud.faults.push({ status: 200, body: { ok: true } });
    const { loop } = make();
    expect(await loop.cycle()).toBe(2000);
    expect(acked()).toBeNull();
  });

  it("does not hold up the claim loop: a job is claimed while the bridge is in backoff", async () => {
    writeFileSync(eventsFile, lines(0, 1), { mode: 0o600 });
    for (let i = 0; i < 50; i++) cloud.faults.push("drop");
    const { loop } = make();
    const stop = new AbortController();
    const bridge = loop.run(stop.signal);
    await until(() => loop.status().state === "backoff");
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
    expect(loop.status().state).toBe("backoff");
    stop.abort();
    await Promise.all([bridge, poll]);
  });
});

describe("bridge_dropped and the key", () => {
  it("makes one notice per reason per batch with the bridge's own seq, and ack(null) moves the cursor past drops", async () => {
    const bad = "{not json}\n";
    const oversize = `${"x".repeat(70 * 1024)}\n`;
    writeFileSync(eventsFile, bad + bad + oversize + line(0), { mode: 0o600 });
    // The secret case: a line the redactor would change is dropped, not sent altered.
    appendFileSync(eventsFile, `${JSON.stringify({ v: 1, engine_instance_id: A, seq: 1, ts: "2026-11-16T15:00:00.000Z", kind: "agent_started", spawn_id: `toolu_${SECRET.replace(/-/g, "")}`, role: "other", background: false, isolation: "none" })}\n`);
    const { loop } = make({ secrets: [`toolu_${SECRET.replace(/-/g, "")}`] });
    await loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0]);
    const own = cloud.sessions.get(BRIDGE)!.stored;
    expect(own.filter((e) => e.kind === "bridge_dropped").map((e) => [e.kind === "bridge_dropped" && e.reason, e.kind === "bridge_dropped" && e.count])).toEqual([["schema", 2], ["oversize", 1], ["redaction", 1]]);
    expect(own.map((e) => e.seq)).toEqual([0, 1, 2]);
    // The cursor is past every drop: the next passes send no notice again.
    const before = cloud.seen.length;
    await loop.cycle();
    expect(cloud.seen.length).toBe(before);
    // A file of only bad lines: nothing sent, ack(null), notices only.
    appendFileSync(eventsFile, bad);
    await loop.cycle();
    const notices = cloud.sessions.get(BRIDGE)!.stored.filter((e) => e.kind === "bridge_dropped");
    expect(notices).toHaveLength(4);
    expect(cloud.sessions.get(BRIDGE)!.stored.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(acked()).toBe(0);
    expect(logs.join("\n")).not.toContain("not json");
  });

  it("a notice held while the cloud is down is sent once, and drops are not counted twice", async () => {
    writeFileSync(eventsFile, `{bad}\n${lines(0, 0)}`, { mode: 0o600 });
    const { loop } = make();
    cloud.faults.push("drop", "drop");
    // The engine request fails twice; nothing is acked, and the drop is not yet counted.
    await loop.cycle();
    await clock.advance(2000);
    await loop.cycle();
    await clock.advance(4000);
    await loop.cycle();
    const own = (cloud.sessions.get(BRIDGE)?.stored ?? []).filter((e) => e.kind === "bridge_dropped");
    expect(own.map((e) => e.kind === "bridge_dropped" && e.count)).toEqual([1]);
  });

  it("never logs the key, a signature, the address or a line of the file", async () => {
    writeFileSync(eventsFile, `{"secret":"${SECRET}"}\n${lines(0, 1)}`, { mode: 0o600 });
    const bad = generateRunnerKey();
    const down = await startStrictEngineIngest();
    const sends = [createEventsUploader({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch }), createEventsUploader({ origin: down.origin, key: bad, now: () => clock.now(), fetchFn: fetch })];
    for (const send of sends) {
      const { loop } = make({ send });
      await loop.cycle();
    }
    await down.close();
    const text = logs.join("\n");
    const pem = key.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const d = (key.privateKey.export({ format: "jwk" }) as { d: string }).d;
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [pem, d, SECRET, cloud.origin, down.origin, ...cloud.seen.map((s) => s.headers["signature"] ?? "x-none"), key.jkt]) expect(text).not.toContain(secret);
    // Every line is one of the fixed ones.
    expect(logs.every((l) => l.startsWith("engine-bridge: "))).toBe(true);
  });
});

describe("a request the cloud refuses for good", () => {
  it("a repeated 400 waits 300 seconds from the first failure, drops nothing, and shows backoff with the word refused", async () => {
    writeFileSync(eventsFile, lines(0, 4), { mode: 0o600 });
    for (let i = 0; i < 3; i++) cloud.faults.push({ status: 400, body: { error: "invalid_message" } });
    const { loop } = make();
    for (let i = 0; i < 3; i++) {
      expect(await loop.cycle()).toBe(BACKOFF_MAX_S * 1000);
      expect(loop.status()).toMatchObject({ state: "backoff", reason: "refused", lastAckedSeq: null });
      expect(acked()).toBeNull();
      await clock.advance(BACKOFF_MAX_S * 1000);
    }
    expect(cloud.seqsOf(A)).toEqual([]);
    // The same events are still held: when the cloud takes them they go through once, and the reason is gone.
    await loop.cycle();
    expect(cloud.seqsOf(A)).toEqual([0, 1, 2, 3, 4]);
    expect(acked()).toBe(4);
    expect(loop.status()).toMatchObject({ state: "uploading", reason: null });
  });

  it("a 413 is the same, and a failure of another kind shows its own word and uses the normal wait", async () => {
    writeFileSync(eventsFile, lines(0, 1), { mode: 0o600 });
    cloud.faults.push({ status: 413, body: {} });
    const { loop } = make();
    expect(await loop.cycle()).toBe(BACKOFF_MAX_S * 1000);
    expect(loop.status().reason).toBe("refused");
    await clock.advance(BACKOFF_MAX_S * 1000);
    cloud.faults.push({ status: 502, body: {} });
    expect(await loop.cycle()).toBe(4000);
    expect(loop.status().reason).toBe("server");
    expect(logs.filter((l) => l.includes("did not take"))).toHaveLength(1);
  });

  it("refuses a version that is not a dotted number before anything is read", () => {
    const tail = new EngineTail({ eventsPath: eventsFile, cursorPath: cursorFile, uid: process.getuid?.(), secrets: () => [], log: () => undefined });
    const send = createEventsUploader({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch });
    const base = { tail, send, clock, repoGhId: 77, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined };
    expect(() => new BridgeLoop(base)).not.toThrow();
    for (const bad of ["", "1.2", "v1.2.3", "1.2.3-rc1", "1.2.3\n", "1234567.0.0"]) {
      expect(() => new BridgeLoop({ ...base, engineVersion: bad })).toThrow();
      expect(() => new BridgeLoop({ ...base, bridgeVersion: bad })).toThrow();
    }
  });
});

describe("the cursor moves only after the last request of a batch", () => {
  const bigBatch = () =>
    Array.from({ length: 15 }, (_, i) =>
      EngineEvent.parse({ v: 1, engine_instance_id: A, seq: i, ts: "2026-11-16T15:00:00.000Z", kind: "plan_snapshot", snapshot_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a11", chunk_index: 0, chunk_count: 1, plan_date: "2026-11-16", items: [], roadmap: Array.from({ length: 450 }, (_, r) => ({ row_key: `R${r}`, status: "in_progress", planned_prs: 3 })) }),
    );

  it("chunk 2 failing leaves the cursor unmoved, and a restart resends the whole batch without a duplicate", async () => {
    const big = bigBatch();
    writeFileSync(eventsFile, big.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    const real = createEventsUploader({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch });
    let engineCalls = 0;
    const send: BridgeLoopDeps["send"] = async (message) => {
      if (message.session.engine_instance_id === A && ++engineCalls === 2) return { kind: "retry", why: "network" };
      return real(message);
    };
    const first = make({ send });
    expect(await first.loop.cycle()).toBe(2000);
    // Chunk 1 is stored at the cloud; chunk 2 was not; the cursor has not moved past any of the batch.
    const storedAfterFirst = cloud.seqsOf(A);
    expect(storedAfterFirst.length).toBeGreaterThan(0);
    expect(storedAfterFirst.length).toBeLessThan(big.length);
    expect(acked()).toBeNull();
    expect(first.loop.status()).toMatchObject({ state: "backoff", lastAckedSeq: null });
    // The process dies and starts again from the cursor file: the whole batch is read and sent again, and the cloud keeps each event once.
    const before = cloud.seen.length;
    const second = make();
    await second.loop.cycle();
    const resent = cloud.seen.slice(before).filter((s) => s.instance === A);
    expect(resent[0]!.seqs[0]).toBe(0);
    expect(cloud.seqsOf(A)).toEqual(big.map((e) => e.seq));
    expect(acked()).toBe(14);
  });
});
