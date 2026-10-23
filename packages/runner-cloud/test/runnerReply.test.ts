import { describe, expect, it } from "vitest";
import { checkStatusOf, ignoredWork, lastRequestAt, runnerReplyOf, RUNNER_CHECK_REPLY_MS, RUNNER_WORK_REPLY_MS } from "../src/runnerReply.js";
import { classifyRunner } from "../src/readModel.js";

/** D#6 RUNNER-PING: the pure rules, on a fake clock. */
const T = 1_800_000_000_000;
const s = (n: number): number => T + n * 1000;
const work = (o: Partial<Parameters<typeof ignoredWork>[0]>) => ignoredWork({ wakeCapable: true, sandboxDown: false, heardAt: s(-600), epoch: null, first: null, now: s(0), ...o });

describe("checkStatusOf", () => {
  it("is null with no check, or one stamped in the future (a clock that disagrees is not believed)", () => {
    expect(checkStatusOf(null, s(-5), s(0))).toBeNull();
    expect(checkStatusOf(s(10), s(-5), s(0))).toBeNull();
  });
  it("checking up to 60 s, then no reply; answered as soon as the runner is heard at or after the send", () => {
    expect(RUNNER_CHECK_REPLY_MS).toBe(60_000);
    expect(checkStatusOf(s(0), s(-5), s(59))).toBe("checking");
    expect(checkStatusOf(s(0), s(-5), s(60))).toBe("no_reply");
    expect(checkStatusOf(s(0), s(0), s(5))).toBe("answered");
    expect(checkStatusOf(s(0), s(30), s(3000))).toBe("answered");
    expect(checkStatusOf(s(0), null, s(61))).toBe("no_reply");
  });
});

describe("ignoredWork", () => {
  it("no work ever marked (idle) never flags, however long the runner is quiet", () => {
    for (const quiet of [0, 90, 1800, 2099]) expect(work({ heardAt: s(-quiet), now: s(0) })).toBe(false);
  });
  it("a bump the runner has not answered flips at exactly 90 s, not before", () => {
    expect(RUNNER_WORK_REPLY_MS).toBe(90_000);
    expect(work({ epoch: s(-89), first: s(-89) })).toBe(false);
    expect(work({ epoch: s(-90), first: s(-90) })).toBe(true);
  });
  it("a runner heard after the bump has answered it", () => {
    expect(work({ epoch: s(-300), first: s(-300), heardAt: s(-280) })).toBe(false);
  });
  it("uses the first bump of a run when the runner was quiet since before it, else the latest", () => {
    // bumps every 30 s: the latest is 15 s old, but the run began 105 s ago and the runner has said nothing since.
    expect(work({ epoch: s(-15), first: s(-105) })).toBe(true);
    // it answered the run's early bumps: only the latest counts, and that one is young.
    expect(work({ epoch: s(-15), first: s(-105), heardAt: s(-60) })).toBe(false);
  });
  it("an older runner, one whose sandbox is down, one never heard from, or an epoch from the future: never", () => {
    expect(work({ epoch: s(-300), wakeCapable: false })).toBe(false);
    expect(work({ epoch: s(-300), sandboxDown: true })).toBe(false);
    expect(work({ epoch: s(-300), heardAt: null })).toBe(false);
    expect(work({ epoch: s(30) })).toBe(false);
  });
});

describe("lastRequestAt", () => {
  it("is the later of the stamp and the last lease extension (90 s before the lease ends)", () => {
    expect(lastRequestAt(new Date(s(-600)), new Date(s(60)))).toBe(s(-30));
    expect(lastRequestAt(new Date(s(-10)), new Date(s(60)))).toBe(s(-10));
    expect(lastRequestAt(null, null)).toBeNull();
  });
});

describe("runnerReplyOf into the one state", () => {
  const hints = (o: { epoch?: number; first?: number; check?: number } = {}) => ({ epoch: o.epoch ?? null, first: o.first ?? null, checks: new Map(o.check === undefined ? [] : [["r1", o.check]]) });
  const state = (lastSeen: number, h: ReturnType<typeof hints>, now: number, wakeCapable = true) => {
    const reply = runnerReplyOf({ runnerId: "r1", wakeCapable, sandboxDown: false, lastSeenAt: new Date(lastSeen), leaseUntil: null, hints: h, now: new Date(now) });
    return { reply, state: classifyRunner({ revokedAt: null, protocolVersion: 3, lastSeenAt: new Date(lastSeen), busy: false, wakeCapable, noReply: reply.noReply }, new Date(now), 1) };
  };
  it("an older runner gets nothing from either path", () => {
    expect(state(s(-5), hints({ check: s(-100), epoch: s(-100) }), s(0), false)).toEqual({ reply: { check: null, noReply: null }, state: "online_idle" });
  });
  it("an unanswered check wins even past the wake window; ignored work only replaces online", () => {
    expect(state(s(-3000), hints({ check: s(-2500) }), s(0)).state).toBe("not_responding");
    expect(state(s(-3000), hints({ epoch: s(-2500) }), s(0)).state).toBe("offline");
    expect(state(s(-600), hints({ epoch: s(-100) }), s(0))).toMatchObject({ state: "not_responding", reply: { noReply: "work" } });
  });
  it("paused still wins over not responding", () => {
    const reply = runnerReplyOf({ runnerId: "r1", wakeCapable: true, sandboxDown: false, lastSeenAt: new Date(s(-600)), leaseUntil: null, hints: hints({ check: s(-100) }), now: new Date(s(0)) });
    expect(classifyRunner({ revokedAt: null, protocolVersion: 3, lastSeenAt: new Date(s(-600)), busy: false, paused: true, wakeCapable: true, noReply: reply.noReply }, new Date(s(0)), 1)).toBe("paused");
  });
});
