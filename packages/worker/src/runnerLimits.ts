import { RUNNER_MAX_RUN_WALL_CLOCK_MS } from "@fulcrumaxe/runner-protocol";
import { runnerLimitsFor } from "@fx/spend";

/**
 * D#6 R2b-3 (C21 section 8): the two runner limits the lease code reads, behind ONE function. Claim reads
 * `maxConcurrentRunnerJobs` and the fence and the sweeper read `maxRunWallClockMs`; nothing else in this package names the
 * figures. Both come from the runner plan's data (`runnerLimitsFor`, D#6 R2b criterion 12), the same reader that serves the
 * register limit and the daily limit, so there is no second copy of a plan figure.
 *
 * Plan data that is missing, or predates the runner tier, fails closed (C21 section 9): the concurrency is 0, so claim hands
 * out no run, while the wall clock stays at the class constant so a run already in flight is still timed out. A missing figure
 * never becomes an unlimited one.
 */
export interface RunnerLimits {
  /** Runner runs an account may have `running` at once; claim hands out no more. */
  maxConcurrentRunnerJobs: number;
  /** How long a runner run may take from its start; a heartbeat past it is told to stop, and the sweeper times the run out. */
  maxRunWallClockMs: number;
}

export type RunnerLimitsSource = (accountId: string) => RunnerLimits;

export const runnerLimits: RunnerLimitsSource = (accountId) => {
  void accountId; // one runner plan for every account today
  try {
    const { maxConcurrentRunnerJobs, maxRunWallClockMs } = runnerLimitsFor();
    return { maxConcurrentRunnerJobs, maxRunWallClockMs };
  } catch {
    // fx-swallow-ok: unavailable plan data is a refusal to hand out work (fail closed), not a crash; the composition root reports it when it loads the data
    return { maxConcurrentRunnerJobs: 0, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS };
  }
};
