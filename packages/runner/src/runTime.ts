import type { PoolClient } from "pg";
import { RUN_LIMIT_BOUNDS, RUN_LIMIT_INTEGER_KEYS, type RunLimitKey } from "@fx/core/src/run-limits/limits.js";
import { resolveRunLimits } from "@fx/core/src/run-limits/resolve.js";
import { PINNED_MEMORY_MB, computeComputeUsd } from "@fx/spend";
import type { RunLimitsInput } from "./executionTarget.js";
import { EXTENSION_SLICE_FRACTION } from "./runLimitDecision.js";
import { SANDBOX_TIMEOUT_MARGIN_MS, SANDBOX_VCPUS } from "./sandboxPort.js";

/**
 * D#483 S5-p (correction C1, ruling 3): the ONE chain from a role's resolved run limits to the longest a run can take and what its sandbox
 * compute costs. The seat (packages/worker/src/seat.ts) prices a run's reservation from it and the pipeline estimate seeds a role's compute
 * price from it, so there is a single price source. It lives here because both packages can import the runner and neither can import the
 * other.
 *
 *   resolveRunLimits -> runnerLimitsFrom -> sandboxTimeFor(...).maxPossibleRunMs -> computeComputeUsd
 */

const MIN = 60_000;

/** The platform ceiling on one run's length (also what the extension policy is handed). */
export const RUN_TIME_CEILING_MS = RUN_LIMIT_BOUNDS.max_run_minutes.ceiling * MIN;

/** R-BOUNDS (a): every resolved value is held to core's floor and ceiling (a non-number takes the default); whole numbers stay whole. */
export function boundedLimit(key: RunLimitKey, value: unknown): number {
  const b = RUN_LIMIT_BOUNDS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return b.default;
  const clamped = Math.min(Math.max(value, b.floor), b.ceiling);
  return RUN_LIMIT_INTEGER_KEYS.includes(key) ? Math.trunc(clamped) : clamped;
}

/** The one mapping from core's resolved limits (minutes, snake_case) to the runner's (ms), plus the two figures the seat itself needs. */
export function runnerLimitsFrom(resolved: Record<RunLimitKey, number>): { limits: RunLimitsInput; maxExtensions: number; perRunUsd: number } {
  return {
    limits: {
      maxRunMs: boundedLimit("max_run_minutes", resolved.max_run_minutes) * MIN,
      maxTurns: boundedLimit("max_turns", resolved.max_turns),
      maxModelCalls: boundedLimit("max_model_calls", resolved.max_model_calls),
      meteringSilenceMs: boundedLimit("silence_minutes", resolved.silence_minutes) * MIN,
    },
    maxExtensions: boundedLimit("max_extensions", resolved.max_extensions),
    perRunUsd: boundedLimit("per_run_usd", resolved.per_run_usd),
  };
}

/** D-TIMEOUT: the sandbox lives past the longest the run can go (every extension taken, up to the platform ceiling) by one margin. */
export function sandboxTimeFor(limits: RunLimitsInput, maxExtensions: number): { maxPossibleRunMs: number; timeoutMs: number } {
  const slice = Math.floor(limits.maxRunMs * EXTENSION_SLICE_FRACTION);
  const maxPossibleRunMs = Math.min(limits.maxRunMs + maxExtensions * slice, RUN_TIME_CEILING_MS);
  return { maxPossibleRunMs, timeoutMs: maxPossibleRunMs + SANDBOX_TIMEOUT_MARGIN_MS };
}

/** What a sandbox run that goes `maxPossibleRunMs` costs in compute, at the pinned size. */
export function sandboxComputeUsdFor(maxPossibleRunMs: number): number {
  return computeComputeUsd(maxPossibleRunMs / 1000, SANDBOX_VCPUS, PINNED_MEMORY_MB / 1024);
}

/**
 * The upper bound on one hosted run's compute for a role, from the limits that apply to it (the role's override, else the account's, else
 * the default). With the defaults (60 minutes, 2 extensions, a half slice) it is 3600 + 2 x 1800 = 7200 seconds, never more than the
 * 240-minute ceiling. Must run inside a `withTenant` transaction for `accountId`.
 */
export async function roleRunComputeUpperBoundUsd(client: PoolClient, input: { accountId: string; role: string }): Promise<number> {
  const resolved = runnerLimitsFrom(await resolveRunLimits(client, input));
  return sandboxComputeUsdFor(sandboxTimeFor(resolved.limits, resolved.maxExtensions).maxPossibleRunMs);
}
