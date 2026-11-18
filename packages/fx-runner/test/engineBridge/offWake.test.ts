import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import { BridgeLoop, OFF_RETRY_S } from "../../src/engineBridge/loop.js";
import { EngineTail } from "../../src/engineBridge/tail.js";
import type { SendOutcome } from "../../src/engineBridge/upload.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";

/** The upload loop's pause while the cloud's switch is off: it ends on a wake (the command puller's epoch), else after 5 minutes. */
const REPO = 77;
const uid = process.getuid?.();
let dir: string;
let clock: ManualClock;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb-offwake-"));
  chmodSync(dir, 0o700);
  clock = manualClock(Date.now());
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(withWake: boolean, initial: number | null = 1) {
  let switchOn = false;
  let epoch: number | null = initial;
  const sends: number[] = [];
  const send = async (message: EngineEventsMessage): Promise<SendOutcome> => {
    sends.push(clock.now().getTime());
    if (!switchOn) return { kind: "off" };
    return { kind: "accepted", last: message.events[message.events.length - 1]!.seq };
  };
  const tail = new EngineTail({ eventsPath: path.join(dir, "engine-events.jsonl"), cursorPath: path.join(dir, "cursor.json"), uid, secrets: () => [], log: () => undefined });
  const loop = new BridgeLoop({ tail, send, clock, repoGhId: REPO, engineVersion: "1.2.3", bridgeVersion: "0.1.1", log: () => undefined, newInstanceId: () => "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d", ...(withWake ? { wakeEpoch: () => epoch } : {}) });
  return { loop, sends, set: (n: number | null) => (epoch = n), flip: () => (switchOn = true), wake: () => (epoch = (epoch ?? 0) + 1) };
}

describe("a paused upload loop and the wake", () => {
  it("goes within one tick of a wake once the switch is on, not after 5 minutes", async () => {
    const { loop, sends, flip, wake } = setup(true);
    const stop = new AbortController();
    const done = loop.run(stop.signal);
    await clock.advance(1_000);
    expect(loop.status().state).toBe("off");
    const first = sends.length;
    await clock.advance(30_000);
    expect(sends.length).toBe(first);
    flip();
    wake();
    await clock.advance(2_000);
    expect(sends.length).toBe(first + 1);
    expect(loop.status().state).toBe("uploading");
    stop.abort();
    await done;
  });

  it("still retries at 5 minutes when no wake comes", async () => {
    const { loop, sends, flip } = setup(true);
    const stop = new AbortController();
    const done = loop.run(stop.signal);
    await clock.advance(1_000);
    expect(sends.length).toBe(1);
    flip();
    await clock.advance((OFF_RETRY_S - 5) * 1000);
    expect(sends.length).toBe(1);
    await clock.advance(10_000);
    expect(sends.length).toBe(2);
    expect(loop.status().state).toBe("uploading");
    stop.abort();
    await done;
  });

  it("a wake with the switch still off costs one attempt, then waits 5 minutes again", async () => {
    const { loop, sends, wake } = setup(true);
    const stop = new AbortController();
    const done = loop.run(stop.signal);
    await clock.advance(1_000);
    wake();
    await clock.advance(3_000);
    expect(sends.length).toBe(2);
    expect(loop.status().state).toBe("off");
    await clock.advance(120_000);
    expect(sends.length).toBe(2);
    stop.abort();
    await done;
  });

  it("without a wake source the pause is the plain 5 minutes", async () => {
    const { loop, sends } = setup(false);
    const stop = new AbortController();
    const done = loop.run(stop.signal);
    await clock.advance(120_000);
    expect(sends.length).toBe(1);
    stop.abort();
    await done;
  });

  it("the first epoch read after a null one is the baseline, not a wake; a later change is", async () => {
    const { loop, sends, set } = setup(true, null);
    const stop = new AbortController();
    const done = loop.run(stop.signal);
    await clock.advance(1_000);
    expect(sends.length).toBe(1);
    set(5);
    await clock.advance(10_000);
    expect(sends.length).toBe(1);
    set(6);
    await clock.advance(3_000);
    expect(sends.length).toBe(2);
    stop.abort();
    await done;
  });
});
