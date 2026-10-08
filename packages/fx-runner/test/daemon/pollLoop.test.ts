import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaimResult } from "../../src/daemon/client.js";
import { BACKOFF_MAX_SECONDS, abortOnSignals, pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import { filesUnder, PACKAGE_DIR } from "../helpers/srcFiles.js";
import { instantClock, manualClock } from "../helpers/manualClock.js";
import { signedJob } from "../helpers/signedJob.js";

const signed = signedJob();
const claimed: ClaimResult = { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };

/** Replies in order; when they run out the loop is told to stop. */
function rig(replies: Array<ClaimResult | (() => ClaimResult)>, clock: ReturnType<typeof instantClock> = instantClock()) {
  const controller = new AbortController();
  const log: PollEvent[] = [];
  let calls = 0;
  const client = {
    async claim(): Promise<ClaimResult> {
      const next = replies[calls++];
      if (next === undefined) {
        controller.abort();
        return { kind: "idle", retryAfter: 1 };
      }
      return typeof next === "function" ? next() : next;
    },
  };
  const handled: string[] = [];
  const run = (over: { onClaimed?: (c: unknown) => Promise<unknown>; random?: () => number } = {}) =>
    pollLoop({ client, clock, signal: controller.signal, onClaimed: over.onClaimed ?? (async (c) => void handled.push((c as { runId: string }).runId)), log: (e) => log.push(e), random: over.random ?? (() => 1) });
  return { run, clock, controller, log, handled, claims: () => calls };
}

describe("waiting", () => {
  it("an idle claim waits exactly the retry_after it was given, then claims again", async () => {
    const r = rig([{ kind: "idle", retryAfter: 60 }, { kind: "idle", retryAfter: 7 }]);
    expect(await r.run()).toBe("stopped");
    expect(r.clock.slept.slice(0, 2)).toEqual([60_000, 7_000]);
    expect(r.claims()).toBe(3);
  });

  it("a rate-limited claim waits its retry_after", async () => {
    const r = rig([{ kind: "rate_limited", retryAfter: 3 }]);
    await r.run();
    expect(r.clock.slept[0]).toBe(3_000);
    expect(r.log[0]).toEqual({ event: "rate_limited", waitSeconds: 3 });
  });

  it("after a claimed run the next claim follows at once, with no wait of the loop's own", async () => {
    const r = rig([claimed, { kind: "idle", retryAfter: 5 }]);
    await r.run();
    expect(r.handled).toEqual([signed.job.run_id]);
    expect(r.clock.slept[0]).toBe(5_000);
  });
});

describe("errors back off", () => {
  it("5 seconds, doubling, capped at 5 minutes, and a good reply starts over", async () => {
    const err: ClaimResult = { kind: "error", status: 502 };
    const r = rig([err, err, err, err, err, err, err, err, { kind: "idle", retryAfter: 1 }, err]);
    await r.run();
    expect(r.clock.slept.slice(0, 10)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 1, 5].map((s) => s * 1000));
    expect(BACKOFF_MAX_SECONDS).toBe(300);
  });

  it("jitter keeps the wait between half and the whole of the base", async () => {
    const r = rig([{ kind: "error", status: 0 }]);
    await r.run({ random: () => 0 });
    expect(r.clock.slept[0]).toBe(3_000);
    expect(r.log[0]).toEqual({ event: "error", status: 0, waitSeconds: 3 });
  });

  it("401 ends the loop at once, without waiting or claiming again", async () => {
    const r = rig([{ kind: "error", status: 401, code: "unauthorized" }, { kind: "idle", retryAfter: 1 }]);
    expect(await r.run()).toBe("unauthorized");
    expect(r.claims()).toBe(1);
    expect(r.clock.slept).toEqual([]);
  });

  it("a run that throws is logged as a closed code, and the loop pauses and goes on", async () => {
    const r = rig([claimed, { kind: "idle", retryAfter: 1 }]);
    await r.run({ onClaimed: async () => Promise.reject(new Error("secret job text")) });
    expect(r.log).toContainEqual({ event: "job_error" });
    expect(JSON.stringify(r.log)).not.toContain("secret");
    expect(r.clock.slept[0]).toBe(5_000);
    expect(r.claims()).toBe(3);
  });
});

describe("stopping", () => {
  it("a stop while waiting ends the wait and the loop", async () => {
    const r = rig([{ kind: "idle", retryAfter: 3600 }], manualClock());
    const done = r.run();
    await (r.clock as ReturnType<typeof manualClock>).advance(1_000);
    r.controller.abort();
    expect(await done).toBe("stopped");
  });

  it("a run claimed while the stop arrived is not started", async () => {
    const r = rig([() => (r.controller.abort(), claimed)]);
    expect(await r.run()).toBe("stopped");
    expect(r.handled).toEqual([]);
    expect(r.log).toEqual([{ event: "discarded", runId: signed.job.run_id }]);
  });

  it("SIGTERM and SIGINT abort the controller; removing the listeners makes them do nothing", () => {
    for (const name of ["SIGTERM", "SIGINT"] as const) {
      const source = new EventEmitter();
      const controller = new AbortController();
      abortOnSignals(controller, source as unknown as NodeJS.Process);
      expect(controller.signal.aborted).toBe(false);
      source.emit(name);
      expect(controller.signal.aborted, name).toBe(true);
    }
    const source = new EventEmitter();
    const controller = new AbortController();
    abortOnSignals(controller, source as unknown as NodeJS.Process)();
    source.emit("SIGTERM");
    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("the daemon only calls out", () => {
  const files = filesUnder(path.join(PACKAGE_DIR, "src", "daemon"));

  it("no daemon file imports a module that can listen, or calls listen", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'](?:node:)?(?:net|http|https|http2|tls|dgram)["']/);
      expect(text, file).not.toMatch(/\.listen\s*\(/);
    }
  });
});
