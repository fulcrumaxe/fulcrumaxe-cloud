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

export interface UsageMeterOptions {
  maxLineInputSideTokens?: number;
  maxLineOutputTokens?: number;
  maxIds?: number;
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
          let held = perId.get(event.messageId);
          if (!held) {
            if (perId.size >= maxIds) {
              killed = true;
              return undefined;
            }
            perId.set(event.messageId, (held = zero()));
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
  };
  return meter;
}
