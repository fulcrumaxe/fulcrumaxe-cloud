import { describe, expect, it } from "vitest";
import type { Admission } from "../../src/daemon/admission.js";
import type { ClaimResult } from "../../src/daemon/client.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { instantClock } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";

/** D#845 ON-8c: the poll loop starts a machine job beside the loop when a claim reply says `machine_job`, never awaits it on the poll path, and ends only after it. */
const run = signedJob();
/** A machine with room for anything: the production loop always has an admission, and with one it keeps claiming while a job is in hand. */
const ROOMY = {
  snapshot: () => ({ capacity: { light: 5, heavy: 5 }, limits: { light: null, heavy: null }, free: { light: 5, heavy: 5 }, limitedBy: null, usageNear: false }),
  classOf: () => "light",
  begin: () => () => undefined,
  sample: () => undefined,
} as unknown as Admission;
function rig(replies: ClaimResult[], onMachineJob?: () => Promise<"handled" | "none">, over: { draining?: () => boolean } = {}) {
  const controller = new AbortController();
  let calls = 0;
  const client = {
    async claim(): Promise<ClaimResult> {
      const next = replies[calls++];
      if (next === undefined) {
        controller.abort();
        return { kind: "idle", retryAfter: 1 };
      }
      return next;
    },
  };
  const go = () => pollLoop({ client, clock: instantClock(), gate: OPEN_GATE, admission: ROOMY, signal: controller.signal, onClaimed: async () => undefined, ...(onMachineJob === undefined ? {} : { onMachineJob }), ...(over.draining === undefined ? {} : { draining: over.draining }), random: () => 0 });
  return { go, claims: () => calls };
}

describe("machine_job on a claim reply", () => {
  it("an idle answer with the flag starts the handler, and the loop is not held up by it: it claims again while the job runs", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const r = rig([{ kind: "idle", retryAfter: 1, machineJob: true }, { kind: "idle", retryAfter: 1 }], async () => {
      started++;
      await held;
      return "handled";
    });
    const ended = r.go();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    // both replies were taken and the loop is waiting out its stop, not the job
    expect(r.claims()).toBeGreaterThanOrEqual(2);
    let done = false;
    void ended.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false); // it does not end under the job in hand
    release();
    expect(await ended).toBe("stopped");
  });

  it("a flag again while the job is in hand starts nothing more: one machine job at a time", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const r = rig([{ kind: "idle", retryAfter: 1, machineJob: true }, { kind: "idle", retryAfter: 1, machineJob: true }, { kind: "idle", retryAfter: 1, machineJob: true }], async () => {
      started++;
      await held;
      return "handled";
    });
    const ended = r.go();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toBe(1);
    release();
    await ended;
    expect(started).toBe(1);
  });

  it("a claimed run that carries the flag starts the job beside the run", async () => {
    let started = 0;
    const r = rig([{ kind: "claimed", signedJob: run, runId: run.job.run_id, leaseGeneration: 1, machineJob: true }], async () => (started++, "handled" as const));
    await r.go();
    expect(started).toBe(1);
  });

  it("no flag, no handler wired, or a runner told to drain: nothing is started", async () => {
    let started = 0;
    const handler = async () => (started++, "handled" as const);
    await rig([{ kind: "idle", retryAfter: 1 }], handler).go();
    await rig([{ kind: "idle", retryAfter: 1, machineJob: true }]).go();
    await rig([{ kind: "idle", retryAfter: 1, machineJob: true }], handler, { draining: () => true }).go();
    expect(started).toBe(0);
  });

  it("a handler that throws costs a pause, not the loop", async () => {
    const r = rig([{ kind: "idle", retryAfter: 1, machineJob: true }], async () => {
      throw new Error("x");
    });
    expect(await r.go()).toBe("stopped");
  });
});
