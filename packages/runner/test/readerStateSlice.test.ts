import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_LIMITS, LineOutputBudget } from "../src/agentOutput.js";
import { SNAPSHOT_ID_WINDOW, createRunGuard, createUsageMeter, resolveRunLimits } from "../src/meteringGuard.js";
import {
  STATE_MAX_BYTES,
  TAIL_STATE_MAX_BYTES,
  buildReaderState,
  cursorSeqOfRow,
  jsonbText,
  parseOutputBudget,
  parsePortReaderState,
  parseReaderState,
  parseSavedAbort,
  rowSeqOfCursor,
  snapshotMeterLedger,
  tailStateBytes,
  type PortReaderState,
} from "../src/readerState.js";
import { RecordLedger } from "../src/vercelSandboxPort.js";
import { acceptRecords } from "../src/recordParser.js";
import { recordFile } from "./helpers/recorderSdk.js";

const port = (): PortReaderState => ({
  file: { count: 3, chain: "ab".repeat(32) },
  trailer: { seq: 9, code: 0, sig: null, lines: 8, bytes: 120 },
  seq: 4,
  lastResult: { type: "result", isError: false, sessionId: "s1", costUsd: 0.5, usage: { inputTokens: 1, outputTokens: 2 }, agentOutput: { verdict: "pass" } },
  lastEnvelope: { verdict: "pass" },
  lastResultSubtype: "success",
});

describe("RLR-4 the port's reader state and the output budget in the saved state", () => {
  it("a reader state survives JSON and is read back as it was", () => {
    expect(parsePortReaderState(JSON.parse(JSON.stringify(port())))).toEqual(port());
    const empty: PortReaderState = { file: { count: 0, chain: "0".repeat(64) }, trailer: null, seq: 0, lastResult: null, lastEnvelope: null, lastResultSubtype: null };
    expect(parsePortReaderState(JSON.parse(JSON.stringify(empty)))).toEqual(empty);
  });

  it("refuses a malformed one: a chain that is not a digest, a count that is not a count, a trailer that is not one, a result of an unknown type", () => {
    const bad: Array<(s: PortReaderState) => unknown> = [
      (s) => ({ ...s, file: { count: 3, chain: "xyz" } }),
      (s) => ({ ...s, file: { count: -1, chain: "ab".repeat(32) } }),
      (s) => ({ ...s, file: null }),
      (s) => ({ ...s, trailer: { seq: "9" } }),
      (s) => ({ ...s, seq: 1.5 }),
      (s) => ({ ...s, lastResult: { type: "assistant" } }),
      (s) => ({ ...s, lastEnvelope: [] }),
      (s) => ({ ...s, lastResultSubtype: 4 }),
    ];
    for (const make of bad) expect(() => parsePortReaderState(make(port()))).toThrow(/reader state/);
    expect(() => parsePortReaderState(null)).toThrow(/reader state/);
  });

  it("the saved state is checked in full on the way in: a bad part or a bad session id stops the reader", () => {
    const base = { v: 1, usage: {}, guard: {}, ledger: {} };
    expect(parseReaderState({ ...base, reader: port(), out: { rows: 1, bytes: 2, capped: false, droppedMessages: 0, droppedBytes: 0 }, cc: "s1" })).toBeTruthy();
    expect(() => parseReaderState({ ...base, reader: { ...port(), seq: -1 } })).toThrow(/reader state/);
    expect(() => parseReaderState({ ...base, out: { rows: 1 } })).toThrow(/reader state/);
    expect(() => parseReaderState({ ...base, cc: "bad id with spaces" })).toThrow(/session id/);
    expect(() => parseOutputBudget({ rows: 1, bytes: 1, capped: "no", droppedMessages: 0, droppedBytes: 0 })).toThrow(/reader state/);
  });
});

describe("RLR-4 the reader row's 1-based next_seq against the parser's 0-based cursor (one helper)", () => {
  it("a fresh row (column 1) is the header next (cursor 0); after the header alone the column is 2 and the cursor 1; the two functions are inverses", () => {
    expect(cursorSeqOfRow(1)).toBe(0);
    expect(rowSeqOfCursor(0)).toBe(1);
    expect(rowSeqOfCursor(1)).toBe(2);
    expect(cursorSeqOfRow(2)).toBe(1);
    for (const n of [0, 1, 2, 57]) expect(cursorSeqOfRow(rowSeqOfCursor(n))).toBe(n);
  });
});

describe("RLR-4 the file ledger that continues across slices", () => {
  const records = acceptRecords(recordFile("run-1", ["a", "b", "c", "d"]), 0).records;

  it("a ledger continued from a saved (count, chain) reaches the same chain as one that saw every record, and has digests only for its own", () => {
    const whole = new RecordLedger();
    for (const r of records) whole.add(r);
    const first = new RecordLedger();
    for (const r of records.slice(0, 3)) first.add(r);
    const resumed = new RecordLedger(JSON.parse(JSON.stringify(first.state())) as { count: number; chain: string });
    for (const r of records.slice(3)) resumed.add(r);
    expect(resumed.hash()).toBe(whole.hash());
    expect(resumed.count).toBe(whole.count);
    expect(resumed.partial).toBe(true);
    expect(whole.partial).toBe(false);
    expect(resumed.at(2)).toBeUndefined();
    expect(resumed.at(3)).toEqual(whole.at(3));
  });

  it("a different record, a missing record or a different order gives a different chain", () => {
    const hashOf = (rs: typeof records): string => {
      const l = new RecordLedger();
      for (const r of rs) l.add(r);
      return l.hash();
    };
    const full = hashOf(records);
    expect(hashOf(records.slice(0, 4))).not.toBe(full);
    expect(hashOf([records[1]!, records[0]!, ...records.slice(2)])).not.toBe(full);
    const other = acceptRecords(recordFile("run-1", ["a", "b", "X", "d"]), 0).records;
    expect(hashOf(other)).not.toBe(full);
  });
});

describe("RLR-4 the output budget of a sliced run keeps the in-process writer's caps", () => {
  it("counts rows and bytes, drops once a cap is hit and stays dropped, and continues from a saved state", () => {
    const b = new LineOutputBudget();
    for (let i = 0; i < AGENT_OUTPUT_LIMITS.maxRows; i++) expect(b.admit(`line ${i}`)).toEqual({ text: `line ${i}` });
    expect(b.admit("one too many")).toBeUndefined();
    expect(b.droppedMessages).toBe(1);
    expect(b.admit("x")).toBeUndefined(); // once capped, always capped
    expect(b.state()).toMatchObject({ rows: AGENT_OUTPUT_LIMITS.maxRows, capped: true, droppedMessages: 2 });
    const resumed = new LineOutputBudget(JSON.parse(JSON.stringify(b.state())) as ReturnType<LineOutputBudget["state"]>);
    expect(resumed.admit("still no")).toBeUndefined();
    expect(resumed.droppedMessages).toBe(3);
  });

  it("an empty text is no row; a text over the per-message cap is stored cut, with its original size", () => {
    const b = new LineOutputBudget();
    expect(b.admit("")).toBeUndefined();
    expect(b.state().rows).toBe(0);
    const big = "y".repeat(AGENT_OUTPUT_LIMITS.maxMessageBytes + 10);
    expect(b.admit(big)).toMatchObject({ truncated: true, original_bytes: big.length });
  });

  it("the run's byte cap holds: a message that would pass it is dropped, a smaller one before it was kept", () => {
    const b = new LineOutputBudget({ rows: 10, bytes: AGENT_OUTPUT_LIMITS.maxRunBytes - 5, capped: false, droppedMessages: 0, droppedBytes: 0 });
    expect(b.admit("12345")).toEqual({ text: "12345" });
    expect(b.admit("1")).toBeUndefined();
  });
});

describe("RLR-4 the first end the runner decided is saved with the state", () => {
  const base = { v: 1, usage: {}, guard: {}, ledger: {} };
  const kinds = [
    { kind: "implausible" },
    { kind: "model_key_broken", code: 401 },
    { kind: "model_key_broken", code: "credits_exhausted" },
    { kind: "spend_kill", cause: "monthly_budget" },
    { kind: "spend_kill", cause: "per_run_cap", limit: { kind: "per_run_usd", limit: 5, observed: 5.5 } },
    { kind: "limit", limit: { kind: "turns", limit: 17, observed: 17 }, reportedUsd: 0.5 },
  ];

  it("each kind survives JSON and is read back as it was", () => {
    for (const a of kinds) {
      expect(parseSavedAbort(JSON.parse(JSON.stringify(a)))).toEqual(a);
      expect(parseReaderState({ ...base, abort: a }).abort).toEqual(a);
    }
  });

  it("a malformed one stops the reader instead of being taken for no end at all", () => {
    const bad: unknown[] = [
      null,
      "spend_kill",
      { kind: "other" },
      { kind: "model_key_broken", code: 500 },
      { kind: "spend_kill", cause: "free" },
      { kind: "spend_kill", cause: "per_run_cap", limit: { kind: "per_run_usd", limit: "5", observed: 1 } },
      { kind: "limit", limit: { kind: "nope", limit: 1, observed: 1 } },
      { kind: "limit", limit: { kind: "turns", limit: 1, observed: 1 }, reportedUsd: "x" },
    ];
    for (const a of bad) expect(() => parseSavedAbort(a)).toThrow(/reader state/);
    expect(() => parseReaderState({ ...base, abort: { kind: "other" } })).toThrow(/reader state/);
  });
});

describe("RLR-4 the verdict's share of the state column fits at the worst case, measured as jsonb prints it", () => {
  it("the whole state with full windows of hostile ids and the longest figures, plus a verdict at its bound, is under the column's limit", () => {
    const usage = createUsageMeter({ maxLineInputSideTokens: Number.MAX_VALUE, maxLineOutputTokens: Number.MAX_VALUE });
    const guard = createRunGuard(resolveRunLimits({ maxModelCalls: 5000 }), () => undefined);
    const shapes = [(i: number) => `${i}${"\u0001".repeat(128)}`, (i: number) => `${i}${'"'.repeat(200)}`, (i: number) => `msg_${i}${"a".repeat(60)}`];
    for (let i = 0; i < 600; i++) {
      const line = { type: "assistant" as const, messageId: shapes[i % shapes.length]!(i), usage: { inputTokens: 1e300, outputTokens: 1.2345678901234567e-300, cacheWriteTokens: 9.87654321e-299, cacheReadTokens: 1e300 } };
      usage.observe(line);
      guard.observe(line);
    }
    const ledger = snapshotMeterLedger({
      meteredTokens: { inputTokens: 1e300, outputTokens: 1e-300, cacheWriteTokens: 1e-300, cacheReadTokens: 1e300 },
      modelTokens: new Map([["haiku-4.5", { inputTokens: 1e300, outputTokens: 1e-300, cacheWriteTokens: 0, cacheReadTokens: 0 }]]),
      meterFlags: new Set(["implausible_usage", "reported_below_metered", "unknown_message_model"]),
      cumulativeModelUsd: 1e-300,
    });
    // A verdict just under its bound, made of the longest-printing figures: the last result and the envelope carry the same document.
    const values: number[] = [];
    const doc = (): { verdict: string; n: number[] } => ({ verdict: "pass", n: values });
    while (tailStateBytes({ type: "result", agentOutput: doc() }, doc()) < TAIL_STATE_MAX_BYTES - 700) values.push(1e300);
    const tail = tailStateBytes({ type: "result", agentOutput: doc() }, doc());
    expect(tail).toBeLessThanOrEqual(TAIL_STATE_MAX_BYTES);
    const reader: PortReaderState = {
      file: { count: 10 ** 9, chain: "ab".repeat(32) },
      trailer: { seq: 10 ** 9, code: -1, sig: "SIGTERM", lines: 10 ** 9, bytes: 10 ** 9 },
      seq: 10 ** 9,
      lastResult: { type: "result", isError: false, sessionId: "s".repeat(128), costUsd: 1e300, usage: { inputTokens: 1e300 }, agentOutput: doc() },
      lastEnvelope: doc(),
      lastResultSubtype: "success",
    };
    const state = buildReaderState({ usage: usage.snapshot(), guard: guard.snapshot(), ledger, reader, out: { rows: 1e9, bytes: 1e9, capped: true, droppedMessages: 1e9, droppedBytes: 1e9 }, cc: "c".repeat(128) });
    expect(state.usage.ids).toHaveLength(SNAPSHOT_ID_WINDOW);
    expect(Buffer.byteLength(jsonbText(state))).toBeLessThan(STATE_MAX_BYTES);
  });

  it("a verdict one value past the bound is over it, and the same document counted as plain JSON would have passed", () => {
    const values: number[] = [];
    while (tailStateBytes(null, { n: values }) <= TAIL_STATE_MAX_BYTES) values.push(1e300);
    expect(tailStateBytes(null, { n: values })).toBeGreaterThan(TAIL_STATE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify([null, { n: values }]))).toBeLessThan(TAIL_STATE_MAX_BYTES / 10);
  });
});
