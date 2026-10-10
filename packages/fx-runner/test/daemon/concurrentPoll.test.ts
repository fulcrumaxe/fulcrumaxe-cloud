import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobClassOfRole, type ClaimCapacity } from "@fulcrumaxe/runner-protocol";
import { createAdmission } from "../../src/daemon/admission.js";
import type { ClaimResult, Claimed } from "../../src/daemon/client.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import { pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_SETTINGS, type RunnerSettings } from "../../src/runnerSettings.js";
import { manualClock, until } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";

/**
 * The real claim loop and the real admission against a fake cloud that behaves like the real claim route: it offers a run only when the capacity
 * the claim declared has a free slot in that run's class. The jobs are fake: each one runs until the test finishes it.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxc434-poll-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Job {
  claimed: Claimed;
  role: string;
  finish: () => void;
  fail: () => void;
  settled: boolean;
}

function world(over: { reading?: Partial<ResourceReading>; settings?: Partial<RunnerSettings>; obeysCapacity?: boolean } = {}) {
  const reading: ResourceReading = { totalMemBytes: 64 * GIB, availMemBytes: 60 * GIB, load1: 0, cores: 32, freeDiskBytes: 500 * GIB, ...over.reading };
  const settings: RunnerSettings = { ...DEFAULT_SETTINGS, ...over.settings };
  const clock = manualClock();
  const controller = new AbortController();
  const queue: Claimed[] = [];
  const declared: Array<ClaimCapacity | undefined> = [];
  const jobs: Job[] = [];
  const log: PollEvent[] = [];
  const handled: string[] = [];
  const enqueue = (role: string): string => {
    const signed = signedJob({ role: role as never });
    queue.push({ kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 });
    return signed.job.run_id;
  };
  const client = {
    async claim(_sandbox?: unknown, capacity?: ClaimCapacity): Promise<ClaimResult> {
      declared.push(capacity);
      const index = queue.findIndex((job) => {
        if (over.obeysCapacity === false) return true;
        const cls = jobClassOfRole(job.signedJob.job.role);
        return capacity === undefined ? jobs.every((j) => j.settled) : capacity[cls].limit - capacity[cls].in_use > 0;
      });
      if (index === -1) return { kind: "idle", retryAfter: 60 };
      return queue.splice(index, 1)[0]!;
    },
  };
  const admission = createAdmission({
    probe: { read: () => reading },
    footprints: createFootprintStore(dir),
    settings: () => settings,
    paused: () => false,
    now: () => clock.now().getTime(),
    every: () => () => undefined,
  });
  const onClaimed = (claimed: Claimed): Promise<unknown> =>
    new Promise<void>((resolve, reject) => {
      const job: Job = { claimed, role: claimed.signedJob.job.role, settled: false, finish: () => undefined, fail: () => undefined };
      job.finish = () => {
        job.settled = true;
        resolve();
      };
      job.fail = () => {
        job.settled = true;
        reject(new Error("job failed"));
      };
      handled.push(claimed.runId);
      jobs.push(job);
    });
  const run = (extra: { betweenJobs?: () => Promise<"restart" | undefined> } = {}) =>
    pollLoop({ client, clock, gate: OPEN_GATE, signal: controller.signal, onClaimed, admission, log: (e) => log.push(e), random: () => 1, ...extra });
  return { reading, settings, clock, controller, enqueue, declared, jobs, log, handled, run, queue, inHand: () => jobs.filter((j) => !j.settled).length };
}

describe("claims up to capacity, in parallel", () => {
  it("three light runs offered at once are all in hand at once, and each claim reports the growing in-use count", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.enqueue("code-reviewer");
    const loop = w.run();
    await until(() => w.inHand() === 3);
    expect(w.queue).toHaveLength(0);
    // Claims 1..3 saw 0, 1 and 2 in use; the 4th (which found nothing) saw 3.
    await until(() => w.declared.length >= 4);
    expect(w.declared.slice(0, 4).map((c) => c?.light.in_use)).toEqual([0, 1, 2, 3]);
    w.controller.abort();
    w.jobs.forEach((j) => j.finish());
    expect(await loop).toBe("stopped");
  });

  it("the ceiling holds: ten light runs queued, never more than eight in hand, and a finished job's slot is taken at once", async () => {
    const w = world();
    for (let i = 0; i < 10; i++) w.enqueue("code-reviewer");
    const loop = w.run();
    await until(() => w.inHand() === 8);
    await w.clock.advance(1000);
    expect(w.inHand()).toBe(8);
    expect(w.queue).toHaveLength(2);
    // The ninth claim declared no free slot, and said why.
    expect(w.declared.at(-1)).toMatchObject({ light: { limit: 8, in_use: 8 }, limited_by: "ceiling" });
    w.jobs[0]!.finish();
    // No clock advance: the end of a job wakes the loop, which claims again without waiting out the 60 seconds.
    await until(() => w.handled.length === 9);
    expect(w.clock.slept.filter((ms) => ms === 60_000).length).toBeGreaterThan(0);
    w.controller.abort();
    w.jobs.forEach((j) => j.finish());
    await loop;
  });

  it("a ceiling set lower by the person applies from the next claim, and a running job is not stopped", async () => {
    const w = world({ settings: { ceilingTotal: 2 } });
    for (let i = 0; i < 4; i++) w.enqueue("debater");
    const loop = w.run();
    await until(() => w.inHand() === 2);
    await w.clock.advance(1000);
    expect(w.inHand()).toBe(2);
    expect(w.declared.at(-1)?.limited_by).toBe("ceiling");
    w.settings.ceilingTotal = 1;
    w.jobs[0]!.finish();
    await w.clock.advance(1000);
    // One finished, one still running, ceiling now 1: nothing new is claimed, and the survivor was never touched.
    expect(w.handled).toHaveLength(2);
    expect(w.jobs[1]!.settled).toBe(false);
    w.controller.abort();
    w.jobs.forEach((j) => j.finish());
    await loop;
  });
});

describe("resource-aware admission in the loop (fake probe)", () => {
  it("with headroom for two heavy runs, the third is not claimed", async () => {
    // 16 GB machine, reserve 4 GB, 6.5 GB of headroom: two heavy runs (3 GB each).
    const w = world({ reading: { totalMemBytes: 16 * GIB, availMemBytes: 4 * GIB + 6.5 * GIB, cores: 16 } });
    for (let i = 0; i < 3; i++) w.enqueue("executor");
    const loop = w.run();
    await until(() => w.inHand() === 2);
    await w.clock.advance(1000);
    expect(w.inHand()).toBe(2);
    expect(w.queue).toHaveLength(1);
    expect(w.declared.at(-1)).toMatchObject({ heavy: { limit: 2, in_use: 2 }, limited_by: "memory" });
    w.controller.abort();
    w.jobs.forEach((j) => j.finish());
    await loop;
  });

  it("a reserve breach mid-run stops new claims and kills nothing; recovery resumes them", async () => {
    const w = world({ reading: { totalMemBytes: 16 * GIB, availMemBytes: 14 * GIB, cores: 16 } });
    w.enqueue("code-reviewer");
    w.enqueue("code-reviewer");
    const loop = w.run();
    await until(() => w.inHand() === 2);
    await w.clock.advance(120_000);
    // The person starts heavy work: 3 GB left, below the 4 GB reserve.
    w.reading.availMemBytes = 3 * GIB;
    w.enqueue("code-reviewer");
    await w.clock.advance(61_000);
    expect(w.handled).toHaveLength(2);
    expect(w.queue).toHaveLength(1);
    expect(w.declared.at(-1)).toMatchObject({ light: { limit: 2, in_use: 2 }, limited_by: "memory" });
    // Both runs in hand are untouched and finish normally.
    expect(w.jobs.every((j) => !j.settled)).toBe(true);
    w.jobs[0]!.finish();
    w.jobs[1]!.finish();
    expect(w.log.filter((e) => e.event === "job_error")).toEqual([]);
    // Memory comes back: the queued run is claimed.
    w.reading.availMemBytes = 14 * GIB;
    await w.clock.advance(61_000);
    await until(() => w.handled.length === 3);
    w.controller.abort();
    w.jobs.forEach((j) => j.finish());
    await loop;
  });

  it("a cloud that hands over a run of a class with no free slot is refused locally; the run is not started", async () => {
    const w = world({ reading: { totalMemBytes: 16 * GIB, availMemBytes: 4 * GIB + 1 * GIB, cores: 16 }, obeysCapacity: false });
    const id = w.enqueue("executor");
    const loop = w.run();
    await until(() => w.log.some((e) => e.event === "refused"));
    expect(w.log.find((e) => e.event === "refused")).toEqual({ event: "refused", runId: id, reason: "class_full" });
    expect(w.handled).toEqual([]);
    w.controller.abort();
    await loop;
  });
});

describe("the progress floor in the loop", () => {
  it("tight memory with nothing in hand: exactly one light run is claimed, then no more until it ends", async () => {
    const w = world({ reading: { totalMemBytes: 16 * GIB, availMemBytes: 1 * GIB, cores: 16 } });
    for (let i = 0; i < 3; i++) w.enqueue("code-reviewer");
    w.enqueue("executor");
    const loop = w.run();
    await until(() => w.inHand() === 1);
    await w.clock.advance(1000);
    expect(w.inHand()).toBe(1);
    expect(w.queue).toHaveLength(3);
    expect(w.declared[0]).toMatchObject({ light: { limit: 1, in_use: 0 }, heavy: { limit: 0, in_use: 0 }, limited_by: null });
    expect(w.declared.at(-1)).toMatchObject({ light: { limit: 1, in_use: 1 }, limited_by: "memory" });
    // The job ends: nothing in hand again, so the floor lets the next light run in (the heavy one is not offered).
    w.jobs[0]!.finish();
    await until(() => w.handled.length === 2);
    expect(w.jobs[1]!.role).toBe("code-reviewer");
    w.controller.abort();
    w.jobs.forEach((j) => j.finish());
    await loop;
  });
});

describe("the loop around the jobs", () => {
  it("one job failing costs a backoff and leaves the others running", async () => {
    const w = world();
    w.enqueue("code-reviewer");
    w.enqueue("code-reviewer");
    const loop = w.run();
    await until(() => w.inHand() === 2);
    w.jobs[0]!.fail();
    await until(() => w.log.some((e) => e.event === "job_error"));
    await w.clock.advance(6000);
    expect(w.jobs[1]!.settled).toBe(false);
    expect(w.clock.slept).toContain(5000);
    w.controller.abort();
    w.jobs[1]!.finish();
    await loop;
  });

  it("a stop signal returns only after every run in hand has ended", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.enqueue("code-reviewer");
    const loop = w.run();
    await until(() => w.inHand() === 3);
    let returned = false;
    void loop.then(() => (returned = true));
    w.controller.abort();
    await w.clock.advance(1000);
    expect(returned).toBe(false);
    w.jobs[0]!.finish();
    w.jobs[1]!.finish();
    await w.clock.advance(1000);
    expect(returned).toBe(false);
    w.jobs[2]!.finish();
    expect(await loop).toBe("stopped");
  });

  it("self-update's step runs only when no run is in hand: not while any one is, and again when the last ends", async () => {
    const w = world();
    let steps = 0;
    w.enqueue("code-reviewer");
    w.enqueue("code-reviewer");
    const loop = w.run({ betweenJobs: async () => (steps++, undefined) });
    await until(() => w.inHand() === 2);
    const atStart = steps;
    // The loop passes the top of its cycle again (a job ends, the claim loop wakes) while the other job is still in hand.
    w.jobs[0]!.finish();
    await w.clock.advance(5000);
    expect(steps).toBe(atStart);
    w.jobs[1]!.finish();
    await until(() => steps > atStart);
    w.controller.abort();
    await loop;
  });
});

describe("waits the cloud asked for (review round 1)", () => {
  /** A scripted cloud: each claim takes the next reply; when they run out the loop is stopped. */
  function scripted(replies: ClaimResult[], withAdmission: boolean) {
    const clock = manualClock();
    const controller = new AbortController();
    const claimAt: number[] = [];
    const t0 = clock.now().getTime();
    let release!: () => void;
    const jobDone = new Promise<void>((resolve) => (release = resolve));
    const admission = createAdmission({
      probe: { read: () => ({ totalMemBytes: 64 * GIB, availMemBytes: 60 * GIB, load1: 0, cores: 32, freeDiskBytes: 500 * GIB }) },
      footprints: createFootprintStore(dir),
      settings: () => ({ ...DEFAULT_SETTINGS }),
      paused: () => false,
      now: () => clock.now().getTime(),
      every: () => () => undefined,
    });
    let step = 0;
    const client = {
      async claim(): Promise<ClaimResult> {
        claimAt.push(clock.now().getTime() - t0);
        const next = replies[step++];
        if (next === undefined) {
          controller.abort();
          return { kind: "idle", retryAfter: 1 };
        }
        return next;
      },
    };
    const signed = signedJob({ role: "code-reviewer" as never });
    const job: ClaimResult = { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };
    return { clock, claimAt, release, jobDone, job, admission: withAdmission ? admission : undefined, client, controller };
  }

  it("a rate_limited answer is waited out in full even when a job ends meanwhile; an idle one is cut short", async () => {
    const r = scripted([], true);
    const replies: ClaimResult[] = [r.job, { kind: "rate_limited", retryAfter: 300 }, { kind: "idle", retryAfter: 300 }];
    let n = 0;
    const loop = pollLoop({ client: { claim: async () => { r.claimAt.push(r.clock.now().getTime()); return replies[n++] ?? (r.controller.abort(), { kind: "idle" as const, retryAfter: 1 }); } }, clock: r.clock, gate: OPEN_GATE, signal: r.controller.signal, onClaimed: () => r.jobDone, admission: r.admission!, random: () => 1 });
    await until(() => n === 2);
    const limitedAt = r.clock.now().getTime();
    await r.clock.advance(10_000);
    r.release();
    await r.clock.advance(100_000);
    // The job ended at +10 s, but no claim went out until the full 300 s had passed.
    expect(n).toBe(2);
    await r.clock.advance(190_000);
    await until(() => n >= 3);
    expect(r.claimAt[2]! - limitedAt).toBeGreaterThanOrEqual(300_000);
    r.controller.abort();
    await loop;
  });

  it("an idle answer is cut short by a job ending (control for the test above)", async () => {
    const r = scripted([], true);
    const replies: ClaimResult[] = [r.job, { kind: "idle", retryAfter: 300 }];
    let n = 0;
    const loop = pollLoop({ client: { claim: async () => ((n += 1), replies[n - 1] ?? (r.controller.abort(), { kind: "idle" as const, retryAfter: 1 })) }, clock: r.clock, gate: OPEN_GATE, signal: r.controller.signal, onClaimed: () => r.jobDone, admission: r.admission!, random: () => 1 });
    await until(() => n === 2);
    r.release();
    await until(() => n >= 3);
    // No time passed on the fake clock: the claim after the idle answer came because the job ended.
    expect(r.clock.slept).toContain(300_000);
    await loop;
  });

  it("without admission, a job's end sends the loop back to the top, so self-update gets its turn before the next claim", async () => {
    const r = scripted([], false);
    const order: string[] = [];
    const replies: ClaimResult[] = [r.job, { kind: "idle", retryAfter: 1 }];
    let n = 0;
    const loop = pollLoop({
      client: { claim: async () => (order.push("claim"), replies[n++] ?? (r.controller.abort(), { kind: "idle" as const, retryAfter: 1 })) },
      clock: r.clock,
      gate: OPEN_GATE,
      signal: r.controller.signal,
      onClaimed: () => r.jobDone,
      betweenJobs: async () => (order.push("update"), undefined),
      random: () => 1,
    });
    await until(() => order.length >= 2);
    r.release();
    await r.clock.advance(3000);
    await loop;
    // update, claim (the job), then after the job ends: update again before the next claim.
    expect(order.slice(0, 4)).toEqual(["update", "claim", "update", "claim"]);
  });
});
