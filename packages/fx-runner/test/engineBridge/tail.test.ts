import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineTail, type TailOptions } from "../../src/engineBridge/tail.js";
import { loadCursor } from "../../src/engineBridge/cursor.js";

const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const line = (seq: number, instance = A, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ v: 1, engine_instance_id: instance, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 1, ...extra })}\n`;
const lines = (from: number, to: number, instance = A): string => Array.from({ length: to - from + 1 }, (_, i) => line(from + i, instance)).join("");

let dir: string;
let events: string;
let cursor: string;
let logged: string[];
let opened: string[];
const make = (over: Partial<TailOptions> = {}): EngineTail => new EngineTail({ eventsPath: events, cursorPath: cursor, secrets: () => [], log: (l) => logged.push(l), observe: (p) => opened.push(p), uid: process.getuid?.(), ...over });
const seqs = (tail: EngineTail): number[] => tail.poll().events.map((e) => e.seq);
/** Polls and commits what it got, as the upload loop does. */
const seqsAcked = (tail: EngineTail): number[] => {
  const got = tail.poll().events.map((e) => e.seq);
  tail.ack(got.length > 0 ? got[got.length - 1]! : null);
  return got;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb3a-"));
  mkdirSync(path.join(dir, "engine"));
  mkdirSync(path.join(dir, "runner"));
  events = path.join(dir, "engine", "engine-events.jsonl");
  cursor = path.join(dir, "runner", "cursor.json");
  logged = [];
  opened = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tail", () => {
  it("returns complete valid lines in order and nothing when the file is absent", () => {
    const tail = make();
    expect(tail.poll().status).toBe("idle");
    writeFileSync(events, lines(0, 4), { mode: 0o600 });
    const r = tail.poll();
    tail.ack(4);
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(r.gaps).toEqual([]);
    expect(seqs(tail)).toEqual([]);
  });

  it("waits on a line with no newline and never parses it half-written", () => {
    const full = line(1);
    writeFileSync(events, line(0) + full.slice(0, 20), { mode: 0o600 });
    const tail = make();
    const first = tail.poll();
    tail.ack(0);
    expect(first.events.map((e) => e.seq)).toEqual([0]);
    expect(first.dropped).toEqual({ schema: 0, oversize: 0, redaction: 0, partial_line: 0 });
    appendFileSync(events, full.slice(20));
    expect(seqs(tail)).toEqual([1]);
  });

  it("counts malformed lines by reason, uploads none, and logs nothing from them", () => {
    const secret = "claude-sonnet-5-5";
    const bad = ["not json\n", `${JSON.stringify({ v: 1 })}\n`, line(2, A, { title: "x" }), line(3, A, { surprise: 1 }), "@@BAD@@", `${"x".repeat(70_000)}\n`, `${JSON.stringify({ v: 1, engine_instance_id: A, seq: 5, ts: "2026-11-16T15:00:00.000Z", kind: "agent_started", spawn_id: "toolu_abc", role: "executor", background: false, isolation: "none", model: secret })}\n`, line(6)].join("");
    writeFileSync(events, Buffer.concat([Buffer.from(line(0) + bad.replace("@@BAD@@", "")), Buffer.from([0xff, 0xfe, 0x0a])]), { mode: 0o600 });
    appendFileSync(events, line(7));
    const r = make({ secrets: () => [secret] }).poll();
    expect(r.events.map((e) => e.seq)).toEqual([0, 6, 7]);
    expect(r.dropped).toEqual({ schema: 5, oversize: 1, redaction: 1, partial_line: 0 });
    expect(logged).toEqual([]);
  });

  it("drops an unterminated line over 64 KiB and skips the rest of it on later polls", () => {
    writeFileSync(events, line(0) + "y".repeat(70_000), { mode: 0o600 });
    const tail = make();
    const first = tail.poll();
    tail.ack(0);
    expect(first.events.map((e) => e.seq)).toEqual([0]);
    expect(first.dropped.oversize).toBe(1);
    appendFileSync(events, `${"y".repeat(500)}\n${line(1)}`);
    const second = tail.poll();
    expect(second.events.map((e) => e.seq)).toEqual([1]);
    expect(second.dropped.schema).toBe(0);
  });

  it("reads a bounded amount per poll and a bounded batch", () => {
    writeFileSync(events, lines(0, 299), { mode: 0o600 });
    const tail = make({ maxEvents: 100 });
    expect(seqsAcked(tail)).toHaveLength(100);
    expect(seqsAcked(tail)[0]).toBe(100);
    writeFileSync(events, lines(0, 1999), { mode: 0o600 });
    const small = make({ cursorPath: path.join(dir, "runner", "other.json"), maxPollBytes: 1, maxEvents: 5000 });
    expect(small.poll().events.length).toBeLessThan(2000);
  });

  it("reports a gap and does not fill it", () => {
    writeFileSync(events, line(0) + line(1) + line(5), { mode: 0o600 });
    const r = make().poll();
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 5]);
    expect(r.gaps).toEqual([{ after_seq: 1, next_seq: 5, missing: 3 }]);
  });

  it("treats a new engine instance as a reset, never a gap, and never mixes two instances in one batch", () => {
    writeFileSync(events, lines(0, 2) + lines(0, 1, B), { mode: 0o600 });
    const tail = make();
    const first = tail.poll();
    expect(first.events.map((e) => e.engine_instance_id)).toEqual([A, A, A]);
    expect(first.reset).toBe(false);
    tail.ack(2);
    const second = tail.poll();
    expect(second.events.map((e) => [e.engine_instance_id, e.seq])).toEqual([[B, 0], [B, 1]]);
    expect(second.reset).toBe(true);
    expect(second.gaps).toEqual([]);
    tail.ack(1);
    expect(loadCursor(cursor, undefined, process.getuid?.())).toMatchObject({ engine_instance_id: B, last_acked_seq: 1 });
  });
});

describe("cursor and restart", () => {
  it("resumes after a restart with no line read twice, and re-reads what was read but never acked", () => {
    writeFileSync(events, lines(0, 9), { mode: 0o600 });
    const before = make();
    expect(seqs(before)).toHaveLength(10);
    before.ack(4);
    expect(seqs(make())).toEqual([5, 6, 7, 8, 9]);
    // killed between the read and the cursor write: nothing acked since, so the same lines come back
    expect(seqs(make())).toEqual([5, 6, 7, 8, 9]);
    const c = loadCursor(cursor, undefined, process.getuid?.())!;
    expect(c).toMatchObject({ engine_instance_id: A, last_sent_seq: 9, last_acked_seq: 4 });
  });

  it("acks part of a batch and resumes right after the acked event", () => {
    writeFileSync(events, lines(0, 5), { mode: 0o600 });
    const t = make();
    t.poll();
    t.ack(2);
    expect(seqs(make())).toEqual([3, 4, 5]);
  });

  it("writes the cursor 0600 through a temp file and leaves nothing behind", () => {
    writeFileSync(events, lines(0, 1), { mode: 0o600 });
    const t = make();
    t.poll();
    t.ack(1);
    expect(statSync(cursor).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.join(dir, "runner"))).toEqual(["cursor.json"]);
  });

  it("starts over from 0 when the cursor is damaged", () => {
    writeFileSync(events, lines(0, 2), { mode: 0o600 });
    writeFileSync(cursor, "{broken", { mode: 0o600 });
    expect(seqs(make())).toEqual([0, 1, 2]);
  });

  it("follows a rotation: finishes the rotated file, then reads the new one from 0", () => {
    writeFileSync(events, lines(0, 3), { mode: 0o600 });
    const t = make();
    t.poll();
    t.ack(1);
    appendFileSync(events, lines(4, 5));
    renameSync(events, `${events}.1`);
    writeFileSync(events, lines(6, 7), { mode: 0o600 });
    const r = make();
    expect(seqs(r)).toEqual([2, 3, 4, 5]);
    r.ack(5);
    expect(seqs(r)).toEqual([6, 7]);
  });

  it("re-reads a rotated file it cannot follow from 0, skipping what was acked", () => {
    writeFileSync(events, lines(0, 3), { mode: 0o600 });
    const t = make();
    t.poll();
    t.ack(3);
    rmSync(events);
    writeFileSync(events, lines(0, 5), { mode: 0o600 });
    expect(seqs(make())).toEqual([4, 5]);
  });

  it("re-reads a truncated file from 0, skipping what was acked", () => {
    writeFileSync(events, lines(0, 5), { mode: 0o600 });
    const t = make();
    t.poll();
    t.ack(5);
    truncateSync(events, 0);
    writeFileSync(events, lines(4, 7), { mode: 0o600 });
    expect(seqs(t)).toEqual([6, 7]);
  });
});

describe("refusals", () => {
  const refusedOnce = (tail: EngineTail): void => {
    expect(tail.poll()).toMatchObject({ status: "refused", events: [] });
    expect(tail.poll().status).toBe("refused");
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain(dir);
  };

  it("refuses a symlinked events file", () => {
    writeFileSync(path.join(dir, "real.jsonl"), lines(0, 1), { mode: 0o600 });
    symlinkSync(path.join(dir, "real.jsonl"), events);
    refusedOnce(make());
  });

  it("refuses a FIFO", () => {
    execFileSync("mkfifo", [events]);
    refusedOnce(make());
  });

  it("refuses an events file others can write", () => {
    writeFileSync(events, lines(0, 1), { mode: 0o600 });
    chmodSync(events, 0o666);
    refusedOnce(make());
  });

  it("refuses a symlinked cursor and writes nothing through it", () => {
    writeFileSync(events, lines(0, 1), { mode: 0o600 });
    const target = path.join(dir, "elsewhere.json");
    writeFileSync(target, "keep", { mode: 0o600 });
    symlinkSync(target, cursor);
    refusedOnce(make());
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});

describe("what the bridge opens", () => {
  it("is exactly the events file, its .1 after a rotation, and the cursor", () => {
    writeFileSync(events, lines(0, 2), { mode: 0o600 });
    writeFileSync(path.join(dir, "engine", "spawn-registry.jsonl"), "x");
    const t = make();
    t.poll();
    t.ack(2);
    renameSync(events, `${events}.1`);
    writeFileSync(events, lines(3, 4), { mode: 0o600 });
    const u = make();
    u.poll();
    u.ack(4);
    const allowed = (p: string): boolean => p === events || p === `${events}.1` || p === cursor || (p.startsWith(`${cursor}.`) && p.endsWith(".tmp"));
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter((p) => !allowed(p))).toEqual([]);
    expect(opened).toContain(`${events}.1`);
  });
});
