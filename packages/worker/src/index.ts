export { createWorker, assertWorkdirAllowed, type CreateWorkerOptions, type Worker, type WorkerPorts } from "./compositionRoot.js";
export type { RunActionFacade, RunActionPrincipal, ClaimedRunAction, SettleRunActionInput, RunActionSettleState, PerformResult } from "./runActions.js";
export type { RunnerLeaseFacade, FailRunnerLeasesInput, FailRunnerLeasesResult, RunnerLeaseFailReason } from "./runnerLeases.js";
export type { RunnerClaimFacade, ClaimRunnerRunInput, ClaimRunnerRunResult, HeartbeatRunnerRunInput, HeartbeatRunnerRunResult, IngestRunnerEventsInput, IngestRunnerEventsResult, LeaseVerdict } from "./runnerClaims.js";
export type { RunnerDoneFacade, RunnerDoneVerdict, DoneFailureReason, BeginRunnerDoneResult, FinishRunnerDoneInput, FinishRunnerDoneResult } from "./runnerDone.js";
export type { RunnerLimits, RunnerLimitsSource } from "./runnerLimits.js";
export type { RunnerLeaseSweeper, RunnerLeaseSweepResult } from "./runnerLeaseSweep.js";
export type { RunnerQueueSweeper, RunnerQueueSweepResult } from "./runnerQueueSweep.js";
export type { RunnerNoticeSweeper, RunnerNoticeResult } from "./runnerNotices.js";
export { RunActionInputError, RunActionUnavailableError, RunActionForbiddenError, RunActionRefusedError } from "./runActions.js";
export { productionVercelCredentials, VercelCredentialsUnavailableError } from "./vercelCredentials.js";
export { StartupGuardError, type StartupRule } from "./pools.js";
export type { SeatRequest, SeatResult, SeatRefusal, SeatRunConfig } from "./seat.js";
// D#2 H14c-3-3a-3: the follower's two step bodies, standalone functions (not Worker methods); the timeout writes with the runner's own writer over the runner login.
export { followStatusBody, followTimeoutBody, type FollowStatus } from "@fx/runner";
export { operatorMode } from "@fx/runner";
// D#6 R3b: a pure factory (no pool, no secret); apps/web builds the live repository-visibility read with it and passes it in as a port.
export { createGithubRepoVisibility, type RepoReadHttp } from "@fx/runner";
// D#6 R2b: the runner tier's limits, read from the plan data (a pure read, no pool or secret); apps/web passes the register limit from it.
export { runnerLimitsFor } from "@fx/spend";
export { createVercelKeepAlive } from "./keepAlive.js";
export type { AdvanceFacade, AdvanceStartArgs, AdvanceTriageInput, AdvanceTriageResult, AdvanceRunRequest, AdvanceRunStart, AdvanceRunOutcome, AdvanceItem, AdvancePrSource, AdvanceStepPorts, AdvanceStepResult, AdvanceStepWho, AdvanceReviewContext, AdvanceReviewLoad, AdvanceReviewDeps, AdvanceRoundInput, AdvanceRoundResult, AdvanceVerdictInput, AdvanceFixRequest, AdvanceMergeGateResult } from "./advance.js";
