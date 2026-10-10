import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobClassOfRole, type ClaimCapacity, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { createAdmission } from "../../src/daemon/admission.js";
import type { ClaimResult, Claimed } from "../../src/daemon/client.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_BLOCK_MS, DEFAULT_WARNING_MS, MAX_BLOCK_MS, MAX_JITTER_MS, createUsageGate } from "../../src/daemon/usageGate.js";
import { DEFAULT_SETTINGS } from "../../src/runnerSettings.js";
import { manualClock, until } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "c436-gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const limitEvent = (resetAt?: number): LocalOnlyEvent => ({ seq: 0, ts: new Date(T0).toISOString(), type: "usage_limit_reached", ...(resetAt === undefined ? {} : { reset_at: new Date(resetAt).toISOString() }) });

describe("the usage gate on its own", () => {
  const gateAt = (now: { ms: number }, over: { mode?: "subscription" | "api_key"; random?: number } = {}) => createUsageGate({ credentialMode: over.mode ?? "subscription", now: () => now.ms, random: () => over.random ?? 0 });

  it("blocks from the limit event until reset_at plus the jitter, then lets go by itself", () => {
    const now = { ms: T0 };
    const gate = gateAt(now, { random: 0.5 });
    expect(gate.state()).toEqual({ blocked: false, single: false });
    gate.observe(limitEvent(T0 + 600_000));
    const until = T0 + 600_000 + Math.floor(0.5 * MAX_JITTER_MS);
    now.ms = until - 1;
    expect(gate.state().blocked).toBe(true);
    now.ms = until;
    expect(gate.state().blocked).toBe(false);
  });

  it("holds for an hour when the event names no reset, cuts a time past a day to a day, and ignores a time already past", () => {
    const now = { ms: T0 };
    const gate = gateAt(now);
    gate.observe(limitEvent());
    now.ms = T0 + DEFAULT_BLOCK_MS - 1;
    expect(gate.state().blocked).toBe(true);
    now.ms = T0 + DEFAULT_BLOCK_MS;
    expect(gate.state().blocked).toBe(false);

    now.ms = T0;
    gate.observe(limitEvent(T0 + 5 * MAX_BLOCK_MS));
    now.ms = T0 + MAX_BLOCK_MS - 1;
    expect(gate.state().blocked).toBe(true);
    now.ms = T0 + MAX_BLOCK_MS;
    expect(gate.state().blocked).toBe(false);

    const past = gateAt({ ms: T0 });
    past.observe(limitEvent(T0 - 1000));
    expect(past.state().blocked).toBe(false);
  });

  it("a later report overwrites an earlier one, and an event of another type changes nothing", () => {
    const now = { ms: T0 };
    const gate = gateAt(now);
    gate.observe(limitEvent(T0 + 3_600_000));
    gate.observe(limitEvent(T0 + 60_000));
    now.ms = T0 + 60_000;
    expect(gate.state().blocked).toBe(false);
    gate.observe({ seq: 1, ts: new Date(T0).toISOString(), type: "usage", usage: { input: 1, output: 1 } });
    expect(gate.state().blocked).toBe(false);
  });

  it("an api_key runner is never held back, whatever it hears", () => {
    const gate = gateAt({ ms: T0 }, { mode: "api_key" });
    gate.observe(limitEvent(T0 + 600_000));
    gate.warn({});
    expect(gate.state()).toEqual({ blocked: false, single: false });
  });

  it("a warning holds the runner to one job until the reset it named, or for half an hour when it named none; a later one renews it", () => {
    const now = { ms: T0 };
    const gate = gateAt(now);
    gate.warn({});
    now.ms = T0 + DEFAULT_WARNING_MS - 1;
    expect(gate.state()).toEqual({ blocked: false, single: true });
    now.ms = T0 + DEFAULT_WARNING_MS;
    expect(gate.state().single).toBe(false);

    now.ms = T0;
    gate.warn({ resetsAtMs: T0 + 2 * DEFAULT_WARNING_MS });
    now.ms = T0 + 2 * DEFAULT_WARNING_MS - 1;
    expect(gate.state().single).toBe(true);
    // A reset time already past counts as unnamed.
    const late = gateAt({ ms: T0 });
    late.warn({ resetsAtMs: T0 - 1 });
    expect(late.state().single).toBe(true);
  });
});

const idle = (): ResourceReading => ({ totalMemBytes: 64 * GIB, availMemBytes: 60 * GIB, load1: 0, cores: 32, freeDiskBytes: 500 * GIB });

function admissionWith(state: () => { blocked: boolean; single: boolean }, clock = { ms: T0 }) {
  return createAdmission({ probe: { read: idle }, footprints: createFootprintStore(dir), settings: () => ({ ...DEFAULT_SETTINGS }), paused: () => false, usage: state, now: () => clock.ms, every: () => () => undefined });
}
const claimedAs = (role: string): Claimed => {
  const signed = signedJob({ role: role as never });
  return { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };
};

describe("admission under the usage gate", () => {
  it("blocked: no slot in any class, the reason is the usage limit, and a job in hand keeps its place", () => {
    let state = { blocked: false, single: false };
    const admission = admissionWith(() => state);
    expect(admission.snapshot().free.light).toBeGreaterThan(0);
    const end = admission.begin(claimedAs("code-reviewer"));
    state = { blocked: true, single: false };
    const snap = admission.snapshot();
    expect(snap.free).toEqual({ light: 0, heavy: 0 });
    expect(snap.limitedBy).toBe("usage_limit");
    // What the cloud is told: no room beyond the job already running.
    expect(snap.capacity).toEqual({ light: { limit: 1, in_use: 1 }, heavy: { limit: 0, in_use: 0 }, limited_by: "usage_limit" });
    end();
    state = { blocked: false, single: false };
    expect(admission.snapshot().free.light).toBeGreaterThan(0);
  });

  it("blocked on an empty runner: the progress floor does not push one job through", () => {
    const admission = admissionWith(() => ({ blocked: true, single: false }));
    expect(admission.snapshot().free).toEqual({ light: 0, heavy: 0 });
  });

  it("the person's pause is named before the usage limit", () => {
    const admission = createAdmission({ probe: { read: idle }, footprints: createFootprintStore(dir), settings: () => ({ ...DEFAULT_SETTINGS }), paused: () => true, usage: () => ({ blocked: true, single: false }), now: () => T0, every: () => () => undefined });
    expect(admission.snapshot().limitedBy).toBe("paused");
  });

  it("near the limit: one job when none is in hand, none while one is, one again when it ends", () => {
    const admission = admissionWith(() => ({ blocked: false, single: true }));
    const empty = admission.snapshot();
    expect(empty.free).toEqual({ light: 1, heavy: 1 });
    const end = admission.begin(claimedAs("executor"));
    const busy = admission.snapshot();
    expect(busy.free).toEqual({ light: 0, heavy: 0 });
    expect(busy.limitedBy).toBe("usage_limit");
    end();
    expect(admission.snapshot().free).toEqual({ light: 1, heavy: 1 });
  });
});

/**
 * The real claim loop against a fake cloud that obeys the capacity a claim declares. A job tells the gate about its limit as the daemon's
 * event tap does, and the gate is read by the real admission.
 */
describe("the claim loop under a usage limit", () => {
  function world(mode: "subscription" | "api_key") {
    const clock = manualClock(T0);
    const controller = new AbortController();
    const gate = createUsageGate({ credentialMode: mode, now: () => clock.now().getTime(), random: () => 0 });
    const queue: Claimed[] = [];
    const declared: Array<ClaimCapacity | undefined> = [];
    const taken: string[] = [];
    const running: Array<{ id: string; finish: () => void }> = [];
    const enqueue = (role: string): void => void queue.push(claimedAs(role));
    const client = {
      async claim(_sandbox?: unknown, capacity?: ClaimCapacity): Promise<ClaimResult> {
        declared.push(capacity);
        const index = queue.findIndex((job) => capacity !== undefined && capacity[jobClassOfRole(job.signedJob.job.role)].limit - capacity[jobClassOfRole(job.signedJob.job.role)].in_use > 0);
        return index === -1 ? { kind: "idle", retryAfter: 60 } : queue.splice(index, 1)[0]!;
      },
    };
    const admission = createAdmission({ probe: { read: idle }, footprints: createFootprintStore(dir), settings: () => ({ ...DEFAULT_SETTINGS }), paused: () => false, usage: () => gate.state(), now: () => clock.now().getTime(), every: () => () => undefined });
    const onClaimed = (claimed: Claimed): Promise<unknown> =>
      new Promise<void>((resolve) => {
        taken.push(claimed.runId);
        running.push({ id: claimed.runId, finish: resolve });
      });
    const loop = pollLoop({ client, clock, gate: OPEN_GATE, signal: controller.signal, onClaimed, admission, random: () => 1 });
    return { clock, controller, gate, enqueue, declared, taken, running, loop, stop: async () => (controller.abort(), running.forEach((job) => job.finish()), loop) };
  }

  it("after one job reports the limit, nothing more is claimed until reset_at; the other job carries on; claiming resumes after", async () => {
    const w = world("subscription");
    w.enqueue("code-reviewer");
    w.enqueue("security-reviewer");
    await until(() => w.taken.length === 2);
    // The first job hits the limit: the daemon's event tap tells the gate. The reset is ten minutes away.
    w.gate.observe(limitEvent(T0 + 600_000));
    w.running[0]!.finish();
    w.enqueue("debater");
    w.enqueue("executor");
    await w.clock.advance(300_000, 5000);
    expect(w.taken).toHaveLength(2);
    // The second job was never stopped by the first one's limit, and the claims said there was no room (and why).
    expect(w.running[1]!.id).toBe(w.taken[1]);
    expect(w.declared.at(-1)).toMatchObject({ light: { limit: 1, in_use: 1 }, heavy: { limit: 0, in_use: 0 }, limited_by: "usage_limit" });
    await w.clock.advance(400_000, 5000);
    await until(() => w.taken.length === 4);
    await w.stop();
  });

  it("an api_key runner is not paused by the same report", async () => {
    const w = world("api_key");
    w.enqueue("code-reviewer");
    await until(() => w.taken.length === 1);
    w.gate.observe(limitEvent(T0 + 600_000));
    w.enqueue("debater");
    w.enqueue("executor");
    await w.clock.advance(120_000, 5000);
    await until(() => w.taken.length === 3);
    expect(w.declared.every((c) => c?.limited_by !== "usage_limit")).toBe(true);
    await w.stop();
  });

  it("near the limit the runner claims only with no job in hand, until the reported reset", async () => {
    const w = world("subscription");
    w.gate.warn({ resetsAtMs: T0 + 600_000 });
    w.enqueue("code-reviewer");
    w.enqueue("code-reviewer");
    await until(() => w.taken.length === 1);
    await w.clock.advance(120_000, 5000);
    expect(w.taken).toHaveLength(1);
    // The one job ends: the next is taken, still one at a time.
    w.running[0]!.finish();
    await until(() => w.taken.length === 2);
    w.enqueue("debater");
    w.enqueue("debater");
    // The reset passes: back to several at once.
    await w.clock.advance(600_000, 5000);
    await until(() => w.taken.length === 4);
    await w.stop();
  });
});
