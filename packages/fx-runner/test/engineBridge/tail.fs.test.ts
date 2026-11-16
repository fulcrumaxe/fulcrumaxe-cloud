import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineTail } from "../../src/engineBridge/tail.js";

/**
 * L1, at the file-system layer: every function of `node:fs` is wrapped, and while `rec.on` is set each call that names a path (a string first argument:
 * open, read, readdir, stat, rename, unlink, mkdir, anything) is recorded. The tail does not report anything itself here, so a read of any other file in
 * the state directory fails this test whatever way it is made.
 */
const rec = vi.hoisted(() => ({ on: false, calls: [] as Array<{ fn: string; path: string }> }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      if (rec.on && typeof args[0] === "string") rec.calls.push({ fn: name, path: args[0] });
      return (value as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const line = (seq: number): string => `${JSON.stringify({ v: 1, engine_instance_id: A, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5 })}\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb3a-l1-"));
});
afterEach(() => {
  rec.on = false;
  rec.calls = [];
  rmSync(dir, { recursive: true, force: true });
});

describe("what the bridge touches", () => {
  it("is the events file, its .1, the cursor and its temp file, and nothing else in the state directory", () => {
    const stateDir = path.join(dir, "engine");
    mkdirSync(stateDir);
    mkdirSync(path.join(dir, "runner"), { mode: 0o700 });
    const events = path.join(stateDir, "engine-events.jsonl");
    const cursor = path.join(dir, "runner", "cursor.json");
    // Decoys the bridge must never open: a sibling of the events file, the rest of the engine's state, and a file next to the cursor.
    for (const decoy of ["spawn-registry.jsonl", "engine-instance.json", "engine-halt.json"]) writeFileSync(path.join(stateDir, decoy), "x", { mode: 0o600 });
    writeFileSync(path.join(dir, "runner", "runner-key.pem"), "x", { mode: 0o600 });
    writeFileSync(events, line(0) + line(1) + line(2), { mode: 0o600 });

    rec.on = true;
    const first = new EngineTail({ eventsPath: events, cursorPath: cursor, secrets: () => [], log: () => undefined, uid: process.getuid?.() });
    first.poll();
    first.ack(2);
    rec.on = false;
    renameSync(events, `${events}.1`);
    writeFileSync(events, line(3) + line(4), { mode: 0o600 });
    rec.on = true;
    const second = new EngineTail({ eventsPath: events, cursorPath: cursor, secrets: () => [], log: () => undefined, uid: process.getuid?.() });
    // The first poll after a rotation finishes the old file; the next one reads the new.
    expect(second.poll().events).toEqual([]);
    second.ack(null);
    expect(second.poll().events.map((e) => e.seq)).toEqual([3, 4]);
    second.ack(4);
    second.poll();
    second.ack(null);
    rec.on = false;

    const allowed = (p: string): boolean => p === events || p === `${events}.1` || p === cursor || (p.startsWith(`${cursor}.`) && p.endsWith(".tmp")) || p === path.dirname(cursor);
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(rec.calls.filter((c) => !allowed(c.path))).toEqual([]);
    expect(rec.calls.some((c) => c.path === `${events}.1`)).toBe(true);
    expect(rec.calls.some((c) => c.path === cursor)).toBe(true);
  });
});
