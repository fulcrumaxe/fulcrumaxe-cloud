import { reportError } from "@fx/telemetry";
import { RUN_LIMIT_BOUNDS } from "@fx/core/src/run-limits/limits.js";
import type { RunLimit } from "./executionTarget.js";
import type { NormalizedEvent } from "./types.js";

/**
 * D#2 H14c-5b-1 (C46 MP-MSG, C54): the per-message usage meter for a run
 * whose events come from a sandbox, so from a process that may be hostile.
 *
 * One `assistant` message arrives as several `stream-json` lines that share
 * a `message.id` and repeat (possibly growing) usage, so summing per line
 * over-counts. This meter holds each token field's MAXIMUM per id and counts
 * only what a line adds above it. A final `result` line carries a cumulative
 * figure for the whole command: it raises the total if it is higher and is
 * ignored if it is lower. Nothing a line reports can lower the total, so a
 * forged line can only bring a kill earlier.
 *
 * Only usage and the id are read by the meter. The clock, silence and
 * call-count limits (`createRunGuard`) are H14c-5b-2a's. H14c-5b-2b (MP-PLAUS,
 * S7) bounds what any ONE line can add: an `assistant` line over the ceiling
 * is a kill, and a `result` line's raise is clamped and flagged. Nothing in
 * this file reads a file from the VM or a stream other than the events it
 * is given.
 */

import { createUsageMeter, MAX_LINE_INPUT_SIDE_TOKENS, MAX_LINE_OUTPUT_TOKENS, MAX_METERED_IDS, type MeterRise, type TokenTotals, type UsageMeter, type UsageMeterOptions } from "@fulcrumaxe/runner-protocol";
export { createUsageMeter, MAX_LINE_INPUT_SIDE_TOKENS, MAX_LINE_OUTPUT_TOKENS, MAX_METERED_IDS };
export type { MeterRise, TokenTotals, UsageMeter, UsageMeterOptions };

/**
 * D#2 H14c-5b-2a (C46 MP-TURNS/MP-CLOCK/MP-SILENT, C48 LIMIT-END): the runner
 * side limits. Nothing here is read from the VM: the count is of distinct
 * message ids on the agent command's stdout, and both clocks are the
 * runner's own.
 */
export interface RunLimits {
  maxTurns: number;
  maxModelCalls: number;
  maxRunMs: number;
  meteringSilenceMs: number;
}

/** C46's defaults; H14c-3 resolves per-role values on top of them. */
export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxTurns: 100,
  maxModelCalls: 300,
  maxRunMs: 60 * 60_000,
  meteringSilenceMs: 15 * 60_000,
};

/** W-2 (C48): the runner warns the agent once this share of `maxModelCalls` is used. */
export const WARN_FRACTION = 0.8;

/** The `result` subtype the CLI prints when `--max-turns` stopped it.
 * PLACEHOLDER from the SDK's types: confirm in H18. */
export const CLI_MAX_TURNS_SUBTYPE = "error_max_turns";

/** The platform's floor and ceiling for each field, read from core's table (never copied). */
const PLATFORM_BOUNDS: Record<keyof RunLimits, readonly [number, number]> = {
  maxTurns: [RUN_LIMIT_BOUNDS.max_turns.floor, RUN_LIMIT_BOUNDS.max_turns.ceiling],
  maxModelCalls: [RUN_LIMIT_BOUNDS.max_model_calls.floor, RUN_LIMIT_BOUNDS.max_model_calls.ceiling],
  maxRunMs: [RUN_LIMIT_BOUNDS.max_run_minutes.floor * 60_000, RUN_LIMIT_BOUNDS.max_run_minutes.ceiling * 60_000],
  meteringSilenceMs: [RUN_LIMIT_BOUNDS.silence_minutes.floor * 60_000, RUN_LIMIT_BOUNDS.silence_minutes.ceiling * 60_000],
};

/**
 * Merges `overrides` over the defaults; every value must be a positive integer. With `bounded`
 * (a run's own limits, which come from a tenant's settings) every value must also lie within
 * `RUN_LIMIT_BOUNDS`, whatever the caller checked: a fixed error, thrown before any SDK call
 * (D#2 H14c-3-2d-2, R-BOUNDS layer b).
 */
export function resolveRunLimits(overrides: Partial<RunLimits> = {}, opts: { bounded?: boolean } = {}): RunLimits {
  const limits = { ...DEFAULT_RUN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`run limit ${name} must be a positive integer, got ${String(value)}`);
  }
  // setTimeout fires immediately above 2^31-1 ms, which would end every run at once.
  for (const name of ["maxRunMs", "meteringSilenceMs"] as const) {
    if (limits[name] > MAX_TIMER_MS) throw new Error(`run limit ${name} must be at most ${MAX_TIMER_MS} ms`);
  }
  if (opts.bounded) {
    for (const [name, [floor, ceiling]] of Object.entries(PLATFORM_BOUNDS) as [keyof RunLimits, readonly [number, number]][]) {
      if (limits[name] < floor || limits[name] > ceiling) throw new Error(`run limit ${name} is outside the platform bounds`);
    }
  }
  return limits;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Rejects `hookFired` when the runner ended the command at a limit. */
export class RunLimitError extends Error {
  /** `reportedUsd`: the final result's already-validated `total_cost_usd`, if any (EV-SETTLE). */
  constructor(
    public readonly limit: RunLimit,
    public readonly reportedUsd?: number,
  ) {
    super(`run reached its ${limit.kind} limit`);
    this.name = "RunLimitError";
  }
}

export interface RunGuard {
  /** Arms the wall clock and the silence timer (the command has started). */
  start(): void;
  /** Feeds one delivered event: counts its message id, and a metered rise resets the silence timer. */
  observe(event: Pick<NormalizedEvent, "type" | "messageId" | "usage">): void;
  /** The `turns` limit when the last `result` carried the CLI's max-turns subtype AND the runner saw at least `maxTurns` distinct ids. */
  turnsLimit(resultSubtype: unknown): RunLimit | undefined;
  /** Read-only: distinct assistant message ids seen (the W-2 signal). */
  modelCalls(): number;
  /** X-3 E3: the runner's clock when the metered total last rose; undefined if it never has. */
  lastRiseAt(): number | undefined;
  /** The limits in force now (an extension raises `maxRunMs` or `maxModelCalls`). */
  current(): Readonly<RunLimits>;
  /** Clears both timers. Idempotent. */
  stop(): void;
}

/** H14c-5c-2a (X-1/X-4): asked when `run_time` or `model_calls` is reached. */
export interface GuardExtension {
  /** The kind's new limit (same unit as `limit.limit`), or undefined to end the run. */
  decide(limit: RunLimit): Promise<number | undefined>;
  /** Called once the guard has applied the new limit; not called for a decision that came too late. */
  applied(limit: RunLimit, newLimit: number): void;
  /** Bound on `decide`: past it the run ends with the limit that was asked about. Default 30 s. */
  decisionTimeoutMs?: number;
}

export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

/** `onLimit` is called at most once, with the first limit reached (an extended limit is not reached). */
export function createRunGuard(initial: RunLimits, onLimit: (limit: RunLimit) => void, extension?: GuardExtension): RunGuard {
  const limits = { ...initial };
  const ids = new Set<string>();
  const meter = createUsageMeter();
  let wall: ReturnType<typeof setTimeout> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined;
  let decisionTimer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let silentSince = 0;
  let lastRise: number | undefined;
  let fired = false;
  let deciding = false;
  let stopped = false;
  const finish = (limit: RunLimit): void => {
    if (fired) return;
    fired = true;
    guard.stop();
    onLimit(limit);
  };
  const fire = (limit: RunLimit): void => {
    if (fired) return;
    if (!extension || (limit.kind !== "run_time" && limit.kind !== "model_calls")) return finish(limit);
    // One decision at a time. A limit reached meanwhile is not dropped: when the
    // decision settles without ending the run, the wall clock is re-armed from its
    // deadline (immediately if past) and the call count is checked again, so the
    // other limit is asked about as its own extension request. Events keep being
    // counted and metered meanwhile; the silence timer still runs.
    if (deciding) return;
    deciding = true;
    let settled = false;
    decisionTimer = setTimeout(() => {
      if (settled || fired || stopped) return;
      settled = true;
      deciding = false;
      finish(limit); // a decision that never settles ends the run at the limit that was asked about
    }, extension.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS);
    decisionTimer.unref?.();
    void Promise.resolve()
      .then(() => extension.decide(limit))
      .catch(() => undefined)
      .then((next) => {
        if (settled) return;
        settled = true;
        clearTimeout(decisionTimer);
        deciding = false;
        if (fired || stopped) return;
        if (next === undefined || !(next > limit.limit)) return finish(limit);
        if (limit.kind === "run_time") limits.maxRunMs = next;
        else limits.maxModelCalls = next;
        try {
          extension.applied(limit, next);
        } catch (err) {
          // a throwing observer does not undo the extension, nor leave the limits unarmed
          reportError(err, { stage: "run.limit_applied" });
        }
        // Whichever limit was raised, the other may have run out while the decision was pending.
        armWall();
        if (ids.size > limits.maxModelCalls) fire({ kind: "model_calls", limit: limits.maxModelCalls, observed: ids.size });
      });
  };
  const armWall = (): void => {
    clearTimeout(wall);
    wall = setTimeout(
      () => fire({ kind: "run_time", limit: limits.maxRunMs, observed: Date.now() - startedAt }),
      Math.max(limits.maxRunMs - (Date.now() - startedAt), 0),
    );
    wall.unref?.();
  };
  const armSilence = (): void => {
    clearTimeout(silence);
    silentSince = Date.now();
    silence = setTimeout(
      () => finish({ kind: "silence", limit: limits.meteringSilenceMs, observed: Date.now() - silentSince }),
      limits.meteringSilenceMs,
    );
    silence.unref?.();
  };
  const guard: RunGuard = {
    start() {
      stopped = false;
      startedAt = Date.now();
      armWall();
      armSilence();
    },
    observe(event) {
      if (fired) return;
      if (event.type === "assistant" && typeof event.messageId === "string") {
        ids.add(event.messageId);
        if (ids.size > limits.maxModelCalls) fire({ kind: "model_calls", limit: limits.maxModelCalls, observed: ids.size });
        if (fired) return;
      }
      if (meter.observe(event) !== undefined && silence !== undefined) {
        lastRise = Date.now();
        armSilence();
      }
    },
    turnsLimit(resultSubtype) {
      if (resultSubtype !== CLI_MAX_TURNS_SUBTYPE || ids.size < limits.maxTurns) return undefined;
      return { kind: "turns", limit: limits.maxTurns, observed: ids.size };
    },
    modelCalls: () => ids.size,
    lastRiseAt: () => lastRise,
    current: () => ({ ...limits }),
    stop() {
      stopped = true;
      clearTimeout(wall);
      clearTimeout(silence);
      clearTimeout(decisionTimer);
      wall = silence = decisionTimer = undefined;
    },
  };
  return guard;
}
