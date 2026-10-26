import type { Pool } from "pg";
import type { BranchSyncPort } from "@fx/github";
import { envKekSource, type KekSource } from "@fx/model-connection";
import { contextWindowTokensFor, outsideMeterOn } from "@fx/spend";
import type { HostLookup } from "@fx/net-guard";
import {
  RunnerTarget,
  VerifiedTarget,
  type RunnerLimitsPort,
  createJobIssuer,
  createPgJobContext,
  SandboxTarget,
  SWEEP_TIME_BUDGET_MS,
  unwiredJobIssuer,
  unwiredRepoVisibility,
  sweepComputeSettle,
  sweepLostRuns,
  sweepOutsideMeter,
  type OutsideMeterResult,
  sweepSandboxReap,
  sandboxInventory,
  type SweepSandboxReapInput,
  type SweepSandboxReapResult,
  type SandboxInventoryInput,
  type SandboxInventoryResult,
  type LostSweepResult,
  type AuthorCheckProvider,
  buildPublishFirewallPolicy,
  PLANE_PUBLISH_ROLE,
  configureAgentRunWiring,
  createVercelSandboxPort,
  defaultResolvePayer,
  githubProxyForwardUrl,
  loadGithubForwardConfig,
  operatorMode,
  operatorTokenFor,
  overlapsAgentConfigDir,
  type ConnectionStatusPort,
  type CreateVercelSandboxPortOptions,
  type DecryptTenantKey,
  type ExecutionRun,
  type ExecutionTarget,
  type ExecutionTargetRegistry,
  type GithubForwardConfig,
  type HookResumePort,
  type ContinuationBasePort,
  type ContinuationBindingPort,
  type JobIssuer,
  type ModelConnectionPort,
  type RepoVisibilityPort,
  type SandboxPort,
  type SandboxTargetDeps,
  type SweepResult as ComputeSettleSweepResult,
  type VercelSandboxSdk,
} from "@fx/runner";
import { createExtensionPolicyFor } from "./extensionPolicy.js";
import { createVercelKeepAlive, slotWaitUntil } from "./keepAlive.js";
import { createConnectionStatusPort, createDecryptTenantKey, createModelConnectionPort } from "./ports.js";
import { createWorkerPools, type WorkerPools } from "./pools.js";
import { runsPerDayOfAccountPlan } from "./runnerLimits.js";
import { loadJobSigner } from "./jobSigner.js";
import { loadGitTicketSigner } from "./gitTicketSigner.js";
import { createRunnerGitTicketFacade, type RunnerGitTicketFacade } from "./runnerGitTicket.js";
import { createRunnerPlanePushFacade, type RunnerPlanePushFacade } from "./runnerPlanePush.js";
import { createRunnerPlaneMergeStore, type RunnerPlaneMergeStore } from "./runnerPlaneMerge.js";
import { createPlanePublish, createPublishSettler, type PlanePublish, type PlanePublishDeps } from "./planePublish.js";
import { createRunActionFacade, type RunActionFacade } from "./runActions.js";
import { createRunnerLeaseFacade, type RunnerLeaseFacade } from "./runnerLeases.js";
import { sweepInvariants, type InvariantSweeper } from "./invariantSweep.js";
import { sweepAskWithdrawals } from "./askWithdrawSweep.js";
import { SWEEP_REAL_CLOCK, sweepOverdueAsks } from "@fx/core/src/decisions/sweepOverdue.js";
import { purgeAap } from "./aapPurge.js";
import { createRunnerNoticeSweeper, runnerNoticeReports, type RunnerNoticeSweeper } from "./runnerNotices.js";
import { createRunnerQueueSweeper, type RunnerQueueSweeper } from "./runnerQueueSweep.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "./runnerClaims.js";
import { configuredWakeKey, readWakeKey } from "@fx/runner-cloud";
import { createRunnerDoneFacade, type RunnerDoneFacade } from "./runnerDone.js";
import { createRunnerLeaseSweeper, type RunnerLeaseSweeper } from "./runnerLeaseSweep.js";
import { createRunHandoffs, type RunHandoffs } from "./runHandoffs.js";
import { createStageResume, type StageResume } from "./stageResume.js";
import { sweepSetupRequestChecks as runSetupRequestCheckSweep, type CheckSweepCounts } from "@fx/core/src/setup-requests/checkSweep.js";
import { sweepBranchCleanups as runBranchCleanupSweep, type BranchCleanupCounts, type BranchCleanupGithub } from "./branchCleanup.js";
import type { PrCloseOpen } from "./privatePrClose.js";
import { reconcileHolder, sweepPrSlotHolders as runPrSlotSweep, type PrSlotSweepCounts, type PrStateOpen, type ReconcileOutcome } from "./prSlotReconcile.js";
import type { VercelEnvSource } from "@fx/core/src/setup-requests/checks.js";
import { answerAsk, type AskAnswerResult } from "@fx/core/src/decisions/answer.js";
import { approveSubItem, type SubItemApprovalResult } from "@fx/core/src/decisions/approveSubItem.js";
import type { RunActionSignal } from "@fx/core/src/runActions/index.js";
import { createFollowUpPorts } from "./runnerFollowUp.js";
import { discoverySettings } from "@fx/plan-data";
import { createProposalVerifySweep, type ProposalVerifyCounts, type ProposalVerifyDeps } from "./proposalVerify.js";
import { PREVIEW_ROLE, createPreviewModule, type PreviewFacade, type PreviewSeatSource } from "./preview.js";
import { createRetryModule, type RetryFacade, type RetrySeatSource } from "./retry.js";
import { createAdvanceModule, type AdvanceFacade, type AdvanceModuleDeps } from "./advance.js";
import type { FixRoundHeadPorts } from "./fixRoundHeads.js";
import { createResumeModule, reconcileResumes, type ResumeFacade } from "./resumeDecision.js";
import { createEnvelopeAsk } from "./envelopeAsk.js";
import { createDecisionIntake } from "./decisionIntake.js";
import { createSeatResolver, retrySeatSourceOf, type SeatRequest, type SeatResult } from "./seat.js";
import { createRunStarter, type RunFollower } from "./starter.js";
import { reportError } from "@fx/telemetry";

/**
 * D#2 H14c-3-1: the production composition root, as a library. `createWorker`
 * is called ONCE per process (by the thin apps/web routes H14c-3b adds); it
 * builds everything that must exist exactly once:
 *
 *  - the two pools, after their startup guards passed (pools.ts);
 *  - ONE `GithubForwardConfig`, from the process environment and nowhere else,
 *    handed to the sandbox target (which passes it to `buildFirewallPolicy`);
 *  - ONE real `SandboxPort`, its credentials constructor arguments (never a
 *    port per run: per-run limits travel through the target's per-run seam);
 *  - the production `ExecutionTargetRegistry`.
 *
 * Three of the four `WorkerPorts` have production bodies here (ports.ts: the
 * KEK open, the model-connection read, the run-id `markBroken` wrapper), built
 * from the pools and the KEK in the environment; passing one in replaces it
 * (a test seam). `hooks` has no default: its body is H14c-3-3, so the caller
 * must supply it.
 */

export interface WorkerPorts {
  /** Opens a tenant's sealed model key. Its plaintext only ever reaches the firewall policy. */
  decryptTenantKey: DecryptTenantKey;
  modelConnection: ModelConnectionPort;
  connectionStatus: ConnectionStatusPort;
  /** How a finished sandbox resumes the run's workflow hook. */
  hooks: HookResumePort;
  /** The retry author check (D#31 AUTHOR-CHECK-WIRE); kept for the run-action facade, absent means no check. */
  authorCheck?: AuthorCheckProvider;
  /** Starts whatever follows a running run to its end (apps/web starts the follower workflow). Absent, no preview can start: `previewReady()` stays false. */
  follow?: RunFollower;
  /** D#6 R3a: builds and records the signed job for a runner run. Absent, the worker builds the real issuer when the job-signing key is in the environment (R3b); with neither, a run for a `runner_local` repo cannot be dispatched. */
  jobIssuer?: JobIssuer;
  /** D#6 R3a: reads whether a repo is private (apps/web supplies the live GitHub read, R3b). Absent, every repo reads as unknown and a runner run is refused. */
  repoVisibility?: RepoVisibilityPort;
  /** D#6 R2b-3f: reads a continuation's branch head at dispatch (apps/web supplies the live GitHub read). Absent, a continuation (a fix round or a follow-up of one) cannot be issued. */
  continuationBase?: ContinuationBasePort;
  /** FIXROUND-BASE-SYNC: merges a pull request's base branch into its private branch before a fix round. Absent: such a round is refused `base_sync_unavailable`. */
  branchSync?: BranchSyncPort;
  /** D#599 PL-2b: reads the item's pull request, the default branch and a branch's protection to bind a continuation on `fx/issue-<n>`. Absent, such a continuation is refused (`continues_base_unavailable`) and nothing is recorded; a continuation on a run branch does not need it. */
  continuationBinding?: ContinuationBindingPort;
  /** D#6 R2b criterion 12: the runner tier's limits. Absent, they are read from the plan data (`runnerLimitsFor`), and unavailable plan data refuses every runner run. */
  runnerLimits?: RunnerLimitsPort;
  /** D#598 P1f-5b: what the paired-publish step needs from outside the worker (the built hook, the commit identity, the GitHub reads). Absent, the step answers `not_configured` and starts nothing. */
  planePublish?: Pick<PlanePublishDeps, "hook" | "identity" | "privateHead" | "privateDefaultHead" | "hosted" | "pullRequests" | "stackBase">;
}

export interface CreateWorkerOptions {
  /** The process environment; the one place the pools' and the forward config's variables are read from. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Vercel Sandbox credentials: ids are constructor arguments, the token is fetched before every SDK call (OIDC tokens rotate). */
  vercel: { teamId: string; projectId: string; getToken: () => Promise<string> };
  /** `hooks` is required; any other port given replaces the production body. */
  ports: Pick<WorkerPorts, "hooks"> & Partial<WorkerPorts>;
  /**
   * The only sandbox-target dependencies a caller may set (H14c-3-2b); every
   * other dependency is built here. Absent, a run limit ends the run and the
   * target's default timeout applies.
   */
  targetOverrides?: Pick<SandboxTargetDeps, "extensionPolicyFor" | "defaultTimeoutMs" | "keepAlive" | "agentStartTimeoutMs">;
  /** Port-wide runner limits (C46); omitted fields take the runner defaults. Validated at build. */
  portLimits?: CreateVercelSandboxPortOptions["limits"];
  /** pipeline's buildPreviewPrompt (this package cannot import @fx/pipeline). Absent, no preview can start: `previewReady()` stays false. */
  previewPrompt?: (repo: { owner: string; name: string }) => string;
  /**
   * D#483 S4-b2b: the claim verifier's injected pieces (pipeline's prompt builder and output recorder; this package cannot import
   * @fx/pipeline) and its read-only GitHub reader. Absent, `sweepProposalVerification` starts nothing and answers `idle: "not_configured"`.
   */
  verify?: Pick<ProposalVerifyDeps, "prompt" | "record" | "github">;
  /** D#483 P1: the stage driver's injected pieces (apps/web owns the workflow and the pipeline). Absent, `advance_work_item` is refused `advance_unavailable`. */
  advance?: Pick<AdvanceModuleDeps, "startAdvance" | "triage" | "panel" | "spec" | "build" | "buildFailed" | "buildWaitReason" | "prState" | "review" | "lightSpec" | "respec" | "amendSpec">;
}

/**
 * What a caller gets: the execution-target registry (the dispatch entry), the
 * run-action facade (plain-data methods bound to the runner login's pool) and
 * `close()`. No pool, client, login, port or target deps: a web route that
 * calls `createWorker` must not be able to reach the runner login's pool (CARRY-8).
 *
 * AUTHORITY WARNING: the run-action methods do not decide who may call them.
 * `cancelRun`'s principal must come from an authenticated request (account from
 * the session); token principals are refused. `claimRunAction`, `settleRunAction`,
 * `listDueRunActions` and `purgeRunActions` work across tenants and are for the
 * worker's own sweep/kick only, never directly callable from a user request.
 * H14c-3b's CARRY-28 enforces caller authorisation.
 */
export interface Worker extends PlanePublish, RunActionFacade, RunnerLeaseFacade, RunnerClaimFacade, RunnerDoneFacade, RunnerGitTicketFacade, RunnerPlanePushFacade, RunnerQueueSweeper, RunnerLeaseSweeper, Pick<RunHandoffs, "sweepRunHandoffs" | "completeRunHandoff" | "completeHandoffOnDone">, RunnerNoticeSweeper, InvariantSweeper, Pick<StageResume, "sweepParkedStages">, PreviewFacade, RetryFacade, AdvanceFacade, ResumeFacade {
  registry: ExecutionTargetRegistry;
  /** D#2 H14c-3-2d-2: resolves one run's card, model, limits, sandbox timeout and spend facts, or refuses with a fixed reason. Starts nothing. */
  resolveRunSeat(request: SeatRequest): Promise<SeatResult>;
  /**
   * D#2 COMPUTE-SETTLE CS-2b-2: one tick of the deferred compute settle. Works across tenants like `listDueRunActions`:
   * for the cron only, never callable from a user request. Takes no input and returns counts. The same tick first settles
   * runs that are `running` while their sandbox is gone (`lost`), so a run stopped from outside ends within a few minutes.
   */
  sweepComputeSettle(): Promise<ComputeSettleSweepResult & { lost: LostSweepResult; outside: OutsideMeterResult }>;
  /**
   * D#2 SANDBOX-REAPER-1a (C82): one pass of the sandbox reaper, over plain data. Like `sweepComputeSettle` it works across
   * tenants and is for the cron only, never callable from a user request; the pool, the provider port and the stop path stay
   * inside. `pass: "terminal"` deletes executor sandboxes whose work items have all ended; `ephemeral` is the 1-day safety net and `idle` the 7-day rule and cap (REAPER-2);
   * there is no `off` mode: the caller decides that and never calls.
   * The reconcile cron calls it (REAPER-1b); the kill switch (`FX_SANDBOX_REAP_MODE`) is read there.
   */
  sweepSandboxReap(input: SweepSandboxReapInput): Promise<SweepSandboxReapResult>;
  /**
   * D#598 P8b: one pass of the setup-request check sweep (the once-a-minute cron). Works across tenants like the other sweeps and is for
   * the cron only: the list is one definer (migration 0874) and the rest runs per request under its own tenant. `envSource` is where a
   * provider's variable names come from; the caller binds it.
   */
  sweepSetupRequestChecks(input: { envSource: VercelEnvSource }): Promise<CheckSweepCounts>;
  /**
   * D#598 P1f-5d: one pass of the branch cleanup sweep (a cron of its own, behind its own pending-work marker): removes the private branches of closed or
   * merged paired items whose head still is the recorded one. `github` is the GitHub client opener (apps/web binds it); the signing key is read here. For the cron only.
   */
  sweepBranchCleanups(input: { github: BranchCleanupGithub; closePr?: PrCloseOpen }): Promise<BranchCleanupCounts>;
  /** D#598: one pass of the stale pull-request sweep (items in a pull-request stage whose pull request was closed or merged without its webhook). */
  sweepPrSlotHolders(input: { github: PrStateOpen }): Promise<PrSlotSweepCounts>;
  /** D#6 PUBLIC-MERGE PR2b: reads ONE item's pull request from GitHub and moves the item as the webhook would when it merged or closed (the same read as the sweep, at most once per window). */
  reconcilePrHolder(input: { github: PrStateOpen; accountId: string; workItemId: string }): Promise<ReconcileOutcome>;
  /**
   * D#6 PUBLIC-MERGE PR2b: runs `fn` with the runner login's pool, for a pipeline callback that apps/web supplies (the merge gate run again in the go phase of a merge
   * order, as the review stage's `mergeGate` is handed the same pool). The pool is lent for the call and never returned.
   */
  withRunnerPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T>;
  /** D#6 PUBLIC-MERGE PR2b: the merge-order store (order placement, claims, the single write grant, the end of an order). Its holder owns the authority warning in runnerPlaneMerge.ts. */
  planeMerge: RunnerPlaneMergeStore;
  /**
   * D#483 S4-b2b: one pass of the claim verifier sweep (its own cron). Works across tenants like the other sweeps and is for the cron only:
   * the list is one definer (migration 0889), the rest runs per proposal under its own tenant, and one pass at a time holds an advisory lock.
   * The `discovery.*` figures are read from the plan data on every pass (fail closed: missing is `idle: "discovery_unconfigured"`).
   */
  sweepProposalVerification(): Promise<ProposalVerifyCounts>;
  /**
   * D#598 P8c-2a: a person's answer to a decision ask. It runs on the worker's RECEIPT pool (the only login that can call the receipt and ask
   * definers), which is never handed out: the caller passes the session principal and the choice, and gets the result or a thrown `AskAnswerError`.
   * `signal` kicks the resume request the answer files; without it the run-action sweep finds the request anyway.
   */
  answerDecisionAsk(input: { principal: { accountId: string; userId: string; tokenId?: string }; askId: string; choice: string; signal?: RunActionSignal }): Promise<AskAnswerResult>;
  /**
   * D#483 S5-b2a: a person's Approve on one sub-item of an approved parent. Like `answerDecisionAsk`, it runs on the RECEIPT pool, which is never
   * handed out; a token principal is refused (`SubItemApprovalError`, 403 `session_required`) before any connection.
   */
  approveSubItem(input: { principal: { accountId: string; userId: string; tokenId?: string }; workItemId: string; key: string }): Promise<SubItemApprovalResult>;
  /** D#2 SANDBOX-REAPER-1b (C82): the per-account inventory, rebuilt from the provider's list and the run rows. Plain data in and out; for the cron only. */
  sandboxInventory(input: SandboxInventoryInput): Promise<SandboxInventoryResult>;
  close(): Promise<void>;
}

/** Package-internal (not exported from index.ts): what tests inspect, plus the test seams. */
export interface BuiltWorker extends Worker {
  pools: WorkerPools;
  sandboxPort: SandboxPort;
  githubForward: GithubForwardConfig;
  /** The exact deps the sandbox target was built with. */
  targetDeps: SandboxTargetDeps;
  authorCheck: AuthorCheckProvider;
}

export interface BuildWorkerOptions extends CreateWorkerOptions {
  sdk?: VercelSandboxSdk;
  lookup?: HostLookup;
  /** Test seam; defaults to `envKekSource(env)` (FX_KEK_V{n}). */
  kek?: KekSource;
  createPools?: (env: Readonly<Record<string, string | undefined>>) => Promise<WorkerPools>;
  /** Test seam for the retry seat (D#31 API-6b-2); absent, a retry takes its seat from resolveRunSeat. */
  retrySeats?: RetrySeatSource;
}

/** The preview module's seat source over the root's own resolver: the PM's card, the repo, the preview purpose. The limits are copied into a plain record (the resolver types them as an interface); a refusal passes through. */
/**
 * FIXROUND-REFRESH-HEAD: the reads a fix round makes before it starts, from ports the worker already has: the private branch head through the continuation
 * base read (the issuer's own port), and the paired public branch head through the hosted publish reads (a `plane_push` token minted and revoked per read).
 */
export function fixRoundHeadPorts(ports: Pick<WorkerPorts, "continuationBase" | "planePublish" | "branchSync">): FixRoundHeadPorts {
  const base = ports.continuationBase;
  const hosted = ports.planePublish?.hosted;
  return {
    ...(base ? { privateHead: (input: { repo: { id: string; owner: string; name: string }; branch: string }) => base.headOid(input) } : {}),
    ...(ports.branchSync ? { syncBase: (input: Parameters<BranchSyncPort["sync"]>[0]) => ports.branchSync!.sync(input) } : {}),
    ...(hosted?.branchHead ? { publicHead: hosted.branchHead.bind(hosted) } : {}),
  };
}

export function previewSeatSourceOf(resolve: (request: SeatRequest) => Promise<SeatResult>): PreviewSeatSource {
  return {
    previewSeat: async (accountId, repoId) => {
      const result = await resolve({ accountId, role: PREVIEW_ROLE, repoId, purpose: "preview" });
      return result.ok ? { ok: true, seat: { ...result.seat, limits: { ...result.seat.limits } } } : result;
    },
  };
}

/** C59 §5: a run's workdir is never the runner's agent-config directory or under it. */
export function assertWorkdirAllowed(workdir: string | undefined): void {
  if (workdir !== undefined && overlapsAgentConfigDir(workdir)) {
    throw new Error("worker: a run's workdir must be outside the runner's agent config directory");
  }
}

/** Wraps a target so a run naming a forbidden workdir is refused before it reaches the port (the port refuses it too). */
function guardWorkdir(target: ExecutionTarget): ExecutionTarget {
  return {
    runtime: target.runtime,
    admit: (run, client) => target.admit(run, client),
    cancel: (run) => target.cancel(run),
    finalize: (run, report) => target.finalize(run, report),
    dispatch: async (run: ExecutionRun) => {
      assertWorkdirAllowed(run.workdir);
      return target.dispatch(run);
    },
    resume: async (run: ExecutionRun, sessionId: string) => {
      assertWorkdirAllowed(run.workdir);
      return target.resume(run, sessionId);
    },
  };
}

/** Fails at build time, not at the first decrypt; the message names the variable, never a value. */
function assertCurrentKek(kek: KekSource): void {
  const version = kek.currentVersion();
  try {
    kek.keyFor(version);
  } catch {
    throw new Error(`worker: FX_KEK_V${version} must be set to a base64-encoded 32-byte key`);
  }
}

export async function buildWorker(options: BuildWorkerOptions): Promise<BuiltWorker> {
  const env = options.env ?? process.env;
  const kek = options.kek ?? envKekSource(env);
  // The default decrypt is the only user of the KEK: refuse to build (before any pool opens) without the current version's key.
  if (!options.ports.decryptTenantKey) assertCurrentKek(kek);
  const pools = await (options.createPools ?? createWorkerPools)(env);
  try {
    const githubForward = loadGithubForwardConfig(env);
    const sandboxPort = createVercelSandboxPort({
      teamId: options.vercel.teamId,
      projectId: options.vercel.projectId,
      getToken: options.vercel.getToken,
      sdk: options.sdk,
      limits: options.portLimits,
    });
    const targetDeps: SandboxTargetDeps = {
      pool: pools.runnerPool,
      sandboxPort,
      githubForward,
      lookup: options.lookup,
      decryptTenantKey: options.ports.decryptTenantKey ?? createDecryptTenantKey(kek),
      modelConnection: options.ports.modelConnection ?? createModelConnectionPort(pools.runnerPool),
      connectionStatus: options.ports.connectionStatus ?? createConnectionStatusPort(pools.platformOpsPool),
      outsideMeterOn: () => outsideMeterOn(env.FX_OUTSIDE_METER),
      hooks: options.ports.hooks,
      // The payer is read from targetDeps at call time, so an extension is held against the account `admit` charged.
      extensionPolicyFor:
        options.targetOverrides?.extensionPolicyFor ??
        createExtensionPolicyFor({ pool: pools.runnerPool, resolvePayer: (run) => (targetDeps.resolvePayer ?? defaultResolvePayer)(run), operatorToken: (accountId, payer) => operatorTokenFor(env, accountId, payer) }),
      defaultTimeoutMs: options.targetOverrides?.defaultTimeoutMs,
      // The stream and finalize of a run outlive the call that started it: ask the platform to keep that invocation alive.
      keepAlive: options.targetOverrides?.keepAlive ?? createVercelKeepAlive(slotWaitUntil), // loud on Vercel when the platform gave no context
      agentStartTimeoutMs: options.targetOverrides?.agentStartTimeoutMs,
      // The operator exception: the token is read here, per call, only for accounts the operator decision admits.
      operatorToken: (accountId, payerAccountId) => operatorTokenFor(env, accountId, payerAccountId),
    };
    const sandboxTarget = new SandboxTarget(targetDeps);
    // D#6 R3a: the runner target holds no money and starts nothing; it queues a run for a runner. It needs the runner login's pool only to count the day's runs.
    // D#6 R3b: the job-signing key is read here, once, and goes straight into the signer. Without it the issuer stays unwired and a runner run cannot be dispatched.
    const repoVisibility = options.ports.repoVisibility ?? unwiredRepoVisibility;
    const jobSigner = loadJobSigner(env);
    const jobIssuer = options.ports.jobIssuer ?? (jobSigner ? createJobIssuer({ pool: pools.runnerPool, signer: jobSigner, visibility: repoVisibility, context: createPgJobContext(pools.runnerPool), contextWindowTokensFor, ...(options.ports.continuationBase ? { continuationBase: options.ports.continuationBase } : {}), ...(options.ports.continuationBinding ? { continuationBinding: options.ports.continuationBinding } : {}) }) : unwiredJobIssuer);
    const runnerLimits = options.ports.runnerLimits ?? { runsPerDay: runsPerDayOfAccountPlan(pools.runnerPool) };
    const runnerTarget = new RunnerTarget({ pool: pools.runnerPool, issuer: jobIssuer, visibility: repoVisibility, limits: runnerLimits }, "runner_local");
    // D#6 R5b-2a: a cloud-verified repository's agents run on the runner, and its four reviewers in the sandbox target above, on the customer's key.
    const guardedSandbox = guardWorkdir(sandboxTarget);
    const runnerVerifiedTarget = new RunnerTarget({ pool: pools.runnerPool, issuer: jobIssuer, visibility: repoVisibility, limits: runnerLimits }, "runner_verified");
    const registry: ExecutionTargetRegistry = Object.freeze({ sandbox: guardedSandbox, runner_local: guardWorkdir(runnerTarget), runner_verified: new VerifiedTarget(guardWorkdir(runnerVerifiedTarget), guardedSandbox) });
    // The runner's workflow steps and the follower's bodies reach the pool and the registry through this, never through arguments.
    configureAgentRunWiring({ pool: pools.runnerPool, registry });
    const runActions = createRunActionFacade(pools.runnerPool, registry);
    const runnerLeases = createRunnerLeaseFacade(pools.runnerPool);
    const runnerQueue = createRunnerQueueSweeper(pools.runnerPool, { onError: (runId) => console.warn(JSON.stringify({ event: "runner.queue_sweep_failed", run_id: runId })) });
    // D#6 RUNNER-WAKE: the wake gate is the one minting uses (a usable FX_RUNNER_WAKE_KEY), read on each call so a changed setting applies at once.
    const wakeEnabled = (): boolean => configuredWakeKey(() => readWakeKey(env)) !== null;
    const runnerNotices = createRunnerNoticeSweeper(pools.runnerPool, { ...runnerNoticeReports({ report: reportError, warn: (line) => console.warn(line) }), wakeEnabled });
    const authorCheck = options.ports.authorCheck ?? (() => null);
    const resolveRunSeat = createSeatResolver({ pool: pools.runnerPool, isOperatorAccount: (accountId) => operatorMode(env, accountId).active });
    // The three pieces a preview needs, wired together: its seat (from the resolver), the production run starter and the prompt builder.
    // Any one missing and `previewReady()` is false.
    // Two starters over one follower: the advance module polls its runs' status with the queued time credited, so it accepts a run
    // queued for a runner; a preview waits on its run's end and is sandbox-only, so it refuses one (D#6 C29).
    const previewStarter = options.ports.follow ? createRunStarter({ pool: pools.runnerPool, registry, follow: options.ports.follow, queued: "refuse" }) : null;
    const advanceStarter = options.ports.follow ? createRunStarter({ pool: pools.runnerPool, registry, follow: options.ports.follow, queued: "accept" }) : null;
    const preview = createPreviewModule(pools.runnerPool, { seats: previewSeatSourceOf(resolveRunSeat), starter: previewStarter, promptFor: options.previewPrompt ?? null, isOperatorAccount: (accountId) => operatorMode(env, accountId).active });
    const retry = createRetryModule(pools.runnerPool, registry, { seats: options.retrySeats ?? retrySeatSourceOf(resolveRunSeat), authorCheck });
    const advance = createAdvanceModule(pools.runnerPool, { starter: advanceStarter, resolveRunSeat, startAdvance: options.advance?.startAdvance ?? null, triage: options.advance?.triage ?? null, panel: options.advance?.panel ?? null, spec: options.advance?.spec ?? null, build: options.advance?.build ?? null, buildFailed: options.advance?.buildFailed ?? null, buildWaitReason: options.advance?.buildWaitReason ?? null, prState: options.advance?.prState ?? null, review: options.advance?.review ?? null, lightSpec: options.advance?.lightSpec ?? null, respec: options.advance?.respec ?? null, amendSpec: options.advance?.amendSpec ?? null, registry, fixHeads: fixRoundHeadPorts(options.ports), isOperatorAccount: (accountId) => operatorMode(env, accountId).active, raiseEnvelopeAsk: createEnvelopeAsk(pools.receiptPool), decisionIntake: createDecisionIntake({ runnerPool: pools.runnerPool, receiptPool: pools.receiptPool }) });
    // D#7 DP11c: the performer of `resume_decision` starts one run through the advance module's keyed start and a workflow that follows it.
    const resume = createResumeModule(pools.runnerPool, { startRun: advance.advanceStartRun, startFix: advance.advanceStartFix, startAdvance: options.advance?.startAdvance ?? null });
    // D#483 S4-b2b: the claim verifier's sweep. A sandbox repository's run shares the preview's starter (it refuses a queued run). S4-b2c: a cloud-verified
    // repository's run is a runner job and shares the advance module's starter (its wait is the next pass's status read, which credits queued time).
    const verifySweep =
      previewStarter && options.verify
        ? createProposalVerifySweep({ pool: pools.runnerPool, resolveSeat: resolveRunSeat, starter: previewStarter, ...(advanceStarter ? { runnerStarter: advanceStarter } : {}), visibility: repoVisibility, github: options.verify.github, settings: discoverySettings, prompt: options.verify.prompt, record: options.verify.record })
        : async (): Promise<ProposalVerifyCounts> => ({ idle: "not_configured", listed: 0, started: 0, waiting: 0, recorded: 0, daily_limit: 0, daily_cap: 0, skipped: 0, failed: 0 });
    // D#483 S5-k1b: the parked-stage sweep restarts a stage whose workflow gave up waiting for a spending limit, once the limit allows it.
    const stageResume = createStageResume(pools.runnerPool, { resolveRunSeat, startAdvance: options.advance?.startAdvance ?? null, buildWaitReason: options.advance?.buildWaitReason ? (accountId, workItemId) => options.advance!.buildWaitReason!(pools.runnerPool, accountId, workItemId) : null });
    // D#6 R2b-3 (C21 section 4): the run after a lost lease or a usage limit is dispatched through the runner target; a second loss fails the work item through the stage driver.
    const followUp = createFollowUpPorts({ pool: pools.runnerPool, registry, buildFailed: (accountId, workItemId, runId, code) => advance.advanceBuildFailed(accountId, workItemId, runId, code) });
    // D#599 HO-2b: a handoff finishes from the runner's event, from `done`, or from the 30 s sweep. The branch head is read through the continuation base (GitHub), the stage driver parks an item whose move cannot go on, and the
    // child's own start (`dispatchChild`) is the seam PL-2's cross-side job fills; until it is wired a child cannot start, and the handoff fails closed with the work saved on its branch.
    const runHandoffs = createRunHandoffs(pools.runnerPool, {
      ...(options.ports.continuationBase ? { base: options.ports.continuationBase } : {}),
      park: async ({ accountId, workItemId, runId, code }) => {
        await advance.advanceBuildFailed(accountId, workItemId, runId, code);
      },
      onError: (runId) => console.warn(JSON.stringify({ event: "run.handoff_failed", run_id: runId })),
    });
    const runnerClaims = createRunnerClaimFacade(pools.runnerPool, { visibility: repoVisibility, followUp, wakeEnabled, onError: (runId) => console.warn(JSON.stringify({ event: "runner.follow_up_failed", run_id: runId })), onHandedOff: (i) => runHandoffs.completeRunHandoff({ ...i, forced: false }) });
    const runnerDone = createRunnerDoneFacade(pools.runnerPool);
    // D#6 R5a-2b (C27 section 1.6): the ticket key is read here, once. Without it (or without the forward host) the ticket route answers 503 and nothing else changes.
    const gitTicketSigner = loadGitTicketSigner(env);
    const runnerGitTickets = createRunnerGitTicketFacade(pools.runnerPool, { signer: gitTicketSigner, audience: githubProxyForwardUrl(githubForward) });
    // D#598 P1f-2: the public-push token and report routes' database half. Needs no setting of its own.
    const runnerPlanePush = createRunnerPlanePushFacade(pools.runnerPool);
    // D#6 PUBLIC-MERGE PR2b: the merge-order store, over the same login.
    const planeMerge = createRunnerPlaneMergeStore(pools.runnerPool);
    // D#598 P1f-5b: the sandbox publish step and "Try the push again". The pool, the port and the proxy-only policy are the worker's own.
    const planePublish = createPlanePublish(options.ports.planePublish ? { ...options.ports.planePublish, pool: pools.runnerPool, port: sandboxPort, networkPolicy: () => buildPublishFirewallPolicy({ githubForward, lookup: options.lookup }) } : null);
    const runnerLeaseSweep = createRunnerLeaseSweeper(pools.runnerPool, { followUp, onError: (runId) => console.warn(JSON.stringify({ event: "runner.lease_sweep_failed", run_id: runId })) });
    // A publish run is settled by its recorded pp- name and attempt, never by a name derived from the role.
    const publishSettler = createPublishSettler({ pool: pools.runnerPool, port: sandboxPort });
    const runSweepComputeSettle = async (): Promise<ComputeSettleSweepResult & { lost: LostSweepResult; outside: OutsideMeterResult }> => {
      // The lost-run check goes first and spends part of the tick's time; the settle gets what is left of its budget.
      const began = performance.now();
      let lost: LostSweepResult = { listed: 0, young: 0, stale: 0, settled: 0, alive: 0, unknown: 0, failed: 0, skipped: 0 };
      try {
        lost = await sweepLostRuns({ pool: pools.runnerPool, target: { settleIfLost: (run) => (run.role === PLANE_PUBLISH_ROLE ? publishSettler.settleIfLost(run) : sandboxTarget.settleIfLost(run)) }, onError: (runId) => console.warn(JSON.stringify({ event: "run.lost_sweep_failed", run_id: runId })) });
      } catch {
        // fx-swallow-ok: the list itself failed (a fixed-code line is logged); the compute settle below must still run this tick
        console.warn(JSON.stringify({ event: "run.lost_sweep_list_failed" }));
      }
      const left = Math.max(SWEEP_TIME_BUDGET_MS - (performance.now() - began), 0);
      const settled = await sweepComputeSettle({ pool: pools.runnerPool, target: sandboxTarget, timeBudgetMs: left });
      // D#221 OM-2b: the outside meter rides the same tick. It never fails the settle above.
      let outside: OutsideMeterResult = { listed: 0, waiting: 0, read: 0, final: 0, unavailable: 0, failed: 0, skipped: 0 };
      try {
        outside = await sweepOutsideMeter({ pool: pools.runnerPool, modelConnection: targetDeps.modelConnection, decryptTenantKey: targetDeps.decryptTenantKey, flagOn: () => outsideMeterOn(env.FX_OUTSIDE_METER), onError: (runId) => console.warn(JSON.stringify({ event: "run.outside_meter_failed", run_id: runId })), onEscalate: (e) => console.warn(JSON.stringify({ event: "run.outside_meter_needs_owner", run_id: e.runId, kind: e.kind, gateway_usd: e.gatewayUsd, metered_usd: e.meteredUsd })) });
      } catch {
        // fx-swallow-ok: the list itself failed (a fixed-code line is logged); the next tick tries again
        console.warn(JSON.stringify({ event: "run.outside_meter_list_failed" }));
      }
      return { ...settled, lost, outside };
    };
    const runSweepSandboxReap = (input: SweepSandboxReapInput): Promise<SweepSandboxReapResult> =>
      sweepSandboxReap({ pool: pools.runnerPool, port: sandboxPort, stopStray: (run) => sandboxTarget.stopStraySandbox(run) }, input);
    // D#7 DP4b-1: the ask-withdrawal sweep rides the invariant sweep's tick (the same cron, the same cross-tenant shape) on the RECEIPT pool; it never throws, so it cannot fail the invariant result.
    const runInvariantTick = async (): Promise<Awaited<ReturnType<typeof sweepInvariants>>> => {
      const result = await sweepInvariants({ pool: pools.runnerPool, report: reportError, warn: (line) => console.warn(line) });
      await sweepAskWithdrawals({ pool: pools.receiptPool, warn: (line) => console.warn(line) });
      await reconcileResumes({ pool: pools.receiptPool, warn: (line) => console.warn(line) });
      // D#7 DP12a-2: asks whose answer window ended move to overdue or proceeded. Never throws; counts only, no ids or text.
      const ended = await sweepOverdueAsks(pools.receiptPool, SWEEP_REAL_CLOCK);
      if (ended.overdue + ended.proceeded + ended.failed > 0) console.warn(JSON.stringify({ event: "decision.ask_window_sweep", overdue: ended.overdue, proceeded: ended.proceeded, failed: ended.failed }));
      await purgeAap({ pool: pools.receiptPool, ready: pools.aapReady, warn: (line) => console.warn(line) });
      return result;
    };
    const runSandboxInventory = (input: SandboxInventoryInput): Promise<SandboxInventoryResult> => sandboxInventory({ pool: pools.runnerPool, port: sandboxPort }, input);
    return { ...planePublish, ...runActions, ...runnerLeases, ...runnerClaims, ...runnerDone, ...runnerGitTickets, ...runnerPlanePush, ...runnerLeaseSweep, sweepRunHandoffs: runHandoffs.sweepRunHandoffs, sweepParkedStages: stageResume.sweepParkedStages, sweepSetupRequestChecks: (input) => runSetupRequestCheckSweep({ pool: pools.runnerPool, envSource: input.envSource }), approveSubItem: (input) => approveSubItem({ pool: pools.receiptPool, principal: input.principal }, { workItemId: input.workItemId, key: input.key }), answerDecisionAsk: (input) => answerAsk({ pool: pools.receiptPool, principal: input.principal, ...(input.signal ? { signal: input.signal } : {}) }, { askId: input.askId, choice: input.choice }), sweepBranchCleanups: (input) => runBranchCleanupSweep({ pool: pools.runnerPool, signer: gitTicketSigner, github: input.github, ...(input.closePr ? { closePr: input.closePr } : {}) }), sweepPrSlotHolders: (input) => runPrSlotSweep({ pool: pools.runnerPool, openClient: input.github }), reconcilePrHolder: (input) => reconcileHolder(pools.runnerPool, input.github, input.accountId, input.workItemId), planeMerge, withRunnerPool: (fn) => fn(pools.runnerPool), sweepProposalVerification: verifySweep, completeRunHandoff: runHandoffs.completeRunHandoff, completeHandoffOnDone: runHandoffs.completeHandoffOnDone, ...runnerQueue, ...runnerNotices, sweepInvariants: runInvariantTick, ...preview, ...retry, ...advance, ...resume, resolveRunSeat, sweepComputeSettle: runSweepComputeSettle, sweepSandboxReap: runSweepSandboxReap, sandboxInventory: runSandboxInventory, registry, pools, sandboxPort, githubForward, targetDeps, authorCheck, close: () => pools.close() };
  } catch (err) {
    await pools.close();
    throw err;
  }
}

let instance: Promise<Worker> | undefined;

/**
 * The public factory. Safe to call from every route: the first call builds the
 * worker (pools, guards, port, registry) and every later call, concurrent or
 * not, gets the same promise, so a cold route never reopens pools or re-runs
 * the guards. The first call's options win. A failed build is not kept, so the
 * next call tries again. Returns only the registry and `close()`; `close()`
 * also forgets the instance.
 */
export function createWorker(options: CreateWorkerOptions): Promise<Worker> {
  if (instance) return instance;
  const mine: Promise<Worker> = buildWorker(options).then(
    ({ registry, resolveRunSeat, sweepComputeSettle, sweepSandboxReap, sandboxInventory: inventory, close, claimRunAction, settleRunAction, listDueRunActions, purgeRunActions, cancelRun, performCancelRun, performCancelWorkItem, failRunnerLeases, claimRunnerRun, heartbeatRunnerRun, ingestRunnerEvents, beginRunnerDone, finishRunnerDone, gitTicketContext, signGitTicket, planePushGrant, planePushPairing, planePushSettleGrant, planePushReportContext, planePushRecordReport, sweepRunnerLeases, sweepRunHandoffs, completeRunHandoff, completeHandoffOnDone, publishPairedChange, retryPublish, settlePairedBuild, openPublicPullRequest, sweepRunnerQueue, sweepRunnerNotices, sweepInvariants: runInvariants, sweepParkedStages, sweepSetupRequestChecks, answerDecisionAsk, approveSubItem, sweepBranchCleanups, sweepPrSlotHolders, reconcilePrHolder, planeMerge, withRunnerPool, sweepProposalVerification, performStartPreview, previewReady, performRetryRun, performAdvanceWorkItem, performRespecWorkItem, performAmendSpec, performResumeDecision, advanceLoadItem, advanceStartRun, advanceRunOutcome, advanceTriage, advancePanel, advanceSpec, advanceBuild, advanceBuildFailed, advanceDecision, advancePrFound, advanceLightSpec, advanceRespec, advanceLoadReview, advanceLoadSpecText, advanceRecordRound, advanceRecordMergeOnly, advanceStartFix, advanceStartCheckFix, advanceReviewRuns, advanceMergeGate, advanceMergeOrder, advanceVerifiedReviewGate, advanceRecordEvent, advanceCancel, advanceCancelStepRuns }) => {
      let closing: Promise<void> | undefined;
      return {
        registry,
        resolveRunSeat,
        sweepComputeSettle,
        sweepSandboxReap,
        sandboxInventory: inventory,
        claimRunAction,
        settleRunAction,
        listDueRunActions,
        purgeRunActions,
        cancelRun,
        performCancelRun,
        performCancelWorkItem,
        failRunnerLeases,
        claimRunnerRun,
        heartbeatRunnerRun,
        ingestRunnerEvents,
        beginRunnerDone,
        finishRunnerDone,
        gitTicketContext,
        signGitTicket,
        planePushGrant,
        planePushPairing,
        planePushSettleGrant,
        planePushReportContext,
        publishPairedChange,
        retryPublish,
        settlePairedBuild,
        openPublicPullRequest,
        planePushRecordReport,
        sweepRunnerLeases,
        sweepRunHandoffs,
        completeRunHandoff,
        completeHandoffOnDone,
        sweepRunnerQueue,
        sweepRunnerNotices,
        sweepInvariants: runInvariants,
        sweepParkedStages,
        sweepSetupRequestChecks,
        answerDecisionAsk,
        approveSubItem,
        sweepBranchCleanups,
        sweepPrSlotHolders,
        reconcilePrHolder,
        planeMerge,
        withRunnerPool,
        sweepProposalVerification,
        performStartPreview,
        previewReady,
        performRetryRun,
        performAdvanceWorkItem,
        performRespecWorkItem,
        performAmendSpec,
        performResumeDecision,
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
        advanceReviewRuns,
        advanceMergeGate,
        advanceMergeOrder,
        advanceVerifiedReviewGate,
        advanceRecordEvent,
        advanceCancel,
        advanceCancelStepRuns,
        // Once only; and it forgets the instance only while that is still this one,
        // so a stale close() after a rebuild neither clears nor closes the newer worker.
        // A rejected close is not kept: the next call tries again. That is safe because the
        // pools' own close settles every pool end and so does not reject on a second `end()`.
        close: () => {
          if (instance === mine) instance = undefined;
          closing ??= close().catch((err: unknown) => {
            closing = undefined;
            throw err;
          });
          return closing;
        },
      };
    },
    (err: unknown) => {
      if (instance === mine) instance = undefined;
      throw err;
    },
  );
  instance = mine;
  return mine;
}

/** Test-only (not exported from index.ts). */
export function forgetWorkerForTests(): void {
  instance = undefined;
}
