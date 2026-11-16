import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCursor } from "../../src/engineBridge/cursor.js";
import { EngineTail, type TailOptions } from "../../src/engineBridge/tail.js";

const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const line = (seq: number): string => `${JSON.stringify({ v: 1, engine_instance_id: A, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5 })}\n`;
const lines = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => line(from + i)).join("");
const uid = process.getuid?.();

let dir: string;
let events: string;
let cursor: string;
let opened: string[];
const make = (over: Partial<TailOptions> = {}): EngineTail => new EngineTail({ eventsPath: events, cursorPath: cursor, secrets: () => [], log: () => undefined, observe: (p) => opened.push(p), uid, ...over });
const saved = () => loadCursor(cursor, undefined, uid);
/** Polls and commits what it got, as the upload loop does. */
const seqsAcked = (tail: EngineTail): number[] => {
  const got = tail.poll().events.map((e) => e.seq);
  tail.ack(got.length > 0 ? got[got.length - 1]! : null);
  return got;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb3a-c-"));
  mkdirSync(path.join(dir, "engine"));
  mkdirSync(path.join(dir, "runner"), { mode: 0o700 });
  events = path.join(dir, "engine", "engine-events.jsonl");
  cursor = path.join(dir, "runner", "cursor.json");
  opened = [];
});
afterEach(() => {
  chmodSync(path.join(dir, "runner"), 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("the batch contract", () => {
  it("refuses ack(null) while the poll holds events, and changes nothing", () => {
    writeFileSync(events, lines(0, 2), { mode: 0o600 });
    const t = make();
    expect(t.poll().events).toHaveLength(3);
    expect(() => t.ack(null)).toThrow("ack(null)");
    expect(saved()).toBeNull();
    t.ack(2);
    expect(saved()).toMatchObject({ last_acked_seq: 2 });
  });

  it("refuses a second poll while a batch is outstanding, until it is acked or rewound", () => {
    writeFileSync(events, lines(0, 2), { mode: 0o600 });
    const t = make();
    t.poll();
    expect(() => t.poll()).toThrow("not yet acked");
    t.rewind();
    expect(t.poll().events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("an ack that cannot write the cursor throws, changes nothing, and can be retried", () => {
    writeFileSync(events, lines(0, 2), { mode: 0o600 });
    const t = make();
    t.poll();
    chmodSync(path.join(dir, "runner"), 0o500);
    expect(() => t.ack(2)).toThrow();
    chmodSync(path.join(dir, "runner"), 0o700);
    expect(saved()).toBeNull();
    t.ack(2);
    expect(saved()).toMatchObject({ last_acked_seq: 2 });
    expect(seqsAcked(t)).toEqual([]);
  });

  it("acking an idle poll writes nothing", () => {
    writeFileSync(events, lines(0, 1), { mode: 0o600 });
    const t = make();
    seqsAcked(t);
    opened.length = 0;
    t.poll();
    t.ack(null);
    expect(opened.filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  it("counts a rotated .1 that ends mid-line as one partial_line", () => {
    writeFileSync(events, lines(0, 1) + '{"v":1,"engine_inst', { mode: 0o600 });
    const t = make();
    seqsAcked(t);
    renameSync(events, `${events}.1`);
    writeFileSync(events, lines(2, 3), { mode: 0o600 });
    const r = t.poll();
    expect(r.events).toEqual([]);
    expect(r.dropped.partial_line).toBe(1);
    t.ack(null);
    expect(seqsAcked(t)).toEqual([2, 3]);
  });

  it("an over-long line's skip state does not outlive a rotation", () => {
    writeFileSync(events, line(0) + "y".repeat(70_000), { mode: 0o600 });
    const t = make();
    expect(t.poll().dropped.oversize).toBe(1);
    t.ack(0);
    renameSync(events, `${events}.1`);
    writeFileSync(events, lines(1, 2), { mode: 0o600 });
    const got: number[] = [];
    for (let i = 0; i < 3; i++) got.push(...seqsAcked(t));
    expect(got).toEqual([1, 2]);
  });

  it("an over-long line's skip state does not outlive a rotation that cannot be followed", () => {
    writeFileSync(events, line(0) + "y".repeat(70_000), { mode: 0o600 });
    const t = make();
    expect(t.poll().dropped.oversize).toBe(1);
    t.ack(0);
    renameSync(events, path.join(dir, "engine", "gone.jsonl"));
    writeFileSync(events, lines(1, 2), { mode: 0o600 });
    expect(seqsAcked(t)).toEqual([1, 2]);
  });

  it("judges at most maxLines per poll and says more is waiting", () => {
    writeFileSync(events, "{}\n".repeat(5000), { mode: 0o600 });
    const t = make({ maxLines: 1000 });
    let polls = 0;
    let schema = 0;
    for (;;) {
      const r = t.poll();
      t.ack(null);
      polls++;
      schema += r.dropped.schema;
      expect(r.dropped.schema).toBeLessThanOrEqual(1000);
      if (!r.more) break;
    }
    expect(polls).toBe(5);
    expect(schema).toBe(5000);
  });
});
