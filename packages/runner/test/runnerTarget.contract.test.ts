import { describeExecutionTargetContract } from "./executionTarget.contract.js";
import { RunnerTarget } from "../src/targets/runnerTarget.js";
import { createFakeJobIssuer, createFakeVisibility } from "./helpers/runnerTargetFakes.js";

/**
 * D#6 R3a (C12 section 2.1): C10's contract suite, run against `RunnerTarget` in its queued variant. `dispatch` and
 * `resume` answer `{ queued: true }`, the target names `runtime = 'runner'`, and a run whose role no runner may run is
 * the one `admit` refuses (a runner target holds no money, so there is no spend refusal to provoke).
 */
describeExecutionTargetContract(
  "RunnerTarget",
  (pool) => new RunnerTarget({ pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility("private") }),
  {
    dispatch: "queued",
    runtime: "runner",
    refusableRun: async (run) => ({ ...run, role: "researcher" }),
  },
);
