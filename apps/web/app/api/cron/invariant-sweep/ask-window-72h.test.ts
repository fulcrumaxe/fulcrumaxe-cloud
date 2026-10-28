import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { MARKER_HORIZON_MS, SWEEP_SCHEDULE_MS, setPendingHooks } from "@fx/core/src/pendingWork";
import { raiseAskMarked } from "@fx/core/src/decisions/raiseAskMarked";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { COVER_MS, invariantSweepHandler } from "./handler";

/**
 * ASK-WIRE-1, long windows: a class-3 ask's default window is 72 hours, further out than a marker can be stored. The REAL raise marks it, the REAL
 * tick gate (readTickGate/finishTick, through the real handler) walks every cron slot against a fake of the runtime cache that expires entries, and the
 * worker answers like the database does (the ask is resolved by the first connection at or after its due time; `nextAskDueAt` is the due time while ahead).
 * The backstop is held off (last-connect refreshed before each call) so only the marker can open the gate: the worst case for latency.
 */
const SECRET = "test-cron-secret";
const SLOT = SWEEP_SCHEDULE_MS["invariant-sweep"];
const HOUR = 3_600_000;
const ASK_ID = "11111111-1111-4111-8111-111111111111";
const clock = { value: Math.floor(Date.parse("2026-10-10T12:00:00Z") / SLOT) * SLOT + 17_000 };
let region: FakeRegion;

function askClient(now: number, windowMinutes: number): PoolClient {
  return {
    async query(sql: string) {
      if (sql.includes("decision_ask_raise")) return { rows: [{ id: ASK_ID }] };
      return { rows: [{ due: new Date(now + windowMinutes * 60_000) }] };
    },
  } as unknown as PoolClient;
}

async function walk(windowMinutes: number) {
  const raisedAt = clock.value;
  const due = raisedAt + windowMinutes * 60_000;
  await raiseAskMarked(askClient(raisedAt, windowMinutes), {
    class: "human_over_the_loop", decisionType: "test_strategy_choice", workItemId: ASK_ID, runId: null, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    proposed: "a", rationale: "r", quotedInputs: [{ trust: "trusted", storedBody: "x" }], policy: { answerWindowMinutes: windowMinutes, onTimeout: "stop_and_flag" },
  } as never);
  await new Promise((r) => setTimeout(r, 20));
  const connects: Array<{ at: number; reason: string }> = [];
  let resolvedAt: number | null = null;
  const sweepInvariants = vi.fn(async () => {
    if (resolvedAt === null && clock.value >= due) resolvedAt = clock.value;
    return { checked: 0, raised: {}, failed: 0, nextAskDueAt: resolvedAt === null ? due : null };
  });
  const log = vi.fn((line: string) => {
    const g = JSON.parse(line) as { connected: boolean; reason: string };
    if (g.connected) connects.push({ at: clock.value, reason: g.reason });
  });
  const deps = { cronSecret: SECRET, getWorker: async () => ({ sweepInvariants }), log, sleep: async (ms: number) => { clock.value += ms; }, paused: () => false, now: () => clock.value };
  const req = () => new NextRequest("https://example.test/api/cron/invariant-sweep", { headers: { authorization: `Bearer ${SECRET}` } });
  const end = due + 2 * SLOT;
  for (let t = Math.floor(raisedAt / SLOT) * SLOT + SLOT; t <= end; t += SLOT) {
    clock.value = t;
    region.entries.set("lastrun:invariant-sweep", { json: JSON.stringify(t), expiresAt: t + 3_600_000 });
    await invariantSweepHandler(req(), deps as never);
  }
  return { raisedAt, due, resolvedAt, connects };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock.value);
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
});
afterEach(() => {
  setPendingHooks(null);
  vi.useRealTimers();
});

describe("invariant sweep: ask windows longer than a marker can be stored", () => {
  it("a 72 hour window is resolved by the first connection within one slot after it ends, at the price of one extra wake (a burst inside the cover window)", async () => {
    const { raisedAt, due, resolvedAt, connects } = await walk(72 * 60);
    expect(resolvedAt).not.toBeNull();
    expect(resolvedAt! - due).toBeGreaterThanOrEqual(0);
    expect(resolvedAt! - due).toBeLessThanOrEqual(SLOT);
    // Before the due time only ONE burst connects: the horizon tick. The handler keeps a fired marker alive for COVER_MS (it cannot tell an ask's marker from a
    // run completion's), so that one wake is a few passes in a row inside COVER_MS, exactly what a due ask's own marker costs; then the marker is re-armed to the real due time.
    const early = connects.filter((c) => c.at < due);
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThanOrEqual(2 * Math.ceil(COVER_MS / SLOT) + 2);
    expect(early.every((c) => c.reason === "marker")).toBe(true);
    expect(early[early.length - 1]!.at - early[0]!.at).toBeLessThanOrEqual(COVER_MS + SLOT);
    expect(early[0]!.at - raisedAt).toBeLessThanOrEqual(MARKER_HORIZON_MS + SLOT);
    expect(early[0]!.at - raisedAt).toBeGreaterThanOrEqual(MARKER_HORIZON_MS - HOUR);
    // After resolving, only the cover burst follows, then the marker is cleared.
    expect(connects.filter((c) => c.at > resolvedAt! + COVER_MS + SLOT)).toHaveLength(0);
  });

  it("a window inside the horizon costs no extra wake", async () => {
    const { due, resolvedAt, connects } = await walk(24 * 60);
    expect(resolvedAt! - due).toBeLessThanOrEqual(SLOT);
    expect(connects.filter((c) => c.at < due)).toHaveLength(0);
  });
});
