import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunLimit } from "../src/executionTarget.js";
import { SNAPSHOT_ID_WINDOW, createRunGuard, createUsageMeter, resolveRunLimits, type TokenTotals } from "../src/meteringGuard.js";
import {
  STATE_MAX_BYTES,
  buildReaderState,
  jsonbText,
  createSideEffects,
  mergeSideEffects,
  parseReaderState,
  parseSideEffects,
  recordExtension,
  restoreMeterLedger,
  snapshotMeterLedger,
  type MeterLedger,
  type SideEffects,
} from "../src/readerState.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const u = (inputTokens: number, outputTokens = 0): TokenTotals => ({ inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens: 0 });
const asst = (messageId: string, usage: TokenTotals) => ({ type: "assistant" as const, messageId, usage });
const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

afterEach(() => vi.useRealTimers());

describe("guard snapshot and restore (RLR-2)", () => {
  const limits = resolveRunLimits({ maxModelCalls: 6, maxTurns: 4, maxRunMs: 600_000, meteringSilenceMs: 300_000 });
  // ids m0..m7 each twice (the second line grows), a result; the 7th distinct id passes the limit of 6.
  const events = Array.from({ length: 8 }, (_, i) => [asst(`m${i}`, u(10 + i)), asst(`m${i}`, u(20 + i, 5))]).flat();

  function run(from: number, to: number, guard: ReturnType<typeof createRunGuard>, log: unknown[], t: { now: number }): void {
    for (const [i, event] of events.slice(from, to).entries()) {
      t.now += 1000;
      vi.setSystemTime(t.now);
      guard.observe(event);
      log.push({ at: from + i, calls: guard.modelCalls(), rise: guard.lastRiseAt(), limits: guard.current() });
    }
  }

  it("reaches the same limit on the same line whatever line the stream is split at", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_000_000);
    const firedWhole: RunLimit[] = [];
    const whole = createRunGuard(limits, (l) => void firedWhole.push(l));
    whole.start();
    const wholeLog: unknown[] = [];
    run(0, events.length, whole, wholeLog, { now: 1_000_000 });
    expect(firedWhole).toEqual([{ kind: "model_calls", limit: 6, observed: 7 }]);

    for (let split = 0; split <= events.length; split++) {
      vi.setSystemTime(1_000_000);
      const firedA: RunLimit[] = [];
      const a = createRunGuard(limits, (l) => void firedA.push(l));
      a.start();
      const logA: unknown[] = [];
      const clock = { now: 1_000_000 };
      run(0, split, a, logA, clock);
      const snap = viaJson(a.snapshot());
      a.stop();
      const firedB: RunLimit[] = [];
      const b = createRunGuard(limits, (l) => void firedB.push(l), undefined, snap);
      b.start();
      const logB: unknown[] = [];
      run(split, events.length, b, logB, clock);
      b.stop();
      // a limit reached before the split is the first guard's, and the restored one must not fire it again
      expect([...firedA, ...firedB], `split at ${split}`).toEqual(firedWhole);
      expect(logB, `split at ${split}`).toEqual(wholeLog.slice(split));
    }
  });

  it("re-arms the wall clock from the original start, so a handover does not extend the window", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(2_000_000);
    const a = createRunGuard(limits, () => undefined);
    a.start();
    vi.advanceTimersByTime(250_000);
    vi.setSystemTime(2_000_000 + 500_000);
    a.observe(asst("rise", u(5))); // silence now counts from here, so only the wall clock can end the run first
    const snap = viaJson(a.snapshot());
    a.stop();
    const fired: RunLimit[] = [];
    const b = createRunGuard(limits, (l) => void fired.push(l), undefined, snap);
    b.start();
    vi.advanceTimersByTime(99_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(fired).toEqual([{ kind: "run_time", limit: 600_000, observed: 600_000 }]);
  });

  it("keeps the limits an extension raised, and a limit already reached stays reached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(3_000_000);
    const a = createRunGuard(limits, () => undefined, { decide: async (l) => l.limit + 3, applied: () => undefined });
    a.start();
    for (let i = 0; i < 7; i++) a.observe(asst(`x${i}`, u(1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.current().maxModelCalls).toBe(9);
    const restored = createRunGuard(limits, () => undefined, undefined, viaJson(a.snapshot()));
    expect(restored.current().maxModelCalls).toBe(9);
    expect(restored.modelCalls()).toBe(7);
    a.stop();

    const killed: RunLimit[] = [];
    const done = createRunGuard(limits, (l) => void killed.push(l));
    done.start();
    for (let i = 0; i < 7; i++) done.observe(asst(`y${i}`, u(1)));
    expect(killed).toHaveLength(1);
    const again: RunLimit[] = [];
    const next = createRunGuard(limits, (l) => void again.push(l), undefined, viaJson(done.snapshot()));
    next.start();
    expect(vi.getTimerCount()).toBe(0); // nothing is armed for a limit that was already acted on
    next.observe(asst("z", u(1)));
    vi.advanceTimersByTime(10 * 60_000 * 60);
    expect(again).toEqual([]);
    expect(next.snapshot().fired).toEqual(killed[0]);
  });

  it("counts a forgotten id seen again, so a restore reaches the call limit no later", () => {
    const big = resolveRunLimits({ maxModelCalls: 5000 });
    const a = createRunGuard(big, () => undefined);
    for (let i = 0; i < SNAPSHOT_ID_WINDOW + 20; i++) a.observe(asst(`g${i}`, u(1)));
    const snap = viaJson(a.snapshot());
    expect(snap.ids).toHaveLength(SNAPSHOT_ID_WINDOW);
    expect(snap.idCount).toBe(SNAPSHOT_ID_WINDOW + 20);
    const b = createRunGuard(big, () => undefined, undefined, snap);
    expect(b.modelCalls()).toBe(SNAPSHOT_ID_WINDOW + 20);
    b.observe(asst(`g${SNAPSHOT_ID_WINDOW + 19}`, u(1))); // in the window: a repeat
    expect(b.modelCalls()).toBe(SNAPSHOT_ID_WINDOW + 20);
    b.observe(asst("g0", u(1))); // forgotten: counted again
    expect(b.modelCalls()).toBe(SNAPSHOT_ID_WINDOW + 21);
  });

  it("keeps counting silence across handovers: a restore does not give the run a fresh silence window", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(5_000_000);
    const lim = resolveRunLimits({ meteringSilenceMs: 600_000, maxRunMs: 6_000_000 });
    // reproduction: usage never rises, a handover every 5 minutes; without handovers silence fires at 10 minutes
    const alone: RunLimit[] = [];
    const single = createRunGuard(lim, (l) => void alone.push(l));
    single.start();
    vi.advanceTimersByTime(600_000);
    expect(alone.map((l) => l.kind)).toEqual(["silence"]);

    vi.setSystemTime(5_000_000);
    const fired: RunLimit[] = [];
    let guard = createRunGuard(lim, (l) => void fired.push(l));
    guard.start();
    for (let handover = 0; handover < 20 && fired.length === 0; handover++) {
      vi.advanceTimersByTime(300_000);
      const snap = viaJson(guard.snapshot());
      guard.stop();
      guard = createRunGuard(lim, (l) => void fired.push(l), undefined, snap);
      guard.start();
    }
    expect(fired.map((l) => l.kind)).toEqual(["silence"]);
    expect(Date.now()).toBe(5_000_000 + 600_000);
  });

  it("a metered rise before a handover restarts the silence window from that rise, and the restore keeps it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(7_000_000);
    const lim = resolveRunLimits({ meteringSilenceMs: 600_000, maxRunMs: 6_000_000 });
    const a = createRunGuard(lim, () => undefined);
    a.start();
    vi.advanceTimersByTime(400_000);
    a.observe(asst("m", u(5))); // a rise at +400 s
    vi.advanceTimersByTime(300_000);
    const snap = viaJson(a.snapshot());
    expect(snap.silentSinceMs).toBe(7_400_000);
    a.stop();
    const fired: RunLimit[] = [];
    const b = createRunGuard(lim, (l) => void fired.push(l), undefined, snap);
    b.start();
    vi.advanceTimersByTime(299_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(fired.map((l) => l.kind)).toEqual(["silence"]);
  });

  it("a guard that saw ids that are not plain (a space, over 64 characters) saves and restores, and keeps counting them", () => {
    const odd = ["has a space", "z".repeat(80), "tab\there"];
    const g = createRunGuard(limits, () => undefined);
    for (const id of odd) g.observe(asst(id, u(1)));
    g.observe(asst("msg_plain", u(1)));
    const snap = viaJson(g.snapshot());
    expect(snap.ids.filter((id) => id.startsWith("#"))).toHaveLength(3);
    const restored = createRunGuard(limits, () => undefined, undefined, snap);
    expect(restored.modelCalls()).toBe(4);
    for (const id of [...odd, "msg_plain"]) restored.observe(asst(id, u(1)));
    expect(restored.modelCalls()).toBe(4); // repeats are not counted again
    expect(viaJson(restored.snapshot())).toEqual(snap);
  });

  it("a meter and a guard fed the same mixed plain and non-plain ids round-trip together and decide as the original", () => {
    const ids = ["m1", "has a space", "m2", "q".repeat(100), "m3", "\u0000odd", "m1", "has a space"];
    const lines = ids.map((id, i) => asst(id, u(10 + i)));
    for (let split = 0; split <= lines.length; split++) {
      const wholeMeter = createUsageMeter();
      const wholeGuard = createRunGuard(limits, () => undefined);
      const expected = lines.map((l) => (wholeGuard.observe(l), [wholeMeter.observe(l), wholeGuard.modelCalls()]));
      const meter = createUsageMeter();
      const guard = createRunGuard(limits, () => undefined);
      for (const l of lines.slice(0, split)) {
        meter.observe(l);
        guard.observe(l);
      }
      const state = parseReaderState(viaJson(buildReaderState({ usage: meter.snapshot(), guard: guard.snapshot(), ledger: snapshotMeterLedger({ meteredTokens: u(0), modelTokens: new Map(), meterFlags: new Set(), cumulativeModelUsd: 0 }) })));
      const meter2 = createUsageMeter({ restore: state.usage });
      const guard2 = createRunGuard(limits, () => undefined, undefined, state.guard);
      const got = lines.slice(split).map((l) => (guard2.observe(l), [meter2.observe(l), guard2.modelCalls()]));
      expect(got, `split at ${split}`).toEqual(expected.slice(split));
    }
  });

  it("a snapshot with a repeated id is refused, not restored with a smaller count", () => {
    const g = createRunGuard(limits, () => undefined);
    g.observe(asst("a", u(1)));
    g.observe(asst("b", u(1)));
    const snap = viaJson(g.snapshot());
    expect(() => createRunGuard(limits, () => undefined, undefined, { ...snap, ids: ["a", "a"], idCount: 2 })).toThrow(/guard snapshot: bad ids/);
    expect(() => createRunGuard(limits, () => undefined, undefined, { ...snap, ids: ["a b"], idCount: 2 })).toThrow(/guard snapshot: bad ids/);
  });

  it("refuses a malformed snapshot", () => {
    const good = viaJson(createRunGuard(limits, () => undefined).snapshot());
    const bad: unknown[] = [
      null,
      { ...good, limits: { ...good.limits, maxTurns: 0 } },
      { ...good, startedMs: -1 },
      { ...good, idCount: 0, ids: ["a"] },
      { ...good, ids: [1] },
      { ...good, lastRiseMs: "x" },
      { ...good, fired: { kind: "nope", limit: 1, observed: 1 } },
    ];
    for (const raw of bad) expect(() => createRunGuard(limits, () => undefined, undefined, raw)).toThrow(/guard snapshot|run limit/);
    expect(() => createRunGuard(limits, () => undefined, undefined, { ...good, meter: { nope: true } })).toThrow(/usage meter snapshot/);
  });
});

describe("meter ledger snapshot (RLR-2)", () => {
  const ledger = (): MeterLedger<"a" | "b"> => ({
    meteredTokens: u(100, 20),
    modelTokens: new Map([["a", u(60, 10)], ["b", u(40, 10)]]),
    meterFlags: new Set(["unknown_message_model"]),
    cumulativeModelUsd: 1.25,
  });

  it("round-trips through JSON and keeps flags that were already raised", () => {
    const target: MeterLedger<"a" | "b"> = { meteredTokens: u(0), modelTokens: new Map(), meterFlags: new Set(["implausible_usage"]), cumulativeModelUsd: 0 };
    restoreMeterLedger(viaJson(snapshotMeterLedger(ledger())), target);
    expect(target.meteredTokens).toEqual(u(100, 20));
    expect([...target.modelTokens]).toEqual([...ledger().modelTokens]);
    expect([...target.meterFlags].sort()).toEqual(["implausible_usage", "unknown_message_model"]);
    expect(target.cumulativeModelUsd).toBe(1.25);
  });

  it("refuses to write a ledger it could not read back", () => {
    const many = ledger();
    for (let i = 0; i < 33; i++) (many.modelTokens as Map<string, TokenTotals>).set(`m${i}`, u(1));
    expect(() => snapshotMeterLedger(many)).toThrow(/ledger is too large/);
    const flags = ledger();
    for (let i = 0; i < 17; i++) flags.meterFlags.add(`f${i}`);
    expect(() => snapshotMeterLedger(flags)).toThrow(/ledger is too large/);
    const odd = ledger();
    odd.meterFlags.add("bad flag\u0000");
    expect(() => snapshotMeterLedger(odd)).toThrow(/bad meter flag/);
    // exactly at the caps is fine and reads back
    const edge = ledger();
    for (let i = 0; i < 30; i++) (edge.modelTokens as Map<string, TokenTotals>).set(`m${i}`, u(1));
    for (let i = 0; i < 15; i++) edge.meterFlags.add(`f${i}`);
    const target = ledger();
    expect(() => restoreMeterLedger(viaJson(snapshotMeterLedger(edge)), target)).not.toThrow();
  });

  it("refuses what is not a ledger", () => {
    const good = viaJson(snapshotMeterLedger(ledger()));
    const target = ledger();
    for (const raw of [null, {}, { ...good, cumulativeModelUsd: -1 }, { ...good, meterFlags: [1] }, { ...good, meterFlags: Array(17).fill("f") }, { ...good, modelTokens: [["a"]] }, { ...good, meteredTokens: u(Number.POSITIVE_INFINITY) }]) {
      expect(() => restoreMeterLedger(raw, target)).toThrow(/reader state/);
    }
    expect(target.cumulativeModelUsd).toBe(1.25); // a refused restore wrote nothing
  });
});

describe("side effects are monotone (RLR-2)", () => {
  it("records an extension against its own kind's warning only", () => {
    const fx = createSideEffects();
    fx.callsWarned = fx.timeWarned = true;
    recordExtension(fx, "run_time", { ghWrites: 2, messageIds: 30 });
    expect(fx).toMatchObject({ extensionsUsed: 1, ghAtLast: 2, idsAtLast: 30, timeWarned: false, callsWarned: true, timeWindow: 1, callsWindow: 0 });
    recordExtension(fx, "model_calls", { ghWrites: 3, messageIds: 40 });
    expect(fx).toMatchObject({ extensionsUsed: 2, callsWarned: false, timeWarned: false, callsWindow: 1 });
  });

  const rank = (window: number, flag: boolean): number => window * 2 + (flag ? 1 : 0);
  const atLeast = (merged: SideEffects, x: SideEffects): boolean =>
    merged.extensionsUsed >= x.extensionsUsed &&
    rank(merged.callsWindow, merged.callsWarned) >= rank(x.callsWindow, x.callsWarned) &&
    rank(merged.timeWindow, merged.timeWarned) >= rank(x.timeWindow, x.timeWarned) &&
    (merged.killIssued || !x.killIssued);

  it("a merge never takes a flag, count or kill back from either side, over random histories", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const history = (): SideEffects => {
      const fx = createSideEffects();
      for (let i = 0, n = rnd(6); i < n; i++) {
        const step = rnd(5);
        if (step === 0) fx.callsWarned = true;
        else if (step === 1) fx.timeWarned = true;
        else if (step === 2) fx.killIssued = true;
        else recordExtension(fx, step === 3 ? "run_time" : "model_calls", { ghWrites: rnd(9), messageIds: rnd(99) });
      }
      return fx;
    };
    for (let i = 0; i < 500; i++) {
      const a = history();
      const b = history();
      const m = mergeSideEffects(a, b);
      expect(atLeast(m, a) && atLeast(m, b), JSON.stringify([a, b, m])).toBe(true);
      expect(mergeSideEffects(m, a)).toEqual(m);
      expect(mergeSideEffects(a, b)).toEqual(mergeSideEffects(b, a));
    }
  });

  it("replaying a line after a restore does not send a second warning", () => {
    const stored = createSideEffects();
    stored.callsWarned = true;
    const restored = parseSideEffects(viaJson(stored));
    // the reader replays the line that triggered the warning: it sees the flag and does not write again
    let sent = 0;
    if (!restored.callsWarned) {
      sent += 1;
      restored.callsWarned = true;
    }
    expect(sent).toBe(0);
    expect(mergeSideEffects(stored, restored).callsWarned).toBe(true);
  });

  it("reads the column's empty default as nothing done, and refuses anything else malformed", () => {
    expect(parseSideEffects({})).toEqual(createSideEffects());
    expect(() => parseSideEffects(null)).toThrow(/reader state/);
    expect(() => parseSideEffects({ ...createSideEffects(), killIssued: 1 })).toThrow(/killIssued/);
    expect(() => parseSideEffects({ ...createSideEffects(), extensionsUsed: -1 })).toThrow(/extensionsUsed/);
    expect(() => parseSideEffects({ extensionsUsed: 1 })).toThrow(/reader state/);
  });
});

describe("the reader state document (RLR-2)", () => {
  const parts = () => ({
    usage: createUsageMeter().snapshot(),
    guard: createRunGuard(resolveRunLimits(), () => undefined).snapshot(),
    ledger: snapshotMeterLedger({ meteredTokens: u(0), modelTokens: new Map(), meterFlags: new Set(), cumulativeModelUsd: 0 }),
  });

  it("uses the same ceiling as the table's CHECK", () => {
    const migration = readFileSync(path.join(here, "../../db/migrations/0697_run_log_readers.sql"), "utf8");
    expect(migration).toContain(`octet_length(state::text) <= ${STATE_MAX_BYTES}`);
  });

  it("stays under the ceiling at the worst case: full windows of hostile ids and the longest figures, measured as jsonb prints it", () => {
    const usage = createUsageMeter({ maxLineInputSideTokens: Number.MAX_VALUE, maxLineOutputTokens: Number.MAX_VALUE });
    const guard = createRunGuard(resolveRunLimits({ maxModelCalls: 5000 }), () => undefined);
    const shapes = [(i: number) => `${i}${"\u0001".repeat(128)}`, (i: number) => `${i}${'"'.repeat(200)}`, (i: number) => `${i}\u0000x`, (i: number) => `${i}\ud800`, (i: number) => `${i}${"y".repeat(100_000)}`, (i: number) => `msg_${i}${"a".repeat(60)}`];
    for (let i = 0; i < 600; i++) {
      // huge held figures (1e300) and fractions with a long plain expansion (1e-300)
      const line = asst(shapes[i % shapes.length]!(i), { inputTokens: 1e300, outputTokens: 1.2345678901234567e-300, cacheWriteTokens: 9.87654321e-299, cacheReadTokens: 1e300 });
      usage.observe(line);
      guard.observe(line);
    }
    usage.observe({ type: "result", usage: { inputTokens: 1e300, outputTokens: 2.5e-300, cacheWriteTokens: 1e-300, cacheReadTokens: 3e-300 } });
    const ledger = snapshotMeterLedger({
      meteredTokens: { inputTokens: 1e300, outputTokens: 1e-300, cacheWriteTokens: 1e-300, cacheReadTokens: 1e300 },
      modelTokens: new Map([["haiku-4.5", u(1e-300)], ["sonnet-5", u(1e300)], ["opus-5", u(1e-300)]]),
      meterFlags: new Set(["implausible_usage", "reported_below_metered", "unknown_message_model"]),
      cumulativeModelUsd: 1e-300,
    });
    const state = buildReaderState({ usage: usage.snapshot(), guard: guard.snapshot(), ledger });
    const bytes = Buffer.byteLength(jsonbText(state));
    expect(state.usage.ids).toHaveLength(SNAPSHOT_ID_WINDOW);
    expect(state.guard.ids).toHaveLength(SNAPSHOT_ID_WINDOW);
    expect(state.guard.meter.ids).toHaveLength(SNAPSHOT_ID_WINDOW);
    expect(bytes).toBeLessThan(STATE_MAX_BYTES);
    // the same state, plain JSON, is smaller than jsonb's text; and every stored id is storable (no NUL, no lone surrogate)
    expect(JSON.stringify(state).length).toBeLessThan(bytes);
    expect(JSON.stringify(state)).not.toMatch(/\\u0000|\\ud800/i);
    expect(parseReaderState(viaJson(state))).toEqual(state);
  });

  it("prints numbers and separators the way jsonb does", () => {
    expect(jsonbText({ a: [1, 1e300, 1e-7, 1.5e21, 12.5, -2e-7], b: "x\u0001", c: null, d: true })).toBe(
      `{"a": [1, 1${"0".repeat(300)}, 0.0000001, 15${"0".repeat(20)}, 12.5, -0.0000002], "b": "x\\u0001", "c": null, "d": true}`,
    );
  });

  it("refuses a state over the ceiling, with a fixed message that does not carry its content", () => {
    const state = parts();
    state.ledger.meterFlags = ["f".repeat(STATE_MAX_BYTES)];
    expect(() => buildReaderState(state)).toThrow(/over the 262144 byte limit/);
  });

  it("refuses a state that is under the ceiling as JSON but over it as jsonb prints it", () => {
    const state = parts();
    (state.ledger as unknown as Record<string, unknown>).filler = Array.from({ length: 100_000 }, () => 1);
    expect(JSON.stringify(state).length).toBeLessThan(STATE_MAX_BYTES);
    expect(() => buildReaderState(state)).toThrow(/byte limit/);
  });

  it("refuses an unknown version or a missing part", () => {
    expect(() => parseReaderState({ v: 2 })).toThrow(/unknown version/);
    expect(() => parseReaderState({ v: 1, usage: {}, guard: {} })).toThrow(/ledger is missing/);
    expect(() => parseReaderState(null)).toThrow(/unknown version/);
  });
});
