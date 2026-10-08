import { RUNNER_MAX_RUN_WALL_CLOCK_MS } from "@fulcrumaxe/runner-protocol";
import { RUNNER_MAX_CONCURRENT_JOBS } from "@fx/runner";

/**
 * D#6 R2b-3 (C21 section 8): the two runner limits the lease code reads, behind ONE function. Claim reads
 * `maxConcurrentRunnerJobs` and the fence and the sweeper read `maxRunWallClockMs`; nothing else in this package names the
 * constants below.
 *
 * Until the runner plan's data (R2b-3 part ii) is merged, the figures are the class constants: one job at a time and a two
 * hour wall clock. Whichever of part (i)'s routes and part (ii)'s plan-data reader merges second replaces the body of this
 * function with the reader, and its test then holds the count at the plan's figure N: the (N+1)th concurrent claim gets no run.
 */
export interface RunnerLimits {
  /** Runner runs an account may have `running` at once; claim hands out no more. */
  maxConcurrentRunnerJobs: number;
  /** How long a runner run may take from its start; a heartbeat past it is told to stop, and the sweeper times the run out. */
  maxRunWallClockMs: number;
}

export type RunnerLimitsSource = (accountId: string) => RunnerLimits;

export const runnerLimits: RunnerLimitsSource = (accountId) => {
  void accountId;
  return { maxConcurrentRunnerJobs: RUNNER_MAX_CONCURRENT_JOBS, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS };
};
