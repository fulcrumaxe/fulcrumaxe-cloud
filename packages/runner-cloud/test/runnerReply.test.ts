import { describe, expect, it } from "vitest";
import { checkStatusOf, lastRequestAt, runnerReplyOf, RUNNER_CHECK_REPLY_MS } from "../src/runnerReply.js";
import { classifyRunner } from "../src/readModel.js";

/** D#6 RUNNER-PING: the pure rules, on a fake clock. */
const T = 1_800_000_000_000;
const s = (n: number): number => T + n * 1000;

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

describe("lastRequestAt", () => {
  it("is the later of the stamp and the last lease extension (90 s before the lease ends)", () => {
    expect(lastRequestAt(new Date(s(-600)), new Date(s(60)))).toBe(s(-30));
    expect(lastRequestAt(new Date(s(-10)), new Date(s(60)))).toBe(s(-10));
    expect(lastRequestAt(null, null)).toBeNull();
  });
});

describe("runnerReplyOf into the one state", () => {
  const hints = (o: { check?: number } = {}) => ({ checks: new Map(o.check === undefined ? [] : [["r1", o.check]]) });
  const state = (lastSeen: number, h: ReturnType<typeof hints>, now: number, wakeCapable = true, ignoringWork = false) => {
    const reply = runnerReplyOf({ runnerId: "r1", wakeCapable, ignoringWork, lastSeenAt: new Date(lastSeen), leaseUntil: null, hints: h, now: new Date(now) });
    return { reply, state: classifyRunner({ revokedAt: null, protocolVersion: 3, lastSeenAt: new Date(lastSeen), busy: false, wakeCapable, noReply: reply.noReply }, new Date(now), 1) };
  };
  it("an older runner gets nothing from either path", () => {
    expect(state(s(-5), hints({ check: s(-100) }), s(0), false)).toEqual({ reply: { check: null, noReply: null }, state: "online_idle" });
  });
  it("an unanswered check wins even past the wake window; ignored work (the SQL rule's answer) only replaces online", () => {
    expect(state(s(-3000), hints({ check: s(-2500) }), s(0)).state).toBe("not_responding");
    expect(state(s(-3000), hints(), s(0), true, true).state).toBe("offline");
    expect(state(s(-600), hints(), s(0), true, true)).toMatchObject({ state: "not_responding", reply: { noReply: "work" } });
    expect(state(s(-600), hints(), s(0), true, false)).toMatchObject({ state: "online_idle", reply: { noReply: null } });
  });
  it("paused still wins over not responding", () => {
    const reply = runnerReplyOf({ runnerId: "r1", wakeCapable: true, ignoringWork: false, lastSeenAt: new Date(s(-600)), leaseUntil: null, hints: hints({ check: s(-100) }), now: new Date(s(0)) });
    expect(classifyRunner({ revokedAt: null, protocolVersion: 3, lastSeenAt: new Date(s(-600)), busy: false, paused: true, wakeCapable: true, noReply: reply.noReply }, new Date(s(0)), 1)).toBe("paused");
  });
});
