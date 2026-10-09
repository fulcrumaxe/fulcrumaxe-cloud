import { SANDBOX_UNAVAILABLE_REASONS } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { REPROBE_INTERVAL_MS, createSandboxGate } from "../../src/daemon/sandboxGate.js";
import { abortOnSignals, pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import type { ClaimResult } from "../../src/daemon/client.js";
import { SANDBOX_REASONS, type SandboxProbeResult } from "../../src/sandbox/probe.js";
import { manualClock } from "../helpers/manualClock.js";
import { signedJob } from "../helpers/signedJob.js";

const PASS: SandboxProbeResult = { ok: true, tool: "bubblewrap" };
const fail = (reason: (typeof SANDBOX_REASONS)[number]): SandboxProbeResult => ({ ok: false, reason, detail: "x" });

/** A probe whose answer the test sets, and which counts its runs. */
function rig(first: SandboxProbeResult | (() => never)) {
  const clock = manualClock();
  let answer: SandboxProbeResult | (() => never) = first;
  let runs = 0;
  const gate = createSandboxGate({
    now: clock.now,
    probe: async () => {
      runs += 1;
      if (typeof answer === "function") return answer();
      return answer;
    },
  });
  return { clock, gate, set: (a: SandboxProbeResult | (() => never)) => void (answer = a), runs: () => runs };
}

describe("the protocol and the probe agree on the reason codes", () => {
  it("the closed sets are the same five, in the same order", () => {
    expect([...SANDBOX_UNAVAILABLE_REASONS]).toEqual([...SANDBOX_REASONS]);
  });
});

describe("the claim gate", () => {
  it("probes at the first check, and each reason code closes the gate with exactly that code", async () => {
    for (const reason of SANDBOX_REASONS) {
      const r = rig(fail(reason));
      expect(await r.gate.check()).toEqual({ open: false, reason });
      expect(r.runs()).toBe(1);
    }
  });

  it("a pass opens it, and an open gate never probes again", async () => {
    const r = rig(PASS);
    expect(await r.gate.check()).toEqual({ open: true });
    await r.clock.advance(60 * 60_000, 10 * 60_000);
    expect(await r.gate.check()).toEqual({ open: true });
    expect(r.runs()).toBe(1);
  });

  it("while closed it probes again at most once every 5 minutes, however often it is asked", async () => {
    const r = rig(fail("bwrap_missing"));
    await r.gate.check();
    for (let i = 0; i < 20; i += 1) {
      await r.clock.advance(10_000, 10_000);
      expect(await r.gate.check()).toEqual({ open: false, reason: "bwrap_missing" });
    }
    expect(r.runs()).toBe(1);
    await r.clock.advance(REPROBE_INTERVAL_MS - 200_000 + 10_000, 10_000);
    await r.gate.check();
    expect(r.runs()).toBe(2);
    await r.gate.check();
    expect(r.runs()).toBe(2);
  });

  it("the transition: closed, then fixed, opens at the next probe without a restart; the reason can change while closed", async () => {
    const r = rig(fail("userns_disabled"));
    expect(await r.gate.check()).toEqual({ open: false, reason: "userns_disabled" });
    r.set(fail("socat_missing"));
    await r.clock.advance(REPROBE_INTERVAL_MS, 60_000);
    expect(await r.gate.check()).toEqual({ open: false, reason: "socat_missing" });
    r.set(PASS);
    expect(await r.gate.check()).toEqual({ open: false, reason: "socat_missing" });
    await r.clock.advance(REPROBE_INTERVAL_MS, 60_000);
    expect(await r.gate.check()).toEqual({ open: true });
  });

  it("fails closed: a probe that throws, or answers with something that is not a pass or a known reason, is probe_failed_other", async () => {
    const thrown = rig(() => {
      throw new Error("boom with /home/someone/secret");
    });
    expect(await thrown.gate.check()).toEqual({ open: false, reason: "probe_failed_other" });
    const odd = rig({ ok: false, reason: "made_up" as never, detail: "x" });
    expect(await odd.gate.check()).toEqual({ open: false, reason: "probe_failed_other" });
    const notBoolean = rig({ ok: "yes" as never, tool: "bubblewrap" });
    expect(await notBoolean.gate.check()).toEqual({ open: false, reason: "probe_failed_other" });
    const empty = rig(undefined as never);
    expect(await empty.gate.check()).toEqual({ open: false, reason: "probe_failed_other" });
  });
});

describe("the poll loop on a closed gate", () => {
  const signed = signedJob();
  const job: ClaimResult = { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };

  function loop(replies: ClaimResult[], gateRig: ReturnType<typeof rig>) {
    const controller = new AbortController();
    const seen: Array<string | undefined> = [];
    const handled: string[] = [];
    const log: PollEvent[] = [];
    let i = 0;
    const client = {
      async claim(reason?: string): Promise<ClaimResult> {
        seen.push(reason);
        const next = replies[i++];
        if (next === undefined) {
          controller.abort();
          return { kind: "idle", retryAfter: 1 };
        }
        return next;
      },
    };
    const run = () =>
      pollLoop({ client: client as never, clock: gateRig.clock, gate: gateRig.gate, signal: controller.signal, onClaimed: async (c) => void handled.push(c.runId), log: (e) => log.push(e), random: () => 1 });
    return { run, seen, handled, log, abortOnSignals };
  }

  it("an unavailable probe: every poll names the reason, no run is handed on, and the loop keeps waiting as told", async () => {
    const r = rig(fail("apparmor_userns_restricted"));
    const l = loop([{ kind: "idle", retryAfter: 60 }, { kind: "idle", retryAfter: 60 }, { kind: "rate_limited", retryAfter: 3 }], r);
    const done = l.run();
    await r.clock.advance(70_000, 1000);
    await r.clock.advance(70_000, 1000);
    await r.clock.advance(10_000, 1000);
    expect(await done).toBe("stopped");
    expect(l.seen.slice(0, 3)).toEqual(["apparmor_userns_restricted", "apparmor_userns_restricted", "apparmor_userns_restricted"]);
    expect(l.handled).toEqual([]);
    expect(l.log[0]).toEqual({ event: "sandbox_unavailable", reason: "apparmor_userns_restricted", waitSeconds: 60 });
    expect(l.log.every((e) => e.event !== "claimed")).toBe(true);
    expect(r.runs()).toBe(1);
  });

  it("a job that comes back on a status poll is discarded and never handed on (no fallback)", async () => {
    const r = rig(fail("bwrap_missing"));
    const l = loop([job], r);
    const done = l.run();
    await r.clock.advance(60_000, 1000);
    expect(await done).toBe("stopped");
    expect(l.handled).toEqual([]);
    expect(l.log[0]).toEqual({ event: "discarded", runId: signed.job.run_id });
  });

  it("an open gate: the poll is an ordinary claim (no reason) and the claimed run is handed on", async () => {
    const r = rig(PASS);
    const l = loop([job], r);
    expect(await l.run()).toBe("stopped");
    expect(l.seen[0]).toBeUndefined();
    expect(l.handled).toEqual([signed.job.run_id]);
  });

  it("the transition inside the loop: polls name the reason until the probe passes, then claims proceed without a restart", async () => {
    const r = rig(fail("userns_disabled"));
    const l = loop([{ kind: "idle", retryAfter: 200 }, { kind: "idle", retryAfter: 200 }, { kind: "idle", retryAfter: 200 }, job], r);
    const done = l.run();
    await r.clock.advance(100_000, 1000);
    r.set(PASS);
    await r.clock.advance(1_000_000, 5000);
    expect(await done).toBe("stopped");
    expect(l.seen.slice(0, 4)).toEqual(["userns_disabled", "userns_disabled", undefined, undefined]);
    expect(l.handled).toEqual([signed.job.run_id]);
  });
});
