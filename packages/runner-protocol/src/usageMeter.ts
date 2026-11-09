import { createHash } from "node:crypto";
import type { NormalizedEvent } from "./agentRuntime.js";

/** The per-message usage meter, shared by the sandbox runner (meteringGuard) and the local runner so both count a run the same way. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

const FIELDS = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"] as const;

const zero = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });

/** A usable count is a finite, non-negative number; anything else counts 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * MP-PLAUS / S7 (C59 §3): no single stdout line may raise the metered total
 * by more than these, and an `assistant` line reporting more is a kill. They
 * are the largest context window and the largest max output of any priced
 * model. PROVISIONAL: H18 confirms both against Anthropic's model docs.
 */
export const MAX_LINE_INPUT_SIDE_TOKENS = 1_000_000;
export const MAX_LINE_OUTPUT_TOKENS = 128_000;
/** W1: a memory bound on distinct message ids the meter holds, zero-usage ones included. */
export const MAX_METERED_IDS = 10_000;

/** A final figure this far below the metered one is flagged (MP-PLAUS). */
const REPORTED_BELOW_FACTOR = 0.95;

const inputSide = (t: Pick<TokenTotals, "inputTokens" | "cacheWriteTokens" | "cacheReadTokens">): number =>
  t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens;

/**
 * RLR-2: a snapshot carries the newest `SNAPSHOT_ID_WINDOW` message ids. Older ones are forgotten, which can only
 * over-count a repeat of one.
 *
 * Ids come from a process that may be hostile, so the meter never keeps or stores one as it arrived. `messageIdKey`
 * keeps a short id of plain characters as it is and replaces any other with a fixed-length SHA-256 digest, so a
 * stored key is at most 64 plain ASCII characters: its size does not depend on the id, it needs no JSON escaping,
 * and it is always storable in jsonb (no NUL, no lone surrogate).
 */
export const SNAPSHOT_ID_WINDOW = 256;
const PLAIN_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DIGEST_KEY = /^#[0-9a-f]{32}$/;

export function messageIdKey(id: string): string {
  return PLAIN_ID.test(id) ? id : `#${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32)}`;
}

/** True for a key `messageIdKey` can produce (a plain id, or a digest key); what a snapshot may hold. */
export const isStoredKey = (key: unknown): key is string => typeof key === "string" && (PLAIN_ID.test(key) || DIGEST_KEY.test(key));

/** The newest `SNAPSHOT_ID_WINDOW` entries, oldest first. */
export function newestWithinWindow<T>(entries: readonly T[]): T[] {
  return entries.slice(-SNAPSHOT_ID_WINDOW);
}

/** Held figures are stored whole and capped (rounding down only ever over-counts a repeat), so a hostile figure cannot grow the state. */
const storedCount = (n: number): number => Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);

/**
 * RLR-2: the meter's state as plain JSON, small enough for a reader's checkpoint (at most `SNAPSHOT_ID_WINDOW`
 * ids, each with four numbers). A meter built with `restore` decides as the original would have.
 */
export interface UsageMeterSnapshot {
  /** The newest message ids and each one's per-field maximum, oldest first. */
  ids: Array<[string, TokenTotals]>;
  /** Distinct ids ever held, the forgotten ones included: the `maxIds` bound counts them. */
  idsSeen: number;
  summed: TokenTotals;
  cumulative: TokenTotals;
  total: TokenTotals;
  sawCumulative: boolean;
  killed: boolean;
  clamped: boolean;
}

export interface UsageMeterOptions {
  maxLineInputSideTokens?: number;
  maxLineOutputTokens?: number;
  maxIds?: number;
  /** Start from a state `snapshot()` produced. It is validated: a malformed one throws, so a bad checkpoint never meters from zero. */
  restore?: unknown;
}

function totalsFrom(value: unknown, what: string): TokenTotals {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null) throw new Error(`usage meter snapshot: ${what} is not an object`);
  const out = zero();
  for (const f of FIELDS) {
    const n = v[f];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`usage meter snapshot: ${what}.${f} is not a count`);
    out[f] = n;
  }
  return out;
}

function parseSnapshot(raw: unknown): UsageMeterSnapshot {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || !Array.isArray(r.ids)) throw new Error("usage meter snapshot: not a snapshot");
  if (r.ids.length > SNAPSHOT_ID_WINDOW) throw new Error("usage meter snapshot: too many ids");
  const ids = r.ids.map((entry): [string, TokenTotals] => {
    if (!Array.isArray(entry) || !isStoredKey(entry[0])) throw new Error("usage meter snapshot: bad id entry");
    return [entry[0], totalsFrom(entry[1], "id")];
  });
  const idsSeen = r.idsSeen;
  if (new Set(ids.map(([id]) => id)).size !== ids.length) throw new Error("usage meter snapshot: duplicate ids");
  if (typeof idsSeen !== "number" || !Number.isSafeInteger(idsSeen) || idsSeen < ids.length) throw new Error("usage meter snapshot: bad idsSeen");
  for (const k of ["sawCumulative", "killed", "clamped"] as const) {
    if (typeof r[k] !== "boolean") throw new Error(`usage meter snapshot: ${k} is not a boolean`);
  }
  return {
    ids,
    idsSeen,
    summed: totalsFrom(r.summed, "summed"),
    cumulative: totalsFrom(r.cumulative, "cumulative"),
    total: totalsFrom(r.total, "total"),
    sawCumulative: r.sawCumulative as boolean,
    killed: r.killed as boolean,
    clamped: r.clamped as boolean,
  };
}

/** What one line added: the new total and the (clamped) increase. */
export interface MeterRise {
  total: TokenTotals;
  delta: TokenTotals;
}

export interface UsageMeter {
  /**
   * Feeds one event. Returns the new metered token total when it rose in
   * any field, and `undefined` when the event added nothing (no usage, a
   * repeat, or a figure at or below what is already held).
   */
  observe(event: Pick<NormalizedEvent, "type" | "messageId" | "usage">): TokenTotals | undefined;
  /** Like `observe`, with the increase this one line added (for pricing it). */
  observeRise(event: Pick<NormalizedEvent, "type" | "messageId" | "usage">): MeterRise | undefined;
  /** The metered token total so far. */
  total(): TokenTotals;
  /** True once an `assistant` line, or the id count, was implausible: the run is to be killed. */
  implausible(): boolean;
  /** `implausible_usage` and `reported_below_metered`, when they apply. */
  flags(): string[];
  /** RLR-2: the state as JSON, bounded to `SNAPSHOT_ID_WINDOW` ids. Does not change the meter. */
  snapshot(): UsageMeterSnapshot;
}

export function createUsageMeter(options: UsageMeterOptions = {}): UsageMeter {
  const maxIn = options.maxLineInputSideTokens ?? MAX_LINE_INPUT_SIDE_TOKENS;
  const maxOut = options.maxLineOutputTokens ?? MAX_LINE_OUTPUT_TOKENS;
  const maxIds = options.maxIds ?? MAX_METERED_IDS;
  const perId = new Map<string, TokenTotals>();
  /** Sum over ids of each id's per-field maximum, plus anonymous usage. */
  const summed = zero();
  /** The highest cumulative figure a `result` line has reported. */
  const cumulative = zero();
  let total = zero();
  let sawCumulative = false;
  let killed = false;
  let clamped = false;
  /** Distinct ids held; equals `perId.size` unless a restore dropped older ids from the map. */
  let idsSeen = 0;
  if (options.restore !== undefined) {
    const snap = parseSnapshot(options.restore);
    for (const [id, held] of snap.ids) perId.set(id, held);
    idsSeen = snap.idsSeen;
    Object.assign(summed, snap.summed);
    Object.assign(cumulative, snap.cumulative);
    total = snap.total;
    sawCumulative = snap.sawCumulative;
    killed = snap.killed;
    clamped = snap.clamped;
  }

  /** Caps one line's increase per side; the input side is filled in field order. */
  function clampRise(next: TokenTotals, bounded: boolean): TokenTotals {
    if (!bounded) return FIELDS.reduce((d, f) => ({ ...d, [f]: Math.max(next[f] - total[f], 0) }), zero());
    const delta = zero();
    let room = maxIn;
    for (const f of ["inputTokens", "cacheWriteTokens", "cacheReadTokens"] as const) {
      const want = Math.max(next[f] - total[f], 0);
      delta[f] = Math.min(want, room);
      room -= delta[f];
      if (delta[f] < want) clamped = true;
    }
    const wantOut = Math.max(next.outputTokens - total.outputTokens, 0);
    delta.outputTokens = Math.min(wantOut, maxOut);
    if (delta.outputTokens < wantOut) clamped = true;
    return delta;
  }

  const meter: UsageMeter = {
    observeRise(event) {
      const usage = event.usage;
      if (usage === undefined || usage === null || typeof usage !== "object") return undefined;

      // The ceilings bind every line the VM can write. An id-less usage line
      // cannot come from the sandbox port (it drops one, MP-MSG), only from a
      // runtime whose figures the runner produced itself (the fake), so it
      // is not bounded.
      const bounded = event.type === "result" || event.type === "error" || typeof event.messageId === "string";
      if (event.type === "result" || event.type === "error") {
        sawCumulative = true;
        for (const f of FIELDS) cumulative[f] = Math.max(cumulative[f], count(usage[f]));
      } else {
        // A message reporting more than any model allows is a kill.
        if (
          bounded &&
          (count(usage.inputTokens) + count(usage.cacheWriteTokens) + count(usage.cacheReadTokens) > maxIn ||
            count(usage.outputTokens) > maxOut)
        ) {
          killed = true;
        }
        if (typeof event.messageId === "string") {
          const key = messageIdKey(event.messageId);
          let held = perId.get(key);
          if (!held) {
            if (idsSeen >= maxIds) {
              killed = true;
              return undefined;
            }
            perId.set(key, (held = zero()));
            idsSeen += 1;
          }
          for (const f of FIELDS) {
            const reported = count(usage[f]);
            if (reported > held[f]) {
              summed[f] += reported - held[f];
              held[f] = reported;
            }
          }
        } else {
          // No message id: only a non-sandbox runtime (the fake) produces
          // this, because the sandbox port drops such a line. Each one is
          // its own message.
          for (const f of FIELDS) summed[f] += count(usage[f]);
        }
      }

      const next = zero();
      for (const f of FIELDS) next[f] = Math.max(summed[f], cumulative[f]);
      const delta = clampRise(next, bounded);
      if (!FIELDS.some((f) => delta[f] > 0)) return undefined;
      const before = total;
      total = zero();
      for (const f of FIELDS) {
        total[f] = before[f] + delta[f];
        // Keep the held figures within what was counted, so a clamped
        // figure cannot be re-counted by the next unrelated line.
        summed[f] = Math.min(summed[f], total[f]);
        cumulative[f] = Math.min(cumulative[f], total[f]);
      }
      return { total: { ...total }, delta };
    },
    observe: (event) => meter.observeRise(event)?.total,
    total: () => ({ ...total }),
    implausible: () => killed,
    flags() {
      const flags: string[] = [];
      if (killed || clamped) flags.push("implausible_usage");
      if (
        sawCumulative &&
        (inputSide(cumulative) < REPORTED_BELOW_FACTOR * inputSide(summed) || cumulative.outputTokens < REPORTED_BELOW_FACTOR * summed.outputTokens)
      ) {
        flags.push("reported_below_metered");
      }
      return flags;
    },
    snapshot: () => ({
      ids: newestWithinWindow([...perId]).map(([id, held]): [string, TokenTotals] => [
        id,
        { inputTokens: storedCount(held.inputTokens), outputTokens: storedCount(held.outputTokens), cacheWriteTokens: storedCount(held.cacheWriteTokens), cacheReadTokens: storedCount(held.cacheReadTokens) },
      ]),
      idsSeen,
      summed: { ...summed },
      cumulative: { ...cumulative },
      total: { ...total },
      sawCumulative,
      killed,
      clamped,
    }),
  };
  return meter;
}
