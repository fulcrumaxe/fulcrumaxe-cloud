import type { ExecutionRun } from "../../src/executionTarget.js";
import type { JobIssuer, RepoVisibility, RepoVisibilityPort, RunContinues, RunnerLimitsPort } from "../../src/targets/runnerTarget.js";

/** The R3a fake issuer: records what it was asked to issue, builds nothing and signs nothing. R3b supplies the real one. */
export interface RecordedJobIssuer extends JobIssuer {
  readonly calls: readonly { run: ExecutionRun; continues?: RunContinues }[];
}

export function createFakeJobIssuer(): RecordedJobIssuer {
  const calls: { run: ExecutionRun; continues?: RunContinues }[] = [];
  return {
    calls,
    async issue(input) {
      calls.push(input);
    },
  };
}

/** A visibility port that answers one fixed value for every repo and records what it was asked. */
export function createFakeVisibility(answer: RepoVisibility | "throw" = "private"): RepoVisibilityPort & {
  readonly calls: readonly { accountId: string; repoId: string }[];
} {
  const calls: { accountId: string; repoId: string }[] = [];
  return {
    calls,
    async visibility(repo) {
      calls.push(repo);
      if (answer === "throw") throw new Error("the visibility read failed");
      return answer;
    },
  };
}

/** A limits port that answers one fixed daily figure. The default is high enough that no test meets it by accident. */
export function createFakeRunnerLimits(runsPerDay = 1000): RunnerLimitsPort {
  return { runsPerDay: () => runsPerDay };
}
