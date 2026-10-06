import { envKekSource, type KekSource } from "@fx/model-connection";
import type { HostLookup } from "@fx/net-guard";
import {
  RunnerTarget,
  createJobIssuer,
  createPgJobContext,
  SandboxTarget,
  SWEEP_TIME_BUDGET_MS,
  unwiredJobIssuer,
  unwiredRepoVisibility,
  sweepComputeSettle,
  sweepLostRuns,
  type LostSweepResult,
  type AuthorCheckProvider,
  configureAgentRunWiring,
  createVercelSandboxPort,
  defaultResolvePayer,
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
import { loadJobSigner } from "./jobSigner.js";
import { createRunActionFacade, type RunActionFacade } from "./runActions.js";
import { createRunnerLeaseFacade, type RunnerLeaseFacade } from "./runnerLeases.js";
import { PREVIEW_ROLE, createPreviewModule, type PreviewFacade, type PreviewSeatSource } from "./preview.js";
import { createRetryModule, type RetryFacade, type RetrySeatSource } from "./retry.js";
import { createAdvanceModule, type AdvanceFacade, type AdvanceModuleDeps } from "./advance.js";
import { createSeatResolver, retrySeatSourceOf, type SeatRequest, type SeatResult } from "./seat.js";
import { createRunStarter, type RunFollower } from "./starter.js";

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
  /** D#483 P1: the stage driver's injected pieces (apps/web owns the workflow and the pipeline). Absent, `advance_work_item` is refused `advance_unavailable`. */
  advance?: Pick<AdvanceModuleDeps, "startAdvance" | "triage" | "panel" | "spec" | "build" | "buildFailed" | "review" | "lightSpec">;
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
export interface Worker extends RunActionFacade, RunnerLeaseFacade, PreviewFacade, RetryFacade, AdvanceFacade {
  registry: ExecutionTargetRegistry;
  /** D#2 H14c-3-2d-2: resolves one run's card, model, limits, sandbox timeout and spend facts, or refuses with a fixed reason. Starts nothing. */
  resolveRunSeat(request: SeatRequest): Promise<SeatResult>;
  /**
   * D#2 COMPUTE-SETTLE CS-2b-2: one tick of the deferred compute settle. Works across tenants like `listDueRunActions`:
   * for the cron only, never callable from a user request. Takes no input and returns counts. The same tick first settles
   * runs that are `running` while their sandbox is gone (`lost`), so a run stopped from outside ends within a few minutes.
   */
  sweepComputeSettle(): Promise<ComputeSettleSweepResult & { lost: LostSweepResult }>;
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
    const jobIssuer = options.ports.jobIssuer ?? (jobSigner ? createJobIssuer({ pool: pools.runnerPool, signer: jobSigner, visibility: repoVisibility, context: createPgJobContext(pools.runnerPool) }) : unwiredJobIssuer);
    const runnerTarget = new RunnerTarget({ pool: pools.runnerPool, issuer: jobIssuer, visibility: repoVisibility });
    const registry: ExecutionTargetRegistry = Object.freeze({ sandbox: guardWorkdir(sandboxTarget), runner_local: guardWorkdir(runnerTarget) });
    // The runner's workflow steps and the follower's bodies reach the pool and the registry through this, never through arguments.
    configureAgentRunWiring({ pool: pools.runnerPool, registry });
    const runActions = createRunActionFacade(pools.runnerPool, registry);
    const runnerLeases = createRunnerLeaseFacade(pools.runnerPool);
    const authorCheck = options.ports.authorCheck ?? (() => null);
    const resolveRunSeat = createSeatResolver({ pool: pools.runnerPool, isOperatorAccount: (accountId) => operatorMode(env, accountId).active });
    // The three pieces a preview needs, wired together: its seat (from the resolver), the production run starter and the prompt builder.
    // Any one missing and `previewReady()` is false.
    const starter = options.ports.follow ? createRunStarter({ pool: pools.runnerPool, registry, follow: options.ports.follow }) : null;
    const preview = createPreviewModule(pools.runnerPool, { seats: previewSeatSourceOf(resolveRunSeat), starter, promptFor: options.previewPrompt ?? null, isOperatorAccount: (accountId) => operatorMode(env, accountId).active });
    const retry = createRetryModule(pools.runnerPool, registry, { seats: options.retrySeats ?? retrySeatSourceOf(resolveRunSeat), authorCheck });
    const advance = createAdvanceModule(pools.runnerPool, { starter, resolveRunSeat, startAdvance: options.advance?.startAdvance ?? null, triage: options.advance?.triage ?? null, panel: options.advance?.panel ?? null, spec: options.advance?.spec ?? null, build: options.advance?.build ?? null, buildFailed: options.advance?.buildFailed ?? null, review: options.advance?.review ?? null, lightSpec: options.advance?.lightSpec ?? null, registry });
    const runSweepComputeSettle = async (): Promise<ComputeSettleSweepResult & { lost: LostSweepResult }> => {
      // The lost-run check goes first and spends part of the tick's time; the settle gets what is left of its budget.
      const began = performance.now();
      let lost: LostSweepResult = { listed: 0, young: 0, stale: 0, settled: 0, alive: 0, unknown: 0, failed: 0, skipped: 0 };
      try {
        lost = await sweepLostRuns({ pool: pools.runnerPool, target: sandboxTarget, onError: (runId) => console.warn(JSON.stringify({ event: "run.lost_sweep_failed", run_id: runId })) });
      } catch {
        // fx-swallow-ok: the list itself failed (a fixed-code line is logged); the compute settle below must still run this tick
        console.warn(JSON.stringify({ event: "run.lost_sweep_list_failed" }));
      }
      const left = Math.max(SWEEP_TIME_BUDGET_MS - (performance.now() - began), 0);
      return { ...(await sweepComputeSettle({ pool: pools.runnerPool, target: sandboxTarget, timeBudgetMs: left })), lost };
    };
    return { ...runActions, ...runnerLeases, ...preview, ...retry, ...advance, resolveRunSeat, sweepComputeSettle: runSweepComputeSettle, registry, pools, sandboxPort, githubForward, targetDeps, authorCheck, close: () => pools.close() };
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
    ({ registry, resolveRunSeat, sweepComputeSettle, close, claimRunAction, settleRunAction, listDueRunActions, purgeRunActions, cancelRun, performCancelRun, performCancelWorkItem, failRunnerLeases, performStartPreview, previewReady, performRetryRun, performAdvanceWorkItem, advanceLoadItem, advanceStartRun, advanceRunOutcome, advanceTriage, advancePanel, advanceSpec, advanceBuild, advanceBuildFailed, advancePrFound, advanceLightSpec, advanceLoadReview, advanceLoadSpecText, advanceRecordRound, advanceStartFix, advanceMergeGate, advanceRecordEvent, advanceCancel }) => {
      let closing: Promise<void> | undefined;
      return {
        registry,
        resolveRunSeat,
        sweepComputeSettle,
        claimRunAction,
        settleRunAction,
        listDueRunActions,
        purgeRunActions,
        cancelRun,
        performCancelRun,
        performCancelWorkItem,
        failRunnerLeases,
        performStartPreview,
        previewReady,
        performRetryRun,
        performAdvanceWorkItem,
        advanceLoadItem,
        advanceStartRun,
        advanceRunOutcome,
        advanceTriage,
        advancePanel,
        advanceSpec,
        advanceBuild,
        advanceBuildFailed,
        advancePrFound,
        advanceLightSpec,
        advanceLoadReview,
        advanceLoadSpecText,
        advanceRecordRound,
        advanceStartFix,
        advanceMergeGate,
        advanceRecordEvent,
        advanceCancel,
        // Once only; and it forgets the instance only while that is still this one,
        // so a stale close() after a rebuild neither clears nor closes the newer worker.
        close: () => {
          if (instance === mine) instance = undefined;
          return (closing ??= close());
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
