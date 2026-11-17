import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeLoop, HALT_REPORTS_MAX } from "../../src/engineBridge/loop.js";
import { judgeLine } from "../../src/engineBridge/shape.js";
import { EngineTail } from "../../src/engineBridge/tail.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const BRIDGE = "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d";
const base = { v: 1, engine_instance_id: A, ts: "2026-11-16T15:00:00.000Z" };
const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

describe("an engine's file cannot send the runner's own kinds", () => {
  it("judges bridge_heartbeat and bridge_dropped lines of the engine's file as schema drops, and a plain event as fine", () => {
    expect(judgeLine(enc({ ...base, seq: 0, kind: "bridge_heartbeat" }), [])).toEqual({ ok: false, reason: "schema" });
    expect(judgeLine(enc({ ...base, seq: 1, kind: "bridge_dropped", count: 3, reason: "schema" }), [])).toEqual({ ok: false, reason: "schema" });
    expect(judgeLine(enc({ ...base, seq: 2, kind: "loop_tick", origin: "cron", duration_s: 1 }), [])).toMatchObject({ ok: true });
  });

  it("drops such a line from an upload, counts it, and still sends the engine events around it in order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-eb3c-own-"));
    try {
      const file = path.join(dir, "engine-events.jsonl");
      const lines = [{ ...base, seq: 0, kind: "loop_tick", origin: "cron", duration_s: 1 }, { ...base, seq: 1, kind: "bridge_heartbeat" }, { ...base, seq: 2, kind: "loop_tick", origin: "cron", duration_s: 1 }];
      writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
      const tail = new EngineTail({ eventsPath: file, cursorPath: path.join(dir, "c.json"), uid: process.getuid?.(), secrets: () => [], log: () => undefined });
      const polled = tail.poll();
      expect(polled.events.map((e) => e.seq)).toEqual([0, 2]);
      expect(polled.dropped.schema).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("halt reports in the bridge session", () => {
  let dir: string;
  let ingest: StrictEngineIngest;
  let clock: ManualClock;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fx-eb3c-own-"));
    ingest = await startStrictEngineIngest();
    clock = manualClock(Date.now());
    ingest.now = () => clock.now();
  });
  afterEach(async () => {
    await ingest.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function make() {
    const key = generateRunnerKey();
    ingest.trust(key.publicJwk);
    const tail = new EngineTail({ eventsPath: path.join(dir, "e.jsonl"), cursorPath: path.join(dir, "c.json"), uid: process.getuid?.(), secrets: () => [], log: () => undefined });
    return new BridgeLoop({ tail, send: createEventsUploader({ origin: ingest.origin, key, now: () => clock.now(), fetchFn: fetch }), clock, repoGhId: 77, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined, newInstanceId: () => BRIDGE });
  }
  const stored = () => ingest.sessions.get(BRIDGE)?.stored ?? [];

  it("sends halt_applied in the bridge's own session, in order after nothing of the engine's seq space", async () => {
    const loop = make();
    loop.reportHalt({ halt_epoch: 3, method: "scope", survivors: 0 });
    await loop.cycle();
    expect(stored().map((e) => e.kind)).toEqual(["halt_applied", "bridge_heartbeat"]);
    expect(stored().map((e) => e.seq)).toEqual([0, 1]);
    expect(stored()[0]).toMatchObject({ halt_epoch: 3, method: "scope", survivors: 0 });
  });

  it("counts a survivors figure that is not a whole number as 1, never 0, and keeps at most 20 reports", async () => {
    const loop = make();
    loop.reportHalt({ halt_epoch: 1, method: "group_only", survivors: Number.NaN });
    loop.reportHalt({ halt_epoch: 1, method: "group_only", survivors: -2 });
    for (let i = 0; i < HALT_REPORTS_MAX + 5; i++) loop.reportHalt({ halt_epoch: 10 + i, method: "scope", survivors: 0 });
    await loop.cycle();
    const halts = stored().filter((e) => e.kind === "halt_applied");
    expect(halts).toHaveLength(HALT_REPORTS_MAX);
    expect(halts[0]).toMatchObject({ halt_epoch: 15, survivors: 0 });
    const loop2 = make();
    loop2.reportHalt({ halt_epoch: 1, method: "group_only", survivors: Number.NaN });
    expect(() => loop2.reportHalt({ halt_epoch: 1, method: "group_only", survivors: 1.5 })).not.toThrow();
  });

  it("keeps a report the cloud has not taken and sends it again", async () => {
    const loop = make();
    ingest.faults.push({ status: 500 });
    loop.reportHalt({ halt_epoch: 4, method: "scope", survivors: 0 });
    await loop.cycle();
    expect(stored()).toEqual([]);
    await clock.advance(5000, 1000);
    await loop.cycle();
    expect(stored().filter((e) => e.kind === "halt_applied")).toHaveLength(1);
  });
});
