import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobClassOfRole, type ClaimCapacity } from "@fulcrumaxe/runner-protocol";
import { createAdmission } from "../../src/daemon/admission.js";
import type { ClaimResult, Claimed } from "../../src/daemon/client.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import { HEADROOM_CHECK_MS, pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { WakeTracker } from "../../src/daemon/wake.js";
import { DEFAULT_SETTINGS } from "../../src/runnerSettings.js";
import { manualClock, until } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";

/**
 * A runner whose heavy class had no room at its last claim, and a cloud that answers idle (60 s) for it. When room opens on the machine the loop must
 * claim again without waiting out the idle answer, without any request while nothing opened, and say once, in the journal, what it holds back.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxreoffer-poll-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function world(reading: ResourceReading, opts: { wake?: boolean } = {}) {
  const clock = manualClock();
  const controller = new AbortController();
  const log: PollEvent[] = [];
  const declared: Array<ClaimCapacity | undefined> = [];
  const waked: number[] = [];
  const queue: Claimed[] = [];
  const handled: string[] = [];
  const signed = signedJob({ role: "executor" as never });
  queue.push({ kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 });
  const client = {
    async claim(_sandbox?: unknown, capacity?: ClaimCapacity): Promise<ClaimResult> {
      declared.push(capacity);
      const index = queue.findIndex((job) => capacity !== undefined && capacity[jobClassOfRole(job.signedJob.job.role)].limit - capacity[jobClassOfRole(job.signedJob.job.role)].in_use > 0);
      if (index === -1) return { kind: "idle", retryAfter: 60 };
      return queue.splice(index, 1)[0]!;
    },
    async wake() {
      waked.push(clock.now().getTime());
      return { kind: "wake" as const, epoch: 1, dueAt: null };
    },
  };
  const admission = createAdmission({ probe: { read: () => reading }, footprints: createFootprintStore(dir), settings: () => ({ ...DEFAULT_SETTINGS }), paused: () => false, now: () => clock.now().getTime(), every: () => () => undefined });
  const wake = opts.wake === true ? new WakeTracker({ token: "t".repeat(40), poll_s: 20, transport: "poll" } as never) : undefined;
  const loop = pollLoop({
    client,
    ...(wake === undefined ? {} : { wake }),
    clock,
    gate: OPEN_GATE,
    signal: controller.signal,
    onClaimed: async (claimed) => {
      handled.push(claimed.runId);
    },
    admission,
    log: (e) => log.push(e),
    random: () => 1,
  });
  return { clock, controller, log, declared, waked, handled, loop, reading };
}

/** 16 GB, 25% reserve; 6 GB free leaves 2 GB: a light job fits, a heavy one (3 GB) does not. */
const tight = (): ResourceReading => ({ totalMemBytes: 16 * GIB, availMemBytes: 6 * GIB, load1: 0, load5: 0, cores: 16, freeDiskBytes: 100 * GIB });

describe("re-claiming when room opens", () => {
  it("claims again within one headroom check of the room opening, not after the cloud's 60 seconds", async () => {
    const w = world(tight());
    await until(() => w.declared.length === 1);
    expect(w.declared[0]).toMatchObject({ heavy: { limit: 0 }, limited_by: "memory" });
    w.reading.availMemBytes = 14 * GIB;
    await w.clock.advance(HEADROOM_CHECK_MS + 1000);
    await until(() => w.handled.length === 1);
    expect(w.declared.length).toBeGreaterThanOrEqual(2);
    expect(w.declared[1]).toMatchObject({ heavy: { limit: 3, in_use: 0 } });
    w.controller.abort();
    await w.loop;
  });

  it("makes no request while nothing opened: the loop only looks at the machine", async () => {
    const w = world(tight());
    await until(() => w.declared.length === 1);
    await w.clock.advance(HEADROOM_CHECK_MS * 2);
    expect(w.declared.length).toBe(1);
    // Memory moved but not enough for a heavy job: still no request.
    w.reading.availMemBytes = 6.5 * GIB;
    await w.clock.advance(HEADROOM_CHECK_MS);
    expect(w.declared.length).toBe(1);
    w.controller.abort();
    await w.loop;
  });

  it("a machine whose room shrank does not trigger a claim either", async () => {
    const w = world({ ...tight(), availMemBytes: 14 * GIB });
    // The run is taken at once; make the next claim find nothing and the machine tighten afterwards.
    await until(() => w.handled.length === 1);
    await until(() => w.declared.length === 2);
    w.reading.availMemBytes = 2 * GIB;
    await w.clock.advance(HEADROOM_CHECK_MS * 2);
    expect(w.declared.length).toBe(2);
    w.controller.abort();
    await w.loop;
  });

  it("also while waiting on wake checks: room opening cuts the wait short and the safety claim is not needed", async () => {
    const w = world(tight(), { wake: true });
    await until(() => w.declared.length === 1);
    w.reading.availMemBytes = 14 * GIB;
    await w.clock.advance(HEADROOM_CHECK_MS + 1000);
    await until(() => w.handled.length === 1);
    expect(w.declared.length).toBeGreaterThanOrEqual(2);
    // The claim came from the headroom check, long before the 60-second idle answer ran out.
    expect(w.clock.now().getTime() - Date.parse("2026-10-08T12:00:00.000Z")).toBeLessThan(60_000);
    w.controller.abort();
    await w.loop;
  });
});

describe("the journal line for what is held back", () => {
  it("says once that heavy jobs are held back and why, says nothing while it stays so, and says when it clears", async () => {
    const w = world(tight());
    await until(() => w.declared.length === 1);
    await w.clock.advance(HEADROOM_CHECK_MS * 3);
    expect(w.log.filter((e) => e.event === "held")).toEqual([{ event: "held", light: null, heavy: "memory" }]);
    w.reading.availMemBytes = 14 * GIB;
    await w.clock.advance(HEADROOM_CHECK_MS + 1000);
    await until(() => w.log.filter((e) => e.event === "held").length === 2);
    expect(w.log.filter((e) => e.event === "held")[1]).toEqual({ event: "held", light: null, heavy: null });
    w.controller.abort();
    await w.loop;
  });

  it("a machine with room throughout never says anything", async () => {
    const w = world({ ...tight(), availMemBytes: 14 * GIB });
    await until(() => w.handled.length === 1);
    w.controller.abort();
    await w.loop;
    expect(w.log.filter((e) => e.event === "held")).toEqual([]);
  });
});
