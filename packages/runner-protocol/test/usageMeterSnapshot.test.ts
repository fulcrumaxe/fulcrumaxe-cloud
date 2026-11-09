import { describe, expect, it } from "vitest";
import { MAX_LINE_INPUT_SIDE_TOKENS, SNAPSHOT_ID_WINDOW, createUsageMeter, messageIdKey, type TokenTotals } from "../src/usageMeter.js";

type Line = Parameters<ReturnType<typeof createUsageMeter>["observeRise"]>[0];

const u = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0): TokenTotals => ({ inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens });
const asst = (messageId: string | undefined, usage: TokenTotals): Line => ({ type: "assistant", messageId, usage });

/** A recorded-style stream: ids repeat and grow, one id-less line, a lower repeat, a forged huge line, a cumulative result. */
function stream(): Line[] {
  const lines: Line[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(asst(`m${i}`, u(100 + i, 10)));
    lines.push(asst(`m${i}`, u(100 + i, 10 + i)));
    if (i % 4 === 3) lines.push(asst(`m${i - 1}`, u(1, 1)));
  }
  lines.push({ type: "assistant", usage: u(5) });
  lines.push({ type: "assistant", messageId: undefined, usage: undefined });
  lines.push({ type: "result", usage: u(900, 400) });
  lines.push(asst("forged", u(MAX_LINE_INPUT_SIDE_TOKENS * 2)));
  lines.push({ type: "result", usage: u(3000, 400) });
  lines.push(asst("m3", u(500, 10)));
  return lines;
}

const outcome = (meter: ReturnType<typeof createUsageMeter>, line: Line) => ({
  rise: meter.observeRise(line),
  total: meter.total(),
  flags: meter.flags(),
  implausible: meter.implausible(),
});

const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("usage meter snapshot and restore (RLR-2)", () => {
  it("a restored meter decides exactly as the original, however the stream is split", () => {
    const lines = stream();
    const whole = createUsageMeter();
    const expected = lines.map((line) => outcome(whole, line));
    for (let split = 0; split <= lines.length; split++) {
      const first = createUsageMeter();
      for (const line of lines.slice(0, split)) first.observeRise(line);
      const second = createUsageMeter({ restore: viaJson(first.snapshot()) });
      expect(second.total()).toEqual(first.total());
      expect(lines.slice(split).map((line) => outcome(second, line)), `split at ${split}`).toEqual(expected.slice(split));
    }
  });

  it("taking a snapshot changes nothing", () => {
    const lines = stream();
    const a = createUsageMeter();
    const b = createUsageMeter();
    for (const line of lines) {
      a.snapshot();
      expect(outcome(a, line)).toEqual(outcome(b, line));
    }
  });

  it("holds at most the id window; a forgotten id seen again is counted again, never less", () => {
    const meter = createUsageMeter();
    for (let i = 0; i < SNAPSHOT_ID_WINDOW + 10; i++) meter.observe(asst(`id${i}`, u(10)));
    const snap = meter.snapshot();
    expect(snap.ids).toHaveLength(SNAPSHOT_ID_WINDOW);
    expect(snap.idsSeen).toBe(SNAPSHOT_ID_WINDOW + 10);
    const before = meter.total().inputTokens;
    // id0 fell out of the window: the original ignores its repeat, the restored meter counts it as new
    expect(meter.observe(asst("id0", u(10)))).toBeUndefined();
    const restored = createUsageMeter({ restore: viaJson(snap) });
    expect(restored.observe(asst("id0", u(10)))?.inputTokens).toBe(before + 10);
    // an id still in the window is not counted again
    expect(createUsageMeter({ restore: viaJson(snap) }).observe(asst(`id${SNAPSHOT_ID_WINDOW + 9}`, u(10)))).toBeUndefined();
  });

  it("the distinct-id bound still counts the ids a snapshot forgot", () => {
    const meter = createUsageMeter({ maxIds: SNAPSHOT_ID_WINDOW + 5 });
    for (let i = 0; i < SNAPSHOT_ID_WINDOW + 5; i++) meter.observe(asst(`id${i}`, u(1)));
    expect(meter.implausible()).toBe(false);
    const restored = createUsageMeter({ maxIds: SNAPSHOT_ID_WINDOW + 5, restore: viaJson(meter.snapshot()) });
    restored.observe(asst("one-too-many", u(1)));
    expect(restored.implausible()).toBe(true);
  });

  it("keeps a raised kill and a raised flag across a restore", () => {
    const meter = createUsageMeter();
    meter.observe(asst("a", u(1000)));
    meter.observe({ type: "result", usage: u(1, 0) });
    meter.observe(asst("forged", u(MAX_LINE_INPUT_SIDE_TOKENS * 2)));
    expect(meter.flags()).toEqual(["implausible_usage", "reported_below_metered"]);
    const restored = createUsageMeter({ restore: viaJson(meter.snapshot()) });
    expect(restored.implausible()).toBe(true);
    expect(restored.flags()).toEqual(meter.flags());
  });

  const hostile = ["\u0001".repeat(128), '"'.repeat(200), "a\u0000b", "lone\ud800surrogate", "x".repeat(1_000_000), "has space", "", "é".repeat(70)];

  it("stores every id as a short plain key, whatever the id a hostile process sent", () => {
    for (const id of hostile) expect(messageIdKey(id)).toMatch(/^([A-Za-z0-9_.:-]{1,64}|#[0-9a-f]{32})$/);
    expect(messageIdKey("msg_01AbC-x.y:z")).toBe("msg_01AbC-x.y:z"); // an ordinary id is kept as it is
    expect(new Set(hostile.map(messageIdKey)).size).toBe(hostile.length); // no two of them share a key
    const meter = createUsageMeter();
    for (const id of hostile) meter.observe(asst(id, u(7)));
    const snap = viaJson(meter.snapshot());
    expect(JSON.stringify(snap).length).toBeLessThan(4000);
    // the ids still dedupe after a restore: a repeat adds nothing, a different id adds
    const restored = createUsageMeter({ restore: snap });
    for (const id of hostile) expect(restored.observe(asst(id, u(7)))).toBeUndefined();
    expect(restored.observe(asst("other", u(7)))?.inputTokens).toBe(7 * hostile.length + 7);
  });

  it("stores held figures whole and capped, so a hostile figure cannot grow the state (rounding only over-counts)", () => {
    const meter = createUsageMeter({ maxLineInputSideTokens: Number.MAX_VALUE });
    meter.observe(asst("a", u(1e300, 1e-300)));
    const held = meter.snapshot().ids[0]![1];
    expect(held.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(held.outputTokens).toBe(0);
  });

  it("refuses a snapshot that is not one, rather than starting from zero", () => {
    const good = viaJson(createUsageMeter().snapshot()) as Record<string, unknown>;
    const bad: unknown[] = [
      null,
      "x",
      {},
      { ...good, ids: "no" },
      { ...good, ids: Array.from({ length: SNAPSHOT_ID_WINDOW + 1 }, (_, i) => [`i${i}`, u(1)]) },
      { ...good, ids: [[1, u(1)]] },
      { ...good, ids: [["has space", u(1)]], idsSeen: 1 },
      { ...good, ids: [["a", u(1)], ["a", u(1)]], idsSeen: 2 },
      { ...good, ids: [["a", { inputTokens: -1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }]] },
      { ...good, idsSeen: -1 },
      { ...good, ids: [["a", u(1)]], idsSeen: 0 },
      { ...good, total: { inputTokens: Number.NaN, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 } },
      { ...good, killed: "yes" },
      { ...good, summed: null },
    ];
    for (const raw of bad) expect(() => createUsageMeter({ restore: raw })).toThrow(/usage meter snapshot/);
  });
});
