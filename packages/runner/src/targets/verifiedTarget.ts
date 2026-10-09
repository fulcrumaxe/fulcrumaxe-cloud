import type { PoolClient } from "pg";
import { isRunnerMode } from "../runnerModes.js";
import type { AdmitResult, CancelResult, DispatchResult, ExecutionRun, ExecutionTarget, LostRunOutcome, TargetRuntime, TerminalReport } from "../executionTarget.js";
import { VERIFIED_SANDBOX_REVIEW_ROLES } from "./runnerTarget.js";

/**
 * D#6 R5b-2a (correction C38 section 1): the target a `runner_verified` repository resolves to. The agents that write code run on the
 * customer's runner (the runner target, job mode `verified`); the four reviewer roles run in our sandbox on the customer's connected
 * key, under the sandbox target's own reserve / meter / settle, and their runs are stamped `runtime = 'production'`.
 *
 * Every method delegates by the run's role, so a caller that holds only a run (cancel, the lost-run sweep, finalize) reaches the target
 * that started it. `runtime` is the runner's, because it is read before a role is known by callers that have none; a caller that has the
 * role reads `runtimeFor` instead.
 */
export class VerifiedTarget implements ExecutionTarget {
  readonly runtime: TargetRuntime = "runner";

  constructor(
    private readonly runner: ExecutionTarget,
    private readonly sandbox: ExecutionTarget,
  ) {}

  /** The target one role's runs use: the sandbox for a reviewer, the runner for every other role. */
  forRole(role: string): ExecutionTarget {
    return VERIFIED_SANDBOX_REVIEW_ROLES.has(role) ? this.sandbox : this.runner;
  }

  admit(run: ExecutionRun, client: PoolClient): Promise<AdmitResult> {
    return this.forRole(run.role).admit(run, client);
  }
  dispatch(run: ExecutionRun): Promise<DispatchResult> {
    return this.forRole(run.role).dispatch(run);
  }
  cancel(run: ExecutionRun): Promise<CancelResult> {
    return this.forRole(run.role).cancel(run);
  }
  resume(run: ExecutionRun, sessionId: string): Promise<DispatchResult> {
    return this.forRole(run.role).resume(run, sessionId);
  }
  finalize(run: ExecutionRun, report: TerminalReport): Promise<CancelResult> {
    return this.forRole(run.role).finalize(run, report);
  }
  async settleIfLost(run: ExecutionRun): Promise<LostRunOutcome> {
    return (await this.forRole(run.role).settleIfLost?.(run)) ?? "unknown";
  }
}

/** True when a run of this role in this mode is started by us (in our sandbox) rather than by a runner: every sandbox-mode run, and a reviewer in a verified repo. */
export const runsInOurSandbox = (mode: string | null | undefined, role: string): boolean => !isRunnerMode(mode) || (mode === "runner_verified" && VERIFIED_SANDBOX_REVIEW_ROLES.has(role));
