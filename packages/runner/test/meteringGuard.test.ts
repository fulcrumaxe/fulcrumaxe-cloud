import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_LIMIT_BOUNDS } from "@fx/core/src/run-limits/limits.js";
import { configureErrorReporter } from "@fx/telemetry";
import { normalizeMessage } from "@fx/runtime/src/streamJson.js";
import type { RunLimit } from "../src/executionTarget.js";
import {
  CLI_MAX_TURNS_SUBTYPE,
  DEFAULT_DECISION_TIMEOUT_MS,
  MAX_LINE_INPUT_SIDE_TOKENS,
  MAX_LINE_OUTPUT_TOKENS,
  createRunGuard,
  createUsageMeter,
  resolveRunLimits,
} from "../src/meteringGuard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const u = (inputTokens: number, outputTokens = 0) => ({ inputTokens, outputTokens });
const asst = (messageId: string | undefined, usage: ReturnType<typeof u>) => ({ type: "assistant" as const, messageId, usage });

describe("createUsageMeter (MP-MSG)", () => {
  it("meters each id's per-field maximum, summed: not the per-line sum", () => {
    // The recorded fixture's messages are larger than the per-line ceilings, so raise them for it.
    const meter = createUsageMeter({ maxLineInputSideTokens: 3_000_000, maxLineOutputTokens: 1_000_000 });
    const lines = readFileSync(path.join(here, "fixtures", "streamJsonPerMessage.jsonl"), "utf8").trim().split("\n");
    for (const [i, line] of lines.entries()) meter.observe(normalizeMessage({ runId: "r", role: "reviewer" }, JSON.parse(line), i));
    // 3 messages of 2 lines each: per-id max is 3.5M in / 900k out; a per-line sum would be 7M in.
    expect(meter.total()).toMatchObject({ inputTokens: 3_500_000, outputTokens: 900_000 });
  });

  it("returns the new total only when a field rose, and repeats add nothing", () => {
    const meter = createUsageMeter();
    expect(meter.observe(asst("m1", u(100, 10)))).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(meter.observe(asst("m1", u(100, 10)))).toBeUndefined();
    expect(meter.observe(asst("m1", u(100, 30)))).toMatchObject({ inputTokens: 100, outputTokens: 30 });
  });

  it("a lower figure for an existing id changes nothing; a new id with a huge figure only raises the total", () => {
    const meter = createUsageMeter();
    meter.observe(asst("m1", u(1000, 500)));
    expect(meter.observe(asst("m1", u(1, 1)))).toBeUndefined();
    expect(meter.total()).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
    // Over the ceiling: counted, but only up to it, and the run is to be killed (MP-PLAUS).
    expect(meter.observe(asst("forged", u(9_000_000)))).toMatchObject({ inputTokens: 1000 + MAX_LINE_INPUT_SIDE_TOKENS });
    expect(meter.implausible()).toBe(true);
  });

  it("a cumulative result figure is ignored when lower and raises the total when higher", () => {
    const meter = createUsageMeter();
    meter.observe(asst("m1", u(1000, 500)));
    expect(meter.observe({ type: "result", usage: u(10, 5) })).toBeUndefined();
    expect(meter.total()).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
    expect(meter.observe({ type: "result", usage: u(1500, 500) })).toMatchObject({ inputTokens: 1500, outputTokens: 500 });
    // later per-id growth is not double-counted on top of the cumulative figure
    expect(meter.observe(asst("m1", u(1200, 500)))).toBeUndefined();
  });

  it("unusable fields count as 0 and an event without usage is ignored", () => {
    const meter = createUsageMeter();
    const bad = { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: Number.POSITIVE_INFINITY };
    expect(meter.observe(asst("m1", bad as never))).toBeUndefined();
    expect(meter.observe({ type: "assistant", messageId: "m2" })).toBeUndefined();
    expect(meter.total()).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
  });
});

describe("createUsageMeter: no one line can raise the total by more than the ceilings (MP-PLAUS, S7)", () => {
  const cache = (cacheWriteTokens: number, inputTokens = 0, outputTokens = 0) => ({ inputTokens, outputTokens, cacheWriteTokens });

  it("an assistant line over the input-side ceiling (cache fields count with input) is a kill, and adds only the ceiling", () => {
    const meter = createUsageMeter();
    const rise = meter.observeRise(asst("m1", cache(600_000, 600_000)));
    expect(meter.implausible()).toBe(true);
    expect(rise!.delta.inputTokens + rise!.delta.cacheWriteTokens).toBe(MAX_LINE_INPUT_SIDE_TOKENS);
    expect(meter.flags()).toContain("implausible_usage");
  });

  it("an assistant line over the output ceiling is a kill, and adds only the ceiling", () => {
    const meter = createUsageMeter();
    expect(meter.observe(asst("m1", u(10, 99_000_000)))).toMatchObject({ outputTokens: MAX_LINE_OUTPUT_TOKENS });
    expect(meter.implausible()).toBe(true);
  });

  it("a forged result with 100M input tokens raises the total by at most the ceiling, with no kill; a repeat adds nothing", () => {
    const meter = createUsageMeter();
    meter.observe(asst("m1", u(1000, 10)));
    expect(meter.observe({ type: "result", usage: u(100_000_000) })).toMatchObject({ inputTokens: 1000 + MAX_LINE_INPUT_SIDE_TOKENS });
    expect(meter.implausible()).toBe(false);
    expect(meter.flags()).toContain("implausible_usage");
    // The unclamped remainder is not re-counted by a later, unrelated line.
    expect(meter.observe(asst("m1", u(1000, 10)))).toBeUndefined();
    expect(meter.observe(asst("m2", u(5, 1)))).toMatchObject({ inputTokens: 1000 + MAX_LINE_INPUT_SIDE_TOKENS, outputTokens: 11 });
  });

  it("a genuine multi-message stream is unchanged and raises no flag", () => {
    const meter = createUsageMeter();
    for (const [id, tokens] of [["a", 400_000], ["b", 900_000], ["c", 1_000_000]] as const) meter.observe(asst(id, u(tokens, 50_000)));
    expect(meter.total()).toMatchObject({ inputTokens: 2_300_000, outputTokens: 150_000 });
    expect(meter.implausible()).toBe(false);
    expect(meter.flags()).toEqual([]);
  });

  it("W1: distinct ids count toward the cap even with zero usage, and past it nothing more is held", () => {
    const meter = createUsageMeter({ maxIds: 3 });
    for (const id of ["a", "b", "c"]) meter.observe(asst(id, u(0, 0)));
    expect(meter.implausible()).toBe(false);
    meter.observe(asst("a", u(0, 0))); // a repeat is not a new id
    expect(meter.implausible()).toBe(false);
    expect(meter.observe(asst("d", u(0, 0)))).toBeUndefined();
    expect(meter.implausible()).toBe(true);
    expect(meter.total()).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
  });

  it("a final result usage more than 5% below the metered total is flagged; 5% or less is not", () => {
    const meter = createUsageMeter();
    meter.observe(asst("m1", u(1000, 1000)));
    meter.observe({ type: "result", usage: u(960, 1000) });
    expect(meter.flags()).toEqual([]);
    meter.observe({ type: "result", usage: u(900, 1000) });
    expect(meter.flags()).toEqual([]); // cumulative only ever rises: 960 is what is held
    const low = createUsageMeter();
    low.observe(asst("m1", u(1000, 1000)));
    low.observe({ type: "result", usage: u(100, 100) });
    expect(low.flags()).toEqual(["reported_below_metered"]);
  });

  it("an id-less usage line (only a non-sandbox runtime produces one) is not bounded", () => {
    const meter = createUsageMeter();
    expect(meter.observe(asst(undefined, u(30_000_000)))).toMatchObject({ inputTokens: 30_000_000 });
    expect(meter.implausible()).toBe(false);
  });
});

describe("createRunGuard and resolveRunLimits (MP-TURNS, MP-CLOCK, MP-SILENT)", () => {
  const limits = { maxTurns: 3, maxModelCalls: 2, maxRunMs: 5000, meteringSilenceMs: 2000 };
  const armed = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fired: RunLimit[] = [];
    const guard = createRunGuard(limits, (l) => void fired.push(l));
    guard.start();
    return { guard, fired };
  };
  afterEach(() => vi.useRealTimers());

  it("fires once: the first limit reached wins and both timers are cleared", () => {
    const { fired } = armed();
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([{ kind: "silence", limit: 2000, observed: 2000 }]);
  });

  it("the wall clock fires at maxRunMs whatever the metering does, and stop() cancels it", () => {
    const { guard, fired } = armed();
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(1000);
      guard.observe(asst("m", u(i * 10)));
    }
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([{ kind: "run_time", limit: 5000, observed: 5000 }]);
    const again = armed();
    again.guard.stop();
    vi.advanceTimersByTime(60_000);
    expect(again.fired).toEqual([]);
  });

  it("counts distinct assistant message ids only: a repeat, a result and an id-less line add nothing", () => {
    const { guard, fired } = armed();
    for (const id of ["a", "a", "b", "b"]) guard.observe(asst(id, u(1)));
    guard.observe({ type: "result", messageId: "z", usage: u(1) });
    guard.observe(asst(undefined, u(1)));
    expect(fired).toEqual([]);
    guard.observe(asst("c", u(1)));
    expect(fired).toEqual([{ kind: "model_calls", limit: 2, observed: 3 }]);
  });

  it("turnsLimit needs the CLI's max-turns subtype AND at least maxTurns distinct ids", () => {
    const { guard } = armed();
    for (const id of ["a", "b"]) guard.observe(asst(id, u(1)));
    expect(guard.turnsLimit(CLI_MAX_TURNS_SUBTYPE)).toBeUndefined();
    guard.observe(asst("c", u(1)));
    expect(guard.turnsLimit(CLI_MAX_TURNS_SUBTYPE)).toEqual({ kind: "turns", limit: 3, observed: 3 });
    expect(guard.turnsLimit("success")).toBeUndefined();
  });

  it("resolveRunLimits fills the C46 defaults and refuses a non-positive or non-integer value", () => {
    expect(resolveRunLimits()).toEqual({ maxTurns: 100, maxModelCalls: 300, maxRunMs: 3_600_000, meteringSilenceMs: 900_000 });
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => resolveRunLimits({ maxRunMs: bad })).toThrow(/maxRunMs/);
    // setTimeout fires at once above 2^31-1 ms.
    expect(resolveRunLimits({ maxRunMs: 2 ** 31 - 1 }).maxRunMs).toBe(2 ** 31 - 1);
    expect(() => resolveRunLimits({ maxRunMs: 2 ** 31 })).toThrow(/maxRunMs/);
    expect(() => resolveRunLimits({ meteringSilenceMs: 2 ** 31 })).toThrow(/meteringSilenceMs/);
  });

  // D#2 H14c-3-2d-2, R-BOUNDS layer (b): the numbers are read from core's table, never copied here.
  const MIN = 60_000;
  const B = RUN_LIMIT_BOUNDS;
  const FIELDS = [
    ["maxTurns", B.max_turns.floor, B.max_turns.ceiling],
    ["maxModelCalls", B.max_model_calls.floor, B.max_model_calls.ceiling],
    ["maxRunMs", B.max_run_minutes.floor * MIN, B.max_run_minutes.ceiling * MIN],
    ["meteringSilenceMs", B.silence_minutes.floor * MIN, B.silence_minutes.ceiling * MIN],
  ] as const;

  it.each(FIELDS)("R-BOUNDS (b): bounded, %s is refused one below its floor and one above its ceiling with a fixed error, and accepted at both", (name, floor, ceiling) => {
    for (const bad of [floor - 1, ceiling + 1]) {
      expect(() => resolveRunLimits({ [name]: bad }, { bounded: true })).toThrow(`run limit ${name} is outside the platform bounds`);
    }
    for (const ok of [floor, ceiling]) expect(resolveRunLimits({ [name]: ok }, { bounded: true })[name]).toBe(ok);
  });

  it("R-BOUNDS (b): without bounded (the port's own operator-set defaults) small values still work, and the defaults are inside the bounds", () => {
    expect(resolveRunLimits({ maxRunMs: 300, maxTurns: 2 }).maxTurns).toBe(2);
    expect(() => resolveRunLimits({}, { bounded: true })).not.toThrow();
  });
});

describe("createRunGuard with an extension: a pending decision does not disable the other limits", () => {
  const limits = { maxTurns: 100, maxModelCalls: 2, maxRunMs: 5000, meteringSilenceMs: 1_000_000 };
  const defer = () => {
    let resolve!: (n: number | undefined) => void;
    const promise = new Promise<number | undefined>((r) => (resolve = r));
    return { promise, resolve };
  };
  const setup = (decide: (l: RunLimit) => Promise<number | undefined>, decisionTimeoutMs?: number) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fired: RunLimit[] = [];
    const applied: Array<[RunLimit, number]> = [];
    const asked: RunLimit[] = [];
    const guard = createRunGuard(limits, (l) => void fired.push(l), {
      decide: (l) => (asked.push(l), decide(l)),
      applied: (l, n) => void applied.push([l, n]),
      ...(decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs }),
    });
    guard.start();
    return { guard, fired, applied, asked };
  };
  const three = (guard: ReturnType<typeof createRunGuard>) => {
    for (const id of ["a", "b", "c"]) guard.observe(asst(id, u(1)));
  };
  afterEach(() => vi.useRealTimers());

  it("a run-time expiry during a model-calls decision is honoured once the grant lands", async () => {
    const d = defer();
    const { guard, fired, applied, asked } = setup((l) => (l.kind === "model_calls" ? d.promise : Promise.resolve(undefined)));
    three(guard);
    await vi.advanceTimersByTimeAsync(5000); // the wall fires while the call-count decision is pending
    expect(asked.map((l) => l.kind)).toEqual(["model_calls"]);
    expect(fired).toEqual([]);
    d.resolve(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([[{ kind: "model_calls", limit: 2, observed: 3 }, 10]]);
    expect(asked.map((l) => l.kind)).toEqual(["model_calls", "run_time"]);
    expect(fired).toEqual([{ kind: "run_time", limit: 5000, observed: 5000 }]);
  });

  it("a grant that arrives after the raised deadline has already passed is re-armed at once, not lost", async () => {
    const d = defer();
    let calls = 0;
    const { guard, fired, asked } = setup((l) => (l.kind === "run_time" && calls++ === 0 ? d.promise : Promise.resolve(undefined)));
    guard.observe(asst("a", u(1)));
    await vi.advanceTimersByTimeAsync(6000);
    d.resolve(5500); // a limit that is already behind the clock
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.map((l) => l.kind)).toEqual(["run_time", "run_time"]);
    expect(fired).toEqual([{ kind: "run_time", limit: 5500, observed: 6000 }]);
  });

  it("a model-calls limit reached during a run-time decision is asked about when that decision grants", async () => {
    const d = defer();
    const { guard, fired, asked } = setup((l) => (l.kind === "run_time" ? d.promise : Promise.resolve(undefined)));
    await vi.advanceTimersByTimeAsync(5000);
    three(guard); // over the call limit while the run-time decision is pending
    expect(fired).toEqual([]);
    d.resolve(9000);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.map((l) => l.kind)).toEqual(["run_time", "model_calls"]);
    expect(fired).toEqual([{ kind: "model_calls", limit: 2, observed: 3 }]);
  });

  it("an applied() that throws neither leaves the limits unarmed nor leaks a rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fired: RunLimit[] = [];
    const guard = createRunGuard(limits, (l) => void fired.push(l), {
      decide: async (l) => (l.kind === "run_time" ? 9000 : undefined),
      applied: () => {
        throw new Error("recorder down");
      },
    });
    guard.start();
    await vi.advanceTimersByTimeAsync(5000); // asks; the grant lands and applied() throws
    expect(guard.current().maxRunMs).toBe(9000);
    await vi.advanceTimersByTimeAsync(4000); // the wall was re-armed for the new deadline
    expect(fired).toEqual([{ kind: "run_time", limit: 9000, observed: 9000 }]);
  });

  it("a throwing applied() is reported as a class: its stage, never the planted token in its message", async () => {
    const lines: string[] = [];
    configureErrorReporter({ service: "runner", write: (line) => void lines.push(line) });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const guard = createRunGuard(limits, () => undefined, {
        decide: async (l) => (l.kind === "run_time" ? 9000 : undefined),
        applied: () => {
          throw Object.assign(new Error("recorder failed for h1d-canary-plainword at github.com/octo/repo"), { code: "h1d-canary-plainword" });
        },
      });
      guard.start();
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      configureErrorReporter({ service: "app" });
    }
    expect(lines).toHaveLength(1);
    const out = lines.join("\n");
    expect(out).toContain("run.limit_applied");
    for (const leak of ["h1d-canary", "plainword", "octo", "github.com"]) expect(out).not.toContain(leak);
  });

  it("a decision that never settles ends the run at the injected bound with the original limit", async () => {
    const { guard, fired, applied } = setup(() => new Promise(() => undefined), 1000);
    three(guard);
    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([{ kind: "model_calls", limit: 2, observed: 3 }]);
    expect(applied).toEqual([]);
  });

  it("the default bound is 30 s, and a grant that comes after it is ignored", async () => {
    const d = defer();
    const { guard, fired, applied } = setup(() => d.promise);
    three(guard);
    await vi.advanceTimersByTimeAsync(DEFAULT_DECISION_TIMEOUT_MS - 1);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([{ kind: "model_calls", limit: 2, observed: 3 }]);
    d.resolve(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);
    expect(guard.current().maxModelCalls).toBe(2);
    expect(DEFAULT_DECISION_TIMEOUT_MS).toBe(30_000);
  });
});

describe("MP-SRC: the guard reads no file", () => {
  it("meteringGuard.ts, comments stripped, names no file read", () => {
    const source = readFileSync(path.join(here, "..", "src", "meteringGuard.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/readFile|downloadFile|runCommand|node:fs|process\.env/);
  });
});
