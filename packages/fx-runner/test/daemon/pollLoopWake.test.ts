import { describe, expect, it } from "vitest";
import type { WakeGrant } from "@fulcrumaxe/runner-protocol";
import type { ClaimResult, WakeResult } from "../../src/daemon/client.js";
import { pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import { WAKE_SLOT_MS, WakeTracker } from "../../src/daemon/wake.js";
import { manualClock } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";

/**
 * D#6 RUNNER-WAKE: the claim loop of a runner that holds a wake grant, on a fake clock. The cloud's idle answer is 1800 s (what it gives a
 * wake-capable runner); the wake route is a fake that answers `{epoch, due_at}` or fails as the test says.
 */
const T0 = Date.parse("2026-10-23T12:00:00.000Z");
const MIN = 60_000;
const grant = (n = 0): WakeGrant => ({ token: `t${n}.${"b".repeat(43)}`, poll_s: 20, transport: "poll" });

async function rig(over: { retryAfter?: number; claimGrant?: () => WakeGrant | undefined } = {}) {
  const clock = manualClock(T0);
  const controller = new AbortController();
  const claimsAt: number[] = [];
  const checksAt: number[] = [];
  const tokens: string[] = [];
  const log: PollEvent[] = [];
  const cloud = { epoch: 1000, dueAt: null as number | null, failing: false };
  let minted = 0;
  const client = {
    async claim(): Promise<ClaimResult> {
      claimsAt.push(clock.now().getTime());
      const wake = over.claimGrant ? over.claimGrant() : grant(++minted);
      return { kind: "idle", retryAfter: over.retryAfter ?? 1800, ...(wake === undefined ? {} : { wake }) };
    },
    async wake(token: string): Promise<WakeResult> {
      checksAt.push(clock.now().getTime());
      tokens.push(token);
      return cloud.failing ? { kind: "error", status: 503 } : { kind: "wake", epoch: cloud.epoch, dueAt: cloud.dueAt };
    },
  };
  const wake = new WakeTracker(grant(0));
  const done = pollLoop({ client, clock, gate: OPEN_GATE, signal: controller.signal, wake, onClaimed: async () => undefined, log: (e) => log.push(e), random: () => 0 });
  const stop = async () => {
    controller.abort();
    return done;
  };
  // Let the loop make its first claim at T0, before the test moves the clock.
  for (let i = 0; i < 5 && claimsAt.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return { clock, cloud, claimsAt, checksAt, tokens, log, wake, stop };
}

/** Claims after the start-up pair (the first claim, and the one the first check makes with no epoch to go by). */
const steady = (claimsAt: number[]) => claimsAt.slice(2);

describe("an idle wake-capable runner", () => {
  it("claims at start, once more on its first check, then only at slot boundaries while the epoch stays the same: 2 hours, 4 slot claims", async () => {
    const r = await rig();
    await r.clock.advance(2 * 60 * MIN);
    expect(r.claimsAt.slice(0, 2)).toEqual([T0, T0 + 20_000]);
    expect(steady(r.claimsAt)).toEqual([T0 + 30 * MIN, T0 + 60 * MIN, T0 + 90 * MIN, T0 + 120 * MIN]);
    for (const at of steady(r.claimsAt)) expect(at % WAKE_SLOT_MS).toBeLessThan(2 * MIN);
    // It checked every 20 s in between (a slot claim restarts the 20 s), about 3 a minute, and none of those checks claimed.
    expect(r.checksAt.length).toBeGreaterThan(340);
    expect(r.checksAt.every((at, i) => i === 0 || at - r.checksAt[i - 1]! <= 20_000 || r.claimsAt.some((c) => c > r.checksAt[i - 1]! && c < at))).toBe(true);
    expect(await r.stop()).toBe("stopped");
  });

  it("claims within one poll of an epoch bump, and not again until the next bump or slot", async () => {
    const r = await rig();
    await r.clock.advance(10 * MIN);
    const before = r.claimsAt.length;
    r.cloud.epoch = 2000;
    const bumpedAt = r.clock.now().getTime();
    await r.clock.advance(20_000);
    expect(r.claimsAt.length).toBe(before + 1);
    expect(r.claimsAt.at(-1)! - bumpedAt).toBeLessThanOrEqual(20_000);
    expect(r.log).toContainEqual({ event: "wake_claim", reason: "epoch" });
    await r.clock.advance(10 * MIN);
    expect(r.claimsAt.length).toBe(before + 1);
    await r.stop();
  });

  it("claims when a due time passes, once, with the epoch unchanged", async () => {
    const r = await rig();
    await r.clock.advance(5 * MIN);
    const before = r.claimsAt.length;
    r.cloud.dueAt = T0 + 15 * MIN;
    await r.clock.advance(10 * MIN - 1000);
    expect(r.claimsAt.length).toBe(before);
    await r.clock.advance(21_000);
    expect(r.claimsAt.length).toBe(before + 1);
    expect(r.claimsAt.at(-1)!).toBeGreaterThanOrEqual(T0 + 15 * MIN);
    expect(r.claimsAt.at(-1)! - (T0 + 15 * MIN)).toBeLessThanOrEqual(20_000);
    expect(r.log).toContainEqual({ event: "wake_claim", reason: "due" });
    await r.clock.advance(10 * MIN);
    expect(r.claimsAt.length).toBe(before + 1);
    await r.stop();
  });

  it("uses the token of the latest claim reply for its checks", async () => {
    const r = await rig();
    await r.clock.advance(MIN);
    expect(r.tokens[0]).toBe(grant(1).token);
    expect(r.tokens.at(-1)).toBe(grant(2).token);
    await r.stop();
  });
});

describe("wake failures", () => {
  it("after 3 failures in a row it claims at once, and a claim that brings a grant puts it back on checks", async () => {
    const r = await rig();
    await r.clock.advance(5 * MIN);
    const before = r.claimsAt.length;
    r.cloud.failing = true;
    const failedFrom = r.checksAt.length;
    await r.clock.advance(40_000);
    expect(r.claimsAt.length).toBe(before); // two failures: no claim yet
    await r.clock.advance(20_000);
    expect(r.checksAt.length - failedFrom).toBe(3);
    expect(r.claimsAt.length).toBe(before + 1); // the third failure claims at once
    expect(r.claimsAt.at(-1)).toBe(r.checksAt.at(-1));
    expect(r.log.filter((e) => e.event === "wake_fallback")).toHaveLength(1);
    // The claim brought a grant: checks again, and a working check with the same epoch claims nothing more.
    r.cloud.failing = false;
    await r.clock.advance(10 * MIN);
    expect(r.claimsAt.length).toBe(before + 1);
    expect(r.wake.state()).toEqual({ tier: "poll", failures: 0, holdsGrant: true });
    await r.stop();
  });

  it("while fallen back with claims that bring no grant it claims every 60 s, until one brings a grant", async () => {
    let grants = true;
    const r = await rig({ claimGrant: () => (grants ? grant(9) : undefined) });
    await r.clock.advance(MIN);
    r.cloud.failing = true;
    grants = false;
    await r.clock.advance(MIN);
    const fellBackAt = r.claimsAt.at(-1)!;
    expect(r.wake.state().tier).toBe("claim");
    await r.clock.advance(3 * MIN);
    const after = r.claimsAt.filter((at) => at > fellBackAt);
    expect(after).toEqual([fellBackAt + MIN, fellBackAt + 2 * MIN, fellBackAt + 3 * MIN]);
    const checksWhileFallen = r.checksAt.filter((at) => at > fellBackAt).length;
    expect(checksWhileFallen).toBe(0);
    // Recovery: the cloud answers again and a claim brings a grant.
    r.cloud.failing = false;
    grants = true;
    await r.clock.advance(MIN);
    expect(r.wake.state()).toEqual({ tier: "poll", failures: 0, holdsGrant: true });
    const recoveredAt = r.claimsAt.at(-1)!;
    await r.clock.advance(10 * MIN);
    expect(r.claimsAt.filter((at) => at > recoveredAt).length).toBeLessThanOrEqual(1); // at most the one check with a new baseline
    expect(r.checksAt.filter((at) => at > recoveredAt).length).toBeGreaterThan(20);
    await r.stop();
  });
});

describe("no grant held (an older cloud, or one with no wake key)", () => {
  it("waits the cloud's retry_after exactly, with no wake check", async () => {
    const r = await rig({ retryAfter: 60, claimGrant: () => undefined });
    await r.clock.advance(5 * MIN);
    expect(r.claimsAt).toEqual([0, 1, 2, 3, 4, 5].map((n) => T0 + n * MIN));
    expect(r.checksAt).toEqual([]);
    await r.stop();
  });
});
