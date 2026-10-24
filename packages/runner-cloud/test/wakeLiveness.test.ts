import { describe, expect, it } from "vitest";
import { classifyRunner, lastHeardAt, lastHeardNote, type RunnerFacts } from "../src/readModel.js";
import { RUNNER_WAKE_CACHE_NAMESPACE, RUNNER_WAKE_LIVENESS_SECONDS, runnerSeenKey, runnerSeenReader, seenValueOf } from "../src/wakeSeen.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const ago = (s: number): Date => new Date(NOW.getTime() - s * 1000);
const base: RunnerFacts = { revokedAt: null, protocolVersion: 2, lastSeenAt: ago(10), busy: false };
const read = (facts: Partial<RunnerFacts>) => {
  const all = { ...base, ...facts };
  const state = classifyRunner(all, NOW, 1);
  return { state, note: lastHeardNote(state, all, NOW) };
};

describe("liveness: the ordinary 120-second window, either side", () => {
  it("a runner heard 120 s ago is online with no note; at 121 s an ordinary runner is offline", () => {
    expect(read({ lastSeenAt: ago(120) })).toEqual({ state: "online_idle", note: null });
    expect(read({ lastSeenAt: ago(121) })).toEqual({ state: "offline", note: null });
  });
  it("a wake-capable runner inside 120 s shows no note either", () => {
    expect(read({ lastSeenAt: ago(119), wakeCapable: true })).toEqual({ state: "online_idle", note: null });
  });
});

describe("liveness: a wake-capable runner between 120 s and 35 min reads online, \"Last heard N min ago\"", () => {
  it("just past 120 s it is still online and says when it was heard", () => {
    expect(read({ lastSeenAt: ago(121), wakeCapable: true })).toEqual({ state: "online_idle", note: "Last heard 2 min ago" });
  });
  it("one second inside 35 min it is online; one second past it is offline", () => {
    expect(RUNNER_WAKE_LIVENESS_SECONDS).toBe(2100);
    expect(read({ lastSeenAt: ago(2100), wakeCapable: true })).toEqual({ state: "online_idle", note: "Last heard 35 min ago" });
    expect(read({ lastSeenAt: ago(2099), wakeCapable: true })).toEqual({ state: "online_idle", note: "Last heard 34 min ago" });
    expect(read({ lastSeenAt: ago(2101), wakeCapable: true })).toEqual({ state: "offline", note: null });
  });
  it("a busy wake runner past 120 s keeps reading busy, with the note", () => {
    expect(read({ lastSeenAt: ago(600), wakeCapable: true, busy: true })).toEqual({ state: "busy", note: "Last heard 10 min ago" });
  });
  it("paused and draining still win over the online test, and carry no last-heard note", () => {
    expect(read({ lastSeenAt: ago(3000), wakeCapable: true, paused: true })).toEqual({ state: "paused", note: null });
  });
});

describe("liveness: the later of the database stamp and the cached wake check counts", () => {
  it("a cached check 30 s ago keeps an idle runner online with no note, whatever the database stamp says", () => {
    expect(read({ lastSeenAt: ago(1500), seenAt: ago(30), wakeCapable: true })).toEqual({ state: "online_idle", note: null });
    expect(read({ lastSeenAt: null, seenAt: ago(30) })).toEqual({ state: "online_idle", note: null });
  });
  it("an idle wake runner stays online for 2 hours with only slot claims and wake checks", () => {
    // Slot claims stamp the database every 30 min; the wake checks stamp the cache every minute. Sampled each minute for 2 hours.
    for (let minute = 0; minute <= 120; minute += 1) {
      const lastSlotClaim = Math.floor(minute / 30) * 30;
      const facts = { lastSeenAt: ago((minute - lastSlotClaim) * 60), seenAt: ago(40), wakeCapable: true };
      expect(read(facts).state).toBe("online_idle");
    }
  });
  it("with the cache empty (evicted), the database stamp from the last slot claim alone keeps it online inside 35 min", () => {
    expect(read({ lastSeenAt: ago(29 * 60), seenAt: null, wakeCapable: true })).toEqual({ state: "online_idle", note: "Last heard 29 min ago" });
  });
  it("an older cached check never hides a newer database stamp", () => {
    expect(lastHeardAt({ lastSeenAt: ago(5), seenAt: ago(500) })).toEqual(ago(5));
    expect(lastHeardAt({ lastSeenAt: ago(500), seenAt: ago(5) })).toEqual(ago(5));
    expect(lastHeardAt({ lastSeenAt: null, seenAt: null })).toBeNull();
  });
});

describe("wakeSeen: the cache entry both sides name", () => {
  it("the key and namespace are fixed", () => {
    expect(RUNNER_WAKE_CACHE_NAMESPACE).toBe("fx-runner-wake");
    expect(runnerSeenKey("44444444-4444-4444-8444-444444444444")).toBe("seen:44444444-4444-4444-8444-444444444444");
  });
  it("only a plausible millisecond time is taken; anything else is a miss", () => {
    expect(seenValueOf(NOW.getTime() - 1000, NOW)).toEqual(new Date(NOW.getTime() - 1000));
    for (const bad of [null, undefined, "1", 0, -5, 1.5, Number.NaN, NOW.getTime() + 10 * 60_000, { at: 1 }]) expect(seenValueOf(bad, NOW)).toBeNull();
  });
  it("the reader asks once per runner, skips misses and survives a store that throws", async () => {
    const asked: string[] = [];
    const store = {
      get: async (key: string) => {
        asked.push(key);
        if (key === "seen:b") throw new Error("cache down");
        if (key === "seen:a") return NOW.getTime() - 30_000;
        return null;
      },
    };
    const found = await runnerSeenReader(store)(["a", "b", "c", "a"], NOW);
    expect([...found.entries()]).toEqual([["a", new Date(NOW.getTime() - 30_000)]]);
    expect(asked.sort()).toEqual(["seen:a", "seen:b", "seen:c"]);
  });
});
