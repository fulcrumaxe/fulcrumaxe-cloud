import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { advanceActionFor, type AdvanceAction } from "@fx/core/src/work-items/advance.js";
import { parseAcceptanceScope } from "@fx/core/src/specs/acceptanceScope.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { resolveBuildIdentity } from "@fx/core/src/work-items/buildIdentity.js";
import { NO_VERDICT_ESCALATION_CODE, readReviewHold } from "@fx/core/src/work-items/reviewHold.js";
import { VERDICT_ROLES } from "@fx/core/src/work-items/verdictRoles.js";
import { IllegalStageTransitionError, WorkItemHaltedError as StageHaltedError, hasLivePlannedChildSql } from "@fx/core/src/work-items/stages.js";
import { MAX_WAITING_ATTEMPT, assertDriverEvent, recordDriverEvent, type DriverEventInput } from "@fx/core/src/work-items/driverEvents.js";
import { markRunnerWork, markWorkPending } from "@fx/core/src/pendingWork.js";
import { createRunnerPlaneMergeStore, PLANE_MERGE_OPEN_STATES, type PlaneMergeOrder, type RunnerPlaneMergeStore } from "./runnerPlaneMerge.js";
import { setupHoldFor } from "@fx/core/src/setup-requests/store.js";
import { markCorrectionApplied } from "@fx/core/src/corrections/index.js";
import { ITEM_PR_BRANCH, JobMemorySchema, type JobMemory } from "@fulcrumaxe/runner-protocol";
import { attachRunNotes, correctionReasonCode, listRunNoteIds, readPendingRunNotes, renderRunNotes, runNotesStepSuffix } from "@fx/core/src/corrections/driver.js";
import { cancelRun, ensureSpecAnchorRun, DuplicateExecutorRunError, ExecutionModeChangedError, IdempotencyKeyTakenError, RunPrecheckRefusedError, NoSpecVersionError, SandboxReapingError, WorkItemHaltedError, acceptQueuedRunnerRun, PREVIEW_WORKDIR, readRecordedRunnerPullRequest, readSandboxBoundPullRequest, recordSandboxContinuesBound, recordRunStage, insertRunEvent, recordChildPullRequestForItem, readChildBoundPullRequest, recordBuildBranch, DispatchFailedError, JobIssueError, RUNNER_RUN_BRANCH, readExecutionMode, effectiveModeSql, sideOfMode, isRunnerMode, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { reportError } from "@fx/telemetry";
import { checkFixRound, envelopeRunUsd } from "@fx/spend";
import { checkRoundHeadroom } from "./panelHeadroom.js";
import type { RaiseEnvelopeAsk } from "./envelopeAsk.js";
import { ingestRunMemoryProposals } from "./memoryIntake.js";
import { isItemWaitingOnAnswer } from "@fx/db/src/decisionAsks.js";
import { reconcileHolder, reconcileSlotHolders, type PrStateOpen } from "./prSlotReconcile.js";
import type { DecisionIntake, DecisionStepCode } from "./decisionIntake.js";
import { parseDecisionSnapshot, writeDecisionSnapshot, type DecisionOffer, type DecisionSnapshot } from "./decisionSnapshot.js";
import { decisionOfferForItem, decisionStartFor } from "./decisionStart.js";
import type { StartGatePort, StartGateStepInput, StartGateStepOut } from "./startGateStep.js";
import type { FixGatePort, FixGateStepInput, FixGateStepOut } from "./fixGateStep.js";
import { isContextSpill, type ContextAssembly, type ContextSection, type ContextSpill } from "@fx/runner";
import type { RunStarter } from "./preview.js";
import { advanceContinue as advanceContinueCore, type AdvanceContinueOut } from "./advanceContinue.js";
import type { ContinuationSite } from "./continuation.js";
import { readVerifiedReviewGate, type VerifiedReviewGate } from "./verifiedReviewGate.js";
import type { SeatRequest, SeatResult } from "./seat.js";
import { startCheckFixRound } from "./checkFix.js";
import { BASE_SYNCED_PROMPT_LINE, BASE_SYNCED_STAGE, FIX_BASE_EVENT, checkFixBeforeStart, hasPublicCopy, recordBaseSyncUnavailable, republishGate, syncRunBranch } from "./fixRoundBase.js";
import { BRANCH_MOVED_STAGE, checkPrivateHead, checkPublicBranch, type FixRoundHeadPorts } from "./fixRoundHeads.js";
import { RunActionInputError, type PerformResult } from "./runActions.js";
import { STAGE_RESUME_PASS_SECONDS } from "./stageResume.js";

/**
 * D#483 P1: the worker side of `advance_work_item`, the stage driver's run action.
 *
 * `performAdvanceWorkItem` turns a claimed action into ONE start of the durable advance workflow
 * (apps/web/workflows/workItemAdvance.ts), handed in as `startAdvance`. It starts nothing else and spends nothing.
 * The workflow's steps then call the other methods here: start one role run for the item, read how a run ended, and
 * run triage. Every one takes and returns plain data; the runner pool stays in this package.
 *
 * Why a kind of its own: `continue_work_item` is reserved for an executor picking up where a failed run stopped.
 *
 * Order in `performAdvanceWorkItem`, and why: (1) who it runs as, from the database, session principals only, and
 * still an owner or admin NOW (the request-time role check is not enough: a role can be lowered in between);
 * (2) the item, tenant-scoped; (3) every refusal that costs nothing; (4) the start. A replayed perform (a kick and a
 * sweep at once) finds the first one's run through the keys below, so it cannot start a second classify run.
 */


/**
 * D#483 S5-b2c-2: the Spec versions an item is built and reviewed against (alias `s`, item `w`). Its own, except for a planned PR child, whose is the one version of its parent that
 * it names (`planned_pr_spec_version_id`). Never the parent's newest.
 */
const SPEC_OF_ITEM_SQL = "(CASE WHEN w.planned_pr_key IS NULL THEN s.work_item_id = w.id ELSE s.id = w.planned_pr_spec_version_id AND s.work_item_id = w.parent_id END)";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An execution mode word (`sandbox`, `runner_local`): lower case and underscores only. */
const MODE_RE = /^[a-z][a-z_]{0,31}$/;
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });

// The stages the driver advances from, what advancing does at each, and what must be true first live in ONE table:
// @fx/core's work-items/advance.ts. The route, this file and the workflow all ask it; none keeps a list of its own.
export { ADVANCEABLE_STAGES, ADVANCE_NON_BUILDABLE_KINDS } from "@fx/core/src/work-items/advance.js";
/** Run statuses a run cannot leave; anything else is live. Mirrors @fx/runner's RUN_STATUS_TRANSITIONS (pinned by a test). */
export const ADVANCE_TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"] as const;
const TERMINAL = new Set<string>(ADVANCE_TERMINAL_STATUSES);

/**
 * D#6 R2b-3 (C22 sections 5 and 7): the most runs `advanceRunOutcome` looks at when it follows a runner run to the run that
 * replaced it. The same bound as the database's follow-up chain walk (migration 0754).
 */
export const FOLLOW_UP_CHAIN_MAX_RUNS = 16;

/** The two reasons that make a failed runner run get a follow-up (a "follow-up hop", C22 section 5). */
const FOLLOW_UP_REASONS: ReadonlySet<string> = new Set(["runner_lost", "usage_limit"]);
/** D#599 PL-2: the reason PL-1's item-scoped cancel gives a pending run it moves to `cancelled`. */
const PLACEMENT_CHANGED = "placement_changed";
/** D#599 PL-2: how many times one step restarts on the other side after its run was cancelled for a placement change. The key of restart n is `<step key>:p<n>`. */
export const PLACEMENT_RESTARTS_MAX = 3;
/**
 * The first role each action starts: the seat the pre-flight in `performAdvanceWorkItem` resolves. `check_build` starts none
 * (a pull request is looked for first; with none open the item goes to Needs human and no model runs), so it has no seat to
 * require; if a pull request is found the review's own step refuses a missing reviewer seat with a recorded stop.
 */
const PREFLIGHT_ROLE: Readonly<Record<AdvanceAction, string | null>> = Object.freeze({ triage: "project-manager", light_spec: "project-manager", spec: "project-manager", build: "executor", rebuild: "executor", check_build: null, review: "code-reviewer" });

export interface AdvanceStartArgs {
  accountId: string;
  userId: string;
  workItemId: string;
  actionId: string;
  /**
   * The item's halt epoch when the approval was performed (after any halt it resumed from). Every step of the workflow
   * carries it; a step that finds a different epoch was started before a halt and is refused (`halted_since_approval`).
   * A workflow started before this field existed replays it as 0.
   */
  haltEpoch: number;
  /**
   * The newest published Spec's version when the approval was performed (null: none yet). The build and the review are
   * pinned to it: a newer version appearing after the person approved refuses them (`spec_changed`), so what is built and
   * reviewed is what was approved.
   */
  specVersion?: number | null;
  /**
   * D#6 R4d-5b (C34 section 2.3): this is a Re-spec (`respec_work_item`), not an advance. The workflow runs the project manager in file-list mode on the newest
   * Spec and publishes the next version, then stops: the person presses Build again. Absent on every other start, and on a workflow started before it existed.
   */
  respec?: boolean;
  /**
   * D#483 S5-k1b: the first attempt number the build's asks use. Absent (0) on every start a person's approval makes. The parked-stage sweep sets it to one
   * more than the highest attempt among the approval's earlier build runs, so a restart never replays the `refused_spend` run an earlier ask left.
   */
  startAttempt?: number;
  /**
   * D#483 S5-k1d: the re-review round (`:rr<n>`) a parked review was in when its reviewers' start was denied. Set by the sweep from the waiting fact; absent (0) on
   * every start a person's approval makes. The restarted review asks its reviewers at this round, so their keys are the ones the earlier asks used.
   */
  startRereview?: number;
  /**
   * D#7 DP11c: set by `resume_decision` when it has started the resumed executor run. The workflow does not start a build: it follows this run
   * (outcome, decisions, pull request, review) exactly as it follows a build's. Absent on every other start, and on a workflow started before it existed.
   */
  resumeRunId?: string;
  /**
   * D#7 start gate: true only on the start `performDriven` files, i.e. the one a signed-in owner or admin's own session made in this run. It is the only thing
   * that lets the start gate record a PERSON receipt. Absent on every restart (the parked-stage sweep, the slot wake, a resumed run) and on a workflow started
   * before it existed: those go through the gate as unattended and never record a person's click, whatever their attempt number.
   */
  personFiled?: boolean;
  /**
   * D#483 S5-b1a-2: true when the start was filed by the dial (the auto-start sweep files it as a session request for the person who confirmed the weekly limit,
   * under the idempotency key `dial:<receipt>`). Such a start is never a person's click: `personFiled` is false, and the triage gate learns the kind the dial
   * started the item as from the sweep's own start-gate row, not from a label.
   */
  dialFiled?: boolean;
}

/**
 * What an injected pipeline step may do with agent runs, bound to ONE account and work item by the worker: the request
 * cannot name another. Structurally the pipeline's `AdvanceRunPorts`.
 */
export interface AdvanceStepPorts {
  startRun(req: Omit<AdvanceRunRequest, "accountId" | "workItemId" | "haltEpoch">): Promise<AdvanceRunStart>;
  /** D#597 CC-3: the run an earlier call of a step started (the step's prefix plus whatever note pin its key carries), or null. */
  findStep(stepPrefix: string): Promise<{ step: string; runId: string } | null>;
  /** D#483 S5-k1e: the runs a panel seat's earlier asks started (steps shaped `<head>[:s<n>]<tail>`), oldest first, each with its attempt and the run's status. */
  startedAttempts(head: string, tail: string): Promise<Array<{ attempt: number; status: string }>>;
  /** D#483 S5-k1e: the read-only headroom check for a whole round of seats: would a spending limit deny them if all were started now? Writes no run row. */
  headroom(roles: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** D#7 DP4b-3: the decisions a new executor run is offered (the prompt's keys and the snapshot to write in its create transaction), resolved from the item's repository dials now. */
  decisionOffer?(): Promise<DecisionOffer>;
  outcome(runId: string): Promise<AdvanceRunOutcome>;
  /** The existing cancel path, as the approver (so the cancel is audited as theirs and needs their membership to still be active). Safe on a finished run. */
  cancel(runId: string): Promise<void>;
  /** D#2 H14c-3-3b-3 (C89): see the pipeline's `AdvanceRunPorts.continueRun`. */
  continueRun?(endedRunId: string, site: "spec" | "panel_workflow"): Promise<string | null>;
}

/** What a pipeline step answers, as plain data: the pipeline's own status word and the ids a later step needs. */
export interface AdvanceStepResult {
  status: string;
  reason?: string;
  stage?: string | null;
  version?: number;
  runId?: string;
  branch?: string;
  complete?: boolean;
  missingRoles?: string[];
  round2Ran?: boolean;
  replayed?: boolean;
}

/**
 * D#483 S5-k1d: the admit denials that are a spending limit (packages/pipeline reservationPauses.ts RESERVATION_DENIAL_PAUSES keys; a test holds the lists equal).
 * One list for every worker start that has to tell a limit from a refusal: the fix-round start here, and the resume of a parked item (resumeDecision.ts).
 */
export const SPEND_DENIAL_REASONS: readonly string[] = Object.freeze(["model_budget_exceeded", "compute_cap_exceeded", "work_item_cap_exceeded", "per_spawn_cap_exceeded", "envelope_exceeded", "model_credits_exhausted"]);
/** D#483 S5-k1: the refusals that mean "a spending limit denied the run, ask again" (RESERVATION_DENIAL_PAUSES values; a test holds the lists equal). */
export const RESERVATION_PAUSE_REASONS: readonly string[] = Object.freeze(["account_budget_reached", "compute_cap_reached", "item_cap_reached", "run_limit_below_estimate", "envelope_reached", "model_credits_exhausted"]);

/** Who the steps run for: the workflow's own arguments. */
export interface AdvanceStepWho {
  accountId: string;
  userId: string;
  workItemId: string;
  /** The halt epoch the workflow was started under (AdvanceStartArgs.haltEpoch). */
  haltEpoch: number;
}

/** The triage step's input: everything it needs, as plain data. The classifier's category is a string the pipeline's own parser validates. */
export interface AdvanceTriageInput {
  /** The work item the webhook created for the issue. */
  workItemId: string;
  title: string;
  body: string;
  /** What the classify run answered. Not trusted: triage parses it again against the fixed set. */
  category: string;
  sourceEventId: string;
  repoId: string;
  /** The issue author's login. */
  login: string;
  /** The issue's number on GitHub; null for an item that came from an approved proposal with no issue (D#483 S4-e). */
  number: number | null;
}

/** What triage answers, as plain data. `status` is the pipeline's own word ("triaged", "unclassified", "refused", ...). */
export type AdvanceTriageResult = { status: string; reason?: string; category?: string; stage?: string; workItemId?: string; discussionId?: string };

/** One accepted Spec amendment as the pipeline's `publishAmendment` takes it. */
export interface AmendSpecItem {
  id: string;
  text: string;
  name: string;
  date: Date;
}

export interface AdvanceModuleDeps {
  starter: RunStarter | null;
  resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>;
  /** apps/web starts the workflow here. Absent, `advance_work_item` is refused `advance_unavailable`. */
  startAdvance: ((args: AdvanceStartArgs) => Promise<void>) | null;
  /** Injected from apps/web (this package cannot import @fx/pipeline): runs triage on the runner pool, which never leaves the worker. */
  triage: ((pool: Pool, accountId: string, input: AdvanceTriageInput) => Promise<AdvanceTriageResult>) | null;
  /** D#483 P2, injected from apps/web the same way: the pipeline's panel, Spec and build, run with the runner pool and the run ports above. */
  panel?: ((pool: Pool, accountId: string, workItemId: string, ports: AdvanceStepPorts) => Promise<AdvanceStepResult>) | null;
  spec?: ((pool: Pool, accountId: string, workItemId: string, ports: AdvanceStepPorts, options: { attempt?: string; spendAttempt?: number }) => Promise<AdvanceStepResult>) | null;
  build?: ((pool: Pool, accountId: string, workItemId: string, approvalId: string, ports: AdvanceStepPorts, options: { expectedVersion?: number; spendAttempt?: number }) => Promise<AdvanceStepResult>) | null;
  /** D#6 R4d-5b, injected from apps/web the same way: the pipeline's `publishRespec`, the next Spec version (the same text plus the file list) from the project manager's result. */
  respec?: ((pool: Pool, accountId: string, workItemId: string, output: unknown, expectedVersion: number) => Promise<{ status: string; reason?: string; version?: number }>) | null;
  /** D#597 CC-2b, injected from apps/web the same way: the pipeline's `publishAmendment`, the next Spec version (the old text plus the accepted amendments). `status` is published | already_published | refused. */
  amendSpec?: ((pool: Pool, accountId: string, workItemId: string, items: readonly AmendSpecItem[]) => Promise<{ status: string; reason?: string; version?: number }>) | null;
  /** D#483 P3, injected from apps/web: the pipeline's `publishLightSpec`: a small, bug or doc item's short Spec from the PM's result. */
  lightSpec?: ((pool: Pool, accountId: string, workItemId: string, output: unknown) => Promise<{ status: string; reason?: string; version?: number }>) | null;
  /** Records a build that ended without a pull request (in_progress -> needs_human). */
  buildFailed?: ((pool: Pool, accountId: string, workItemId: string, runId: string | null, code: string, attempt?: string) => Promise<AdvanceStepResult>) | null;
  /**
   * D#483, injected from apps/web: the pipeline's `readBuildWaitReason`. The reason this item's build would wait for a slot right now, or null (it would get one).
   * Asked once when a build is approved, so the answer can say "waiting" and not "started". Advisory (no lock): the workflow's own start decides. Absent or failing, the answer is "started".
   */
  buildWaitReason?: ((pool: Pool, accountId: string, workItemId: string) => Promise<string | null>) | null;
  /**
   * D#598, injected from apps/web: the read-only GitHub client (fenced for a `runner_local` repository). When a build start finds the slots held, the
   * holders that have a pull request are checked on GitHub (each at most once per window) and one closed or merged without its webhook is moved as the
   * webhook would; the start is then asked once more. Absent: no holder is checked.
   */
  prState?: PrStateOpen | null;
  /** D#483 S5-d: raises the `spend_past_envelope` ask (receipt login) when a start is denied by the item's spend envelope. Absent, the denial still pauses the item and no ask is raised. */
  raiseEnvelopeAsk?: RaiseEnvelopeAsk | null;
  /** D#7 DP4b-2: reads a succeeded executor run's decision fields (receipts, asks, refusals) on the receipt login. Absent, `advanceDecision` answers `none`. */
  decisionIntake?: DecisionIntake | null;
  /** D#7 start gate (b): the stage driver's call into `decideStart` on the receipt login. Absent, `advanceStartGate` lets the advance go on (nothing is recorded). */
  startGate?: StartGatePort | null;
  /** D#483 S5-b2a part 2: the review fix round's gate on the receipt login. Absent, `advanceFixGate` stops the round (`fix_gate_unavailable`): nothing is spent that cannot be decided. */
  fixGate?: FixGatePort | null;
  /** The execution registry `cancelRun` dispatches through. Absent, a step's cancel is a no-op that the lost-run sweep backs up. */
  registry?: ExecutionTargetRegistry | null;
  /** D#483 P3, injected from apps/web the same way: the review stage's pipeline pieces. Absent, the review steps answer `review_unavailable`. */
  review?: AdvanceReviewDeps | null;
  /** D#6 R5b-2a: accounts that run on our own subscription (they need no model connection for a cloud-verified review). Absent: none. */
  isOperatorAccount?: (accountId: string) => boolean;
  /**
   * FIXROUND-REFRESH-HEAD: the GitHub reads every fix round makes before it starts (fixRoundHeads.ts). Absent: a paired item that already pushed is refused
   * `public_head_unavailable` and a runner round `pr_head_unavailable` (never a round on a head nobody checked).
   */
  fixHeads?: FixRoundHeadPorts | null;
}

/** What the review stage needs from @fx/pipeline and the web app (this package can import neither). */
export interface AdvanceReviewDeps {
  /** The pipeline's `loadReviewContext`, flattened to plain data. The facade adds where the pull request comes from (`AdvancePrSource`). */
  load: (pool: Pool, accountId: string, workItemId: string) => Promise<{ ok: true; ctx: Omit<AdvanceReviewContext, keyof AdvancePrSource> } | { ok: false; reason: string }>;
  /** The pipeline's `recordRound`: every verdict of a head recorded (passes first), and the decision. */
  recordRound: (pool: Pool, registry: ExecutionTargetRegistry, input: AdvanceRoundInput) => Promise<AdvanceRoundResult>;
  /** The pipeline's `resumeAgentRun`: an executor fix round continues the PR's persistent sandbox and session. */
  resume: (pool: Pool, registry: ExecutionTargetRegistry, input: StartAgentRunInput) => Promise<{ id: string; status: string }>;
  /** The merge gate over the real GitHub port (a token of the `merge_gate` purpose). */
  mergeGate: (pool: Pool, input: { accountId: string; workItemId: string; prNumber: number; expectedSignals?: readonly string[]; expectedHeadSha?: string }, extras?: { orders: RunnerPlaneMergeStore }) => Promise<AdvanceMergeGateResult>;
  /**
   * D#6 PUBLIC-MERGE PR2b: ends an AUTHORIZED merge order whose lease ran out (or whose deadline passed) without a report, from what GitHub says through the
   * cloud's own fenced client (the runner may have merged before it stopped). Throws when GitHub cannot be asked, and then ends nothing. Absent: such an order is
   * only ended by its deadline.
   */
  reconcileMergeOrder?: (pool: Pool, store: RunnerPlaneMergeStore, order: PlaneMergeOrder, extras: { reconcile: (input: { accountId: string; workItemId: string; github: PrStateOpen }) => Promise<unknown> }) => Promise<void>;
  /** D#598 P7c: the pipeline's `recordMergeOnlyRecheck`. Absent, every new head gets a full review. */
  recordMergeOnly?: (pool: Pool, input: AdvanceMergeOnlyInput) => Promise<AdvanceMergeOnlyResult>;
}

/** D#598 P7c: a new head that may be only a merge of the base branch. */
export interface AdvanceMergeOnlyInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  prNumber: number;
  baseRef: string;
  requiredRoles: string[];
}
/** `all_passed` (the head was carried forward and recorded), `full_review` (run the reviewers; `reason` is a fixed code) or `ci_pending`. */
export interface AdvanceMergeOnlyResult {
  decision: string;
  reason?: string;
}

/** The review context the workflow keeps: small facts only. The Spec's text is read inside the step that needs it. */
export interface AdvanceReviewContext extends AdvancePrSource {
  workItemId: string;
  stage: string;
  repoId: string;
  owner: string;
  name: string;
  issue: number;
  /** The item's branch, from its build identity: `fx/issue-<n>`, or a planned PR child's own `fx/<parent#>-<key>`. */
  branch: string;
  /** A planned PR child: `issue` is its parent's (D#483 S5-b2c-3). */
  child?: true;
  /** critical | feature | small | bug | doc */
  tier: string;
  specVersion: number;
  /** Fix rounds already started (the driver events); the security reviewer's step-back starts at review round 3. */
  fixRoundsStarted?: number;
  debaterEnabled: boolean;
  /** A person's Request changes is waiting for its fix round (the pipeline's loader derives it). The driver starts that round before any review. */
  personRequestPending?: boolean;
}
export type AdvanceReviewLoad = { ok: true; ctx: AdvanceReviewContext } | { ok: false; reason: string };

export interface AdvanceVerdictInput {
  role: string;
  runId: string;
  verdict: string;
  /** D#598 P7d: the reviewer could not run the tests. */
  environmentFailure?: boolean;
  /** The reviewer could not verify some criteria in its environment (never recorded as a verdict; the round goes to a person). */
  unverifiable?: boolean;
  /** The reviewer's runs on this head ended without a verdict and its re-runs are used up: never recorded as a verdict. */
  noVerdict?: boolean;
  /** With `noVerdict`: how its last run ended (a fixed code). */
  endCode?: string;
  /** The debater only. */
  debatedRole?: string;
}
export interface AdvanceRoundInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  prNumber: number;
  /** Fix rounds already started. Omitted by the driver: it is read from the recorded driver events. */
  round?: number;
  requiredRoles: string[];
  verdicts: AdvanceVerdictInput[];
}
export interface AdvanceRoundResult {
  decision: string;
  /** Fix rounds already started when the decision was made. */
  round: number;
  recorded: Array<{ role: string; runId: string; verdict: string; outcome: string }>;
  nextRound?: number;
}
/**
 * D#6 PUBLIC-MERGE PR2b: where the merge order of a paired `runner_local` item stands. `open`: still waiting for the runner (pending, claimed or authorized).
 * `merged`: GitHub, read by the cloud, says the public pull request merged at the order's head. `head_moved`: a head moved (or the order was replaced); review
 * again. `blocked`/`failed`/`expired`: a person merges, and `code` is the fixed reason. `none`: the item has no order. `refused`: the step may not run.
 */
export interface AdvanceMergeOrderResult {
  state: "open" | "merged" | "head_moved" | "blocked" | "failed" | "none" | "refused";
  code: string | null;
  /**
   * Only for `blocked`: whether the merge gate itself recorded this stop as a `ready_human_merges` fact since the order was placed (a go-phase block carries the
   * gate's full reasons). False for a stop that never passed through the gate (a claim-time takeover or pairing change, a refused or closed pull request in the
   * go phase): the workflow records those, so the card says why.
   */
  gateRecorded?: boolean;
}

export interface AdvanceMergeGateResult {
  outcome: string;
  headSha?: string;
  reasons?: string[];
  status?: string;
  reason?: string;
}

/** What a fix round needs. The prompt is built by the caller (it holds the Spec text and the findings). */
export interface AdvanceFixRequest {
  /** The issue's number: it names the persistent sandbox, as the build used it. NEVER the pull request's number. */
  issue: number;
  /** The head the reviewers found fault with. */
  headSha: string;
  prompt: string;
  /** 1-based. */
  round: number;
  /** The approval that started the driver: names this fix attempt, so a replay finds its run and a fresh approval asks again. */
  actionId: string;
  /**
   * 0 (absent) for the first fix attempt on a head; 1 or more for a further attempt on the SAME head under the same approval (a re-review of a
   * "no change needed" fix that still asked for changes). It joins the run's key, so that attempt is a run of its own, not the finished one.
   */
  retry?: number;
  /**
   * D#483 S5-k1d: the number of the ask when an earlier ask of this fix round was denied by a spending limit (absent for the first ask). A denied start leaves a keyed
   * `refused_spend` run, and a replay of the same key finds that run again, so each later ask is a new attempt: `:s<n>` after everything else in the round's key.
   */
  spendAttempt?: number;
  /** Which review the card shows as asking for changes. */
  reviewer: "code" | "security" | "acceptance";
  /** A reviewer run whose verdict asked for the changes. Absent only for a person's round (`person`) with no reviewer finding on the head. */
  failingRunId?: string;
  /**
   * A person pressed Request changes: their note reaches the run as an accepted run note (fenced, like every run note), and the item is already at
   * Changes requested (the press moved it). Never set by a reviewer's round.
   */
  person?: boolean;
  /** D#6 R4d-1 (C32): the repository's execution mode the fix prompt was built for. Another mode at start refuses `execution_mode_changed`. */
  expectedExecutionMode?: string;
  /** D#600 CX-2: the prompt's sections (code, bytes, hash, trimmed bytes) from the assembler, stored on the run's context ledger. Absent: none recorded. */
  contextSections?: readonly ContextSection[];
  /** D#600 CX-10a: the cloud's assembly time for this prompt (and whether it built the repo map), stored on the run's context ledger. Absent: not recorded. */
  contextAssembly?: ContextAssembly;
  /**
   * D#600 CX-2: set when `prompt` says the Spec is unchanged instead of carrying it. It names the Spec version and hash the caller believes the executor's session holds.
   * The worker checks that against the Spec version pinned on the run whose session this round continues (never against the latest Spec) and sends `fallbackPrompt`
   * when it does not match. `fallbackPrompt` (with `fallbackContextSections`) is the same round with the Spec body: it is also what a fresh session gets when the
   * session's snapshot has expired. Required when `held` is set.
   */
  held?: { version: number; sha256: string };
  fallbackPrompt?: string;
  fallbackContextSections?: readonly ContextSection[];
  /** D#600 CX-4a: the files holding the findings text the prompt cut, and the uncut prompt a failed write falls back to; `fallbackContextSpill` is the same for `fallbackPrompt`. Sandbox side only. */
  contextSpill?: ContextSpill;
  fallbackContextSpill?: ContextSpill;
  /**
   * D#599 PL-2b-2: the pull request the round fixes, as the pipeline's own GitHub lookup just found it (number and head branch). Used only when the round's
   * side is not the side that opened the pull request: the round then works on that branch (a runner round as a continuation with no session, a sandbox
   * round bound to the pull request). It is checked against the item's recorded pull request or the issuer's own GitHub reads; never trusted on its own.
   */
  pr?: { number: number; branch: string };
}

export interface AdvanceRunRequest {
  accountId: string;
  workItemId: string;
  /** Names the step. The run's idempotency key is `advance:<workItemId>:<step>`, so a replayed step returns the same run. */
  step: string;
  role: string;
  prompt: string;
  /** Clone the item's repository (shallow, default branch) into the run's working directory before the agent starts. */
  clone?: boolean;
  /** Executor runs: the number that names the sandbox. The pull request does not exist yet, so the driver passes the issue's number. */
  pr?: number;
  /** SANDBOX-RERUN-BRANCH-a: the id the new run gets, chosen by the build step before its prompt (which names the rebuild's branch from it). A step that already has a run keeps that run's id; this one is then unused. */
  runId?: string;
  /** SANDBOX-RERUN-BRANCH-a: the branch a sandbox build pushes, recorded once as the run's `build.branch` event in its create transaction. Executor builds only. */
  buildBranch?: string;
  /** The item's fixed branch name; see `RunPorts.startRun`. */
  fixedBranch?: string;
  /** Start only if no OTHER run of the item is live (a run already claimed under this step's key is always returned). The executor uses it so two approvals cannot build twice. */
  exclusive?: boolean;
  /** Reviewer runs: the pull request head the review is for. Stored on the run (`head_sha`), which is what the merge gate reads. */
  headSha?: string;
  /** The halt epoch the caller's workflow was started under. A start under an older epoch is refused (`halted_since_approval`). */
  haltEpoch: number;
  /** D#6 R4d-1 (C32): the repository's execution mode the prompt was built for. Another mode at start refuses `execution_mode_changed`, and the role card is the one for this mode. */
  expectedExecutionMode?: string;
  /** D#6 R4d-5a (C34): the `spec_versions.id` the run is built from, pinned on the run at insert (the database's foreign key refuses another account's). */
  specVersionId?: string;
  /** D#600 CX-2: the prompt's sections (code, bytes, hash, trimmed bytes) from the assembler, stored on the run's context ledger. Absent: none recorded. */
  contextSections?: readonly ContextSection[];
  /** D#600 CX-10a: the cloud's assembly time for this prompt (and whether it built the repo map), stored on the run's context ledger. Absent: not recorded. */
  contextAssembly?: ContextAssembly;
  /** D#600 CX-4a: see `AdvanceFixRequest.contextSpill`. */
  contextSpill?: ContextSpill;
  /** D#601 MEM-3: the token estimate of the memory in the prompt, stored on the run's context ledger. Absent: not recorded. */
  memoryTokens?: number;
  /** D#601 MEM-3b: a runner run's recalled memory (person and fenced strings), signed into its job instead of sitting in the prompt. Anything that is not exactly the protocol's shape refuses the start. */
  jobMemory?: JobMemory;
  /** D#7 DP11c: the run this one continues the work of (a resume's parked run). Linked on the new run's row; the parked run is not touched. The run must belong to this item. */
  parentRunId?: string;
  /**
   * D#7 DP4b-3: the run's decision snapshot, built from `portsFor(...).decisionOffer()` before the prompt. Written as the run's `decision.snapshot` row inside its create
   * transaction, so a run never exists without it and a failed write leaves no run. Anything that is not exactly the snapshot's schema refuses the start. Executor builds only.
   */
  decisionSnapshot?: DecisionSnapshot;
}

/** The assembly time when it is a whole number of milliseconds in the ledger's range (and `cold` a boolean); anything else is dropped. */
function assemblyOf(value: unknown): ContextAssembly | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { ms, cold } = value as { ms?: unknown; cold?: unknown };
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 3_600_000) return undefined;
  return typeof cold === "boolean" ? { ms, cold } : { ms };
}

/** The assembler's section list when it is an array the ledger can hold (at most 64 entries); anything else is dropped, and the run is simply not given sections. The definer checks every entry. */
function sectionsOf(value: unknown): readonly ContextSection[] | undefined {
  return Array.isArray(value) && value.length <= 64 ? (value as readonly ContextSection[]) : undefined;
}

export type AdvanceRunStart = { ok: true; runId: string } | { ok: false; reason: string };

export interface AdvanceRunOutcome {
  status: string;
  done: boolean;
  /** The run's parsed AGENT_OUTPUT envelope, or null (none was written, or the run is gone). Model text: never shown as markup. */
  envelope: Record<string, unknown> | null;
  /** Where the run executes (`local`, `production` or `runner`); only a `runner` run's `pending` time is credited (D#6 C12 A3). Absent when the run is gone. */
  runtime?: string;
  /** D#6 C29: for a `runner` run, how long ago (milliseconds, on the database's clock) the tail run left `pending`, from its own `started_at`; null while pending or when none was recorded. Absent for any other runtime and when the run is gone. */
  runningMs?: number | null;
  /**
   * D#6 R2b-3 (C22 section 7): the run this outcome is about, which is the end of the follow-up chain that starts at the run asked
   * about. A runner run that ended `runner_lost` or `usage_limit` has a follow-up run, and the status, envelope and runtime above are
   * the last of those runs'. It is the id the caller must cancel, and the one a failure is recorded against. Absent when the run is gone.
   */
  tailRunId?: string;
  /** The tail's failure reason when it is a failed runner run (`runner_lost`, `usage_limit` or another fixed word), else null. Absent when the run is gone. */
  failureReason?: string | null;
}

/**
 * Where the item's pull request comes from (D#6 C25 section 1.2): the repository's execution mode and, for a `runner_local` repository,
 * the pull request number and run branch its newest executor run recorded at `done` (null when none did). A sandbox repository has no record.
 */
export interface AdvancePrSource {
  /** D#599 PL-2: the item's EFFECTIVE mode (its placement, else the repository's). Prompts, the run seat's card, gating and auto-merge follow it. */
  executionMode: string;
  /**
   * D#599 PL-2: the mode of the item's newest executor run, which is the side the pull request was built on, or the effective mode when the item has
   * no executor run yet. The pull request lookup (and the client it is read through) follows THIS, so a placement change does not hide the open PR.
   * Optional: absent, the lookup follows `executionMode`.
   */
  prExecutionMode?: string | undefined;
  /**
   * The pull request the newest executor run's side recorded. On a runner side, what its `done` recorded. D#599 PL-2b-2: on a SANDBOX side it is set only
   * with `bound: true`, the pull request a cross-side sandbox round was bound to (it carried on from a pull request the runner opened); a sandbox build
   * records none, and a sandbox lookup ignores a pair without the flag.
   */
  recordedPr: { number: number; branch: string; bound?: true } | null;
}

/** What the workflow reads about the item before it starts: plain data, or null when the item is gone. */
export interface AdvanceItem extends AdvancePrSource {
  stage: string;
  provenance: string;
  repoId: string | null;
  ghNumber: number | null;
  ghOwner: string | null;
  ghName: string | null;
  hasDiscussion: boolean;
  /** The discussion's kind, or null when the item has none. */
  kind: string | null;
  /** True when a published Spec (not erased) exists. */
  hasSpec: boolean;
  /** The newest published Spec's version, or null. The build and the review pin it when the person approves. */
  specVersion: number | null;
  /** At Needs a person because a reviewer kept ending without a verdict (see `readReviewHold`). Absent: no. */
  reviewHold?: boolean;
  /** D#483 S5-b2c-2: a planned PR child. `ghNumber`, `kind`, `hasSpec` and `specVersion` are then its parent's issue and the Spec version it names. */
  child?: true;
  /** D#483 S5-b2b: set when the item is not a planned PR child and its newest Spec plans two or more pull requests: the item itself is never built, its children are. */
  splits?: true;
  /** D#483 S5-b2b: set when the item is not a planned PR child and already has planned PR children. A re-spec to a single pull request must not turn such a parent into a build: its children stay, and a person decides. */
  hasChildren?: true;
  /** The item's branch from its build identity: `fx/issue-<n>`, or a planned PR child's own `fx/<parent#>-<key>`. Absent when the identity is refused. */
  branch?: string;
  /** Why the build identity was refused (`no_issue_link`, `child_orphaned`): the plan answers with it in place of a bare missing number. */
  identityRefusal?: string;
  /** The item's newest executor run (any status), or null. A build that ended with no pull request is recorded against it. */
  executorRunId: string | null;
  /**
   * D#483 S5-b2a part 3: set when the item's newest executor run FAILED ITS CHECK and a fix-round question or receipt is on record for it (the gate asked, or decided, before
   * the workflow ended). The re-entry resumes that run's check fix round. Null for any other item, so "Check the build" keeps its meaning for them.
   */
  checkFailedRunId?: string | null;
  /**
   * D#483 S4-e: the proposal this item was approved from, when there is one (third-party text, to be fenced by the prompt that reads it).
   * Absent or null for an item with no proposal. S4-b3: `claims` and `evidence` are read with it (see `AdvanceProposal`).
   */
  proposal?: AdvanceProposal | null;
}

/**
 * D#483 S4-b3: what the triage reads of an item's proposal. `claims` holds the texts of the claims whose verdict is `supported` and nothing else, so
 * a claim the system could not confirm never reaches a prompt as a fact. `evidence` holds every evidence row as `{ ref, excerpt }`: the excerpt is
 * the one the system read at the cited commit and stored, never text a model returned. Both are read when the driver loads the item (not when the
 * person approved), so a verification that ended after the approval is picked up. Optional for callers that build one by hand; the loader always sets them.
 */
export interface AdvanceProposal {
  id: string;
  title: string;
  summary: string | null;
  claims?: string[];
  evidence?: Array<{ ref: string; excerpt: string }>;
}

/**
 * D#483 S4-b3: the supported claims and the evidence of one proposal, in the caller's tenant transaction (the stage driver's runner login, which reads
 * both tables through `app_user`'s SELECT grant and its tenant policy; it can write neither). The explicit account filter repeats what the policy
 * enforces. Ordered so the same rows always give the same intake body: claims by text then id, evidence by when it was stored then id.
 */
export async function readProposalIntakeFacts(
  client: Pick<PoolClient, "query">,
  accountId: string,
  proposalId: string,
): Promise<{ claims: string[]; evidence: Array<{ ref: string; excerpt: string }> }> {
  const claims = await client.query<{ text: string }>(
    "SELECT c.text FROM proposal_claims c WHERE c.account_id = $1 AND c.proposal_id = $2 AND c.verdict = 'supported' ORDER BY c.text, c.id",
    [accountId, proposalId],
  );
  const evidence = await client.query<{ ref: string; excerpt: string }>(
    "SELECT e.ref, e.excerpt FROM proposal_evidence e WHERE e.account_id = $1 AND e.proposal_id = $2 ORDER BY e.created_at, e.id",
    [accountId, proposalId],
  );
  return { claims: claims.rows.map((c) => c.text), evidence: evidence.rows.map((e) => ({ ref: e.ref, excerpt: e.excerpt })) };
}

interface PrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: string;
  user_id: string | null;
}

export interface AdvanceFacade {
  /**
   * Performs a CLAIMED `advance_work_item` action. Takes the action id and nothing else. Outcome
   * `{ work_item_id, advance: "started" }`. Refusals: principal_not_authorised, kind_mismatch, advance_unavailable,
   * target_not_found, external_requires_human, no_repo, no_issue_link, not_advanceable (not at a stage the driver
   * can advance, or already triaged), already_running (a run of the item is live).
   */
  performAdvanceWorkItem(actionId: string): Promise<PerformResult>;
  /**
   * D#6 R4d-5b (C34 section 2.3): performs a CLAIMED `respec_work_item` action: starts the advance workflow in Re-spec mode. Same checks and refusals as
   * `performAdvanceWorkItem` (and the same lift of a halt a person's later press resumes), except that the item must be at Spec ready or Needs a person with a
   * newest Spec that has no readable file list (`not_advanceable` otherwise, `spec_has_file_list` when it has one), and the first seat is the project manager's.
   */
  performRespecWorkItem(actionId: string): Promise<PerformResult>;
  /**
   * D#597 CC-2b: performs a CLAIMED `amend_spec_work_item` action: publishes the next Spec version for the item's accepted `spec_amend` corrections (oldest
   * first, one section each) and stamps each `applied`. No agent runs. Refuses `already_running` while an agent run of the item is live (the route refused
   * it first; this is the race), and with the publish's own fixed code otherwise (`spec_frozen`, `spec_changed`, `spec_too_large`, ...), leaving the
   * corrections `accepted` so a person can still reject them. A replay never adds a second version.
   */
  performAmendSpec(actionId: string): Promise<PerformResult>;
  advanceLoadItem(accountId: string, workItemId: string): Promise<AdvanceItem | null>;
  /** Starts one run of `req.role` for the item, keyed `advance:<item>:<step>`. Never throws for a refusal: it answers `{ ok: false, reason }`. */
  advanceStartRun(req: AdvanceRunRequest): Promise<AdvanceRunStart>;
  advanceRunOutcome(accountId: string, runId: string): Promise<AdvanceRunOutcome>;
  advanceTriage(accountId: string, input: AdvanceTriageInput): Promise<AdvanceTriageResult>;
  /** D#483 P2: the panel (round 1 and the one challenge round) for a discussed item. Never throws for a refusal. */
  advancePanel(who: AdvanceStepWho): Promise<AdvanceStepResult>;
  /**
   * D#483 P2: the pipeline's Spec step (re-enters the panel, runs the PM, publishes the Spec). `attempt` (the approval's id)
   * names this attempt's PM run, so an approval after a PM run that failed starts a fresh one (P3).
   */
  advanceSpec(who: AdvanceStepWho, attempt?: string, spendAttempt?: number): Promise<AdvanceStepResult>;
  /**
   * D#483 P2: starts the executor for an item at `spec_ready` and records `spec_ready -> in_progress`. `approvalId` names the
   * approval (the run action). P3: `expectedVersion` is the Spec version the person approved; a newer one refuses `spec_changed`.
   * A refused start is recorded as a `build_refused` driver event. D#483 S5-k1: `spendAttempt` is the workflow's count of asks that a spend limit denied (absent for the first ask); it keys the run so a later ask is a new start.
   */
  advanceBuild(who: AdvanceStepWho, approvalId: string, expectedVersion?: number, spendAttempt?: number): Promise<AdvanceStepResult>;
  /**
   * D#7 DP4b-2 (R-7-DP4b-2): after a `succeeded` executor run, reads its `decision_request` and `decisions_taken`. One fixed word back: `none` and `resolved` (carry on),
   * `parked` (an ask is waiting for a person: the workflow ends, the stage stays), `refused` (a field was dropped; carry on), `item_halted` / `halted_since_approval`.
   */
  advanceDecision(accountId: string, userId: string, workItemId: string, haltEpoch: number, runId: string): Promise<DecisionStepCode>;
  /** D#483 P2: records a build that ended without a pull request as `in_progress -> needs_human`. `code` is a fixed word. */
  advanceBuildFailed(accountId: string, workItemId: string, runId: string | null, code: string, attempt?: string): Promise<AdvanceStepResult>;
  /**
   * "Check the build": the driver found the item's open pull request while the item still sits at `in_progress` (the
   * webhook that moves it never arrived). Records `in_progress -> pr_opened` so the review can record its verdicts. An item
   * at any other stage is left alone (`unchanged`).
   */
  advancePrFound(who: AdvanceStepWho, prNumber: number): Promise<AdvanceStepResult>;

  /**
   * D#483 P3: publishes the short Spec of a small, bug or doc item from the finished project-manager run `runId` (an
   * `advanceStartRun` of this item; the worker reads the run's result itself, so it never passes through the workflow).
   * `published` moves the item to spec_ready; `not_feasible` publishes nothing (the PM's reason stays in the run, as its
   * summary, for the card); `refused` carries a fixed code. A replay on an item that already has its Spec publishes nothing more.
   */
  /** `split` is set (true) only when the published version plans two or more pull requests: the item then waits at Spec ready for a person's approval, which creates the children. */
  advanceLightSpec(who: AdvanceStepWho, runId: string, actionId: string): Promise<{ status: string; reason: string | null; version: number | null; split?: true }>;
  /**
   * D#6 R4d-5b (C34 section 2.3): publishes the next Spec version from the finished project-manager run `runId` (file-list mode; the worker reads the run's
   * result itself). `expectedVersion` is the version its prompt was made from. `published` leaves the item at Spec ready (from Needs a person it moved there through
   * Discussing in the same transaction); `refused` carries a fixed code and publishes nothing, and an unreadable list (`invalid_file_scope`) is recorded as the
   * fact the card's notice reads (`respec_list_unreadable`). A replay on an item whose newest Spec already has its list publishes nothing more.
   */
  advanceRespec(who: AdvanceStepWho, runId: string, actionId: string, expectedVersion: number): Promise<{ status: string; reason: string | null; version: number | null }>;
  /** D#483 P3: the item's review context, or a fixed refusal. Plain data; the Spec text is not in it. */
  advanceLoadReview(who: AdvanceStepWho): Promise<AdvanceReviewLoad>;
  /** D#483 P3: the Spec's text for the version the person approved, or null (erased, or a newer version exists). Read inside the step that builds a prompt, never kept in the workflow. */
  advanceLoadSpecText(who: AdvanceStepWho, expectedVersion: number): Promise<{ version: number; body: string; sha256?: string } | null>;
  /** D#483 P3: every verdict of one head recorded (passes first, non-passes last) and the decision that follows. */
  advanceRecordRound(who: AdvanceStepWho, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">): Promise<AdvanceRoundResult | { decision: "refused"; reason: string }>;
  /** D#598 P7c: a new head that is only a merge of the base branch is recorded as re-checked (no reviewer runs), or answers `full_review` / `ci_pending`; nothing is written in those two. */
  advanceRecordMergeOnly(who: AdvanceStepWho, input: Omit<AdvanceMergeOnlyInput, "accountId" | "workItemId">): Promise<AdvanceMergeOnlyResult | { decision: "refused"; reason: string }>;
  /**
   * D#483 P3: an executor fix round, continuing the build's persistent sandbox and session. Never a fresh start; refuses a
   * second concurrent resume (`already_running`); moves the card to Changes requested whatever an earlier record said;
   * records `fix_round_started` or `fix_round_refused`. A replay of the same approval and head returns the run it started.
   */
  advanceStartFix(who: AdvanceStepWho, req: AdvanceFixRequest): Promise<AdvanceRunStart>;
  /**
   * D#6 R-CHK-3 (C47): the fix round that follows a build run whose approved check failed (`failed check_failed`, no pull request). Resumes that run's session on its recorded run branch.
   * Refuses `check_rounds_used` once the plan's `maxFixRounds()` rounds have been spent in this run's `parent_run_id` chain (a count per chain, not per item: a later "Build again" starts a new chain; the driver then ends the item in Needs human), `already_running`, `not_check_failed`.
   * A replay returns the run it started.
   */
  advanceStartCheckFix(who: AdvanceStepWho, failedRunId: string): Promise<AdvanceRunStart>;
  /**
   * D#2 H14c-3-3b-2 (C88 R1): an executor run the workflow waits on ended at a limit (`timed_out` / `killed_spend`). Continues it when the customer's run limits allow, and
   * answers one fixed code (see `AdvanceContinueOut`); anything this step cannot decide is `today`, the path the workflow took before continuation existed. Never throws.
   * A replay answers the child the first pass started. The halt guard is the same as every other step's (`halted`).
   */
  advanceContinue(who: AdvanceStepWho, endedRunId: string, site?: ContinuationSite): Promise<AdvanceContinueOut>;
  /**
   * D#483 S5-k1d: the reviewer runs of one head and re-review round that really started (every run but a `refused_spend` one), newest per role. A restarted review
   * uses these runs and asks only for the roles that have none, because the key of a denied ask finds its own refused run again and must never be replayed.
   * `attempt` is the highest attempt (`:s<n>`) among ALL of the role's keys on this head and round, refused ones included: a re-run of a reviewer whose run ended
   * without a verdict asks under the next one, so it can never land on an existing key.
   * `noVerdictEnds` is how many of the role's runs on this head (every re-review round) STORED as ended without a verdict (a terminal run that is not a spending-limit
   * refusal and left no `verdict`), counted from the first ask after the newest `reviewer_no_verdict` escalation of the item. That is the re-run bound's count: it comes from
   * the stored runs, so a workflow that restarts (a spending-limit pause that resumed) cannot reset it. Only a person's Approve at Needs a person moves the boundary (the
   * item reaches it only through that escalation), so Approve starts the count again.
   */
  advanceReviewRuns(who: AdvanceStepWho, req: { headSha: string; rereview: number }): Promise<Array<{ role: string; runId: string; attempt: number; noVerdictEnds: number }>>;
  /**
   * D#519 MQ3-b-2b: the newest delta-review run of each role on one merge commit, found by key (`advance:<item>:delta:<head>:<role>[:s<n>]`). `attempt` is the
   * highest `:s<n>` any run of the role has; `reusable` is false for a run that ended `cancelled` or `refused_spend` (its key cannot start the role again).
   */
  advanceDeltaRuns(who: AdvanceStepWho, req: { headSha: string }): Promise<Array<{ role: string; runId: string; attempt: number; reusable: boolean }>>;
  /** D#483 P3: the merge gate on the pull request's current head. */
  advanceMergeGate(who: AdvanceStepWho, prNumber: number): Promise<AdvanceMergeGateResult>;
  /**
   * D#6 PUBLIC-MERGE PR2b: one look at the merge order the gate placed (`merge_delegated`): lapsed leases are returned to the queue, an authorized order the runner
   * never reported on is ended from GitHub's own answer, and an order past its 60-minute deadline is expired (`runner_merge_timeout`). One read of the order otherwise.
   */
  advanceMergeOrder(who: AdvanceStepWho): Promise<AdvanceMergeOrderResult>;
  /**
   * D#6 R5b-2a: whether the reviewers of a pull request may start now. Only a `runner_verified` repository waits: its reviews start ten minutes after the
   * later of the executor's end and the newest push (answer `wait`), and not without a usable model key (`key_missing`). Any other mode answers
   * `not_verified` with the mode it is in now. `seenHead` is the head the previous check read (null on the first): a different one is a push the webhook has not told us.
   */
  advanceVerifiedReviewGate(who: AdvanceStepWho, input: { prNumber: number; headSha: string; seenHead: string | null }): Promise<VerifiedReviewGate | { state: "refused"; reason: string }>;
  /** D#483 P3: one recorded driver event (fixed vocabulary). A repeat of the same key writes nothing. */
  advanceRecordEvent(who: AdvanceStepWho, event: Omit<DriverEventInput, "workItemId">): Promise<{ recorded: boolean }>;
  /** D#483 P3: stops a live run of this item through the runner's own cancel, as the approver. */
  advanceCancel(who: AdvanceStepWho, runId: string): Promise<void>;
  /**
   * D#6 WAITCANCEL: stops every live run the panel or the Spec step started for this item (matched by the step's run-key prefix, queued and unclaimed ones
   * included) and the tail of each one's follow-up chain. For the workflow's wait that ran out, when it holds no run id.
   */
  advanceCancelStepRuns(who: AdvanceStepWho, step: "panel" | "spec", actionId: string): Promise<void>;
  /**
   * D#7 start gate (b): the start decision at the end of triage and at the entry of the short Spec, the spec step and the build. The advance was filed by a
   * person (`performDriven`), so the click is the decision: a PERSON start receipt, never an ask; an item that came in small and triage found larger is asked
   * (`start_after_reclassify`) and the workflow ends waiting. Answers `proceed: true` or a fixed reason it stopped (`asked`, `held`, `blocked`).
   */
  advanceStartGate(who: AdvanceStepWho, input: StartGateStepInput): Promise<StartGateStepOut>;
  /** D#483 S5-b2a part 2: whether a review fix round may start now (see `gateFixRound`). Fixed words out. Never called for a person's Request changes round or a continuation. */
  advanceFixGate(who: AdvanceStepWho, input: FixGateStepInput): Promise<FixGateStepOut>;
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createAdvanceModule(runnerPool: Pool, deps: AdvanceModuleDeps): AdvanceFacade {
  const performAdvanceWorkItem = (actionId: string): Promise<PerformResult> => performDriven(actionId, "advance_work_item");
  const performRespecWorkItem = (actionId: string): Promise<PerformResult> => performDriven(actionId, "respec_work_item");

  async function performDriven(actionId: string, wanted: "advance_work_item" | "respec_work_item"): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const { rows } = await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId]);
    const who = rows[0];
    if (!who || !who.allowed || who.user_id === null || who.principal_kind !== "session") return refused("principal_not_authorised");
    if (who.kind !== wanted) return refused("kind_mismatch");
    const respec = wanted === "respec_work_item";
    if (!deps.startAdvance) return refused("advance_unavailable");
    const { account_id: accountId, user_id: userId, target_id: workItemId } = who;

    const read = await withTenant(runnerPool, accountId, userId, async (client) => {
      const role = await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
      // D#483 S5-b2c-2: a planned PR child reads its PARENT's issue number and the Spec version it names (its kind is its own, it has no discussion); `child` routes it straight to the build.
      const item = await client.query<{ stage: string; provenance: string; repo_id: string | null; discussion_id: string | null; kind: string | null; has_spec: boolean; spec_version: number | null; acceptance_files: unknown; child: boolean; planned_count: number | null }>(
        `SELECT w.stage, w.provenance, w.repo_id, w.discussion_id,
                CASE WHEN w.planned_pr_key IS NULL THEN d.kind ELSE w.kind END AS kind, (w.planned_pr_key IS NOT NULL) AS child,
                EXISTS (SELECT 1 FROM spec_versions s WHERE s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL}) AS has_spec,
                (SELECT max(s.version) FROM spec_versions s WHERE s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL}) AS spec_version,
                (SELECT s.frontmatter -> 'acceptance_files' FROM spec_versions s WHERE s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL} ORDER BY s.version DESC LIMIT 1) AS acceptance_files,
                (SELECT CASE WHEN jsonb_typeof(s.frontmatter -> 'planned_prs') = 'array' THEN jsonb_array_length(s.frontmatter -> 'planned_prs') ELSE 0 END FROM spec_versions s
                  WHERE w.planned_pr_key IS NULL AND s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL} ORDER BY s.version DESC LIMIT 1) AS planned_count
           FROM work_items w LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
          WHERE w.id = $1 AND w.account_id = $2`,
        [workItemId, accountId],
      );
      // D#483 S5-b2c-3 (R7): the issue number is the build identity's (a planned PR child's is its parent's); this read runs no launch check, the build does.
      const identity = item.rows[0] ? await resolveBuildIdentity(client, accountId, workItemId, "observe") : null;
      const live = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))",
        [accountId, workItemId, [...ADVANCE_TERMINAL_STATUSES]],
      );
      // D#483 S3 E8: the proposal behind this work item, if there is one. Its owner decides whether this product may start it.
      const owner = await client.query<{ owner_process: string }>(
        "SELECT owner_process FROM proposals WHERE account_id = $1 AND work_item_id = $2 LIMIT 1",
        [accountId, workItemId],
      );
      const hold = item.rows[0]?.stage === "needs_human" ? await readReviewHold(client, workItemId) : false;
      return { role: role.rows[0]?.role, item: item.rows[0] ? { ...item.rows[0], issue_number: identity?.ok ? identity.identity.issueNumber : null, no_verdict_hold: hold } : undefined, live: Number(live.rows[0]?.n ?? 0), proposalOwner: owner.rows[0]?.owner_process ?? null };
    });
    if (read.role !== "owner" && read.role !== "admin") return refused("principal_not_authorised");
    const item = read.item;
    if (!item) return refused("target_not_found");
    // E8: one process per item, at start. An item the repository's own development loop owns is never started from here, whatever route
    // asked (the proposal approve route checks it too; this covers a direct POST /work-items/{id}/approve). Fail closed: any owner but
    // the literal "product" refuses.
    if (read.proposalOwner !== null && read.proposalOwner !== "product") return refused("owned_by_internal_loop");
    // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
    if (item.provenance !== "internal") return refused("external_requires_human");
    if (item.repo_id === null) return refused("no_repo");
    // S4-e: an item approved from a proposal with no issue (a Discussion, a task, a docs/code/interview source) has no number; the proposal is its input.
    if (item.issue_number === null && read.proposalOwner === null) return refused("no_issue_link");
    const verdict = advanceActionFor({ ...item, ...(item.child ? { child: true } : {}) });
    if (!verdict.ok) return refused("not_advanceable");
    // A Re-spec is for the two stages a build starts from, and only while the newest Spec has no readable list (the same table and parser the route and the card ask).
    if (respec) {
      if (verdict.action !== "build" && verdict.action !== "rebuild") return refused("not_advanceable");
      if (parseAcceptanceScope(item.acceptance_files).kind === "known") return refused("spec_has_file_list");
    }
    if (read.live > 0) return refused("already_running");

    // Every refusal that costs nothing is answered NOW, so the Approve sentence can say it: a role with no card, a model
    // with no key, an unset model budget, no usable GitHub installation. The seat resolver is read-only; it starts nothing.
    // The role asked is the first one the action starts. A refused build is also recorded as a fact of the item.
    const seatRole = respec ? "project-manager" : PREFLIGHT_ROLE[verdict.action];
    const seat = seatRole === null ? null : await deps.resolveRunSeat({ accountId, role: seatRole, workItemId });
    if (seat !== null && !seat.ok) {
      if (!respec && (verdict.action === "build" || verdict.action === "rebuild")) {
        await withTenant(runnerPool, accountId, userId, (client) =>
          recordDriverEvent(client, accountId, { workItemId, kind: "build_refused", dedupeKey: `preflight:${actionId}`, code: seat.reason }),
        );
      }
      console.info(JSON.stringify({ event: "advance.preflight_refused", work_item_id: workItemId, action: verdict.action, reason: seat.reason }));
      return refused(seat.reason);
    }

    // The one place a halt is lifted: a person's approval that was requested AFTER the halt. An approval pressed before the
    // halt and performed after it is not a resume (the person's latest act was the halt), so the item stays halted.
    const lifted = await withTenant(runnerPool, accountId, userId, async (client) => {
      await client.query(
        `UPDATE work_items SET halted_at = NULL, halt_action_id = NULL
          WHERE id = $1 AND account_id = $2 AND halted_at IS NOT NULL
            AND halted_at < (SELECT q.created_at FROM run_action_requests q WHERE q.id = $3 AND q.account_id = $2)`,
        [workItemId, accountId, actionId],
      );
      const r = await client.query<{ halted: boolean; halt_epoch: number }>("SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId]);
      return r.rows[0];
    });
    if (!lifted) return refused("target_not_found");
    if (lifted.halted) return refused("item_halted");
    // D#598 P8a: an open setup request (or a withdrawn one nobody has advanced past) holds the item until a person acts on it; derived from the requests, never stamped.
    const setupHold = await withTenant(runnerPool, accountId, userId, (client) => setupHoldFor(client, workItemId));
    if (setupHold) return refused(setupHold);

    // D#483: a build that cannot take a slot yet is not "started". The wait is recorded now as the item's own waiting fact (the card reads it; the workflow's polls
    // keep it fresh) and the outcome says so, with the reason. A check that fails decides nothing: the workflow's start is the authority, and the answer stays "started".
    // A parent whose newest Spec plans two or more pull requests never builds itself (its workflow answers `children_launched`, and the build start refuses `parent_splits`), so it
    // takes no slot and has none to wait for: no wait fact, and the approval settles `started` like any other performed approval. Its children are launched by their own gate.
    const splitsParent = !item.child && Number(item.planned_count ?? 0) >= 2;
    let waitReason: string | null = null;
    if (!respec && !splitsParent && (verdict.action === "build" || verdict.action === "rebuild") && deps.buildWaitReason) {
      try {
        waitReason = await deps.buildWaitReason(runnerPool, accountId, workItemId);
      } catch (err) {
        reportError(err, { stage: "advance.build_wait_check" });
        waitReason = null;
      }
      if (waitReason !== null && !BUILD_SLOT_WAIT_REASONS.includes(waitReason)) waitReason = null;
      if (waitReason !== null) {
        const code = waitReason;
        await withTenant(runnerPool, accountId, userId, (client) =>
          recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage: "build", attempt: 0, dedupeKey: `approve_wait:${actionId}`, code }),
        );
      }
    }

    // A start the dial filed is the dial's, not the person's in whose name the request stands: the request's key says so, and so does the proposal it approved.
    const dialFiled = await withTenant(runnerPool, accountId, userId, async (client) => {
      const r = await client.query(
        `SELECT 1 FROM run_action_requests q WHERE q.id = $1 AND q.account_id = $2 AND q.idempotency_key LIKE 'dial:%'
         UNION ALL SELECT 1 FROM proposals p WHERE p.account_id = $2 AND p.work_item_id = $3 AND p.decided_by_kind = 'dial'`,
        [actionId, accountId, workItemId],
      );
      return r.rows.length > 0;
    });
    await deps.startAdvance({ accountId, userId, workItemId, actionId, haltEpoch: lifted.halt_epoch, specVersion: item.spec_version === null ? null : Number(item.spec_version), personFiled: !dialFiled, ...(dialFiled ? { dialFiled: true } : {}), ...(respec ? { respec: true } : {}) });
    console.info(JSON.stringify({ event: respec ? "advance.respec_started" : "advance.started", work_item_id: workItemId, action_id: actionId, ...(waitReason === null ? {} : { waiting: waitReason }) }));
    if (waitReason !== null) return { result: "done", outcome: { work_item_id: workItemId, advance: "waiting", reason: waitReason, reasons: [waitReason] } };
    return { result: "done", outcome: { work_item_id: workItemId, advance: "started" } };
  }

  /** A publish, a look for amendments accepted meanwhile, and room for one retry after a reject that raced a publish. */
  const AMEND_ROUNDS = 3;
  async function performAmendSpec(actionId: string): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const { rows } = await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId]);
    const who = rows[0];
    if (!who || !who.allowed || who.user_id === null || who.principal_kind !== "session") return refused("principal_not_authorised");
    if (who.kind !== "amend_spec_work_item") return refused("kind_mismatch");
    if (!deps.amendSpec) return refused("amend_unavailable");
    const { account_id: accountId, user_id: userId, target_id: workItemId } = who;

    let amended = 0;
    let lastVersion: number | null = null;
    for (let round = 0; round < AMEND_ROUNDS; round += 1) {
      const read = await withTenant(runnerPool, accountId, userId, async (client) => {
        const role = await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
        const item = await client.query<{ provenance: string }>("SELECT provenance FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId]);
        const live = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))",
          [accountId, workItemId, [...ADVANCE_TERMINAL_STATUSES]],
        );
        const pending = await client.query<{ id: string; body: string; decided_at: Date; name: string | null }>(
          `SELECT c.id, c.body, c.decided_at, COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, '')) AS name
             FROM work_item_corrections c LEFT JOIN users u ON u.id = c.decided_by
            WHERE c.account_id = $1 AND c.work_item_id = $2 AND c.kind = 'spec_amend' AND c.status = 'accepted' AND c.decided_at IS NOT NULL
            ORDER BY c.decided_at, c.id`,
          [accountId, workItemId],
        );
        return { role: role.rows[0]?.role, item: item.rows[0], live: Number(live.rows[0]?.n ?? 0), pending: pending.rows };
      });
      if (read.role !== "owner" && read.role !== "admin") return refused("principal_not_authorised");
      if (!read.item) return refused("target_not_found");
      // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
      if (read.item.provenance !== "internal") return refused("external_requires_human");
      if (read.live > 0) return refused("already_running");
      // Nothing accepted any more (each was rejected or already delivered): done, nothing published.
      if (read.pending.length === 0) break;

      const items: AmendSpecItem[] = read.pending.map((p) => ({ id: p.id, text: p.body, name: p.name ?? "a former member", date: new Date(p.decided_at) }));
      const out = await deps.amendSpec(runnerPool, accountId, workItemId, items);
      if (out.status !== "published" && out.status !== "already_published") {
        const code = typeof out.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(out.reason) ? out.reason : "publish_failed";
        // A person rejected one between the read and the publish: the publish wrote nothing, so read again without it.
        if (code === "correction_not_accepted" && round < AMEND_ROUNDS - 1) continue;
        console.info(JSON.stringify({ event: "advance.amend_refused", work_item_id: workItemId, reason: code }));
        return refused(code);
      }
      // A fresh publish stamped its corrections in its own transaction (a reject can no longer be overridden). This only finishes a version that was published
      // before that was so (already_published); on the rest it is a no-op.
      for (const item of items) await withTenant(runnerPool, accountId, userId, (client) => markCorrectionApplied(client, { id: item.id, runId: null }));
      amended += items.length;
      lastVersion = out.version ?? lastVersion;
      // The loop reads again: an amendment accepted while this one published joined this (already claimed) request and would otherwise wait for a later accept.
    }
    console.info(JSON.stringify({ event: "advance.amended", work_item_id: workItemId, version: lastVersion, amended }));
    return { result: "done", outcome: amended === 0 ? { work_item_id: workItemId, amended: 0 } : { work_item_id: workItemId, amended, version: lastVersion } };
  }

  /**
   * The item's effective mode (D#599 PL-2: its placement, else the repository's), the side its newest executor run was on, and, when that side is a
   * runner, the pull request that run recorded. Read in the item's tenant.
   */
  async function boundSandboxPullRequest(client: Parameters<typeof readSandboxBoundPullRequest>[0], accountId: string, workItemId: string): Promise<{ number: number; branch: string; bound: true } | null> {
    const pr = await readSandboxBoundPullRequest(client, { accountId, workItemId });
    return pr === null ? null : { ...pr, bound: true };
  }

  async function pullRequestSource(accountId: string, workItemId: string): Promise<AdvancePrSource> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query<{ execution_mode: string | null; newest_mode: string | null }>(
        `SELECT ${effectiveModeSql("w", "r")} AS execution_mode,
                (SELECT ar.execution_mode FROM agent_runs ar WHERE ar.account_id = w.account_id AND ar.work_item_id = w.id AND ar.role = 'executor' ORDER BY ar.created_at DESC, ar.id DESC LIMIT 1) AS newest_mode
           FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id WHERE w.id = $1 AND w.account_id = $2`,
        [workItemId, accountId],
      );
      const executionMode = r.rows[0]?.execution_mode ?? "sandbox";
      const prExecutionMode = r.rows[0]?.newest_mode ?? executionMode;
      const runnerSide = isRunnerMode(prExecutionMode);
      return {
        executionMode,
        prExecutionMode,
        // D#599 PL-2b-2: on the sandbox side this is the pull request a cross-side sandbox round was bound to (null for a build, found by `fx/issue-<n>`).
        recordedPr: runnerSide ? await readRecordedRunnerPullRequest(client, { accountId, workItemId }) : await boundSandboxPullRequest(client, accountId, workItemId),
      };
    });
  }

  async function advanceLoadItem(accountId: string, workItemId: string): Promise<AdvanceItem | null> {
    if (!UUID_RE.test(accountId) || !UUID_RE.test(workItemId)) return null;
    const item = await loadItemRow(accountId, workItemId);
    return item === null ? null : { ...item, ...(await pullRequestSource(accountId, workItemId)) };
  }

  async function loadItemRow(accountId: string, workItemId: string): Promise<Omit<AdvanceItem, keyof AdvancePrSource> | null> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query<{ child: boolean; planned_pr_key: string | null; stage: string; provenance: string; repo_id: string | null; discussion_id: string | null; gh_owner: string | null; gh_name: string | null; kind: string | null; has_spec: boolean; spec_version: number | null; executor_run_id: string | null; planned_count: number | null; has_children: boolean; check_failed_run_id: string | null; p_id: string | null; p_title: string | null; p_summary: string | null }>(
        `SELECT w.stage, w.provenance, w.repo_id, w.discussion_id, r.gh_owner, r.gh_name,
                CASE WHEN w.planned_pr_key IS NULL THEN d.kind ELSE w.kind END AS kind, (w.planned_pr_key IS NOT NULL) AS child, w.planned_pr_key,
                (SELECT ar.id FROM agent_runs ar WHERE ar.account_id = w.account_id AND ar.work_item_id = w.id AND ar.role = 'executor' ORDER BY ar.created_at DESC, ar.id DESC LIMIT 1) AS executor_run_id,
                (SELECT x.id FROM (SELECT a.id, a.status, a.account_id FROM agent_runs a WHERE a.account_id = w.account_id AND a.work_item_id = w.id AND a.role = 'executor' ORDER BY a.created_at DESC, a.id DESC LIMIT 1) x
                  WHERE x.status = 'failed'
                    AND EXISTS (SELECT 1 FROM run_events e WHERE e.account_id = x.account_id AND e.run_id = x.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed' AND e.payload->>'failureReason' = 'check_failed')
                    AND (EXISTS (SELECT 1 FROM decision_asks k WHERE k.account_id = w.account_id AND k.work_item_id = w.id AND k.decision_type = 'launch_sub_item' AND k.sub_item_key = 'check-' || left(replace(x.id::text, '-', ''), 12))
                      OR EXISTS (SELECT 1 FROM decision_receipts k WHERE k.account_id = w.account_id AND k.work_item_id = w.id AND k.decision_type = 'launch_sub_item' AND k.sub_item_key = 'check-' || left(replace(x.id::text, '-', ''), 12)))) AS check_failed_run_id,
                pr.id AS p_id, pr.title AS p_title, pr.summary AS p_summary,
                EXISTS (SELECT 1 FROM spec_versions s WHERE s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL}) AS has_spec,
                (SELECT max(s.version) FROM spec_versions s WHERE s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL}) AS spec_version,
                (SELECT CASE WHEN jsonb_typeof(s.frontmatter -> 'planned_prs') = 'array' THEN jsonb_array_length(s.frontmatter -> 'planned_prs') ELSE 0 END FROM spec_versions s
                  WHERE w.planned_pr_key IS NULL AND s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL} ORDER BY s.version DESC LIMIT 1) AS planned_count,
                (w.planned_pr_key IS NULL AND ${hasLivePlannedChildSql("w")}) AS has_children
           FROM work_items w
           LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
           LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
           LEFT JOIN proposals pr ON pr.account_id = w.account_id AND pr.work_item_id = w.id AND pr.state = 'approved'
          WHERE w.id = $1 AND w.account_id = $2`,
        [workItemId, accountId],
      );
      const row = r.rows[0];
      // D#483 S5-b2c-3 (R7): the issue number and the branch are the build identity's. A read of what exists, so no launch check: the build re-runs them when it starts.
      const identity = row ? await resolveBuildIdentity(client, accountId, workItemId, "observe") : null;
      const reviewHold = row?.stage === "needs_human" ? await readReviewHold(client, workItemId) : false;
      const facts = row && row.p_id !== null ? await readProposalIntakeFacts(client, accountId, row.p_id) : null;
      return row
        ? {
            reviewHold,
            ...(row.child ? { child: true } : {}),
            ...(Number(row.planned_count ?? 0) >= 2 ? { splits: true as const } : {}),
            ...(row.has_children ? { hasChildren: true as const } : {}),
            ...(identity?.ok ? { branch: identity.identity.branch } : {}),
            ...(identity !== null && !identity.ok ? { identityRefusal: identity.reason } : {}),
            stage: row.stage,
            provenance: row.provenance,
            repoId: row.repo_id,
            ghNumber: identity?.ok ? identity.identity.issueNumber : null,
            ghOwner: row.gh_owner,
            ghName: row.gh_name,
            hasDiscussion: row.discussion_id !== null,
            kind: row.kind,
            hasSpec: row.has_spec,
            specVersion: row.spec_version === null ? null : Number(row.spec_version),
            executorRunId: row.executor_run_id,
            checkFailedRunId: row.check_failed_run_id,
            proposal: row.p_id === null || facts === null ? null : { id: row.p_id, title: row.p_title ?? "", summary: row.p_summary, claims: facts.claims, evidence: facts.evidence },
          }
        : null;
    });
  }

  async function advanceStartRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    if (!UUID_RE.test(req.accountId) || !UUID_RE.test(req.workItemId) || !/^[a-z0-9:_.-]{1,128}$/i.test(req.step)) return { ok: false, reason: "invalid_input" };
    if (!deps.starter) return { ok: false, reason: "starter_unavailable" };
    if (req.pr !== undefined && !(Number.isSafeInteger(req.pr) && req.pr > 0)) return { ok: false, reason: "invalid_input" };
    if (req.expectedExecutionMode !== undefined && !MODE_RE.test(req.expectedExecutionMode)) return { ok: false, reason: "invalid_input" };
    if (req.specVersionId !== undefined && !UUID_RE.test(req.specVersionId)) return { ok: false, reason: "invalid_input" };
    if (req.parentRunId !== undefined && !UUID_RE.test(req.parentRunId)) return { ok: false, reason: "invalid_input" };
    // A prompt that was cut needs its files: a spill that is not exactly the closed shape refuses the start rather than send a cut prompt with nothing to read.
    if (req.contextSpill !== undefined && !isContextSpill(req.contextSpill)) return { ok: false, reason: "invalid_input" };
    if (req.jobMemory !== undefined && !JobMemorySchema.safeParse(req.jobMemory).success) return { ok: false, reason: "invalid_input" };
    // D#7 DP4b-3: only an executor run has a decision snapshot, and it must be exactly the snapshot's schema (checked again when it is written).
    const snapshotOf = req.decisionSnapshot === undefined ? undefined : parseDecisionSnapshot(req.decisionSnapshot);
    if (req.decisionSnapshot !== undefined && (req.role !== "executor" || snapshotOf === null)) return { ok: false, reason: "invalid_input" };
    if (req.runId !== undefined && !UUID_RE.test(req.runId)) return { ok: false, reason: "invalid_input" };
    if (req.buildBranch !== undefined && (req.role !== "executor" || typeof req.buildBranch !== "string" || req.buildBranch.length > 80)) return { ok: false, reason: "invalid_input" };
    if (req.fixedBranch !== undefined && (req.buildBranch === undefined || typeof req.fixedBranch !== "string" || req.fixedBranch.length > 80)) return { ok: false, reason: "invalid_input" };
    const baseKey = `advance:${req.workItemId}:${req.step}`;
    let key = baseKey;
    const found = await withTenant(runnerPool, req.accountId, async (client) => {
      // D#599 PL-2 (AC4): a step whose run was cancelled `placement_changed` starts again on the new side, once, under the next key (`:p1`, `:p2`...). The key
      // is chosen from the rows alone, so a replay of the step finds the restart's key and returns that run: it starts nothing more.
      for (let generation = 0; generation <= PLACEMENT_RESTARTS_MAX; generation++) {
        key = generation === 0 ? baseKey : `${baseKey}:p${generation}`;
        const held = await client.query<{ status: string; reason: string | null }>(
          `SELECT a.status, (SELECT e.payload->>'failureReason' FROM run_events e WHERE e.account_id = a.account_id AND e.run_id = a.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'cancelled' ORDER BY e.seq DESC LIMIT 1) AS reason
             FROM agent_run_idempotency_keys k JOIN agent_runs a ON a.account_id = k.account_id AND a.id = k.run_id
            WHERE k.account_id = $1 AND k.idempotency_key = $2`,
          [req.accountId, key],
        );
        const run = held.rows[0];
        if (!run || run.status !== "cancelled" || run.reason !== PLACEMENT_CHANGED) break;
      }
      const r = await client.query<{ repo_id: string | null; gh_owner: string | null; gh_name: string | null; halted: boolean; halt_epoch: number }>(
        "SELECT w.repo_id, w.halted_at IS NOT NULL AS halted, w.halt_epoch, r.gh_owner, r.gh_name FROM work_items w LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id WHERE w.id = $1 AND w.account_id = $2",
        [req.workItemId, req.accountId],
      );
      // `exclusive`: refuse when another run of the item is live and this step's own run is not already claimed. A
      // replay of the step finds its claim and goes on; a second approval does not start a second run.
      let busy = false;
      if (req.exclusive === true) {
        const claim = await client.query("SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [req.accountId, key]);
        if (claim.rowCount === 0) {
          const live = await client.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))", [
            req.accountId,
            req.workItemId,
            [...ADVANCE_TERMINAL_STATUSES],
          ]);
          busy = Number(live.rows[0]?.n ?? 0) > 0;
        }
      }
      return { row: r.rows[0], busy };
    });
    const repo = found.row;
    // Advisory, and read before the seat and the environment so a halted item pays for neither: the authority is the
    // trigger on agent_runs (0750), which refuses the insert itself. The epoch fences a workflow started before a halt.
    if (repo?.halted) return { ok: false, reason: "item_halted" };
    if (repo && repo.halt_epoch !== req.haltEpoch) return { ok: false, reason: "halted_since_approval" };
    if (!repo?.repo_id) return { ok: false, reason: "no_repo" };
    if (found.busy) return { ok: false, reason: "already_running" };
    const seat = await deps.resolveRunSeat({ accountId: req.accountId, role: req.role, workItemId: req.workItemId, ...(req.expectedExecutionMode !== undefined ? { expectedExecutionMode: req.expectedExecutionMode } : {}) });
    if (!seat.ok) return { ok: false, reason: seat.reason };
    const cloneFrom = req.clone === true ? (repo.gh_owner && repo.gh_name ? { owner: repo.gh_owner, name: repo.gh_name } : null) : undefined;
    if (cloneFrom === null) return { ok: false, reason: "no_repo" };
    const input: StartAgentRunInput = {
      ...seat.seat,
      accountId: req.accountId,
      repoId: repo.repo_id,
      workItemId: req.workItemId,
      role: req.role as StartAgentRunInput["role"],
      product: "team",
      prompt: req.prompt,
      ...(req.expectedExecutionMode !== undefined ? { expectedExecutionMode: req.expectedExecutionMode } : {}),
      ...(req.specVersionId !== undefined ? { specVersionId: req.specVersionId } : {}),
      ...(req.parentRunId !== undefined ? { parentRunId: req.parentRunId } : {}),
      ...(sectionsOf(req.contextSections) ? { contextSections: sectionsOf(req.contextSections) } : {}),
      ...(assemblyOf(req.contextAssembly) ? { contextAssembly: assemblyOf(req.contextAssembly) } : {}),
      ...(req.contextSpill ? { contextSpill: req.contextSpill } : {}),
      ...(Number.isSafeInteger(req.memoryTokens) && req.memoryTokens! >= 0 ? { memoryTokens: req.memoryTokens } : {}),
      ...(req.jobMemory ? { jobMemory: req.jobMemory } : {}),
      ...(req.pr !== undefined ? { pr: req.pr } : {}),
      ...(req.headSha !== undefined ? { headSha: req.headSha } : {}),
      // The runner clones this repository (shallow, default branch) into the workdir before the agent starts.
      ...(cloneFrom ? { workdir: PREVIEW_WORKDIR, cloneRepo: cloneFrom } : {}),
      // D#7 DP4b-3: the snapshot is written in the run's create transaction, on its client; a write that fails rolls the run back (no run, no key, no sandbox call).
      ...(req.runId !== undefined ? { runId: req.runId } : {}),
      ...(snapshotOf || req.buildBranch !== undefined
        ? {
            inCreateTransaction: async (client: PoolClient, runId: string) => {
              if (snapshotOf) await writeDecisionSnapshot(client, runId, snapshotOf);
              // SANDBOX-RERUN-BRANCH-a: the branch record shares the run's create transaction, so a run that has a pull request always has its record.
              if (req.buildBranch !== undefined) await recordBuildBranch(client, req.accountId, runId, req.buildBranch, req.fixedBranch);
            },
          }
        : {}),
      idempotency: { key, requestHash: createHash("sha256").update(`${key}:${req.role}`).digest("hex") },
    };
    let started: Awaited<ReturnType<RunStarter["start"]>>;
    try {
      started = await deps.starter.start(input);
    } catch (err) {
      // The database allows one live executor per pull request (the unique index). Two approvals racing to build, or a
      // build racing a fix round, lose here: the loser is told, and nothing is left behind. This is the lock.
      if (err instanceof DuplicateExecutorRunError) return { ok: false, reason: "already_running" };
      if (err instanceof WorkItemHaltedError) return { ok: false, reason: "item_halted" };
      // The repository changed mode after the prompt was built (R4d-1): nothing was written, and no job was issued.
      if (err instanceof ExecutionModeChangedError) return { ok: false, reason: "execution_mode_changed" };
      // D#599 PL-2: the guards of the run's own side refused it (a public or unreadable repo, a stale cloud-verified consent...) before a row was written.
      if (err instanceof RunPrecheckRefusedError) return { ok: false, reason: err.reason };
      // The executor's sandbox is inside a reaper claim (0761): nothing was written, and the step retries after a wait.
      if (err instanceof SandboxReapingError) return { ok: false, reason: "sandbox_reaping" };
      throw err;
    }
    console.info(JSON.stringify({ event: "advance.run_started", work_item_id: req.workItemId, step: req.step, role: req.role, run_id: started.runId, refused: started.refused ?? null }));
    if (started.refused) {
      // D#483 S5-d: a start the item's spend envelope denied asks the person once per envelope version. The ask never changes the answer: a failure to raise it is logged.
      if (started.refused === "envelope_exceeded" && deps.raiseEnvelopeAsk) {
        try {
          await deps.raiseEnvelopeAsk({ accountId: req.accountId, workItemId: req.workItemId, runUsd: envelopeRunUsd(seat.seat.spend) ?? 0 });
        } catch (err) {
          reportError(err, { stage: "advance.envelope_ask" });
        }
      }
      return { ok: false, reason: started.refused };
    }
    return { ok: true, runId: started.runId };
  }

  /**
   * How a run stands, following the run that replaced it (C22 sections 5 and 7). A runner run that ended `failed` with
   * `runner_lost` or `usage_limit` and has a runner child (the follow-up) is not the end of the work: the outcome is that of the
   * child, and of ITS child in turn, for at most `FOLLOW_UP_CHAIN_MAX_RUNS` runs. Only a chain whose last run has no child is
   * final, so a pending child reads as not done and queued on a runner, and a childless failed run (a chain that ran out of
   * allowance, or whose child could not be made) reads as failed and done. Every other run is read as it stands.
   */
  async function advanceRunOutcome(accountId: string, runId: string): Promise<AdvanceRunOutcome> {
    if (!UUID_RE.test(accountId) || !UUID_RE.test(runId)) return { status: "missing", done: true, envelope: null };
    const outcome = await withTenant(runnerPool, accountId, async (client) => {
      let currentId = runId;
      for (let seen = 1; ; seen++) {
        const r = await client.query<{ status: string; envelope: unknown; runtime: string; running_ms: string | null }>(
          "SELECT status, envelope, runtime, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint AS running_ms FROM agent_runs WHERE id = $1 AND account_id = $2",
          [currentId, accountId],
        );
        const row = r.rows[0];
        if (!row) return { status: "missing", done: true, envelope: null };
        let reason: string | null = null;
        // D#599 HO-2b: a run that was handed off ended `cancelled` with its work on a branch, and the run that continues it is the outcome.
        if (row.status === "cancelled" && seen < FOLLOW_UP_CHAIN_MAX_RUNS) {
          const e = await client.query<{ reason: string | null }>(
            "SELECT payload->>'failureReason' AS reason FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'run.status_changed' AND payload->>'to' = 'cancelled' ORDER BY seq DESC LIMIT 1",
            [accountId, currentId],
          );
          if (e.rows[0]?.reason === "handed_off") {
            const next = await client.query<{ id: string }>("SELECT id FROM agent_runs WHERE account_id = $1 AND parent_run_id = $2 ORDER BY created_at DESC LIMIT 1", [accountId, currentId]);
            if (next.rows[0]) {
              currentId = next.rows[0].id;
              continue;
            }
          }
        }
        if (row.status === "cancelled") {
          // D#599 PL-2: the one cancellation the driver acts on. The step that waited starts the same step again on the new side (see advanceStartRun).
          const e = await client.query<{ reason: string | null }>(
            "SELECT payload->>'failureReason' AS reason FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'run.status_changed' AND payload->>'to' = 'cancelled' ORDER BY seq DESC LIMIT 1",
            [accountId, currentId],
          );
          if (e.rows[0]?.reason === PLACEMENT_CHANGED) reason = PLACEMENT_CHANGED;
        }
        if (row.status === "failed" && row.runtime === "runner") {
          const e = await client.query<{ reason: string | null }>(
            "SELECT payload->>'failureReason' AS reason FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'run.status_changed' AND payload->>'to' = 'failed' ORDER BY seq DESC LIMIT 1",
            [accountId, currentId],
          );
          reason = e.rows[0]?.reason ?? null;
          if (reason !== null && FOLLOW_UP_REASONS.has(reason) && seen < FOLLOW_UP_CHAIN_MAX_RUNS) {
            const next = await client.query<{ id: string }>("SELECT id FROM agent_runs WHERE account_id = $1 AND parent_run_id = $2 AND runtime = 'runner' LIMIT 1", [accountId, currentId]);
            if (next.rows[0]) {
              currentId = next.rows[0].id;
              continue;
            }
          }
        }
        const envelope = row.envelope !== null && typeof row.envelope === "object" && !Array.isArray(row.envelope) ? (row.envelope as Record<string, unknown>) : null;
        return { status: row.status, done: TERMINAL.has(row.status), envelope, runtime: row.runtime, ...(row.runtime === "runner" ? { runningMs: row.running_ms === null ? null : Math.max(Number(row.running_ms), 0) } : {}), tailRunId: currentId, failureReason: reason };
      }
    });
    // D#601 MEM-2: a finished run's memory proposals become pending entries, once (the intake is idempotent per run, and never reads a runner run).
    // After the read's transaction, and never able to change the outcome the driver sees.
    if (outcome.done && outcome.envelope !== null) {
      await ingestRunMemoryProposals({ pool: runnerPool, accountId, runId: outcome.tailRunId ?? runId, envelope: outcome.envelope }).catch((err) => reportError(err, { stage: "advance.memory_intake" }));
    }
    return outcome;
  }

  async function supersededByTriage(accountId: string, workItemId: string): Promise<boolean> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query(
        // The guarded supersede record (migration 0851), written only by retire_superseded_work_item; never the free-text ref on a history row.
        "SELECT 1 FROM work_item_supersedes WHERE account_id = $1 AND old_work_item_id = $2 LIMIT 1",
        [accountId, workItemId],
      );
      return r.rowCount === 1;
    });
  }

  async function advanceTriage(accountId: string, input: AdvanceTriageInput): Promise<AdvanceTriageResult> {
    if (!deps.triage) return { status: "refused", reason: "triage_unavailable" };
    if (!UUID_RE.test(accountId) || !UUID_RE.test(input.workItemId) || !UUID_RE.test(input.repoId)) return { status: "refused", reason: "invalid_input" };
    // The step re-asserts what perform checked: only an internal item that has no discussion yet is triaged here.
    const item = await advanceLoadItem(accountId, input.workItemId);
    if (!item) return { status: "refused", reason: "target_not_found" };
    if (item.provenance !== "internal") return { status: "refused", reason: "external_requires_human" };
    if (item.repoId !== input.repoId || item.ghNumber !== input.number) return { status: "refused", reason: "item_changed" };
    // A replay of a triage that already finished is allowed (the pipeline's triage is idempotent on the source event): the
    // item then sits at `closed`, retired by that very triage. Anything else not at `triaged` is not ours to advance.
    const replay = item.stage === "closed" && (await supersededByTriage(accountId, input.workItemId));
    const verdict = advanceActionFor({ stage: item.stage, discussion_id: item.hasDiscussion ? "d" : null, kind: item.kind, has_spec: item.hasSpec });
    if (!replay && !(verdict.ok && verdict.action === "triage")) return { status: "refused", reason: "not_advanceable" };
    const out = await deps.triage(runnerPool, accountId, input);
    console.info(JSON.stringify({ event: "advance.triaged", work_item_id: input.workItemId, status: out.status, category: out.category ?? null, stage: out.stage ?? null, reason: out.reason ?? null }));
    return out;
  }

  /** Stops a LIVE run of this item through the runner's own cancel (what the Cancel button runs), as the approver. A finished run, another item's run and an unknown run are left alone. */
  async function cancelItemRun(who: AdvanceStepWho, runId: string): Promise<void> {
    if (!deps.registry || !UUID_RE.test(runId)) return;
    const live = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1 AND account_id = $2 AND work_item_id = $3", [runId, who.accountId, who.workItemId]);
      return r.rows[0] !== undefined && !TERMINAL.has(r.rows[0].status);
    });
    if (!live) return;
    await cancelRun({ pool: runnerPool, principal: { accountId: who.accountId, userId: who.userId, kind: "session" } }, runId, deps.registry);
  }

  /**
   * D#7 DP4b-3: what a new executor run of this item is offered, resolved from the item's repository dials now (no dial row: Balanced). The repository is the item's own,
   * read here, never taken from the step. An item with no repository is offered nothing and gets an empty snapshot.
   */
  function decisionOfferFor(who: AdvanceStepWho): Promise<DecisionOffer> {
    return decisionOfferForItem(runnerPool, who.accountId, who.workItemId);
  }

  /** The ports one step gets: bound to one account and item, so the step cannot name another. */
  function portsFor(who: AdvanceStepWho): AdvanceStepPorts {
    return {
      startRun: (req) => advanceStartRun({ ...req, accountId: who.accountId, workItemId: who.workItemId, haltEpoch: who.haltEpoch }),
      decisionOffer: () => decisionOfferFor(who),
      findStep: (stepPrefix) => findStepRun(who, stepPrefix),
      startedAttempts: (head, tail) => startedSeatAttempts(who, head, tail),
      headroom: (roles) => checkRoundHeadroom(runnerPool, deps.resolveRunSeat, who, roles),
      outcome: (runId) => advanceRunOutcome(who.accountId, runId),
      cancel: (runId) => cancelItemRun(who, runId),
      continueRun: async (runId, site) => {
        const answer = await advanceContinue(who, runId, site);
        return (answer.code === "continued" || answer.code === "duplicate") && answer.runId !== null && answer.runId !== runId ? answer.runId : null;
      },
    };
  }

  /** What every pipeline step re-asserts before it spends: valid ids, the item exists, and it is internal. */
  async function guardStep(who: AdvanceStepWho): Promise<AdvanceStepResult | null> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.userId) || !UUID_RE.test(who.workItemId)) return { status: "refused", reason: "invalid_input" };
    const item = await advanceLoadItem(who.accountId, who.workItemId);
    if (!item) return { status: "refused", reason: "target_not_found" };
    // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
    if (item.provenance !== "internal") return { status: "refused", reason: "external_requires_human" };
    // A halt is lifted only by a person's later approval, which starts a NEW workflow under the new epoch: this one, started
    // before the halt, stops here whether the halt still stands or has been resumed since.
    const halt = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ halted: boolean; halt_epoch: number }>("SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId]);
      return r.rows[0];
    });
    if (halt?.halted) return { status: "refused", reason: "item_halted" };
    if (halt && halt.halt_epoch !== who.haltEpoch) return { status: "refused", reason: "halted_since_approval" };
    const setupHold = await withTenant(runnerPool, who.accountId, who.userId, (client) => setupHoldFor(client, who.workItemId));
    if (setupHold) return { status: "refused", reason: setupHold };
    return null;
  }

  async function advancePanel(who: AdvanceStepWho): Promise<AdvanceStepResult> {
    if (!deps.panel) return { status: "refused", reason: "panel_unavailable" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await deps.panel(runnerPool, who.accountId, who.workItemId, portsFor(who));
    console.info(JSON.stringify({ event: "advance.panel", work_item_id: who.workItemId, status: out.status, reason: out.reason ?? null, complete: out.complete ?? null, missing: out.missingRoles?.length ?? null, round2: out.round2Ran ?? null }));
    return out;
  }

  async function advanceSpec(who: AdvanceStepWho, attempt?: string, spendAttempt?: number): Promise<AdvanceStepResult> {
    if (!deps.spec) return { status: "refused", reason: "spec_unavailable" };
    if (attempt !== undefined && !UUID_RE.test(attempt)) return { status: "refused", reason: "invalid_input" };
    // D#483 S5-k1c: the number of the ask when an earlier ask of the PM's start was denied by a spending limit (absent for the first ask).
    if (spendAttempt !== undefined && !(Number.isSafeInteger(spendAttempt) && spendAttempt >= 0 && spendAttempt <= MAX_WAITING_ATTEMPT)) return { status: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await deps.spec(runnerPool, who.accountId, who.workItemId, portsFor(who), { ...(attempt !== undefined ? { attempt } : {}), ...(spendAttempt !== undefined && spendAttempt > 0 ? { spendAttempt } : {}) });
    console.info(JSON.stringify({ event: "advance.spec", work_item_id: who.workItemId, status: out.status, reason: out.reason ?? null, stage: out.stage ?? null, version: out.version ?? null }));
    return out;
  }

  /** One driver event on a tenant-scoped client. Never throws for a bad value: the caller gets `recorded: false` (a bad event must not stop the pipeline). */
  async function writeEvent(who: AdvanceStepWho, event: Omit<DriverEventInput, "workItemId">): Promise<{ recorded: boolean }> {
    const full: DriverEventInput = { ...event, workItemId: who.workItemId };
    try {
      assertDriverEvent(full);
    } catch {
      // fx-swallow-ok: a value the store would refuse is dropped with a fixed log line; the pipeline goes on without the fact
      console.warn(JSON.stringify({ event: "advance.event_invalid", work_item_id: who.workItemId, kind: String(event.kind) }));
      return { recorded: false };
    }
    return withTenant(runnerPool, who.accountId, (client) => recordDriverEvent(client, who.accountId, full));
  }

  /** D#599 PL-2: whether a run ended `cancelled` with the reason PL-1's item-scoped cancel gives (`placement_changed`). */
  async function endedForPlacement(accountId: string, runId: string): Promise<boolean> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query(
        `SELECT 1 FROM agent_runs a JOIN run_events e ON e.account_id = a.account_id AND e.run_id = a.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'cancelled'
          WHERE a.account_id = $1 AND a.id = $2 AND a.status = 'cancelled' AND e.payload->>'failureReason' = $3 LIMIT 1`,
        [accountId, runId, PLACEMENT_CHANGED],
      );
      return r.rowCount === 1;
    });
  }

  /**
   * D#483 S5-k1e: every run a panel seat's asks started, found by key: `advance:<item>:<head>[:s<n>]<tail>` and, after a placement restart, `:p<n>` on the end. The
   * LIKE finds candidates (head and tail escaped); the pattern below decides, so a key that merely contains the head is never counted. Oldest first, so the caller
   * reads the newest run of the highest attempt last.
   */
  async function startedSeatAttempts(who: AdvanceStepWho, head: string, tail: string): Promise<Array<{ attempt: number; status: string }>> {
    if (!/^[a-z0-9:_.-]{1,100}$/i.test(head) || !/^:r[12]:[a-z][a-z-]{0,40}$/.test(tail)) return [];
    const esc = (t: string): string => t.replace(/[\\%_]/g, (c) => `\\${c}`);
    const prefix = `advance:${who.workItemId}:${head}`;
    const exact = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::s(\\d{1,6}))?${tail}(?::p\\d{1,2})?$`);
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ idempotency_key: string; status: string }>(
        `SELECT k.idempotency_key, a.status FROM agent_run_idempotency_keys k JOIN agent_runs a ON a.account_id = k.account_id AND a.id = k.run_id
          WHERE k.account_id = $1 AND a.work_item_id = $2 AND k.idempotency_key LIKE $3 ESCAPE '\\' ORDER BY k.created_at DESC, k.run_id DESC LIMIT 500`,
        [who.accountId, who.workItemId, `${esc(prefix)}%${esc(tail)}%`],
      );
      // Read newest first so a seat with more than 500 rows loses its oldest, never its newest; handed back oldest first, as the caller expects.
      return r.rows.reverse().flatMap((row) => {
        const m = exact.exec(row.idempotency_key);
        return m ? [{ attempt: m[1] === undefined ? 0 : Number(m[1]), status: row.status }] : [];
      });
    });
  }

  /** D#597 CC-3: the run a step of this item started, found by its key: the exact prefix, or the prefix plus a note pin (`:n<hash>`), and nothing longer. */
  /**
   * D#483 S5-k1d: the admit denials that are a spending limit (packages/pipeline reservationPauses.ts RESERVATION_DENIAL_PAUSES; a test holds the lists equal). The
   * web step turns each one into its named pause.
   */
  const SPEND_DENIALS: readonly string[] = SPEND_DENIAL_REASONS;

  /** The spending-limit denial a run ended with (`refused_spend` and the closed reason the admit gave), or null when the run did not end that way. */
  async function deniedRunReason(who: AdvanceStepWho, runId: string): Promise<string | null> {
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ status: string; reason: string | null }>(
        `SELECT a.status, (SELECT e.payload->>'failureReason' FROM run_events e WHERE e.account_id = a.account_id AND e.run_id = a.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'refused_spend' ORDER BY e.seq DESC LIMIT 1) AS reason
           FROM agent_runs a WHERE a.account_id = $1 AND a.id = $2`,
        [who.accountId, runId],
      );
      const row = r.rows[0];
      if (!row || row.status !== "refused_spend") return null;
      return row.reason !== null && SPEND_DENIALS.includes(row.reason) ? row.reason : "refused_spend";
    });
  }

  async function findStepRun(who: AdvanceStepWho, stepPrefix: string): Promise<{ step: string; runId: string } | null> {
    if (!/^[a-z0-9:_.-]{1,128}$/i.test(stepPrefix)) return null;
    const keyPrefix = `advance:${who.workItemId}:${stepPrefix}`;
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ idempotency_key: string; run_id: string }>(
        "SELECT idempotency_key, run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND (idempotency_key = $2 OR (starts_with(idempotency_key, $3) AND length(idempotency_key) = $4)) ORDER BY created_at LIMIT 1",
        [who.accountId, keyPrefix, `${keyPrefix}:n`, keyPrefix.length + 18],
      );
      const row = r.rows[0];
      return row ? { step: row.idempotency_key.slice(`advance:${who.workItemId}:`.length), runId: row.run_id } : null;
    });
  }

  /** D#597 CC-3: the fixed `correction_applied` fact for a run that carried notes (ids only), read back from the stamps so a replay of the step writes it too. Deduped per run. */
  async function recordCorrectionsApplied(who: AdvanceStepWho, runId: string): Promise<void> {
    if (!UUID_RE.test(runId)) return;
    const ids = await listRunNoteIds(runnerPool, who.accountId, runId);
    if (ids.length === 0) return;
    await writeEvent(who, { kind: "correction_applied", dedupeKey: `run:${runId}`, runId, reasons: ids.map(correctionReasonCode) });
    console.info(JSON.stringify({ event: "advance.correction_applied", work_item_id: who.workItemId, run_id: runId, count: ids.length }));
  }

  /** The refusals that mean "no build slot yet" (packages/pipeline buildSlots.ts BUILD_WAIT_REASONS; a test holds the lists equal). */
  const BUILD_SLOT_WAIT_REASONS: readonly string[] = ["one_build_per_repo_until_d598", "waiting_for_build_slot_repo", "waiting_for_build_slot_account"];
  /** How long after a limit pause is first seen the sweep first looks: a workflow's own wait is four hours, so the sweep's first look is just after it (apps/web BUILD_SPEND_WAIT_MS). */
  const STAGE_RESUME_FIRST_LOOK_MS = 4 * 3_600_000;

  async function advanceBuild(who: AdvanceStepWho, approvalId: string, expectedVersion?: number, spendAttempt?: number): Promise<AdvanceStepResult> {
    if (!deps.build) return { status: "refused", reason: "build_unavailable" };
    if (!UUID_RE.test(approvalId) || (expectedVersion !== undefined && !(Number.isSafeInteger(expectedVersion) && expectedVersion > 0))) return { status: "refused", reason: "invalid_input" };
    if (spendAttempt !== undefined && !(Number.isSafeInteger(spendAttempt) && spendAttempt >= 0 && spendAttempt <= MAX_WAITING_ATTEMPT)) return { status: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const buildOptions = { ...(expectedVersion !== undefined ? { expectedVersion } : {}), ...(spendAttempt !== undefined && spendAttempt > 0 ? { spendAttempt } : {}) };
    let out = await deps.build(runnerPool, who.accountId, who.workItemId, approvalId, portsFor(who), buildOptions);
    // D#598: the slots are held. A holder whose pull request was closed or merged without its webhook holds one for good, so the holders are checked on
    // GitHub (each at most once per window); when one was moved out, the start is asked once more. A check that fails changes nothing and the wait goes on.
    if (out.status === "refused" && out.reason != null && BUILD_SLOT_WAIT_REASONS.includes(out.reason) && deps.prState) {
      const moved = await reconcileSlotHolders(runnerPool, deps.prState, who.accountId, who.workItemId, out.reason).catch((err: unknown) => {
        // fx-swallow-ok: the check is a best-effort extra; a fixed line is logged (ids and a code only) and the build keeps waiting as before
        console.warn(JSON.stringify({ event: "advance.pr_slot_reconcile_failed", work_item_id: who.workItemId, code: (err as { code?: string } | null)?.code ?? "error" }));
        return 0;
      });
      if (moved > 0) out = await deps.build(runnerPool, who.accountId, who.workItemId, approvalId, portsFor(who), buildOptions);
    }
    console.info(JSON.stringify({ event: "advance.build", work_item_id: who.workItemId, status: out.status, reason: out.reason ?? null, run_id: out.runId ?? null }));
    if (out.status === "started" && out.runId) await recordCorrectionsApplied(who, out.runId);
    // A build that did not start is a fact of the item (its code is a fixed word the start named).
    // A start that met a reaper claim is not a refusal of the build: the workflow waits and starts again, so no fact is recorded.
    // D#483 S5-c1: nor is a start that found no build slot: the item waits (the workflow asks again) and the wait is derived from the counts when read.
    // D#483 S5-k1: nor is a start a spending limit denied: the same fact names the pause, and the pause is derived from the latest one when read.
    if (out.status === "refused" && out.reason !== undefined && out.reason !== null && (BUILD_SLOT_WAIT_REASONS.includes(out.reason) || RESERVATION_PAUSE_REASONS.includes(out.reason))) {
      // Each ask of a wait leaves one fact (deduped per minute): the slot module counts an item as waiting only while its latest one is fresh.
      // D#483 S5-k1b: it is the generalised `stage_waiting` fact (stage `build`); the readers take the latest of it and the older `build_waiting`, and nothing writes the older kind now.
      await writeEvent(who, { kind: "stage_waiting", stage: "build", attempt: spendAttempt ?? 0, dedupeKey: `wait:${approvalId}:${Math.floor(Date.now() / 60_000)}`, code: out.reason });
      // A limit pause may outlast the workflow that is asking (it parks after four hours): tell the sweep there is work to look at.
      if (RESERVATION_PAUSE_REASONS.includes(out.reason)) void markWorkPending("stage-resume-sweep", { since: Date.now() + STAGE_RESUME_FIRST_LOOK_MS });
    } else if (out.status === "refused" && out.reason !== "start_sandbox_reaping") {
      await writeEvent(who, { kind: "build_refused", dedupeKey: `build:${approvalId}`, code: /^[a-z][a-z0-9_]{0,63}$/.test(out.reason ?? "") ? out.reason : "refused" });
    }
    return out;
  }

  async function advanceBuildFailed(accountId: string, workItemId: string, runId: string | null, code: string, attempt?: string): Promise<AdvanceStepResult> {
    if (!deps.buildFailed) return { status: "refused", reason: "build_unavailable" };
    if (!UUID_RE.test(accountId) || !UUID_RE.test(workItemId) || (runId !== null && !UUID_RE.test(runId)) || (attempt !== undefined && !UUID_RE.test(attempt)) || !/^[a-z_]{1,40}$/.test(code)) return { status: "refused", reason: "invalid_input" };
    // D#7 DP4b-2: an item parked on a question is not a failed build, whoever asks (the driver, the sweeper, "Check the build"). A person's Build again makes a newer run, which ends the wait.
    if (await withTenant(runnerPool, accountId, (client) => isItemWaitingOnAnswer(client, workItemId))) return { status: "refused", reason: "waiting_on_answer" };
    const out = await deps.buildFailed(runnerPool, accountId, workItemId, runId, code, ...(attempt === undefined ? [] : [attempt]));
    console.info(JSON.stringify({ event: "advance.build_failed", work_item_id: workItemId, run_id: runId, code, status: out.status, stage: out.stage ?? null }));
    return out;
  }

  async function advanceDecision(accountId: string, userId: string, workItemId: string, haltEpoch: number, runId: string): Promise<DecisionStepCode> {
    if (!deps.decisionIntake || !UUID_RE.test(userId)) return "none";
    const out = await deps.decisionIntake({ accountId, workItemId, haltEpoch, runId });
    console.info(JSON.stringify({ event: "advance.decision", work_item_id: workItemId, run_id: runId, code: out }));
    return out;
  }

  async function advancePrFound(who: AdvanceStepWho, prNumber: number): Promise<AdvanceStepResult> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !Number.isSafeInteger(prNumber) || prNumber <= 0) return { status: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await withTenant(runnerPool, who.accountId, async (client) => {
      // The stage is read under the row lock (recordStage takes the same lock), and the answer is read again after the
      // attempt, so it is the stage as it stands NOW and not the one seen before another writer (the webhook) got in.
      const stageNow = async () => (await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2 FOR UPDATE", [who.workItemId, who.accountId])).rows[0]?.stage ?? null;
      const before = await stageNow();
      if (before !== "in_progress") return { status: "unchanged", stage: before };
      // D#483 S5-b2c-2 (R1): the platform's own lookup found a planned PR child's pull request on its recorded branch (exactly one open, in this repository): bind the number to the
      // run that recorded the branch. Set once; a runner run's number is its done record's and has no branch row here.
      // A number already bound to the child's run is never replaced: a lookup that finds a different pull request on the branch moves nothing and leaves the binding as it is.
      const bound = await readChildBoundPullRequest(client, who.accountId, who.workItemId);
      if (bound !== null && bound !== prNumber) return { status: "refused", reason: "child_pr_binding_mismatch", stage: before };
      await recordChildPullRequestForItem(client, who.accountId, who.workItemId, prNumber);
      let recorded = false;
      try {
        recorded = (await recordStage(client, { workItemId: who.workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: `pr_found:${prNumber}` })).recorded;
      } catch (err) {
        if (err instanceof StageHaltedError) return { status: "unchanged", reason: "item_halted", stage: before };
        if (!(err instanceof IllegalStageTransitionError)) throw err;
      }
      return { status: recorded ? "recorded" : "unchanged", stage: await stageNow() };
    });
    console.info(JSON.stringify({ event: "advance.pr_found", work_item_id: who.workItemId, pr: prNumber, status: out.status, stage: out.stage }));
    return out;
  }

  // ---- D#483 P3: the review stage -------------------------------------------------------------------------------

  const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const VERDICT_WORDS = ["pass", "needs-fix", "fail"];
  const END_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
  const MAX_FIX_PROMPT_CHARS = 120_000;

  async function advanceLoadReview(who: AdvanceStepWho): Promise<AdvanceReviewLoad> {
    if (!deps.review) return { ok: false, reason: "review_unavailable" };
    const bad = await guardStep(who);
    if (bad) return { ok: false, reason: bad.reason ?? "refused" };
    const loaded = await deps.review.load(runnerPool, who.accountId, who.workItemId);
    if (!loaded.ok) return loaded;
    // Read here, not by the pipeline's loader: it is the worker that holds the run records this comes from.
    return { ok: true, ctx: { ...loaded.ctx, ...(await pullRequestSource(who.accountId, who.workItemId)) } };
  }

  async function advanceLoadSpecText(who: AdvanceStepWho, expectedVersion: number): Promise<{ version: number; body: string; sha256?: string } | null> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) return null;
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ version: number; body: string; body_sha256: string }>(
        `SELECT s.version, s.body, s.body_sha256 FROM work_items w JOIN spec_versions s ON s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM_SQL}
          WHERE w.id = $2 AND w.account_id = $1 ORDER BY s.version DESC LIMIT 1`,
        [who.accountId, who.workItemId],
      );
      const row = r.rows[0];
      // The Spec the person approved is the one used: a newer version appearing in between stops the driver.
      return row && Number(row.version) === expectedVersion ? { version: Number(row.version), body: row.body, sha256: row.body_sha256 } : null;
    });
  }

  async function advanceRecordRound(who: AdvanceStepWho, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">): Promise<AdvanceRoundResult | { decision: "refused"; reason: string }> {
    if (!deps.review || !deps.registry) return { decision: "refused", reason: "review_unavailable" };
    const sane =
      SHA_RE.test(input.headSha) &&
      Number.isSafeInteger(input.prNumber) && input.prNumber > 0 &&
      (input.round === undefined || (Number.isInteger(input.round) && input.round >= 0 && input.round <= 20)) &&
      input.requiredRoles.length > 0 && input.requiredRoles.length <= 4 && input.requiredRoles.every((r) => VERDICT_ROLES.includes(r)) &&
      input.verdicts.length <= 4 &&
      input.verdicts.every((v) => VERDICT_ROLES.includes(v.role) && UUID_RE.test(v.runId) && VERDICT_WORDS.includes(v.verdict) && (v.environmentFailure === undefined || typeof v.environmentFailure === "boolean") && (v.unverifiable === undefined || typeof v.unverifiable === "boolean") && (v.noVerdict === undefined || typeof v.noVerdict === "boolean") && (v.endCode === undefined || END_CODE_RE.test(v.endCode)) && (v.debatedRole === undefined || v.debatedRole === "code-reviewer" || v.debatedRole === "security-reviewer"));
    if (!sane) return { decision: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { decision: "refused", reason: bad.reason ?? "refused" };
    const out = await deps.review.recordRound(runnerPool, deps.registry, { ...input, accountId: who.accountId, workItemId: who.workItemId });
    console.info(JSON.stringify({ event: "advance.round", work_item_id: who.workItemId, round: input.round, decision: out.decision, verdicts: out.recorded.map((r) => `${r.role}:${r.verdict}:${r.outcome}`) }));
    return out;
  }

  async function advanceRecordMergeOnly(who: AdvanceStepWho, input: Omit<AdvanceMergeOnlyInput, "accountId" | "workItemId">): Promise<AdvanceMergeOnlyResult | { decision: "refused"; reason: string }> {
    if (!deps.review) return { decision: "refused", reason: "review_unavailable" };
    const sane =
      SHA_RE.test(input.headSha) &&
      Number.isSafeInteger(input.prNumber) && input.prNumber > 0 &&
      typeof input.baseRef === "string" && input.baseRef.length > 0 && input.baseRef.length <= 200 &&
      input.requiredRoles.length > 0 && input.requiredRoles.length <= 4 && input.requiredRoles.every((r) => VERDICT_ROLES.includes(r));
    if (!sane) return { decision: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { decision: "refused", reason: bad.reason ?? "refused" };
    // No port, no carry-forward: the reviewers run as they always did.
    if (!deps.review.recordMergeOnly) return { decision: "full_review", reason: "unavailable" };
    const out = await deps.review.recordMergeOnly(runnerPool, { ...input, accountId: who.accountId, workItemId: who.workItemId });
    console.info(JSON.stringify({ event: "advance.merge_only", work_item_id: who.workItemId, decision: out.decision, reason: out.reason ?? null }));
    return out;
  }

  /**
   * The newest executor run of the item that holds a session (the build's, or the last fix's). A runner fix run that ended `no_commit` (the
   * agent finished and pushed nothing) recorded no branch, so a continuation cannot start from it: the run before it is the parent.
   */
  async function newestExecutorRun(who: AdvanceStepWho): Promise<string | null> {
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ id: string }>(
        "SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor' AND cc_session_id IS NOT NULL " +
          "AND NOT (status = 'failed' AND EXISTS (SELECT 1 FROM run_events e WHERE e.account_id = agent_runs.account_id AND e.run_id = agent_runs.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed' AND e.payload->>'failureReason' = 'no_commit')) " +
          "ORDER BY created_at DESC LIMIT 1",
        [who.accountId, who.workItemId],
      );
      return r.rows[0]?.id ?? null;
    });
  }

  async function advanceStartCheckFix(who: AdvanceStepWho, failedRunId: string): Promise<AdvanceRunStart> {
    const review = deps.review;
    if (!review || !deps.registry) return { ok: false, reason: "resume_unavailable" };
    const bad = await guardStep(who);
    if (bad) return { ok: false, reason: bad.reason ?? "refused" };
    // FIXROUND-REFRESH-HEAD: a check fix round opens no pull request of its own, but on a paired item that already pushed it is held to the public branch too.
    const beforeStart = checkFixBeforeStart(runnerPool, deps.fixHeads, who);
    const out = await startCheckFixRound({ pool: runnerPool, registry: deps.registry, resume: review.resume, resolveRunSeat: deps.resolveRunSeat, starter: deps.starter, beforeStart, baseSync: () => beforeStart.state }, who, failedRunId);
    // FIXROUND-BASE-SYNC: the run a sync led to says so (a replay finds its run and merged nothing, so it adds no second line).
    if (out.ok && beforeStart.state.synced) await recordRunStage(runnerPool, { accountId: who.accountId, runId: out.runId, stage: BASE_SYNCED_STAGE });
    console.info(JSON.stringify({ event: "advance.check_fix", work_item_id: who.workItemId, failed_run_id: failedRunId, started: out.ok, reason: out.ok ? null : out.reason }));
    return out;
  }

  async function advanceContinue(who: AdvanceStepWho, endedRunId: string, site?: ContinuationSite): Promise<AdvanceContinueOut> {
    const bad = await guardStep(who);
    if (bad) return { code: bad.reason === "item_halted" || bad.reason === "halted_since_approval" ? "halted" : "today", runId: null, parkedAs: null };
    const out = await advanceContinueCore(
      { pool: runnerPool, registry: deps.registry, resolveRunSeat: deps.resolveRunSeat, logError: (name) => console.warn(JSON.stringify({ event: "advance.continue_error", work_item_id: who.workItemId, run_id: endedRunId, error: name })) },
      who.accountId, who.workItemId, endedRunId, undefined, site,
    );
    console.info(JSON.stringify({ event: "advance.continue", work_item_id: who.workItemId, ended_run_id: endedRunId, site: site ?? "executor", code: out.code, run_id: out.runId, parked_as: out.parkedAs }));
    return out;
  }

  async function advanceStartFix(who: AdvanceStepWho, req: AdvanceFixRequest): Promise<AdvanceRunStart> {
    const review = deps.review;
    if (!review || !deps.registry) return { ok: false, reason: "resume_unavailable" };
    const sane =
      UUID_RE.test(req.actionId) && (req.failingRunId === undefined ? req.person === true : UUID_RE.test(req.failingRunId)) &&
      (req.person === undefined || req.person === true) &&
      Number.isSafeInteger(req.issue) && req.issue > 0 &&
      SHA_RE.test(req.headSha) &&
      typeof req.prompt === "string" && req.prompt !== "" && req.prompt.length <= MAX_FIX_PROMPT_CHARS &&
      Number.isInteger(req.round) && req.round >= 1 && req.round <= 20 &&
      (req.held === undefined || (typeof req.held.sha256 === "string" && /^[0-9a-f]{64}$/.test(req.held.sha256) && Number.isInteger(req.held.version) && req.held.version > 0 &&
        typeof req.fallbackPrompt === "string" && req.fallbackPrompt !== "" && req.fallbackPrompt.length <= MAX_FIX_PROMPT_CHARS)) &&
      (req.fallbackPrompt === undefined || (typeof req.fallbackPrompt === "string" && req.fallbackPrompt !== "" && req.fallbackPrompt.length <= MAX_FIX_PROMPT_CHARS)) &&
      (req.contextSpill === undefined || isContextSpill(req.contextSpill)) &&
      (req.fallbackContextSpill === undefined || (req.fallbackPrompt !== undefined && isContextSpill(req.fallbackContextSpill))) &&
      (req.retry === undefined || (Number.isInteger(req.retry) && req.retry >= 1 && req.retry <= 3)) &&
      (req.spendAttempt === undefined || (Number.isSafeInteger(req.spendAttempt) && req.spendAttempt >= 0 && req.spendAttempt <= MAX_WAITING_ATTEMPT)) &&
      (req.reviewer === "code" || req.reviewer === "security" || req.reviewer === "acceptance") &&
      (req.expectedExecutionMode === undefined || MODE_RE.test(req.expectedExecutionMode)) &&
      (req.pr === undefined || (Number.isSafeInteger(req.pr.number) && req.pr.number >= 1 && req.pr.number <= 2_147_483_647 && (RUNNER_RUN_BRANCH.test(req.pr.branch) || ITEM_PR_BRANCH.test(req.pr.branch))));
    if (!sane) return { ok: false, reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { ok: false, reason: bad.reason ?? "refused" };
    // The plan's fix-round limit, for every round (a reviewer's round is decided under it already; a person's round is held to the same number).
    if (checkFixRound(req.round) === "escalate") return { ok: false, reason: "max_fix_rounds" };

    // D#483 S5-k1d: the attempt after a spending-limit denial goes last, after the re-review retry (`:r<n>`), so the two never collide.
    const attemptKey = `${req.headSha}:${req.actionId}${req.retry ? `:r${req.retry}` : ""}${req.spendAttempt ? `:s${req.spendAttempt}` : ""}`;
    const refuse = async (reason: string): Promise<AdvanceRunStart> => {
      // A spending-limit denial is a pause, not a refusal: the driver leaves its waiting fact and asks again, and the sweep resumes it. No refusal fact is written.
      if (SPEND_DENIALS.includes(reason)) return { ok: false, reason };
      await writeEvent(who, { kind: "fix_round_refused", dedupeKey: `fix:${attemptKey}`, code: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "refused", headSha: req.headSha, round: req.round });
      return { ok: false, reason };
    };

    // A replay of the same approval on the same head finds the run it started; it never starts a second one. D#597 CC-3: the key also carries a pin of the
    // accepted run notes the run was started with, so the replay finds its run through the prefix (the notes accepted since would give another pin).
    // D#599 PL-2 (AC4): a fix run cancelled `placement_changed` is restarted once on the new side under the next generation (`fix:<attempt>:p1`...).
    let keyBase = `fix:${attemptKey}`;
    for (let generation = 1; generation <= PLACEMENT_RESTARTS_MAX; generation++) {
      const ended = await findStepRun(who, keyBase);
      if (!ended || !(await endedForPlacement(who.accountId, ended.runId))) break;
      keyBase = `fix:${attemptKey}:p${generation}`;
    }
    const claimed = () => findStepRun(who, keyBase);
    const claimedRun = async (): Promise<string | null> => (await claimed())?.runId ?? null;
    // The fact is written on every path that returns a started run (it is deduped): a step that died between the resume
    // and the event write would otherwise leave the run uncounted, and `fixRoundsStarted` would undercount.
    // D#483 S5-b2c-3 (R7): the item's own branch is its build identity's. Read without launch checks here (a replay of a start must find its run even after the parent went), and
    // with them below, before anything new is written. A top-level item that has no issue number has no item branch: a pair is then only the recorded one (as it always was).
    const observed = await withTenant(runnerPool, who.accountId, (client) => resolveBuildIdentity(client, who.accountId, who.workItemId, "observe"));
    const itemBranch = observed.ok ? observed.identity.branch : null;
    const started = async (runId: string): Promise<AdvanceRunStart> => {
      await recordCorrectionsApplied(who, runId);
      await writeEvent(who, { kind: "fix_round_started", dedupeKey: `fix:${attemptKey}`, headSha: req.headSha, round: req.round, runId, ...(req.pr && itemBranch !== null && req.pr.branch === itemBranch ? { prNumber: req.pr.number } : {}) });
      return { ok: true, runId };
    };
    const prior = await claimed();
    if (prior) {
      // A replay of a key whose run a spending limit denied is that denial again (a later ask is another attempt, so this is the same ask repeated).
      const denied = await deniedRunReason(who, prior.runId);
      if (denied !== null) return refuse(denied);
      await attachRunNotes(runnerPool, who.accountId, who.workItemId, prior.runId, { suffix: prior.step.slice(keyBase.length) });
      return started(prior.runId);
    }

    // D#483 S5-b2c-3 (R8): a planned PR child's round re-runs the launch rule's checks against the rows as they are now (a deleted parent, a Spec not approved again, a key that left
    // the approved Spec). Nothing is written, no run and no reservation made: the refusal is the resolver's code. A top-level item has no check here.
    if (observed.ok ? observed.identity.isChild : observed.isChild || observed.reason === "not_found") {
      const begin = await withTenant(runnerPool, who.accountId, (client) => resolveBuildIdentity(client, who.accountId, who.workItemId, "start"));
      if (!begin.ok) return refuse(begin.reason);
    }

    // One executor at a time: a second concurrent resume is refused (the database's one-live-executor-per-PR index is the backstop).
    const state = await withTenant(runnerPool, who.accountId, async (client) => {
      const live = await client.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor' AND status IN ('pending', 'running') LIMIT 1", [who.accountId, who.workItemId]);
      const item = await client.query<{ stage: string; repo_id: string | null }>("SELECT stage, repo_id FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId]);
      return { live: (live.rowCount ?? 0) > 0, stage: item.rows[0]?.stage ?? null, repoId: item.rows[0]?.repo_id ?? null };
    });
    if (state.live) return refuse("already_running");
    if (state.repoId === null) return refuse("no_repo");
    // Only a pull request that is still under review gets a fix round (not one that merged, closed or went to a person).
    if (state.stage !== "pr_opened" && state.stage !== "changes_requested" && state.stage !== "review_passed") return refuse(`stage_${state.stage ?? "gone"}`.replace(/[^a-z0-9_]/g, "_"));

    // FIXROUND-REFRESH-HEAD: the branches as GitHub has them now, before anything is started or moved. A public branch changed outside the cloud refuses the
    // round; a private branch that moved is recorded and the round goes on from its latest commit (the issuer reads the tip at dispatch, and the runner resumes
    // a kept workspace only when it is at that tip).
    const publicRefusal = await checkPublicBranch(runnerPool, deps.fixHeads, who);
    if (publicRefusal !== null) return refuse(publicRefusal);
    // The cheap refusals come before anything is written on GitHub: a base-sync merge must never land for a round that is then refused.
    const parent = await newestExecutorRun(who);
    if (parent === null) return refuse("no_session");
    const seat = await deps.resolveRunSeat({ accountId: who.accountId, role: "executor", workItemId: who.workItemId, ...(req.expectedExecutionMode !== undefined ? { expectedExecutionMode: req.expectedExecutionMode } : {}) });
    if (!seat.ok) return refuse(seat.reason);
    const effective = await readExecutionMode(runnerPool, who.accountId, state.repoId, who.workItemId);
    let headMoved = false;
    let baseSynced = false;
    let baseTip: string | null = null;
    let syncedBranch: string | null = null;
    let republishes = false;
    /** A sandbox round that must end by updating the public pull request: the base it was brought up to date with is recorded in the run's create transaction (the sandbox has no signed job to carry it). */
    let sandboxRepublish = false;
    {
      // FIXROUND-BASE-SYNC-SANDBOX: the sync is the cloud's, so a sandbox round gets the same head check and sync (its prompt starts from the fetched branch tip).
      const runnerSide = isRunnerMode(effective);
      // FIXROUND-REPUBLISH (R2-c0, c2): asked before the sync, on either side, which refuses a stacked change with a public copy without merging.
      const publicCopy = await hasPublicCopy(runnerPool, who);
      const repoId = state.repoId;
      const found = await withTenant(runnerPool, who.accountId, async (client) => {
        const r = await client.query<{ gh_owner: string | null; gh_name: string | null }>(
          "SELECT r.gh_owner, r.gh_name FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id WHERE w.id = $1 AND w.account_id = $2",
          [who.workItemId, who.accountId],
        );
        return { coords: r.rows[0], recorded: await readRecordedRunnerPullRequest(client, { accountId: who.accountId, workItemId: who.workItemId }), bound: await readSandboxBoundPullRequest(client, { accountId: who.accountId, workItemId: who.workItemId }) };
      });
      // The branch read is the item's own: a pair the item recorded, or (a round handed the pull request the other side opened) the item's own issue branch.
      // A pair that is neither is not read here; the binding check below refuses it.
      const same = (p: { number: number; branch: string } | null) => p !== null && req.pr !== undefined && p.number === req.pr.number && p.branch === req.pr.branch;
      const pr =
        req.pr === undefined
          ? runnerSide
            ? found.recorded
            : found.bound
          : same(found.recorded) || same(found.bound) || (itemBranch !== null && req.pr.branch === itemBranch)
            ? req.pr
            : null;
      if (pr !== null && found.coords?.gh_owner && found.coords.gh_name) {
        const head = await checkPrivateHead(runnerPool, deps.fixHeads, who, { repo: { id: repoId, owner: found.coords.gh_owner, name: found.coords.gh_name }, pr, askedHead: req.headSha });
        if (!head.ok) return refuse(head.reason);
        headMoved = head.moved;
        // FIXROUND-BASE-SYNC: bring the branch up to date with its base before anything starts; a conflict goes to a person, any other failure refuses the round.
        const sync = await syncRunBranch(runnerPool, deps.fixHeads, who, { repo: { id: repoId, owner: found.coords.gh_owner, name: found.coords.gh_name }, pr, liveHead: head.head, moveToNeedsPerson: true, attempt: attemptKey, publicCopy });
        if (!sync.ok) return refuse(sync.reason);
        baseSynced = sync.synced;
        // The base is signed only for the branch that was synced: the issuer compares it with the branch it resolves for the job.
        baseTip = sync.baseSha;
        syncedBranch = pr.branch;
      } else if (!runnerSide && !(req.pr !== undefined && (await withTenant(runnerPool, who.accountId, async (client) => (await client.query<{ execution_mode: string | null }>("SELECT execution_mode FROM agent_runs WHERE id = $1 AND account_id = $2", [parent, who.accountId])).rows[0]?.execution_mode ?? null).then((m) => sideOfMode(m) !== sideOfMode(effective))))) {
        // A sandbox round always has a pull request (the review step found it on GitHub): without one it is refused, never started on a stale base.
        // A cross-side round with a pair that is not the item's is left to the binding check below, which refuses it `pr_unbound`.
        await recordBaseSyncUnavailable(runnerPool, who, attemptKey, null, null, true);
        return refuse("base_sync_unavailable");
      }
      // An item whose public pull request is open is republished at the end of a runner round, so the round needs a signed base.
      const gate = await republishGate(runnerPool, who, { publicCopy, baseSha: baseTip, prNumber: pr?.number ?? null, moveToNeedsPerson: true, attempt: attemptKey });
      if (gate !== null) return refuse(gate);
      republishes = publicCopy && baseTip !== null && syncedBranch !== null;
      sandboxRepublish = republishes && !runnerSide;
    }

    // The board says "Changes requested" the moment a fix round starts, whatever an earlier record said (a pass recorded
    // after a needs-fix used to leave the card at "ready to merge").
    if (state.stage !== "changes_requested") {
      try {
        await withTenant(runnerPool, who.accountId, (client) =>
          recordStage(client, { workItemId: who.workItemId, toStage: "changes_requested", reviewer: req.reviewer, at: new Date(), source: "control_plane", sourceRef: `fix-round:${req.failingRunId ?? attemptKey}` }),
        );
      } catch (err) {
        if (err instanceof StageHaltedError) return refuse("item_halted");
        if (!(err instanceof IllegalStageTransitionError)) throw err;
        return refuse("stage_changed");
      }
    }

    // The accepted run notes ride on this run (sanitised and fenced), and their ids are pinned into the key. They are read once, here, so a note accepted
    // while the fix starts waits for the next run.
    const notes = await withTenant(runnerPool, who.accountId, (client) => readPendingRunNotes(client, who.workItemId));
    const key = `advance:${who.workItemId}:${keyBase}${runNotesStepSuffix(notes.map((n) => n.id))}`;
    const noteText = renderRunNotes(notes);
    const withNotes = (text: string): string => [text, ...(baseSynced ? [BASE_SYNCED_PROMPT_LINE] : []), ...(noteText ? [noteText] : [])].join("\n\n");
    // A prompt that says "Spec unchanged" is sent only when the run this round continues is pinned to exactly that version and hash. The pin is the one the
    // session was built from, not the latest Spec: a mismatch (or no pin) sends the body.
    let useFallback = false;
    if (req.held !== undefined) {
      const pinned = await withTenant(runnerPool, who.accountId, async (client) => {
        const r = await client.query<{ version: number; body_sha256: string }>(
          "SELECT sv.version, sv.body_sha256 FROM agent_runs r JOIN spec_versions sv ON sv.id = r.spec_version_id AND sv.account_id = r.account_id WHERE r.id = $1 AND r.account_id = $2 AND sv.erased_at IS NULL",
          [parent, who.accountId],
        );
        return r.rows[0] ?? null;
      });
      useFallback = !(pinned !== null && Number(pinned.version) === req.held.version && pinned.body_sha256 === req.held.sha256);
    }
    // D#7 DP4b-3b: what THIS round may decide, from the dials and the catalogue as they stand now, and the snapshot written with the run. Every prompt that can go out
    // (the round's, the body-carrying fallback, the uncut copy of each) carries the same block, so the keys the run reads are the keys in its own row.
    const dec = await decisionStartFor(runnerPool, who.accountId, who.workItemId);
    const prompt = dec.prompt(withNotes(useFallback ? req.fallbackPrompt! : req.prompt));
    const sections = dec.sections(sectionsOf(useFallback ? req.fallbackContextSections : req.contextSections));
    // The fresh session a lost snapshot falls back to has no Spec: it gets the body-carrying prompt whatever the check said.
    const fallbackPrompt = req.fallbackPrompt === undefined || useFallback ? undefined : dec.prompt(withNotes(req.fallbackPrompt));
    const fallbackSections = fallbackPrompt === undefined ? undefined : dec.sections(sectionsOf(req.fallbackContextSections));

    // D#599 PL-2: a round whose effective side is not the side the build's session ran on cannot continue that session: a session belongs to the
    // side that made it. It starts a fresh executor session instead, carrying the fix prompt, the pinned Spec version and the fenced notes above.
    // Same-side rounds are unchanged (R1b). Continuing the PR's branch from the other side is PL-2b (the push-branch rules are not touched here).
    const parentRun = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ execution_mode: string | null; spec_version_id: string | null }>("SELECT execution_mode, spec_version_id FROM agent_runs WHERE id = $1 AND account_id = $2 AND work_item_id = $3", [parent, who.accountId, who.workItemId]);
      return r.rows[0];
    });
    const freshPrompt = req.fallbackPrompt === undefined ? prompt : dec.prompt(withNotes(req.fallbackPrompt));
    const freshSections = req.fallbackPrompt === undefined ? sections : dec.sections(sectionsOf(req.fallbackContextSections));
    // D#600 CX-4a: the files for the prompt that goes out, with the notes added to the uncut prompt as they are to the cut one.
    const spillWithNotes = (s: ContextSpill | undefined): ContextSpill | undefined => dec.spill(s === undefined ? undefined : { ...s, uncut: { ...s.uncut, prompt: withNotes(s.uncut.prompt) } });
    const spill = spillWithNotes(useFallback ? req.fallbackContextSpill : req.contextSpill);
    const fallbackSpill = fallbackPrompt === undefined ? undefined : spillWithNotes(req.fallbackContextSpill);
    const freshSpill = req.fallbackPrompt === undefined ? spill : spillWithNotes(req.fallbackContextSpill);
    const crossSide = parentRun !== undefined && sideOfMode(parentRun.execution_mode) !== sideOfMode(effective);

    let out: { id: string; status: string };
    try {
      if (crossSide) {
        if (!deps.starter) return refuse("starter_unavailable");
        const coords = await withTenant(runnerPool, who.accountId, async (client) => {
          const r = await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE id = $1 AND account_id = $2", [state.repoId, who.accountId]);
          return r.rows[0];
        });
        if (!coords?.gh_owner || !coords.gh_name) return refuse("no_repo");
        // D#599 PL-2b-2: the round carries on from the pull request the other side opened. A runner round continues its branch with no session (the issuer
        // reads GitHub and binds the pull request); a sandbox round is bound to the pull request the item recorded, in its own create transaction.
        let continues: { branch: string; prNumber?: number; baseSha?: string } | undefined;
        let bindTransaction: StartAgentRunInput["inCreateTransaction"];
        if (req.pr !== undefined) {
          const bound = req.pr;
          if (isRunnerMode(effective)) {
            if (ITEM_PR_BRANCH.test(bound.branch)) continues = { branch: bound.branch, prNumber: bound.number, ...(baseTip === null ? {} : { baseSha: baseTip }) };
            else if (RUNNER_RUN_BRANCH.test(bound.branch)) {
              // Defence in depth: a run branch is trusted only as the pair the item itself recorded (a runner's done, or a sandbox round bound to it).
              const known = await withTenant(runnerPool, who.accountId, async (client) => ({
                recorded: await readRecordedRunnerPullRequest(client, { accountId: who.accountId, workItemId: who.workItemId }),
                bound: await readSandboxBoundPullRequest(client, { accountId: who.accountId, workItemId: who.workItemId }),
              }));
              const matches = (p: { number: number; branch: string } | null) => p !== null && p.number === bound.number && p.branch === bound.branch;
              if (!matches(known.recorded) && !matches(known.bound)) return refuse("pr_unbound");
              continues = { branch: bound.branch, ...(republishes && syncedBranch === bound.branch ? { baseSha: baseTip! } : {}) };
            }
            else return refuse("pr_branch_unsupported");
          } else {
            const recorded = await withTenant(runnerPool, who.accountId, (client) => readRecordedRunnerPullRequest(client, { accountId: who.accountId, workItemId: who.workItemId }));
            if (recorded === null || recorded.number !== bound.number || recorded.branch !== bound.branch) return refuse("pr_unbound");
            bindTransaction = async (client, runId) => {
              await recordSandboxContinuesBound(client, { accountId: who.accountId, runId, prNumber: bound.number, branch: bound.branch });
              // The branch recorded is the one the sync was made on (`bound` is that same pair); a round that republishes never starts without its base.
              if (sandboxRepublish) await insertRunEvent(client, who.accountId, runId, FIX_BASE_EVENT, { base_sha: baseTip!, branch: syncedBranch! });
            };
          }
        }
        const fresh = await deps.starter.start({
          ...seat.seat,
          accountId: who.accountId,
          repoId: state.repoId,
          workItemId: who.workItemId,
          role: "executor",
          product: "team",
          pr: req.issue,
          // A fresh session holds nothing a continued one did: it gets the prompt that carries the Spec body when the caller sent one.
          prompt: freshPrompt,
          ...(req.expectedExecutionMode !== undefined ? { expectedExecutionMode: req.expectedExecutionMode } : {}),
          ...(parentRun.spec_version_id === null ? {} : { specVersionId: parentRun.spec_version_id }),
          ...(freshSections ? { contextSections: freshSections } : {}),
          ...(assemblyOf(req.contextAssembly) ? { contextAssembly: assemblyOf(req.contextAssembly) } : {}),
          ...(freshSpill ? { contextSpill: freshSpill } : {}),
          ...(continues ? { continues, parentRunId: parent } : {}),
          inCreateTransaction: dec.inCreateTransaction(bindTransaction),
          // A fresh session: the repository is cloned into the workdir, as for a build.
          workdir: PREVIEW_WORKDIR,
          cloneRepo: { owner: coords.gh_owner, name: coords.gh_name },
          idempotency: { key, requestHash: createHash("sha256").update(`${key}:executor`).digest("hex") },
        });
        console.info(JSON.stringify({ event: "advance.fix_fresh_session", work_item_id: who.workItemId, run_id: fresh.runId, refused: fresh.refused ?? null }));
        if (fresh.refused) return refuse(fresh.refused);
        out = { id: fresh.runId, status: "started" };
      } else {
        // The build ran in the sandbox this PR owns, in the checkout it made; a resume continues both: same sandbox, same
        // session, same working directory, no clone. `pr` is the ISSUE's number, as the build used it (it names the sandbox).
        // A fix round the target queued for a runner has no hook and may sit pending for days. That is accepted: the fix wait is
        // a status poll that credits queued time, and the runner's `done` judges the continuation on the same PR branch.
        out = await acceptQueuedRunnerRun(
          runnerPool,
          who.accountId,
          await review.resume(runnerPool, deps.registry, {
            ...seat.seat,
            accountId: who.accountId,
            repoId: state.repoId,
            workItemId: who.workItemId,
            role: "executor",
            product: "team",
            pr: req.issue,
            parentRunId: parent,
            prompt,
            ...(republishes ? { base: { sha: baseTip!, branch: syncedBranch! } } : {}),
            inCreateTransaction: dec.inCreateTransaction(sandboxRepublish ? (client: PoolClient, runId: string) => insertRunEvent(client, who.accountId, runId, FIX_BASE_EVENT, { base_sha: baseTip!, branch: syncedBranch! }) : undefined),
            ...(req.expectedExecutionMode !== undefined ? { expectedExecutionMode: req.expectedExecutionMode } : {}),
            ...(sections ? { contextSections: sections } : {}),
            ...(assemblyOf(req.contextAssembly) ? { contextAssembly: assemblyOf(req.contextAssembly) } : {}),
            ...(spill ? { contextSpill: spill } : {}),
            ...(fallbackPrompt !== undefined ? { fallbackPrompt, ...(fallbackSections ? { fallbackContextSections: fallbackSections } : {}), ...(fallbackSpill ? { fallbackContextSpill: fallbackSpill } : {}) } : {}),
            workdir: PREVIEW_WORKDIR,
            idempotency: { key, requestHash: createHash("sha256").update(`${key}:executor`).digest("hex") },
          }),
        );
      }
    } catch (err) {
      // fx-swallow-ok: the error's NAME is logged below and the refusal is recorded as a fact; its message can carry text from the sandbox or the platform
      const e = err as { name?: string };
      console.warn(JSON.stringify({ event: "advance.resume_failed", work_item_id: who.workItemId, name: typeof e?.name === "string" ? e.name.slice(0, 60) : null }));
      if (err instanceof IdempotencyKeyTakenError) {
        const won = await claimedRun();
        if (won) return started(won);
      }
      // D#599 PL-2b-2: the issuer refused the continuation with a closed code (the pull request is closed or not the item's, the branch is protected,
      // GitHub could not be read). The code is fixed text and is the answer; the run it left is already failed.
      const issuerRefusal = err instanceof DispatchFailedError ? err.originalError : err;
      if (issuerRefusal instanceof JobIssueError && issuerRefusal.code.startsWith("continues_")) return refuse(issuerRefusal.code);
      // A reaper claim on the sandbox is transient: the step throws and is retried (the run is keyed, so a replay is safe).
      if (err instanceof SandboxReapingError) throw err;
      if (err instanceof DuplicateExecutorRunError) return refuse("already_running");
      if (err instanceof WorkItemHaltedError) return refuse("item_halted");
      if (err instanceof ExecutionModeChangedError) return refuse("execution_mode_changed");
      // D#599 PL-2: the guards of the round's own side refused it before a row was written.
      if (err instanceof RunPrecheckRefusedError) return refuse(err.reason);
      // D#6 R4d-5c (C36): the build this fix round continues has no Spec version to inherit (built before the pin): nothing was written, no job issued.
      if (err instanceof NoSpecVersionError) return refuse("no_spec_version");
      return refuse("resume_failed");
    }
    if (out.status === "refused_spend") {
      // D#483 S5-k1d: the admit's own reason, when it is a spending-limit denial, so the driver can wait for the limit; any other denial keeps the code it always had.
      const why = (out as { reason?: unknown }).reason;
      return refuse(typeof why === "string" && SPEND_DENIALS.includes(why) ? why : "refused_spend");
    }
    console.info(JSON.stringify({ event: "advance.resumed", work_item_id: who.workItemId, run_id: out.id, status: out.status, round: req.round }));
    await attachRunNotes(runnerPool, who.accountId, who.workItemId, out.id, { ids: notes.map((n) => n.id) });
    if (headMoved) await recordRunStage(runnerPool, { accountId: who.accountId, runId: out.id, stage: BRANCH_MOVED_STAGE });
    if (baseSynced) await recordRunStage(runnerPool, { accountId: who.accountId, runId: out.id, stage: BASE_SYNCED_STAGE });
    return started(out.id);
  }

  async function advanceLightSpec(who: AdvanceStepWho, runId: string, actionId: string): Promise<{ status: string; reason: string | null; version: number | null; split?: true }> {
    const refusedWith = (reason: string) => ({ status: "refused", reason, version: null });
    if (!deps.lightSpec) return refusedWith("light_spec_unavailable");
    if (!UUID_RE.test(runId) || !UUID_RE.test(actionId)) return refusedWith("invalid_input");
    const bad = await guardStep(who);
    if (bad) return refusedWith(bad.reason ?? "refused");
    const read = await withTenant(runnerPool, who.accountId, async (client) => {
      const run = await client.query<{ status: string; role: string; envelope: unknown }>("SELECT status, role, envelope FROM agent_runs WHERE id = $1 AND account_id = $2 AND work_item_id = $3", [runId, who.accountId, who.workItemId]);
      const item = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId]);
      const spec = await client.query<{ version: number }>("SELECT max(version) AS version FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 AND erased_at IS NULL", [who.accountId, who.workItemId]);
      return { run: run.rows[0], stage: item.rows[0]?.stage ?? null, version: spec.rows[0]?.version ?? null };
    });
    if (!read.run || read.run.role !== "project-manager" || read.run.status !== "succeeded") return refusedWith("run_not_usable");
    // A replay after the Spec was published: nothing more is published (a second publish would add a version).
    if (read.stage === "spec_ready" && read.version !== null) return { status: "published", reason: null, version: Number(read.version), ...(await specPlansSplit(who, Number(read.version))) };
    if (read.stage !== "triaged") return refusedWith(`stage_${read.stage ?? "gone"}`.replace(/[^a-z0-9_]/g, "_"));
    const out = await deps.lightSpec(runnerPool, who.accountId, who.workItemId, read.run.envelope);
    const code = typeof out.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(out.reason) ? out.reason : null;
    console.info(JSON.stringify({ event: "advance.light_spec", work_item_id: who.workItemId, status: out.status, reason: out.status === "refused" ? code : null, version: out.version ?? null }));
    if (out.status === "not_feasible" || out.status === "refused") {
      await writeEvent(who, { kind: "stopped", dedupeKey: `light:${actionId}`, code: out.status === "not_feasible" ? "not_feasible" : (code ?? "refused"), runId });
    }
    // The PM's own sentence for a not-feasible request is model text: it stays in the run (its summary), never returned.
    const split = out.status === "published" && typeof out.version === "number" ? await specPlansSplit(who, out.version) : {};
    return { status: out.status, reason: out.status === "refused" ? code : null, version: typeof out.version === "number" ? out.version : null, ...split };
  }

  /**
   * D#483 S5-b2b: whether the stored table of Planned PRs of this Spec version has two or more rows (the pipeline stores a table only from rows its parser accepted,
   * and a table of fewer than two rows is never stored). Read from the stored version, so a replay of the publish step answers the same.
   */
  async function specPlansSplit(who: AdvanceStepWho, version: number): Promise<{ split?: true }> {
    const rows = await withTenant(runnerPool, who.accountId, async (client) =>
      (
        await client.query<{ id: string; n: number }>(
          "SELECT id, CASE WHEN jsonb_typeof(frontmatter -> 'planned_prs') = 'array' THEN jsonb_array_length(frontmatter -> 'planned_prs') ELSE 0 END AS n FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 AND version = $3 AND erased_at IS NULL",
          [who.accountId, who.workItemId, version],
        )
      ).rows,
    );
    if (Number(rows[0]?.n ?? 0) < 2) return {};
    await ensureSpecAnchorRun(runnerPool, { accountId: who.accountId, workItemId: who.workItemId, specVersionId: rows[0]!.id });
    return { split: true };
  }

  async function advanceRespec(who: AdvanceStepWho, runId: string, actionId: string, expectedVersion: number): Promise<{ status: string; reason: string | null; version: number | null }> {
    const refusedWith = (reason: string) => ({ status: "refused", reason, version: null });
    if (!deps.respec) return refusedWith("respec_unavailable");
    if (!UUID_RE.test(runId) || !UUID_RE.test(actionId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return refusedWith("invalid_input");
    const bad = await guardStep(who);
    if (bad) return refusedWith(bad.reason ?? "refused");
    const read = await withTenant(runnerPool, who.accountId, async (client) => {
      const run = await client.query<{ status: string; role: string; envelope: unknown }>("SELECT status, role, envelope FROM agent_runs WHERE id = $1 AND account_id = $2 AND work_item_id = $3", [runId, who.accountId, who.workItemId]);
      const spec = await client.query<{ version: number; acceptance_files: unknown }>(
        "SELECT version, frontmatter -> 'acceptance_files' AS acceptance_files FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 AND erased_at IS NULL ORDER BY version DESC LIMIT 1",
        [who.accountId, who.workItemId],
      );
      return { run: run.rows[0], spec: spec.rows[0] };
    });
    if (!read.run || read.run.role !== "project-manager" || read.run.status !== "succeeded") return refusedWith("run_not_usable");
    // A replay after the new version was published: nothing more is published (a second publish would add a version). The newest version then has its list.
    if (read.spec && Number(read.spec.version) > expectedVersion && parseAcceptanceScope(read.spec.acceptance_files).kind === "known") return { status: "published", reason: null, version: Number(read.spec.version) };
    const out = await deps.respec(runnerPool, who.accountId, who.workItemId, read.run.envelope, expectedVersion);
    const code = typeof out.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(out.reason) ? out.reason : null;
    console.info(JSON.stringify({ event: "advance.respec", work_item_id: who.workItemId, status: out.status, reason: out.status === "refused" ? code : null, version: out.version ?? null }));
    // A list that could not be read is a fact of the item: the card's notice says so, in the words of the runner protocol's copy.
    if (out.status === "refused" && code === "invalid_file_scope") await writeEvent(who, { kind: "stopped", dedupeKey: `respec:${actionId}`, code: "respec_list_unreadable", runId });
    return { status: out.status, reason: out.status === "refused" ? code : null, version: typeof out.version === "number" ? out.version : null };
  }

  async function advanceMergeGate(who: AdvanceStepWho, prNumber: number): Promise<AdvanceMergeGateResult> {
    if (!deps.review) return { outcome: "refused", reason: "review_unavailable" };
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return { outcome: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { outcome: "refused", reason: bad.reason ?? "refused" };
    const out = await deps.review.mergeGate(runnerPool, { accountId: who.accountId, workItemId: who.workItemId, prNumber }, { orders: planeMerge });
    console.info(JSON.stringify({ event: "advance.merge_gate", work_item_id: who.workItemId, pr: prNumber, outcome: out.outcome, reasons: out.reasons ?? null, status: out.status ?? null }));
    return out;
  }

  const planeMerge: RunnerPlaneMergeStore = createRunnerPlaneMergeStore(runnerPool);
  const mergeOrderView = (order: PlaneMergeOrder | null): AdvanceMergeOrderResult => {
    if (order === null) return { state: "none", code: null };
    switch (order.state) {
      case "pending":
      case "claimed":
      case "authorized":
        return { state: "open", code: null };
      case "merged":
        return { state: "merged", code: order.outcomeCode };
      case "head_moved":
      case "superseded":
        return { state: "head_moved", code: order.outcomeCode };
      case "blocked":
        return { state: "blocked", code: order.outcomeCode };
      default:
        return { state: "failed", code: order.outcomeCode };
    }
  };

  async function advanceMergeOrder(who: AdvanceStepWho): Promise<AdvanceMergeOrderResult> {
    const bad = await guardStep(who);
    if (bad) return { state: "refused", code: bad.reason ?? "refused" };
    const rec = { accountId: who.accountId, workItemId: who.workItemId };
    const reaped = await planeMerge.reapLeases(who.accountId);
    // A lease that ran out returned the order to the queue: tell the account's runners (a no-DB hint, never awaited).
    if (reaped.requeued > 0) void markRunnerWork(who.accountId);
    let order = await planeMerge.latestForItem(rec);
    if (order === null) return { state: "none", code: null };
    const at = Date.now();
    const pastDeadline = order.deadlineAt.getTime() <= at;
    if (order.state === "authorized" && (pastDeadline || (order.leaseExpiresAt !== null && order.leaseExpiresAt.getTime() <= at)) && deps.review?.reconcileMergeOrder) {
      try {
        await deps.review.reconcileMergeOrder(runnerPool, planeMerge, order, { reconcile: (input) => reconcileHolder(runnerPool, input.github, input.accountId, input.workItemId) });
      } catch (error) {
        // fx-swallow-ok: GitHub could not be asked; nothing was ended, and the next look asks again (the deadline below still bounds the wait)
        reportError(error, { stage: "advance.merge_order_reconcile" });
      }
      order = (await planeMerge.latestForItem(rec)) ?? order;
    }
    if (PLANE_MERGE_OPEN_STATES.includes(order.state) && order.deadlineAt.getTime() <= at) {
      await planeMerge.expireDue({ accountId: who.accountId, orderId: order.id });
      order = (await planeMerge.latestForItem(rec)) ?? order;
    }
    const view = mergeOrderView(order);
    if (view.state !== "blocked") return view;
    const recorded = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ one: number }>(
        `SELECT 1 AS one FROM work_item_driver_events e
          WHERE e.account_id = $1 AND e.work_item_id = $2 AND e.kind = 'merge_gate' AND e.code = 'ready_human_merges'
            AND e.created_at >= (SELECT o.created_at FROM plane_merge_orders o WHERE o.account_id = $1 AND o.id = $3)
          LIMIT 1`,
        [who.accountId, who.workItemId, order.id],
      );
      return r.rows.length > 0;
    });
    return { ...view, gateRecorded: recorded };
  }

  async function advanceVerifiedReviewGate(who: AdvanceStepWho, input: { prNumber: number; headSha: string; seenHead: string | null }): Promise<VerifiedReviewGate | { state: "refused"; reason: string }> {
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !SHA_RE.test(input.headSha) || (input.seenHead !== null && !SHA_RE.test(input.seenHead))) return { state: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { state: "refused", reason: bad.reason ?? "refused" };
    const out = await readVerifiedReviewGate(runnerPool, { accountId: who.accountId, workItemId: who.workItemId, ...input, now: new Date(), ...(deps.isOperatorAccount ? { isOperatorAccount: deps.isOperatorAccount } : {}) });
    console.info(JSON.stringify({ event: "advance.verified_review_gate", work_item_id: who.workItemId, pr: input.prNumber, state: out.state }));
    return out;
  }

  async function advanceRecordEvent(who: AdvanceStepWho, event: Omit<DriverEventInput, "workItemId">): Promise<{ recorded: boolean }> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId)) return { recorded: false };
    // D#598 P7c: the merge gate trusts a `review_verdicts` event with this code (it makes a carried head's reviewer passes count). Only the pipeline's
    // `recordMergeOnlyRecheck`, after its own checks, may write it; a step's free-form event may not. (The literal: this package cannot import @fx/pipeline.)
    if (event.kind === "review_verdicts" && event.code === "merge_only_recheck") {
      console.warn(JSON.stringify({ event: "advance.record_event_refused", work_item_id: who.workItemId, kind: event.kind, code: event.code }));
      return { recorded: false };
    }
    const out = await writeEvent(who, event);
    // D#483 S5-k1c: a start before the build that a limit denied leaves its waiting fact through here. Like the build's, a limit pause may outlast the workflow
    // that is asking (it parks after four hours), so the sweep is told there is work to look at.
    if (out.recorded && event.kind === "stage_waiting" && event.code != null && RESERVATION_PAUSE_REASONS.includes(event.code)) void markWorkPending("stage-resume-sweep", { since: Date.now() + STAGE_RESUME_FIRST_LOOK_MS });
    // A review parked for the runner's daily limit: its workflow has already ended, so the sweep looks at the next pass, not in four hours.
    else if (out.recorded && event.kind === "stage_waiting" && event.stage === "review" && event.code === "runner_daily_limit") void markWorkPending("stage-resume-sweep", { since: Date.now() + STAGE_RESUME_PASS_SECONDS * 1000 });
    return out;
  }

  async function advanceReviewRuns(who: AdvanceStepWho, req: { headSha: string; rereview: number }): Promise<Array<{ role: string; runId: string; attempt: number; noVerdictEnds: number }>> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(req.headSha)) return [];
    if (!(Number.isInteger(req.rereview) && req.rereview >= 0 && req.rereview <= 100)) return [];
    const prefix = `advance:${who.workItemId}:review:${req.headSha}:`;
    const rows = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ idempotency_key: string; run_id: string; refused: boolean; ended_no_verdict: boolean; after_boundary: boolean }>(
        `SELECT k.idempotency_key, k.run_id, (a.status = 'refused_spend') AS refused,
                (a.status = ANY($4::text[]) AND a.status <> 'refused_spend'
                  AND NOT (a.status = 'succeeded' AND jsonb_typeof(a.envelope) = 'object' AND a.envelope ? 'verdict')) AS ended_no_verdict,
                (k.created_at > COALESCE((SELECT max(e.created_at) FROM work_item_driver_events e WHERE e.work_item_id = $2::uuid AND e.kind = 'escalated' AND e.code = $5), '-infinity'::timestamptz)) AS after_boundary
           FROM agent_run_idempotency_keys k JOIN agent_runs a ON a.account_id = k.account_id AND a.id = k.run_id
          WHERE k.account_id = $1 AND a.work_item_id = $2 AND starts_with(k.idempotency_key, $3)
          ORDER BY k.created_at DESC, k.run_id DESC LIMIT 200`,
        [who.accountId, who.workItemId, prefix, [...ADVANCE_TERMINAL_STATUSES], NO_VERDICT_ESCALATION_CODE],
      );
      return r.rows;
    });
    // What follows the head is `<role>[:rr<n>][:s<n>][:p<n>][:n<pin>]` (the role, the re-review round, the attempt, a placement generation, a note pin).
    const tail = /^([a-z][a-z-]*)(?::rr(\d{1,3}))?(?::s(\d{1,6}))?(?::p\d{1,2})?(?::n[0-9a-f]{16})?$/;
    const newest = new Map<string, string>();
    const highest = new Map<string, number>();
    const ends = new Map<string, number>();
    for (const row of rows) {
      const m = tail.exec(row.idempotency_key.slice(prefix.length));
      if (!m) continue;
      // The bound's count spans every re-review round of the head; the run listing below is for the asked round only.
      if (row.ended_no_verdict && row.after_boundary) ends.set(m[1]!, (ends.get(m[1]!) ?? 0) + 1);
      if (Number(m[2] ?? 0) !== req.rereview) continue;
      highest.set(m[1]!, Math.max(highest.get(m[1]!) ?? 0, Number(m[3] ?? 0)));
      if (!row.refused && !newest.has(m[1]!)) newest.set(m[1]!, row.run_id);
    }
    return [...newest].map(([role, runId]) => ({ role, runId, attempt: highest.get(role) ?? 0, noVerdictEnds: ends.get(role) ?? 0 }));
  }

  async function advanceDeltaRuns(who: AdvanceStepWho, req: { headSha: string }): Promise<Array<{ role: string; runId: string; attempt: number; reusable: boolean }>> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !SHA_RE.test(req.headSha)) return [];
    const prefix = `advance:${who.workItemId}:delta:${req.headSha}:`;
    const rows = await withTenant(runnerPool, who.accountId, async (client) =>
      (
        await client.query<{ idempotency_key: string; run_id: string; reusable: boolean }>(
          `SELECT k.idempotency_key, k.run_id, (a.status NOT IN ('cancelled', 'refused_spend')) AS reusable
             FROM agent_run_idempotency_keys k JOIN agent_runs a ON a.account_id = k.account_id AND a.id = k.run_id
            WHERE k.account_id = $1 AND a.work_item_id = $2 AND starts_with(k.idempotency_key, $3)
            ORDER BY k.created_at DESC, k.run_id DESC LIMIT 100`,
          [who.accountId, who.workItemId, prefix],
        )
      ).rows,
    );
    const best = new Map<string, { runId: string; attempt: number; reusable: boolean }>();
    for (const row of rows) {
      const m = /^([a-z][a-z-]*)(?::s(\d{1,6}))?$/.exec(row.idempotency_key.slice(prefix.length));
      if (!m) continue;
      const attempt = Number(m[2] ?? 0);
      // The newest attempt speaks for the role.
      if (!best.has(m[1]!) || attempt > best.get(m[1]!)!.attempt) best.set(m[1]!, { runId: row.run_id, attempt, reusable: row.reusable });
    }
    return [...best].map(([role, v]) => ({ role, ...v }));
  }

  async function advanceCancel(who: AdvanceStepWho, runId: string): Promise<void> {
    await cancelItemRun(who, runId);
  }

  async function advanceCancelStepRuns(who: AdvanceStepWho, step: "panel" | "spec", actionId: string): Promise<void> {
    if (step !== "panel" && step !== "spec") return;
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !UUID_RE.test(actionId)) return;
    const prefix = `advance:${who.workItemId}:${step}:`;
    // The Spec PM's key ends with the approval that asked for it: `advance:<item>:spec:<discussion>[:g<n>]:pm:<action>[:s<n>]`, so only the timed-out workflow's own PM run
    // matches (another approval of the same item keeps its run). A panel seat's key (`advance:<item>:panel:<discussion>[:g<n>]:r<round>:<role>`) carries no approval: the
    // seats are one set per discussion generation, followed by whichever workflow runs, so they are matched by the step alone.
    const own = step === "spec" ? `:pm:${actionId}(:s[0-9]+)?$` : "";
    const heads = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ run_id: string }>(
        "SELECT k.run_id FROM agent_run_idempotency_keys k JOIN agent_runs a ON a.account_id = k.account_id AND a.id = k.run_id WHERE k.account_id = $1 AND a.work_item_id = $2 AND starts_with(k.idempotency_key, $3) AND k.idempotency_key ~ $4",
        [who.accountId, who.workItemId, prefix, own],
      );
      return r.rows.map((row) => row.run_id);
    });
    // The keys name each seat's first run; a run that was lost and followed has a later tail, and that is the one still live. Both are stopped (a finished run is left alone).
    const ids = new Set<string>(heads);
    for (const id of heads) {
      const out = await advanceRunOutcome(who.accountId, id);
      if (out.tailRunId !== undefined) ids.add(out.tailRunId);
    }
    for (const id of ids) await cancelItemRun(who, id);
  }

  async function advanceStartGate(who: AdvanceStepWho, input: StartGateStepInput): Promise<StartGateStepOut> {
    // Fail closed: with no gate wired nothing starts (a start that cannot be decided and recorded does not happen).
    if (!deps.startGate) return { proceed: false, reason: "blocked", blockedBy: "start_gate_unavailable" };
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !UUID_RE.test(who.userId)) return { proceed: false, reason: "blocked", blockedBy: "bad_ids" };
    return deps.startGate({ accountId: who.accountId, userId: who.userId, workItemId: who.workItemId }, input);
  }

  async function advanceFixGate(who: AdvanceStepWho, input: FixGateStepInput): Promise<FixGateStepOut> {
    // Fail closed, as the start gate does: a round that cannot be decided does not start. The halt guard is the same as every other step's.
    if (!deps.fixGate) return { proceed: false, reason: "blocked", blockedBy: "fix_gate_unavailable" };
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !UUID_RE.test(who.userId)) return { proceed: false, reason: "blocked", blockedBy: "bad_ids" };
    const bad = await guardStep(who);
    if (bad) return { proceed: false, reason: "blocked", blockedBy: bad.reason === "item_halted" || bad.reason === "halted_since_approval" ? "halted" : "refused" };
    return deps.fixGate({ accountId: who.accountId, userId: who.userId, workItemId: who.workItemId }, { personFiled: input.personFiled === true, ...(input.checkFailedRunId === undefined ? {} : { checkFailedRunId: input.checkFailedRunId }) });
  }

  return {
    advanceStartGate,
    advanceFixGate,
    performAdvanceWorkItem,
    performRespecWorkItem,
    performAmendSpec,
    advanceLoadItem,
    advanceStartRun,
    advanceRunOutcome,
    advanceTriage,
    advancePanel,
    advanceSpec,
    advanceBuild,
    advanceBuildFailed,
    advanceDecision,
    advancePrFound,
    advanceLightSpec,
    advanceRespec,
    advanceLoadReview,
    advanceLoadSpecText,
    advanceRecordRound,
    advanceRecordMergeOnly,
    advanceStartFix,
    advanceStartCheckFix,
    advanceContinue,
    advanceReviewRuns,
    advanceDeltaRuns,
    advanceMergeGate,
    advanceMergeOrder,
    advanceVerifiedReviewGate,
    advanceRecordEvent,
    advanceCancel,
    advanceCancelStepRuns,
  };
}
