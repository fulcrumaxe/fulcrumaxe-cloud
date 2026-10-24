import { describe, expect, it } from "vitest";
import { WAKE_FAILURES_BEFORE_FALLBACK, WAKE_SLOT_MS, WakeTracker, decideClaim, parseWakeReply, safetyClaimAt } from "../../src/daemon/wake.js";

const T0 = Date.parse("2026-10-23T12:00:00.000Z");
const grant = (token = "aaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", transport = "poll") => ({ token, poll_s: 20, transport });

describe("decideClaim: a pure function of what was seen, what the last claim knew, and the time", () => {
  it("claims on the first check after a claim that had no epoch to go by", () => {
    expect(decideClaim({ epoch: 5, dueAt: null }, { epoch: null, dueAt: null }, T0)).toEqual({ claim: true, reason: "no_baseline" });
  });
  it("does not claim while the epoch is the one the last claim saw", () => {
    expect(decideClaim({ epoch: 5, dueAt: null }, { epoch: 5, dueAt: null }, T0)).toEqual({ claim: false });
  });
  it("claims when the epoch moved, either way (a reset cache counts as moved)", () => {
    expect(decideClaim({ epoch: 6, dueAt: null }, { epoch: 5, dueAt: null }, T0)).toEqual({ claim: true, reason: "epoch" });
    expect(decideClaim({ epoch: 0, dueAt: null }, { epoch: 5, dueAt: null }, T0)).toEqual({ claim: true, reason: "epoch" });
  });
  it("claims once a due time has passed, and not again for the same due time", () => {
    expect(decideClaim({ epoch: 5, dueAt: T0 + 1 }, { epoch: 5, dueAt: null }, T0)).toEqual({ claim: false });
    expect(decideClaim({ epoch: 5, dueAt: T0 }, { epoch: 5, dueAt: null }, T0)).toEqual({ claim: true, reason: "due" });
    expect(decideClaim({ epoch: 5, dueAt: T0 }, { epoch: 5, dueAt: T0 }, T0 + 60_000)).toEqual({ claim: false });
  });
});

describe("safetyClaimAt: the cloud's retry_after, lined up to the 30-minute slot when it is longer than a minute", () => {
  const none = () => 0;
  it("keeps a minute or less exactly (today's idle answer, a queued answer, the throttle)", () => {
    expect(safetyClaimAt(T0 + 5_000, 60, () => 0.99)).toBe(T0 + 65_000);
    expect(safetyClaimAt(T0 + 5_000, 7, none)).toBe(T0 + 12_000);
  });
  it("moves a long wait earlier to the slot boundary inside it, never later than asked", () => {
    expect(safetyClaimAt(T0 + 7 * 60_000, 1800, none)).toBe(T0 + WAKE_SLOT_MS);
    // The jitter spreads runners over the first two minutes of the slot, but never past the time the cloud asked for.
    expect(safetyClaimAt(T0 + 7 * 60_000, 1800, () => 0.5)).toBe(T0 + WAKE_SLOT_MS + 60_000);
    expect(safetyClaimAt(T0 + 20_000, 1800, () => 0.99)).toBe(T0 + WAKE_SLOT_MS + 20_000);
  });
  it("keeps the asked time when no boundary falls inside the wait", () => {
    expect(safetyClaimAt(T0 + 60_000, 300, none)).toBe(T0 + 360_000);
  });
  it("lands every safety claim of a long run of idle answers inside the first two minutes of a slot", () => {
    let now = T0 + 13 * 60_000 + 7_000;
    for (let i = 0; i < 20; i += 1) {
      now = safetyClaimAt(now, 1800, Math.random);
      expect(now % WAKE_SLOT_MS).toBeLessThan(120_000);
    }
  });
});

describe("parseWakeReply: strict, exactly {epoch, due_at}", () => {
  it("takes the two numbers, due_at may be null", () => {
    expect(parseWakeReply({ epoch: 0, due_at: null })).toEqual({ epoch: 0, due_at: null });
    expect(parseWakeReply({ epoch: T0, due_at: T0 + 1 })).toEqual({ epoch: T0, due_at: T0 + 1 });
  });
  it("refuses anything else", () => {
    for (const bad of [null, [], "x", {}, { epoch: 1 }, { epoch: 1, due_at: null, run_id: "x" }, { epoch: -1, due_at: null }, { epoch: 1.5, due_at: null }, { epoch: "1", due_at: null }, { epoch: 1, due_at: "2" }]) {
      expect(parseWakeReply(bad)).toBeUndefined();
    }
  });
});

describe("WakeTracker: the tier state machine", () => {
  it("holds no grant until a hello or claim brings one, and a claim without one drops it", () => {
    const t = new WakeTracker();
    expect(t.mode()).toEqual({ kind: "none" });
    t.onHello(grant());
    expect(t.mode()).toMatchObject({ kind: "poll" });
    t.onClaim(undefined, T0);
    expect(t.mode()).toEqual({ kind: "none" });
  });
  it("refreshes the token from each claim", () => {
    const t = new WakeTracker(grant("a.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    t.onClaim(grant("c.ddddddddddddddddddddddddddddddddddddddddddd"), T0);
    expect(t.mode()).toEqual({ kind: "poll", grant: grant("c.ddddddddddddddddddddddddddddddddddddddddddd") });
  });
  it("treats a transport it does not know as poll", () => {
    const t = new WakeTracker(grant(undefined, "sse_v9"));
    expect(t.state().tier).toBe("poll");
    expect(t.mode()).toMatchObject({ kind: "poll" });
  });
  it("falls back after 3 failures in a row, not before, and a success in between starts the count again", () => {
    const t = new WakeTracker(grant());
    expect(WAKE_FAILURES_BEFORE_FALLBACK).toBe(3);
    expect(t.onWakeFailure()).toBe(false);
    expect(t.onWakeFailure()).toBe(false);
    t.onWake({ epoch: 1, dueAt: null }, T0);
    expect(t.onWakeFailure()).toBe(false);
    expect(t.onWakeFailure()).toBe(false);
    expect(t.onWakeFailure()).toBe(true);
    expect(t.mode()).toEqual({ kind: "fallback" });
    // A claim without a grant keeps the fallback; the first claim that brings one ends it.
    t.onClaim(undefined, T0);
    expect(t.mode()).toEqual({ kind: "fallback" });
    t.onClaim(grant(), T0);
    expect(t.mode()).toMatchObject({ kind: "poll" });
    expect(t.state()).toEqual({ tier: "poll", failures: 0, holdsGrant: true });
  });
  it("remembers the epoch and passed due time a claim covered", () => {
    const t = new WakeTracker(grant());
    expect(t.onWake({ epoch: 4, dueAt: T0 - 1 }, T0)).toMatchObject({ claim: true, reason: "no_baseline" });
    t.onClaim(grant(), T0);
    expect(t.onWake({ epoch: 4, dueAt: T0 - 1 }, T0 + 20_000)).toEqual({ claim: false });
    expect(t.onWake({ epoch: 9, dueAt: T0 - 1 }, T0 + 40_000)).toMatchObject({ claim: true, reason: "epoch" });
  });
});
