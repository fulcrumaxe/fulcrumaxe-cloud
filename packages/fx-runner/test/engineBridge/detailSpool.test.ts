import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@fulcrumaxe/runner-protocol";
import { CATCHUP_MAX_EVENTS, DetailSpool, newDetailInstanceId, SPOOL_MAX_AGE_MS, detailSpoolPaths, removeDetailSpool } from "../../src/engineBridge/detailSpool.js";
import { FileRefused } from "../../src/engineBridge/cursor.js";

const REPO = 77;
const ENGINE = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const DETAIL = "6a1d4c0e-7b2f-8e8a-9c3d-5f1a2b3c4d5e";
const uid = process.getuid?.();
const HOUR = 3_600_000;

let dir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-spool-"));
  chmodSync(dir, 0o700);
  now = Date.parse("2026-11-20T12:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (seq: number, tsMs = now, instance = ENGINE): EngineEvent => ({ v: 1, engine_instance_id: instance, seq, ts: new Date(tsMs).toISOString(), kind: "loop_tick", origin: "cron", duration_s: 5 }) as EngineEvent;
const open = (over: Partial<ConstructorParameters<typeof DetailSpool>[0]> = {}): DetailSpool => new DetailSpool({ ...detailSpoolPaths(dir, REPO), uid, now: () => now, newInstanceId: () => DETAIL, ...over });
const items = (from: number, n: number, tsMs = now, tail = 0) => Array.from({ length: n }, (_, i) => ({ tail, event: ev(from + i, tsMs) }));

describe("the detail spool", () => {
  it("makes its own instance id a version-8 UUID, which the cloud reads as a detail session; the engine's random ids are version 4", () => {
    for (let i = 0; i < 20; i++) expect(newDetailInstanceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(open({ newInstanceId: undefined }).instance()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8/);
  });

  it("holds events under a session of its own: its instance id, its own seq from 0, written 0600 under a 0700 directory", () => {
    const spool = open();
    expect(spool.append(items(100, 3))).toBe(3);
    const { file, statePath } = detailSpoolPaths(dir, REPO);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const sel = spool.selectPending()!;
    expect(sel.events.map((e) => [e.engine_instance_id, e.seq])).toEqual([[DETAIL, 0], [DETAIL, 1], [DETAIL, 2]]);
    expect(sel.events.every((e) => e.kind === "loop_tick")).toBe(true);
    expect(spool.highSeq()).toBe(2);
  });

  it("keeps its instance and its next seq across a restart, and the highest seq already sent", () => {
    const a = open();
    a.append(items(0, 4));
    a.markUploaded(2);
    const b = open({ newInstanceId: () => "11111111-1111-4111-8111-111111111111" });
    expect(b.instance()).toBe(DETAIL);
    expect(b.uploadedThrough()).toBe(2);
    b.append(items(4, 2));
    expect(b.selectPending()!.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("does not spool an event twice when its cursor move failed and the same lines are read again", () => {
    const spool = open();
    spool.append(items(10, 3));
    expect(spool.append(items(10, 3))).toBe(0);
    expect(spool.append(items(11, 4))).toBe(2);
    // A restart finds the origins in the lines themselves, with nothing but the spool to go on.
    const again = open();
    expect(again.append(items(10, 5))).toBe(0);
    expect(again.size().events).toBe(5);
    // A second file (the host's) has its own origin, and its own event numbers do not clash with the engine's.
    expect(again.append(items(10, 2, now, 1))).toBe(2);
  });

  it("a new engine instance (a restart of the engine) is not a repeat, whatever its seq", () => {
    const spool = open();
    spool.append(items(50, 2));
    expect(spool.append([{ tail: 0, event: ev(0, now, "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e") }])).toBe(1);
  });

  it("a catch-up takes the newest events not yet sent, at most 24 h old, 2,000 of them", () => {
    const spool = open();
    spool.append(items(0, 5, now - 30 * HOUR));
    spool.append(items(5, 2_100, now - 20 * HOUR));
    const sel = spool.selectPending()!;
    expect(sel.events).toHaveLength(CATCHUP_MAX_EVENTS);
    expect(sel.events[sel.events.length - 1]!.seq).toBe(2_104);
    expect(sel.events[0]!.seq).toBe(2_105 - CATCHUP_MAX_EVENTS);
    expect(sel.through).toBe(2_104);
    const old = open({ file: path.join(dir, "o.jsonl"), statePath: path.join(dir, "o.json") });
    old.append(items(0, 5, now - 30 * HOUR));
    old.append(items(5, 4, now - 2 * HOUR));
    expect(old.selectPending()!.events.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
  });

  it("a catch-up is under 1 MiB of lines, newest first kept", () => {
    const spool = open();
    const big = (seq: number): EngineEvent => ({ v: 1, engine_instance_id: ENGINE, seq, ts: new Date(now).toISOString(), kind: "plan_snapshot", snapshot_id: "s1", chunk_index: 0, chunk_count: 1, plan_date: "2026-11-20", items: Array.from({ length: 300 }, (_, i) => ({ discussion: 1_000 + i, ordinal: i, state: "planned" })), roadmap: [] }) as EngineEvent;
    spool.append(Array.from({ length: 80 }, (_, i) => ({ tail: 0, event: big(i) })));
    const sel = spool.selectPending()!;
    const bytes = sel.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
    expect(sel.events.length).toBeLessThan(80);
    expect(bytes).toBeLessThanOrEqual(1_048_576 + 200 * sel.events.length);
    expect(sel.events[sel.events.length - 1]!.seq).toBe(79);
  });

  it("after markUploaded only newer events are pending; events a catch-up left behind stay selectable with a before seq", () => {
    const spool = open();
    spool.append(items(0, 2_050));
    const sel = spool.selectPending()!;
    spool.markUploaded(sel.through);
    expect(spool.selectPending()).toBeNull();
    expect(spool.hasPending()).toBe(false);
    const older = spool.selectOlder(sel.events[0]!.seq)!;
    expect(older.events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(spool.selectOlder(0)).toBeNull();
    spool.append(items(2_050, 1));
    expect(spool.selectPending()!.events.map((e) => e.seq)).toEqual([2_050]);
  });

  it("drops what is older than 7 days, when it next checks", () => {
    const spool = open();
    spool.append(items(0, 3, now - 8 * 24 * HOUR));
    spool.append(items(3, 2, now - 1 * HOUR));
    // The age check runs at open, and again an hour later.
    const reopened = open();
    expect(reopened.size().events).toBe(2);
    expect(reopened.selectPending()!.events.map((e) => e.seq)).toEqual([3, 4]);
    now += SPOOL_MAX_AGE_MS;
    reopened.append(items(5, 1, now));
    expect(reopened.size().events).toBe(1);
    // Seq never goes back, even when everything was pruned.
    expect(reopened.highSeq()).toBe(5);
  });

  it("is capped at its byte limit: the oldest lines go first and the file ends under 90% of the cap", () => {
    const spool = open({ maxBytes: 2_000 });
    for (let i = 0; i < 40; i++) spool.append(items(i, 1));
    const { events, bytes } = spool.size();
    expect(bytes).toBeLessThanOrEqual(2_000);
    expect(events).toBeLessThan(40);
    expect(spool.selectPending()!.events.at(-1)!.seq).toBe(39);
    expect(readFileSync(detailSpoolPaths(dir, REPO).file, "utf8").length).toBe(bytes);
  });

  it("writes a pruned spool by temp file and rename, never in place", () => {
    const seen: string[] = [];
    const spool = open({ maxBytes: 1_500, observe: (f) => void seen.push(f) });
    for (let i = 0; i < 30; i++) spool.append(items(i, 1));
    expect(seen.some((f) => f.endsWith(".tmp"))).toBe(true);
    expect(existsSync(`${detailSpoolPaths(dir, REPO).file}`)).toBe(true);
  });

  it("opens every path with the cursor's rules: a link, a file of open permissions, and a directory are refused", () => {
    const { file, statePath } = detailSpoolPaths(dir, REPO);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "elsewhere"), "", { mode: 0o600 });
    symlinkSync(path.join(dir, "elsewhere"), file);
    expect(() => open().append(items(0, 1))).toThrow(FileRefused);
    expect(readFileSync(path.join(dir, "elsewhere"), "utf8")).toBe("");
    rmSync(file);
    writeFileSync(file, "", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => open().append(items(0, 1))).toThrow(FileRefused);
    rmSync(file);
    writeFileSync(statePath, "{}", { mode: 0o644 });
    chmodSync(statePath, 0o644);
    expect(() => open().instance()).toThrow(FileRefused);
    rmSync(statePath);
    symlinkSync(path.join(dir, "elsewhere"), statePath);
    expect(() => open().instance()).toThrow(FileRefused);
    expect(readFileSync(path.join(dir, "elsewhere"), "utf8")).toBe("");
  });

  it("refuses at APPEND a file swapped in after the spool was opened: a FIFO (without hanging), a 0644 file and a link", () => {
    const { file } = detailSpoolPaths(dir, REPO);
    const spool = open();
    spool.append(items(0, 1));
    // A FIFO: a plain open for writing blocks until a reader shows up. It must be refused at once.
    rmSync(file);
    execFileSync("mkfifo", [file]);
    const started = Date.now();
    expect(() => spool.append(items(1, 1))).toThrow(FileRefused);
    expect(Date.now() - started).toBeLessThan(2_000);
    rmSync(file);
    writeFileSync(file, "", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => spool.append(items(1, 1))).toThrow(FileRefused);
    rmSync(file);
    writeFileSync(path.join(dir, "elsewhere"), "", { mode: 0o600 });
    symlinkSync(path.join(dir, "elsewhere"), file);
    expect(() => spool.append(items(1, 1))).toThrow(FileRefused);
    expect(readFileSync(path.join(dir, "elsewhere"), "utf8")).toBe("");
  });

  it("leaves out a line that is not an event of this instance, a partial last line and an out-of-order seq, and rewrites the file without them", () => {
    const spool = open();
    spool.append(items(0, 2));
    const { file } = detailSpoolPaths(dir, REPO);
    const good = readFileSync(file, "utf8");
    const alien = JSON.stringify({ o: [0, ENGINE, 9], e: ev(2, now, "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e") });
    writeFileSync(file, `${good}${alien}\nnot json\n{"o":[0,"${ENGINE}",1],"e":{"v":1`, { mode: 0o600 });
    const reopened = open();
    expect(reopened.size().events).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(good);
    expect(reopened.append(items(2, 1))).toBe(1);
    expect(reopened.selectPending()!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("removeDetailSpool removes both files, and only the name when it is a link", () => {
    const spool = open();
    spool.append(items(0, 2));
    const { file, statePath } = detailSpoolPaths(dir, REPO);
    expect(removeDetailSpool(dir, REPO)).toBe(true);
    expect(existsSync(file) || existsSync(statePath)).toBe(false);
    expect(removeDetailSpool(dir, REPO)).toBe(true);
    writeFileSync(path.join(dir, "keep"), "x", { mode: 0o600 });
    symlinkSync(path.join(dir, "keep"), file);
    expect(removeDetailSpool(dir, REPO)).toBe(true);
    expect(readFileSync(path.join(dir, "keep"), "utf8")).toBe("x");
  });
});
