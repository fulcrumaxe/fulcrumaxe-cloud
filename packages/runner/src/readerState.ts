import type { RunLimit } from "./executionTarget.js";
import type { GuardSnapshot, TokenTotals, UsageMeterSnapshot } from "./meteringGuard.js";
import type { ModelFailureCode } from "./modelFailure.js";

/**
 * D#2 RLR-2 (run-log reader design, Round 3, B3): what a reader saves in `run_log_readers.state` and
 * `.side_effects`, and how it reads them back. Pure functions over plain data: no clock, no database, no file.
 *
 * Three rules hold for everything here.
 * - Bounded. The `state` column refuses more than 256 KiB (migration 0697), so `buildReaderState` refuses first,
 *   with a fixed error, rather than let a commit fail in the database.
 * - Restore throws on a malformed value. A checkpoint that cannot be read must stop the reader; it must never
 *   resume as though the run had spent nothing.
 * - Side effects that left the process only ever turn on. `mergeSideEffects` is how a reader folds what it did
 *   since its last checkpoint into what is stored, so replaying a line never sends a second warning.
 */

/** The `state` column's ceiling, the same figure as the table's CHECK. */
export const STATE_MAX_BYTES = 262_144;

/**
 * THE one place the reader row's `next_seq` is converted. The column is 1-based (migration 0697: default 1, CHECK >= 1), while the record file's header is seq 0
 * and the parser's first expected seq is 0. A fresh row (next_seq 1, byte_offset 0) therefore means "the header is next"; after the header alone it is 2.
 */
export const rowSeqOfCursor = (parserNextSeq: number): number => parserNextSeq + 1;
export const cursorSeqOfRow = (rowNextSeq: number): number => rowNextSeq - 1;

/** The meter's bookkeeping the sandbox target keeps per run; structural, so `RunBookkeeping` satisfies it as it is. */
export interface MeterLedger<M extends string = string> {
  meteredTokens: TokenTotals;
  modelTokens: Map<M, TokenTotals>;
  meterFlags: Set<string>;
  cumulativeModelUsd: number;
}

export interface MeterLedgerSnapshot {
  meteredTokens: TokenTotals;
  modelTokens: Array<[string, TokenTotals]>;
  meterFlags: string[];
  cumulativeModelUsd: number;
}

const FIELDS = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"] as const;
const MAX_LEDGER_MODELS = 32;
const MAX_LEDGER_FLAGS = 16;
/** Model ids and meter flags are runner-made names; anything else is refused, so no odd text reaches the state. */
const LEDGER_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function totals(value: unknown, what: string): TokenTotals {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null) throw new Error(`reader state: ${what} is not an object`);
  const out = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  for (const f of FIELDS) {
    const n = v[f];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`reader state: ${what}.${f} is not a count`);
    out[f] = n;
  }
  return out;
}

export function snapshotMeterLedger(ledger: MeterLedger): MeterLedgerSnapshot {
  // The caps restore enforces, so a snapshot that was written can always be read back.
  if (ledger.modelTokens.size > MAX_LEDGER_MODELS || ledger.meterFlags.size > MAX_LEDGER_FLAGS) throw new Error("reader state: ledger is too large");
  for (const model of ledger.modelTokens.keys()) if (!LEDGER_NAME.test(model)) throw new Error("reader state: bad model entry");
  for (const flag of ledger.meterFlags) if (!LEDGER_NAME.test(flag)) throw new Error("reader state: bad meter flag");
  return {
    meteredTokens: { ...ledger.meteredTokens },
    modelTokens: [...ledger.modelTokens].map(([model, t]): [string, TokenTotals] => [model, { ...t }]),
    meterFlags: [...ledger.meterFlags].sort(),
    cumulativeModelUsd: ledger.cumulativeModelUsd,
  };
}

/** Writes a snapshot into `target`. The flags are merged in, not replaced: a flag already raised stays raised. */
export function restoreMeterLedger<M extends string>(raw: unknown, target: MeterLedger<M>): void {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || !Array.isArray(r.modelTokens) || !Array.isArray(r.meterFlags)) throw new Error("reader state: ledger is not a snapshot");
  if (r.modelTokens.length > MAX_LEDGER_MODELS || r.meterFlags.length > MAX_LEDGER_FLAGS) throw new Error("reader state: ledger is too large");
  const usd = r.cumulativeModelUsd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) throw new Error("reader state: cumulativeModelUsd is not an amount");
  const metered = totals(r.meteredTokens, "meteredTokens");
  const models = r.modelTokens.map((e): [M, TokenTotals] => {
    if (!Array.isArray(e) || typeof e[0] !== "string" || !LEDGER_NAME.test(e[0])) throw new Error("reader state: bad model entry");
    return [e[0] as M, totals(e[1], "modelTokens")];
  });
  const flags = r.meterFlags.map((f) => {
    if (typeof f !== "string" || !LEDGER_NAME.test(f)) throw new Error("reader state: bad meter flag");
    return f;
  });
  target.meteredTokens = metered;
  target.modelTokens = new Map(models);
  for (const f of flags) target.meterFlags.add(f);
  target.cumulativeModelUsd = usd;
}

/**
 * What the reader has done that cannot be undone, plus the extension bookkeeping those effects belong to.
 * Each warning is per window: an extension of its kind re-opens the window and warns again (a `run_time`
 * extension re-opens the time warning, a `model_calls` one the call warning). A flag is therefore ordered by
 * (its window count, then the flag): a later window wins outright, the same window ORs.
 */
export interface SideEffects {
  /** In-run extensions granted (X-4), both kinds. */
  extensionsUsed: number;
  /** The gh-write count and distinct-id count at the last extension (the next one needs progress past them). */
  ghAtLast: number;
  idsAtLast: number;
  /** W-2: `model_calls` extensions so far, and whether the call-limit warning was written since the last. */
  callsWindow: number;
  callsWarned: boolean;
  /** W-1: `run_time` extensions so far, and whether the time warning was written since the last. */
  timeWindow: number;
  timeWarned: boolean;
  /** The runner stopped the command at a limit. */
  killIssued: boolean;
}

export function createSideEffects(): SideEffects {
  return { extensionsUsed: 0, ghAtLast: 0, idsAtLast: 0, callsWindow: 0, callsWarned: false, timeWindow: 0, timeWarned: false, killIssued: false };
}

/** An extension was applied: count it, remember what it was measured against, and re-open that kind's warning. */
export function recordExtension(fx: SideEffects, kind: "run_time" | "model_calls", at: { ghWrites: number; messageIds: number }): void {
  fx.extensionsUsed += 1;
  fx.ghAtLast = at.ghWrites;
  fx.idsAtLast = at.messageIds;
  if (kind === "run_time") {
    fx.timeWindow += 1;
    fx.timeWarned = false;
  } else {
    fx.callsWindow += 1;
    fx.callsWarned = false;
  }
}

const warnedOf = (aWindow: number, aFlag: boolean, bWindow: number, bFlag: boolean): [number, boolean] =>
  aWindow === bWindow ? [aWindow, aFlag || bFlag] : aWindow > bWindow ? [aWindow, aFlag] : [bWindow, bFlag];

export function mergeSideEffects(a: SideEffects, b: SideEffects): SideEffects {
  const newer = a.extensionsUsed >= b.extensionsUsed ? a : b;
  // Two records with the same count describe the same extensions; both figures only ever grow, so the larger is the later.
  const tie = a.extensionsUsed === b.extensionsUsed;
  const [callsWindow, callsWarned] = warnedOf(a.callsWindow, a.callsWarned, b.callsWindow, b.callsWarned);
  const [timeWindow, timeWarned] = warnedOf(a.timeWindow, a.timeWarned, b.timeWindow, b.timeWarned);
  return {
    extensionsUsed: newer.extensionsUsed,
    ghAtLast: tie ? Math.max(a.ghAtLast, b.ghAtLast) : newer.ghAtLast,
    idsAtLast: tie ? Math.max(a.idsAtLast, b.idsAtLast) : newer.idsAtLast,
    callsWindow,
    callsWarned,
    timeWindow,
    timeWarned,
    killIssued: a.killIssued || b.killIssued,
  };
}

export function parseSideEffects(raw: unknown): SideEffects {
  if (typeof raw !== "object" || raw === null) throw new Error("reader state: side effects are not an object");
  // The run's stored slice facts (RLR-5) share the column; they are no side effect and are read by their own parser.
  const { facts: _facts, ...r } = raw as Record<string, unknown>;
  // A row's default is `{}`: nothing has happened yet.
  if (Object.keys(r).length === 0) return createSideEffects();
  const count = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`reader state: ${what} is not a count`);
    return v;
  };
  const flag = (v: unknown, what: string): boolean => {
    if (typeof v !== "boolean") throw new Error(`reader state: ${what} is not a boolean`);
    return v;
  };
  return {
    extensionsUsed: count(r.extensionsUsed, "extensionsUsed"),
    ghAtLast: count(r.ghAtLast, "ghAtLast"),
    idsAtLast: count(r.idsAtLast, "idsAtLast"),
    callsWindow: count(r.callsWindow, "callsWindow"),
    callsWarned: flag(r.callsWarned, "callsWarned"),
    timeWindow: count(r.timeWindow, "timeWindow"),
    timeWarned: flag(r.timeWarned, "timeWarned"),
    killIssued: flag(r.killIssued, "killIssued"),
  };
}

/** The fixed fields of the last `result` line, kept so a later slice can build the run's end. No text. */
export interface LastResultState {
  type: "result" | "error";
  isError?: boolean;
  sessionId?: string;
  costUsd?: number;
  usage?: Record<string, number>;
  agentOutput?: Record<string, unknown>;
}

/**
 * D#2 RLR-4: the port's own reader state across slices. `file` is the count and a chain hash of the record digests consumed so far (the exit cross-check
 * re-reads the agent-writable file and trusts it only if its consumed prefix gives this same pair); `trailer` is the trailer once consumed; the rest is what
 * the run's end is built from.
 */
export interface PortReaderState {
  file: { count: number; chain: string };
  trailer: { seq: number; code: number | null; sig: string | null; lines: number; bytes: number } | null;
  seq: number;
  lastResult: LastResultState | null;
  lastEnvelope: Record<string, unknown> | null;
  lastResultSubtype: string | null;
}

/** The caps that keep the `agent.output` rows of a sliced run to what the in-process writer would store; counted over committed rows only. */
export interface OutputBudgetState {
  rows: number;
  bytes: number;
  capped: boolean;
  droppedMessages: number;
  droppedBytes: number;
}

const isCountN = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseOutputBudget(raw: unknown): OutputBudgetState {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) throw new Error("reader state: out is not an object");
  const { rows, bytes, capped, droppedMessages, droppedBytes } = r;
  if (!isCountN(rows) || !isCountN(bytes) || typeof capped !== "boolean" || !isCountN(droppedMessages) || !isCountN(droppedBytes)) throw new Error("reader state: bad out");
  return { rows, bytes, capped, droppedMessages, droppedBytes };
}

export function parsePortReaderState(raw: unknown): PortReaderState {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) throw new Error("reader state: reader is not an object");
  const file = r.file as Record<string, unknown> | null;
  if (typeof file !== "object" || file === null || !isCountN(file.count) || typeof file.chain !== "string" || !/^[0-9a-f]{64}$/.test(file.chain)) throw new Error("reader state: bad file chain");
  let trailer: PortReaderState["trailer"] = null;
  if (r.trailer !== null) {
    const t = r.trailer as Record<string, unknown> | undefined;
    if (typeof t !== "object" || t === null || !isCountN(t.seq) || !isCountN(t.lines) || !isCountN(t.bytes)) throw new Error("reader state: bad trailer");
    if (!(t.code === null || (typeof t.code === "number" && Number.isInteger(t.code))) || !(t.sig === null || typeof t.sig === "string")) throw new Error("reader state: bad trailer");
    trailer = { seq: t.seq, code: t.code as number | null, sig: t.sig as string | null, lines: t.lines, bytes: t.bytes };
  }
  const obj = (v: unknown, what: string): Record<string, unknown> | null => {
    if (v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) throw new Error(`reader state: bad ${what}`);
    return v as Record<string, unknown>;
  };
  const lr = obj(r.lastResult, "lastResult") as LastResultState | null;
  if (lr !== null && lr.type !== "result" && lr.type !== "error") throw new Error("reader state: bad lastResult");
  if (!isCountN(r.seq)) throw new Error("reader state: bad seq");
  if (r.lastResultSubtype !== null && typeof r.lastResultSubtype !== "string") throw new Error("reader state: bad subtype");
  return { file: { count: file.count, chain: file.chain }, trailer, seq: r.seq, lastResult: lr, lastEnvelope: obj(r.lastEnvelope, "lastEnvelope"), lastResultSubtype: r.lastResultSubtype as string | null };
}

/**
 * The verdict a later slice builds the run's end from (the last result and the last envelope) may take at most this much of the state column, measured the way
 * jsonb prints it. The rest of the state at its worst (full id windows of hostile ids, the longest figures) is about 96 KB, so the whole stays under the column's
 * 256 KiB with room to spare; a verdict that does not fit ends the run as `reader_unavailable`.
 */
export const TAIL_STATE_MAX_BYTES = 96 * 1024;

export function tailStateBytes(lastResult: unknown, lastEnvelope: unknown): number {
  return Buffer.byteLength(jsonbText([lastResult, lastEnvelope]));
}

/** The first reason the runner itself ended a run, kept so a reader that takes the run over ends it for the same reason (the shape of the target's `RunAbortReason`). */
export type SavedAbort =
  | { kind: "model_key_broken"; code: ModelFailureCode }
  | { kind: "spend_kill"; cause: "per_run_cap" | "monthly_budget"; limit?: RunLimit }
  | { kind: "limit"; limit: RunLimit; reportedUsd?: number }
  | { kind: "implausible" };

const LIMIT_KINDS = new Set(["run_time", "model_calls", "per_run_usd", "turns", "silence"]);

function parseSavedLimit(raw: unknown): RunLimit {
  const l = raw as Record<string, unknown> | null;
  if (typeof l !== "object" || l === null || typeof l.kind !== "string" || !LIMIT_KINDS.has(l.kind) || typeof l.limit !== "number" || !Number.isFinite(l.limit) || typeof l.observed !== "number" || !Number.isFinite(l.observed)) {
    throw new Error("reader state: bad abort limit");
  }
  return { kind: l.kind as RunLimit["kind"], limit: l.limit, observed: l.observed };
}

export function parseSavedAbort(raw: unknown): SavedAbort {
  const a = raw as Record<string, unknown> | null;
  if (typeof a !== "object" || a === null) throw new Error("reader state: bad abort");
  switch (a.kind) {
    case "implausible":
      return { kind: "implausible" };
    case "model_key_broken":
      if (a.code !== 401 && a.code !== 403 && a.code !== "credits_exhausted") throw new Error("reader state: bad abort code");
      return { kind: "model_key_broken", code: a.code };
    case "spend_kill":
      if (a.cause !== "per_run_cap" && a.cause !== "monthly_budget") throw new Error("reader state: bad abort cause");
      return { kind: "spend_kill", cause: a.cause, ...(a.limit !== undefined && { limit: parseSavedLimit(a.limit) }) };
    case "limit":
      if (a.reportedUsd !== undefined && (typeof a.reportedUsd !== "number" || !Number.isFinite(a.reportedUsd))) throw new Error("reader state: bad abort figure");
      return { kind: "limit", limit: parseSavedLimit(a.limit), ...(a.reportedUsd !== undefined && { reportedUsd: a.reportedUsd }) };
    default:
      throw new Error("reader state: bad abort kind");
  }
}

/** The `state` document: versioned so a later change can refuse an older shape instead of misreading it. */
export interface ReaderState {
  v: 1;
  /** The per-command usage meter the sandbox target prices from. */
  usage: UsageMeterSnapshot;
  guard: GuardSnapshot;
  ledger: MeterLedgerSnapshot;
  /** RLR-4: absent in a state written before the sliced reader. */
  reader?: PortReaderState;
  out?: OutputBudgetState;
  /** The first end the runner itself decided (a spend kill, a broken key, an implausible line), saved with the checkpoint after it so a takeover ends the run the same way. */
  abort?: SavedAbort;
  /** The Claude Code session id the stream last reported (what a limit end's checkpoint resumes from). */
  cc?: string;
}

/** A number as jsonb prints it: plain decimal digits, never an exponent (so 1e300 is 301 characters). */
function plainNumber(n: number): string {
  const text = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (m === null) return text;
  const [, sign, whole, frac = "", exp] = m as unknown as [string, string, string, string | undefined, string];
  const digits = whole + frac;
  const point = whole.length + Number(exp);
  return sign + (point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`);
}

/** `value::text` as Postgres prints a jsonb document: a space after every `:` and `,`, numbers in plain notation. */
export function jsonbText(value: unknown): string {
  if (typeof value === "number") return plainNumber(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function buildReaderState(parts: Omit<ReaderState, "v">): ReaderState {
  const state: ReaderState = { v: 1, ...parts };
  // Measured the way the column's CHECK measures it, not as JSON.stringify prints it.
  const bytes = Buffer.byteLength(jsonbText(state));
  if (bytes > STATE_MAX_BYTES) throw new Error(`reader state is ${bytes} bytes, over the ${STATE_MAX_BYTES} byte limit`);
  return state;
}

/** Checks the shape's outer parts; each part is validated in full by the restore that consumes it. */
export function parseReaderState(raw: unknown): ReaderState {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || r.v !== 1) throw new Error("reader state: unknown version");
  for (const k of ["usage", "guard", "ledger"] as const) {
    if (typeof r[k] !== "object" || r[k] === null) throw new Error(`reader state: ${k} is missing`);
  }
  if (r.cc !== undefined && (typeof r.cc !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.cc))) throw new Error("reader state: bad session id");
  // RLR-4: the parts a sliced reader adds are checked in full here, so a state that cannot be read stops the reader rather than resuming from nothing.
  if (r.reader !== undefined) parsePortReaderState(r.reader);
  if (r.out !== undefined) parseOutputBudget(r.out);
  if (r.abort !== undefined) parseSavedAbort(r.abort);
  return r as unknown as ReaderState;
}
