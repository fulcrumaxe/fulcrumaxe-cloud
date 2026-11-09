import type { GuardSnapshot, TokenTotals, UsageMeterSnapshot } from "./meteringGuard.js";

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
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) throw new Error("reader state: side effects are not an object");
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

/** The `state` document: versioned so a later change can refuse an older shape instead of misreading it. */
export interface ReaderState {
  v: 1;
  /** The per-command usage meter the sandbox target prices from. */
  usage: UsageMeterSnapshot;
  guard: GuardSnapshot;
  ledger: MeterLedgerSnapshot;
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
  return r as unknown as ReaderState;
}
