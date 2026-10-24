/**
 * What the daemon does with one claimed run: check the job (`verifyJob`), hold the lease, run it through `runJob`, tell the
 * cloud it is done. Nothing is run unless the job is verified. What is sent for a run that does not get to `done` is decided by
 * correction C24 section 1, one case at a time:
 *  - refused (a signature, hash, run id or visibility check) or a repeat of a job id the ledger holds: one `run_ended` (`job_refused`, or
 *    `repo_not_private`) and nothing runs;
 *  - the cloud said stop, or the lease was lost: nothing, as the cloud already ended the run or cannot be reached;
 *  - the daemon is shutting down: one best-effort `run_ended` `runner_shutdown`, given 5 seconds;
 *  - the run failed: the queued events are flushed first, then `run_ended` goes last (never for a credential mismatch);
 *  - the process dies, or `done` is never confirmed: nothing can be sent, and the lease runs out as before.
 * Git path B (D#6 R4a-3) surrounds the run: before it, `git.check` refuses a job it will not push and the fresh workspace is filled from the
 * repo's mirror; after it, the agent's commit is pushed to the run's branch, outside the sandbox, so `done` finds it. A git failure ends the
 * run like any setup failure: a closed code, `run_ended` `runner_setup`.
 * A take-over (D#6 R4a-7) is asked for by the machine's owner through the tmux watch: the agent gets SIGINT, nothing is pushed, one
 * `taken_over` event goes out, and `done` carries no result, so the cloud ends the run `failed` `taken_over`; then the pane is handed over.
 * A handoff (D#599 HO-3) is asked for by the cloud on a heartbeat reply: the agent is stopped the same way, its session is resumed once with the constant
 * checkpoint prompt (`checkpointTurn.ts`), the commit is pushed, and one `run_ended` `handed_off` (`pushed`, `push_failed` or `deadline`) goes out in place
 * of `done`. The note the agent writes stays on this machine.
 */
import { DONE_RETRY_AFTER_SECONDS, LocalOnlyEvent, contextLedgerToWire, type ContextLedgerMeasure, type CheckNotRunReason, type ContextSection, type DoneCheck, type HANDED_OFF_DETAILS, type Job, type JobKeyring, type StopReason } from "@fulcrumaxe/runner-protocol";
import { CHECKPOINT_MAX_TURN_MS, runCheckpointTurn } from "./checkpointTurn.js";
import type { CheckpointNote } from "../job/checkpoint.js";
import type { NixDetail, NixFromDefault, NixResult, NixShellStep, NixSkip, NixSource } from "./nixShell.js";
import type { CheckLaunch, CheckOutcome, CheckRefused, CheckStepInput } from "./checkStep.js";
import { depsDetail, registryHostOf, TEST_ROLES, type DepsDetail } from "../job/depsRegistry.js";
import { repoMapDigest } from "../job/repoMap.js";
import { pinLedgerSections, readJobPins, type JobPinsRead } from "../job/pinFiles.js";
import { SpillRefused, prepareSpill, removeSpill, type SpillHandle } from "../job/spillFiles.js";
import { checkNote, DEPS_FAILED_NOTE, DEPS_INSTALLED_NOTE, DEPS_REGISTRY_NOTE, NIX_FLAKE_CHANGED_NOTE } from "../job/prompt.js";
import type { DepsInstaller } from "./depsInstall.js";
import { NotAPlainSegment, segmentUnder } from "../job/plainSegment.js";
import { cliModelFor, runJob, type JobLedger, type RunJobDeps, type RunJobResult } from "../job/runJob.js";
import { storeKeyOf, type JobAllowanceGrant } from "../sandbox/allowances.js";
import type { SandboxHandle, SandboxPort } from "../sandbox/port.js";
import type { WorkspaceStore } from "../job/workspace.js";
import type { Claimed, RunnerClient } from "./client.js";
import { GitPathError } from "./git.js";
import type { GitPath } from "./gitPath.js";
import type { PlaneBaseLedger, PlanePushOutcome, PlanePushRunEnd } from "./planePush.js";
import type { Published } from "./push.js";
import { clearCliStubs, stubBaseline, type StubBaseline } from "./workspaceStubs.js";
import { startLease, type Clock, type Lease, type LeaseEnd, type EventRelay } from "./lease.js";
import { endOfFailure, endOfRefusal, RUN_ENDED_RETRY_MS, RUN_ENDED_TRIES, runEndedEvent, sendRunEndedAlone, SHUTDOWN_REPORT_MS, type RunEnd } from "./runEnded.js";
import { verifyJob, type JobRefusal } from "./verifyJob.js";
import type { JobWatch, WatchedJob } from "./watch.js";

/** How many times `done` is sent when the cloud cannot reach GitHub or the call fails. */
export const MAX_DONE_ATTEMPTS = 5;
/** The longest wait between two `done` attempts, whatever the cloud asks for: the lease is kept alive meanwhile. */
const MAX_DONE_WAIT_SECONDS = 60;
/** After SIGINT, the agent gets this long to end its turn before its sandbox is stopped. */
export const TAKEOVER_STOP_GRACE_MS = 10_000;
/** The part of a handoff's time kept for the push: the checkpoint turn is cut off this long before the deadline. */
export const HANDOFF_PUSH_MARGIN_MS = 30_000;

export type JobResult =
  | { status: "refused"; reason: JobRefusal }
  | { status: "duplicate" }
  /** The ledger could not record the job's id, so the job was not started; nothing is sent. */
  | { status: "unrecorded" }
  | { status: "stopped"; reason: StopReason | "lease_lost" }
  | { status: "aborted" }
  | { status: "failed"; reason: string }
  | { status: "completed"; outcome: "succeeded" | "failed"; failureReason: string | null; prNumber: number | null }
  | { status: "unconfirmed" }
  /** The run was moved to the other side: `detail` is what `run_ended` said. `note` is the agent's handoff note, kept on this machine (never sent from here). */
  | { status: "handed_off"; detail: (typeof HANDED_OFF_DETAILS)[number]; note?: CheckpointNote };

export interface JobHandlerDeps {
  client: RunnerClient;
  /** The public keys job signatures are checked against, pinned by the caller. */
  keyring: JobKeyring;
  clock: Clock;
  /** Everything `runJob` needs except the ledger and the sandbox, which the handler supplies. */
  run: Omit<RunJobDeps, "sandbox" | "ledger">;
  sandbox: SandboxPort;
  ledger: JobLedger;
  /** Git path B: the mirror, the workspace and the push. */
  git: GitPath;
  /**
   * D#598 P1f-3: the run-end hook for a repository paired with a public repository. `baseLedger` takes the commit a fresh executor run starts from before the agent
   * starts (this handler writes it, from the path's own answer, never from the checkout); `run` is called once, after the run's private branch was pushed and
   * before `done`. Absent: no executor run enters a hook, as before. A run on a repository that is not paired is told so by the cloud and goes on unchanged.
   */
  planePush?: { baseLedger: PlaneBaseLedger; run: (input: PlanePushRunEnd) => Promise<PlanePushOutcome> };
  /** Git path A (cloud-verified, D#6 R5a-3). Absent when this build pins no GitHub relay for the cloud: a `verified` job then ends `git_proxy_unpinned`. */
  gitA?: GitPath;
  events: EventRelay;
  /** Writes the local session index the next fix round reads (the engine's own recorder, bound to its file). */
  recordSession: (sessionId: string, workspace: string) => Promise<void>;
  /** Aborts when the daemon is asked to stop. */
  shutdown?: AbortSignal;
  /** Called when a job is about to start, before any mirror or sandbox: an `api_key` runner reads its key file here. A closed failure code ends the run `runner_setup`; undefined goes on. */
  credentialsReady?: () => string | undefined;
  /** D#6 R7c: builds a repo's Nix dev shell before a job that carries allowances. Absent (no `nix` on this machine, or none wired): no job gets one. */
  nix?: NixShellStep;
  /** Told the closed detail when the dev shell step is skipped. */
  onNixSkip?: (skip: NixSkip) => void;
  /** Told the closed detail when the dev shell came from the default branch's merge-base instead of the job's own commit. */
  onNixDetail?: (detail: NixDetail) => void;
  /** D#6 C44-4: told the closed detail when the repo has a lockfile and the job allows no npm registry host. The job still runs. */
  onDepsDetail?: (detail: DepsDetail) => void;
  /** D#600 CX-3b: told a closed word when a job that would get a repository map does not (`no_mirror`: this git path has no mirror to read; `unavailable`: the mirror could not give the tree). The job still runs. */
  onRepoMapSkip?: (reason: "no_mirror" | "unavailable") => void;
  /** D#6 C44-4 (G-C44-7): the host-side dependency install, run before the agent's sandbox starts for a test-running role with an allowed npm registry. Absent: no install is done. */
  depsInstall?: DepsInstaller;
  /** The directory of the per-repo package stores (the host sandbox's `packageStoreRoot`); the install uses the job's own store in it. Absent: no install is done. */
  packageStoreRoot?: string;
  /**
   * D#600 CX-4b: the directory the per-run spill directories are made under (a sibling of the workspaces; `cacheRootsFor`). Never taken from a job. Absent: a job that carries a spill
   * ends `context_spill_unwritable` instead of starting with a marker that leads nowhere.
   */
  spillRoot?: string;
  /** Replaceable so a test can count the calls. */
  runJobFn?: typeof runJob;
  heartbeatMs?: number;
  flushMs?: number;
  /** The lease's short flush while an activity or stage event waits (default 2 s). */
  activityFlushMs?: number;
  doneAttempts?: number;
  /**
   * D#6 R-CHK-2: the check step (`checkStep.ts`), how to start its argument vector under the sandbox's rules (`HostSandbox.checkLaunch`), the content of a file at the job's start
   * commit, and the home directory to hide in the output. A job that carries a check while any of the first three is absent fails its check: it is never passed by default.
   */
  checkStep?: (input: CheckStepInput) => Promise<CheckOutcome>;
  checkLaunch?: (handle: SandboxHandle, argv: readonly string[], devShell: boolean) => CheckLaunch | CheckRefused | undefined;
  baseFile?: CheckStepInput["baseFile"];
  checkHome?: string;
  /** The tmux watch and take-over (R4a-7). Absent: no watch. */
  watch?: JobWatch;
  /** Sends the agent in a sandbox SIGINT, which ends its turn cleanly. Required for a take-over to stop the agent. */
  interrupt?: (handle: SandboxHandle) => void | Promise<void>;
  /** The session a run was in, from its local transcript. A handoff resumes it; without this (and without a session in the run's result) no checkpoint turn runs. */
  sessionOfRun?: (runId: string) => string | undefined;
}

/** What the handler knows of the sandbox it made for the run. */
interface HeldSandbox {
  handle?: SandboxHandle;
}

/** A port whose every start carries these read grants (git path B: the repo mirror's `objects` directory). The host sandbox's builder checks each one again. */
function withReadGrants(port: SandboxPort, paths: readonly string[]): SandboxPort {
  const grant = <T extends { extraReadPaths?: readonly string[] | undefined }>(opts: T): T => ({ ...opts, extraReadPaths: [...(opts.extraReadPaths ?? []), ...paths] });
  return {
    ...port,
    startDetached: (handle, opts) => port.startDetached(handle, grant(opts)),
    resume: (handle, sessionId, prompt, opts) => port.resume(handle, sessionId, prompt, grant(opts)),
  };
}

/** A port whose every start carries this job's signed sandbox allowances (D#6 R7b). The host sandbox checks the floor again and applies them. */
export function withAllowances(port: SandboxPort, grant: JobAllowanceGrant): SandboxPort {
  return {
    ...port,
    startDetached: (handle, opts) => port.startDetached(handle, { ...opts, allowances: grant }),
    resume: (handle, sessionId, prompt, opts) => port.resume(handle, sessionId, prompt, { ...opts, allowances: grant }),
  };
}

/**
 * D#600 CX-5c: a port whose every `startDetached` and `resume` carries this job's excluded paths, whatever the caller built, so the settings file written before each
 * agent command holds the deny entries. The checkpoint turn of a handoff builds its own resume options; without this it would rewrite the file with the floor only, and the
 * resumed session (and a later take-over, which reuses that file) could read excluded paths and use Grep and Glob. A job without excludes gets the port unchanged.
 */
export function withExcludes(port: SandboxPort, excludes: readonly string[] | undefined): SandboxPort {
  if (excludes === undefined || excludes.length === 0) return port;
  const carry = <T extends object>(opts: T): T => ({ ...opts, excludes });
  return {
    ...port,
    startDetached: (handle, opts) => port.startDetached(handle, carry(opts)),
    resume: (handle, sessionId, prompt, opts) => port.resume(handle, sessionId, prompt, carry(opts)),
  };
}

/**
 * D#600 CX-4b: a port whose every start and resume carries this run's spill directory: as a read-only grant of the shell sandbox (`extraReadPaths`, checked again by the host
 * sandbox's builder against its runner-owned roots) and as the one extra place the agent's file tools may read.
 */
export function withSpillDir(port: SandboxPort, dir: string | undefined): SandboxPort {
  if (dir === undefined) return port;
  const carry = <T extends { extraReadPaths?: readonly string[] | undefined }>(opts: T): T => ({ ...opts, extraReadPaths: [...(opts.extraReadPaths ?? []), dir], spillDir: dir });
  return {
    ...port,
    startDetached: (handle, opts) => port.startDetached(handle, carry(opts)),
    resume: (handle, sessionId, prompt, opts) => port.resume(handle, sessionId, prompt, carry(opts)),
  };
}

/** A port whose sandbox is stopped as soon as `signal` aborts, which ends the agent and so the run. */
function stopOnAbort(port: SandboxPort, signal: AbortSignal, held: HeldSandbox): SandboxPort {
  const gone = new Map<string, () => void>();
  return {
    ...port,
    async createSandbox(opts) {
      const handle = await port.createSandbox(opts);
      held.handle = handle;
      const stop = (): void => {
        void port.stop(handle).catch(() => undefined);
      };
      if (signal.aborted) stop();
      else {
        signal.addEventListener("abort", stop, { once: true });
        gone.set(handle.sandboxName, () => signal.removeEventListener("abort", stop));
      }
      return handle;
    },
    // Once the run has deleted its sandbox there is nothing left to stop: a stop reply that arrives later (while a handoff's checkpoint turn
    // or the final report is in flight) must not reach it again.
    async deleteSandbox(handle, opts) {
      gone.get(handle.sandboxName)?.();
      gone.delete(handle.sandboxName);
      return port.deleteSandbox(handle, opts);
    },
  };
}

/** Stands in for path A on a build with no pinned relay: the first step refuses, so no git runs. */
const UNPINNED_PATH: GitPath = {
  check: () => {
    throw new GitPathError("git_proxy_unpinned");
  },
  resume: () => Promise.reject(new GitPathError("git_proxy_unpinned")),
  prepare: () => Promise.reject(new GitPathError("git_proxy_unpinned")),
  publish: () => Promise.reject(new GitPathError("git_proxy_unpinned")),
  readGrants: () => [],
};

/** The relay's 409 or 401: the cloud has ended or fenced the run, so nothing is reported (as for any stop reply). */
const isGitStop = (code: string): boolean => code === "git_stopped" || code === "git_revoked";

/** The runs that enter the public-push hook: a fresh executor run. A fix round updates a branch that already exists (a later change), and no other role pushes. */
const enters = (job: Job): boolean => job.role === "executor" && job.continues === null && (job.review ?? null) === null;

/**
 * The commit the run's public publish diffs from, recorded in the daemon's own memory before the agent can run. A fresh executor run: the commit it starts from. A fix round that carries
 * a signed `continues.base_sha`: that commit, which the cloud chose when it brought the branch up to date with its base. The checkout and the agent never pick it. Nothing else records one.
 */
const planeBaseOf = (job: Job, startedAt: string): string | undefined => (enters(job) ? startedAt : job.continues?.base_sha);

const closedCheck = (summary = "", reason?: CheckNotRunReason, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ passed: false, body: { exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary, ...(reason === undefined ? {} : { reason }) }, ...extra });

export function createJobHandler(deps: JobHandlerDeps): (claimed: Claimed) => Promise<JobResult> {
  const run = deps.runJobFn ?? runJob;
  const attempts = deps.doneAttempts ?? MAX_DONE_ATTEMPTS;

  const never = new AbortController().signal;

  /**
   * Builds the repo's dev shell outside the sandbox and hands its filtered environment to the job's grant (D#6 R7c). Called only for a job that carries
   * allowances. A fix round, and any commit that is not in the default branch's history, is skipped with a closed detail; so is every failure.
   */
  async function prepareNix(job: Job, git: GitPath, grant: JobAllowanceGrant, base: string, notes: string[]): Promise<void> {
    if (deps.nix === undefined) return;
    let result: NixResult;
    let fromDefault: NixFromDefault | undefined;
    try {
      const source: NixSource = git.nixSource === undefined ? { kind: "not_default_branch" } : await git.nixSource(job, base);
      if (source.kind === "flake") fromDefault = source.fromDefault;
      // A commit outside the default branch is built from its merge-base (D#6 C43-1); the job's own commit is never named to nix.
      result = await deps.nix.prepare({ approved: true, sha: fromDefault?.rev ?? base, source });
    } catch {
      // fx-swallow-ok: the step fails closed to "no dev shell"; the error text could hold a path
      result = { ok: false, skip: "nix_failed" };
    }
    if (!result.ok) return deps.onNixSkip?.(result.skip);
    grant.nixEnv = result.env;
    if (fromDefault === undefined) return;
    deps.onNixDetail?.("nix_from_default_branch");
    if (fromDefault.flakeChanged) {
      deps.onNixDetail?.("nix_flake_changed");
      notes.push(NIX_FLAKE_CHANGED_NOTE);
    }
  }

  /**
   * D#600 CX-3b. A first run of an executor gets the repository map of the commit it starts from, built here from the repo's mirror and carried in the
   * prompt; a fix round, a review and every other role get none (as on the cloud side). Every failure leaves the run without a map: it is never a
   * reason to refuse or delay a run. Nothing of the map leaves this machine but its byte count and sha256, in the ledger's `map` section.
   */
  async function prepareMap(job: Job, git: GitPath, base: string, held: { map?: { version: string; text: string } }): Promise<void> {
    if (job.role !== "executor" || job.continues !== null) return;
    if (git.repoMap === undefined) return deps.onRepoMapSkip?.("no_mirror");
    let map: { version: string; text: string } | null = null;
    try {
      map = await git.repoMap(job, base);
    } catch {
      // fx-swallow-ok: a map that cannot be built is left out; the error text could hold a path
      map = null;
    }
    if (map === null) return deps.onRepoMapSkip?.("unavailable");
    held.map = map;
  }

  /**
   * D#6 C44-4. A test-running role in a repo with a lockfile: with no npm registry host in the job's domains the job still runs with one fixed line (the install
   * cannot download); with one, the runner installs on the host before the agent starts (`depsInstall.ts`, no repo code), marks `deps_installed` or
   * `deps_install_failed`, and the agent gets one fixed line. Neither outcome fails the run.
   */
  async function prepareDeps(job: Job, workspace: string, notes: string[], signal: AbortSignal, mark: (stage: "deps_installed" | "deps_install_failed") => void): Promise<void> {
    const domains = (job.sandbox_allowances?.entries ?? []).filter((entry) => entry.kind === "domain").map((entry) => entry.value);
    const registryHost = registryHostOf(domains);
    if (registryHost === undefined) {
      const detail = depsDetail({ role: job.role, workspace, domains });
      if (detail === undefined) return;
      deps.onDepsDetail?.(detail);
      notes.push(DEPS_REGISTRY_NOTE);
      return;
    }
    if (deps.depsInstall === undefined || deps.packageStoreRoot === undefined || !TEST_ROLES.has(job.role)) return;
    let storeDir: string;
    try {
      storeDir = segmentUnder(deps.packageStoreRoot, storeKeyOf(job.repo));
    } catch (error) {
      // The sandbox refuses a job whose repo id is not one plain segment (`sandbox_allowance_forbidden`); nothing is installed for it.
      if (error instanceof NotAPlainSegment) return;
      throw error;
    }
    const outcome = await deps.depsInstall.run({ workspace, registryHost, storeDir, signal });
    if (outcome.kind === "none") return;
    if (outcome.kind === "refused") deps.onDepsDetail?.("deps_lockfile_refused");
    mark(outcome.kind === "installed" ? "deps_installed" : "deps_install_failed");
    notes.push(outcome.kind === "installed" ? DEPS_INSTALLED_NOTE : DEPS_FAILED_NOTE);
  }

  /** A refusal made before anything is held: the one event is the only thing this run sends. */
  async function refuse(claimed: Claimed, reason: JobRefusal): Promise<JobResult> {
    await sendRunEndedAlone(deps.client, deps.clock, claimed, endOfRefusal(reason), deps.shutdown ?? never);
    return { status: "refused", reason };
  }

  /** Queues `run_ended` after everything else the run sent, and sends it: up to three tries while the lease holds. */
  async function reportEnd(lease: Lease, end: RunEnd): Promise<void> {
    lease.push(runEndedEvent((lease.highestSeq() ?? -1) + 1, deps.clock.now(), end));
    for (let attempt = 1; attempt <= RUN_ENDED_TRIES; attempt++) {
      await lease.flush();
      if (lease.ended() !== undefined || lease.pending() === 0) return;
      if (attempt < RUN_ENDED_TRIES) await deps.clock.sleep(RUN_ENDED_RETRY_MS * attempt, deps.shutdown ?? never);
    }
  }

  /**
   * One attempt, given `SHUTDOWN_REPORT_MS`. A reply that comes later is not waited for (the answer is `false`, and the caller closes the
   * lease without waiting for the send); the lease path covers a report that was lost.
   */
  async function reportShutdown(lease: Lease): Promise<boolean> {
    lease.push(runEndedEvent((lease.highestSeq() ?? -1) + 1, deps.clock.now(), { reason: "runner_shutdown" }));
    const limit = new AbortController();
    const finished = await Promise.race([lease.flush().then(() => true), deps.clock.sleep(SHUTDOWN_REPORT_MS, limit.signal).then(() => false)]);
    limit.abort();
    return finished;
  }

  return async (claimed) => {
    const verified = verifyJob(claimed.signedJob, deps.keyring, deps.clock.now());
    if (!verified.ok) return refuse(claimed, verified.reason);
    const job = verified.job;
    // The signed job's own mode picks the path (C27 section 4.1); nothing on this machine can change it.
    const git: GitPath = job.mode === "verified" ? deps.gitA ?? UNPINNED_PATH : deps.git;
    // The reply's own run id must be the signed job's. The reply schema checks it as well; this is the second check.
    if (job.run_id !== claimed.runId) return refuse(claimed, "run_id_mismatch");

    const held: HeldSandbox = {};
    const ran = new AbortController();
    let takeoverOpen = true;
    let tookOver = false;
    /** Set when the cloud asks for the run to move (a heartbeat reply's `handoff`); ignored once the agent's run has ended. */
    let handoff: { deadline: Date } | undefined;
    // The first heartbeat and the first events batch are an interval away, so a run that is refused or repeated at once sends neither.
    const lease = startLease({ onHandoff: (deadline) => {
      if (!takeoverOpen || tookOver || handoff !== undefined) return;
      handoff = { deadline };
      void interruptAgent();
    }, client: deps.client, clock: deps.clock, runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }), ...(deps.flushMs === undefined ? {} : { flushMs: deps.flushMs }), ...(deps.activityFlushMs === undefined ? {} : { activityFlushMs: deps.activityFlushMs }) });
    const stopRun = deps.shutdown === undefined ? lease.signal : AbortSignal.any([lease.signal, deps.shutdown]);
    // One run, one `seq` line: the engine numbers its events from 0 on each start and the stage marks below are made here, so every event is
    // renumbered as it is queued (a stage mark sent before the engine starts would otherwise share its numbers).
    const next = (): number => (lease.highestSeq() ?? -1) + 1;
    const detach = deps.events.attach(claimed.runId, (event) => lease.push({ ...event, seq: next() }));
    const mark = (stage: "workspace_ready" | "cloned" | "deps_installed" | "deps_install_failed"): void => lease.push({ seq: next(), ts: deps.clock.now().toISOString(), type: "stage", stage });
    let abandonSend = false;
    let usedPort: SandboxPort = deps.sandbox;
    const watched = await deps.watch?.begin({ runId: claimed.runId, role: job.role, repo: `${job.repo.owner}/${job.repo.name}`, started: deps.clock.now() });
    watched?.onTakeOver(() => {
      if (!takeoverOpen) return;
      tookOver = true;
      void interruptAgent();
    });
    /**
     * SIGINT now (after the sandbox exists, if the request came first); if the agent has not ended its turn within the grace, its sandbox is stopped.
     * A take-over waits a bounded time for the sandbox; a handoff waits until the sandbox exists or the run ends, because its request arrives once
     * and setup (clone, deps, Nix shell) can take longer than any fixed wait.
     */
    async function interruptAgent(): Promise<void> {
      for (let waited = 0; held.handle === undefined && (handoff !== undefined || waited < 40) && !ran.signal.aborted; waited++) await deps.clock.sleep(250, ran.signal);
      const handle = held.handle;
      if (handle === undefined) return;
      await Promise.resolve(deps.interrupt?.(handle)).catch(() => undefined);
      await deps.clock.sleep(TAKEOVER_STOP_GRACE_MS, ran.signal);
      if (!ran.signal.aborted) await deps.sandbox.stop(handle).catch(() => undefined);
    }
    let spillHeld: SpillHandle | undefined;
    /**
     * D#600 CX-4b: writes the job's spill files before anything else starts (no mirror fetch, no sandbox) and keeps the handle. True when the job has a spill and it could not be
     * made: with no spill root, a damaged root, a file that could not be written, or a marker with no text behind it. The run then ends and the agent never sees a dangling marker.
     */
    const spillFails = (): boolean => {
      if (job.spill === undefined) return false;
      try {
        if (deps.spillRoot === undefined) throw new SpillRefused();
        spillHeld = prepareSpill(deps.spillRoot, job.run_id, job.spill, job.task.prompt);
        return false;
      } catch (error) {
        if (!(error instanceof SpillRefused)) throw error;
        return true;
      }
    };
    try {
      const started: { base?: string } = {};
      const promptNotes: string[] = [];
      if (job.check !== undefined) promptNotes.push(checkNote(job.check, job.role));
      const checkHeld: { outcome?: CheckOutcome } = {};
      const repoMapHeld: { map?: { version: string; text: string } } = {};
      const pinsHeld: { read?: JobPinsRead } = {};
      // D#6 RUNNER-CWD-1: what the workspace held right before the agent started, so the CLI's placeholders made during the run can be cleared before the check and the publish.
      let stubsBefore: StubBaseline | undefined;
      const clearStubs = (workspace: string): void => {
        if (stubsBefore !== undefined) clearCliStubs(workspace, stubsBefore);
      };
      let result: RunJobResult;
      let notReady: string | undefined;
      try {
        // An id the price table lacks is refused first, so a fix round with a bad hint starts no process, mirror fetch or ticketed session.
        // `runJob` keeps its own check for callers that do not come through here.
        if (cliModelFor(job, deps.run.defaultModel) === undefined) result = { status: "failed", reason: "model_unsupported" };
        else if ((notReady = deps.credentialsReady?.()) !== undefined) result = { status: "failed", reason: notReady };
        else if (spillFails()) result = { status: "failed", reason: "context_spill_unwritable" };
        else {
          git.check(job, claimed);
          // A fix round resumes its kept session only when that workspace is exactly at the branch's tip after a fresh mirror sync; any other
          // workspace is left unused and the run starts fresh on the tip (C25 section 1.4). The decision is made here, before the run starts.
          const grant: JobAllowanceGrant | undefined = job.sandbox_allowances === undefined ? undefined : { entries: job.sandbox_allowances.entries, commandTimeoutS: job.sandbox_allowances.command_timeout_s, storeKey: storeKeyOf(job.repo) };
          let planSession = deps.run.planSession;
          const wanted = job.continues === null ? undefined : deps.run.planSession(job.continues);
          if (job.continues !== null && wanted?.kind === "resume" && deps.run.workspaces.owns(wanted.workspace)) {
            const resumed = await git.resume(job, claimed, wanted.workspace);
            if (resumed !== null) {
              started.base = resumed.base;
              const resumedBase = planeBaseOf(job, resumed.base);
              if (deps.planePush !== undefined && resumedBase !== undefined) deps.planePush.baseLedger.record(claimed.runId, resumedBase);
              mark("workspace_ready");
              mark("cloned");
              // The resumed session gets the same dev shell a fresh start would (same step, same skips), built at the resumed head.
              if (grant !== undefined) await prepareNix(job, git, grant, resumed.base, promptNotes);
              await prepareDeps(job, wanted.workspace, promptNotes, stopRun, mark);
              stubsBefore = stubBaseline(wanted.workspace);
            }
            else {
              const fresh = { kind: "fresh", branch: job.continues.branch } as const;
              planSession = () => fresh;
            }
          }
          const fill = async (workspace: string): Promise<void> => {
            // The job is verified, the sandbox gate has passed and the workspace directory exists; the mirror checkout comes next.
            mark("workspace_ready");
            started.base = (await git.prepare(job, claimed, workspace)).base;
            // The start commit is recorded here, in the daemon's own memory, before the agent can run: the run-end hook reads this and never the checkout.
            const planeBase = planeBaseOf(job, started.base);
            if (deps.planePush !== undefined && planeBase !== undefined) deps.planePush.baseLedger.record(claimed.runId, planeBase);
            mark("cloned");
            await prepareMap(job, git, started.base, repoMapHeld);
            // D#600 CX-5c2: the job's pins, read from the checkout just made (at the start commit) before the agent can touch it. Never a reason to refuse the run.
            pinsHeld.read = await readJobPins(job, workspace);
            // D#6 R7c: the repo's Nix dev shell, only for a job with signed, approved allowances. A skip or a failure leaves the job without one.
            if (grant !== undefined) await prepareNix(job, git, grant, started.base, promptNotes);
            await prepareDeps(job, workspace, promptNotes, stopRun, mark);
            stubsBefore = stubBaseline(workspace);
          };
          const granted = withReadGrants(deps.sandbox, git.readGrants(job));
          const withGrants = grant === undefined ? granted : withAllowances(granted, grant);
          const allowed = withSpillDir(withExcludes(withGrants, job.excludes), spillHeld?.dir);
          usedPort = allowed;
          const afterAgent = async (sandboxHandle: SandboxHandle, workspace: string): Promise<void> => {
            // Before the check's before-and-after comparison of the protected files, so a placeholder is neither checked nor reported as a change.
            clearStubs(workspace);
            const check = job.check;
            if (check === undefined) return;
            const closed = closedCheck;
            // A check that needs the dev shell is not run without one, and never passes by default.
            if (check.dev_shell && grant?.nixEnv === undefined) {
              checkHeld.outcome = closed("", undefined, { noDevShell: true });
              return;
            }
            const { checkStep, checkLaunch, baseFile } = deps;
            if (checkStep === undefined || checkLaunch === undefined || baseFile === undefined || started.base === undefined) {
              checkHeld.outcome = closed("the check was not run: it is not set up on this runner", "not_set_up");
              return;
            }
            // The files the check names are pinned to the merge-base of the branch tip with the default branch, read from the runner's mirror; without one the check fails.
            const mirror = git.mirrorDir?.(job);
            const pin = mirror === undefined ? null : await git.checkBase?.(job, started.base).catch(() => null);
            if (mirror === undefined || pin === null || pin === undefined) {
              checkHeld.outcome = closed("the check was not run: the default branch's copy of its files could not be found", "base_missing");
              return;
            }
            try {
              checkHeld.outcome = await checkStep({ check, workspace, base: pin, baseDir: mirror, launch: (argv, devShell) => checkLaunch(sandboxHandle, argv, devShell), baseFile, home: deps.checkHome, signal: stopRun });
            } catch {
              // fx-swallow-ok: a check step that threw did not pass; the error text could hold a path
              checkHeld.outcome = closed("the check was not run: it is not set up on this runner", "not_set_up");
            }
          };
          result = await run(job, { ...deps.run, afterAgent, promptNotes: () => promptNotes, repoMap: () => repoMapHeld.map, pinned: () => pinsHeld.read?.items, ...(spillHeld === undefined ? {} : { taskPrompt: spillHeld.rewrite }), planSession, workspaces: filledWith(deps.run.workspaces, fill), sandbox: stopOnAbort(allowed, stopRun, held), ledger: deps.ledger });
        }
      } catch (error) {
        // The workspace could not be made, or the job is not one this path pushes. Only the closed code is kept: an error text could hold a path or a remote.
        if (!(error instanceof GitPathError)) throw error;
        result = { status: "failed", reason: error.code };
      }
      if (result.status === "duplicate") {
        // A ledger that refused because it could not record the id (damaged file, failed write) has not seen this job before, so it is
        // not a repeat: nothing is sent, and the lease path decides, as it did before the report existed.
        if (deps.ledger.has?.(job.job_id) === false) return { status: "unrecorded" };
        await reportEnd(lease, endOfRefusal("duplicate_job"));
        return { status: "duplicate" };
      }
      if (result.status === "refused") {
        await reportEnd(lease, endOfRefusal(result.reasons[0]!));
        return { status: "refused", reason: result.reasons[0]! };
      }
      takeoverOpen = false;
      ran.abort();
      // The owner took the run over: no push, no result. The sandbox is down already (runJob stops it), so only the record is left to send.
      if (tookOver && watched !== undefined && (result.status === "done" || result.status === "failed")) return await recordTakeover(claimed, lease, watched, result.status === "done" ? result.sessionId : undefined);
      const ended = lease.ended();
      if (ended !== undefined) return stoppedBy(ended);
      if (stopRun.aborted) {
        abandonSend = !(await reportShutdown(lease));
        return { status: "aborted" };
      }
      // The cloud asked for the run to move and the agent has been stopped: checkpoint, push, and say `handed_off`. A run that never got a workspace
      // and a base (a setup failure) has nothing to hand off and is reported as the failure it is.
      if (handoff !== undefined && result.workspace !== undefined && started.base !== undefined) {
        const handed = await handOff({ claimed, job, lease, git, sandbox: usedPort, stopRun, workspace: result.workspace, base: started.base, sessionId: result.status === "done" ? result.sessionId : undefined, deadline: handoff.deadline, clearStubs });
        if (handed.status === "aborted") abandonSend = !(await reportShutdown(lease));
        return handed;
      }
      if (result.status === "failed") {
        // The events the run queued go first, so `run_ended` is the last thing the cloud hears. A stop on that flush ends the report.
        await lease.flush();
        const stopped = lease.ended();
        if (stopped !== undefined) return stoppedBy(stopped);
        if (isGitStop(result.reason)) return { status: "stopped", reason: "lease_lost" };
        // A credential mismatch ends the run on its own event; the engine has queued it, so nothing more is sent for it.
        const end = lease.saw("credential_mismatch") ? null : endOfFailure(result.reason);
        if (end !== null) await reportEnd(lease, end);
        return { status: "failed", reason: result.reason };
      }
      let published: Published = { pushed: false };
      try {
        if (started.base === undefined) throw new GitPathError("push_failed");
        clearStubs(result.workspace);
        published = await git.publish(job, claimed, result.workspace, started.base, () => lease.ended() !== undefined);
      } catch (error) {
        if (!(error instanceof GitPathError)) throw error;
        await lease.flush();
        const stopped = lease.ended();
        if (stopped !== undefined) return stoppedBy(stopped);
        if (isGitStop(error.code)) return { status: "stopped", reason: "lease_lost" };
        await reportEnd(lease, endOfFailure(error.code, error.sizeMb)!);
        return { status: "failed", reason: error.code };
      }
      // A check that did not pass: the branch is on the run branch for the fix round (pushed above), the public-push hook is not entered, and the run ends `check_failed`.
      // `done` still goes, carrying the check result, so the cloud records what ran (the run is already ended by `run_ended`, which the cloud may answer with a stop).
      // A job with a check always has an outcome here; if the hook never recorded one, that is a failure, not a pass.
      // What the runner knows about the context it loaded, for the ledger: the repository map's size and hash, and the pinned files' sections and reasons. The same on every way a run ends.
      const ledgerSections = (): ContextSection[] => [...(repoMapHeld.map === undefined ? [] : [{ code: "map" as const, ...repoMapDigest(repoMapHeld.map.text), trimmed_bytes: 0 }]), ...(pinsHeld.read === undefined ? [] : pinLedgerSections(pinsHeld.read))];
      const checked = checkHeld.outcome ?? (job.check === undefined ? undefined : closedCheck("the check was not run", "other"));
      if (checked !== undefined && !checked.passed) {
        await lease.flush();
        const stoppedAtCheck = lease.ended();
        if (stoppedAtCheck !== undefined) return stoppedBy(stoppedAtCheck);
        await reportEnd(lease, { reason: "check_failed", ...(checked.noDevShell === true ? { detail: "check_no_dev_shell" as const } : {}) });
        const sentFailed = await sendDone(claimed, result, lease, ledgerSections(), checked.body);
        if (sentFailed.status === "aborted") abandonSend = !(await reportShutdown(lease));
        return sentFailed;
      }
      // The run-end hook for a paired repository (D#598 P1f-3). Its calls need the live lease, so it runs before `done`. It never fails the run: an
      // unexpected error is the closed outcome `failed`, and a cloud that ended the run ends this one too.
      const mirrorDir = deps.planePush !== undefined && enters(job) ? git.mirrorDir?.(job) : undefined;
      // A run the cloud has already ended, or a daemon that is shutting down, asks for nothing: the hook's first call would be a token request.
      if (deps.planePush !== undefined && mirrorDir !== undefined && lease.ended() === undefined && !stopRun.aborted) {
        const outcome = await deps.planePush
          .run({ runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, repo: { owner: job.repo.owner, name: job.repo.name }, mirrorDir, privateHead: published.pushed ? published.sha : undefined, signal: stopRun })
          .catch((): PlanePushOutcome => ({ kind: "failed" }));
        if (outcome.kind === "stopped") return { status: "stopped", reason: outcome.reason };
      }
      await lease.flush();
      // A stop reply (to anything sent so far, the flush included) ends the run: `done` is not sent for it.
      const stoppedAfterPush = lease.ended();
      if (stoppedAfterPush !== undefined) return stoppedBy(stoppedAfterPush);
      const sent = await sendDone(claimed, result, lease, ledgerSections(), checked?.body);
      if (sent.status === "aborted") abandonSend = !(await reportShutdown(lease));
      return sent;
    } finally {
      ran.abort();
      detach();
      // The run's spill files go with the run, on every way out; a directory that is not the one made is left alone.
      if (spillHeld !== undefined) try { removeSpill(spillHeld); } catch { /* fx-swallow-ok: a refused or failed removal leaves the daemon's own directory, cleared the next time this run id is seen */ }
      deps.planePush?.baseLedger.forget(claimed.runId);
      await lease.close({ abandon: abandonSend });
      await watched?.finish();
    }
  };

  /**
   * The handoff (D#599 HO-3). The agent is already stopped. One resume with the constant checkpoint prompt, cut off `HANDOFF_PUSH_MARGIN_MS` before the
   * deadline; then the push; then one `run_ended` `handed_off`: `pushed`, `push_failed` (the push was refused or failed) or `deadline` (no time was left
   * to push). Past the deadline the cloud has fenced this side, so nothing is pushed then. Nothing from the note is sent.
   */
  async function handOff(input: { claimed: Claimed; job: Job; lease: Lease; git: GitPath; sandbox: SandboxPort; stopRun: AbortSignal; workspace: string; base: string; sessionId: string | undefined; deadline: Date; clearStubs: (workspace: string) => void }): Promise<JobResult> {
    const { claimed, job, lease, deadline } = input;
    const sessionId = input.sessionId ?? deps.sessionOfRun?.(claimed.runId);
    const turnMs = Math.min(deadline.getTime() - deps.clock.now().getTime() - HANDOFF_PUSH_MARGIN_MS, CHECKPOINT_MAX_TURN_MS);
    let note: CheckpointNote | undefined;
    if (sessionId !== undefined && turnMs > 0) {
      const limit = new AbortController();
      void deps.clock.sleep(turnMs, limit.signal).then(() => limit.abort());
      try {
        note = (await runCheckpointTurn({ job, sandbox: input.sandbox, credentials: deps.run.credentials, envOptions: deps.run.envOptions, defaultModel: deps.run.defaultModel, workspace: input.workspace, sessionId, signal: AbortSignal.any([input.stopRun, limit.signal]), limitMs: turnMs })).note;
      } finally {
        limit.abort();
      }
    }
    const stoppedAfterTurn = lease.ended();
    if (stoppedAfterTurn !== undefined) return stoppedBy(stoppedAfterTurn);
    if (input.stopRun.aborted) return { status: "aborted" };
    let detail: (typeof HANDED_OFF_DETAILS)[number] = "deadline";
    if (deps.clock.now().getTime() < deadline.getTime()) {
      try {
        // Pushed or nothing new to push: either way the branch holds everything the run committed. The checkpoint turn started the CLI again: clear first.
        input.clearStubs(input.workspace);
        await input.git.publish(job, claimed, input.workspace, input.base, () => lease.ended() !== undefined);
        detail = "pushed";
      } catch (error) {
        if (!(error instanceof GitPathError)) throw error;
        await lease.flush();
        const stopped = lease.ended();
        if (stopped !== undefined) return stoppedBy(stopped);
        if (isGitStop(error.code)) return { status: "stopped", reason: "lease_lost" };
        detail = "push_failed";
      }
    }
    await lease.flush();
    const stoppedAfterPush = lease.ended();
    if (stoppedAfterPush !== undefined) return stoppedBy(stoppedAfterPush);
    await reportEnd(lease, { reason: "handed_off", detail });
    return { status: "handed_off", detail, ...(note === undefined ? {} : { note }) };
  }

  /** The take-over, as the cloud is told: one `taken_over` event (a timestamp, nothing else), then `done` with no envelope. Then the pane is handed over. */
  async function recordTakeover(claimed: Claimed, lease: Lease, watched: WatchedJob, sessionId: string | undefined): Promise<JobResult> {
    lease.push(LocalOnlyEvent.parse({ seq: (lease.highestSeq() ?? -1) + 1, ts: deps.clock.now().toISOString(), type: "taken_over" }));
    await lease.flush();
    const stopped = lease.ended();
    const sent = stopped !== undefined ? stoppedBy(stopped) : await sendDone(claimed, { ...(sessionId === undefined ? {} : { sessionId }) }, lease);
    await watched.handOver();
    return sent;
  }

  async function sendDone(claimed: Claimed, result: { sessionId?: string; agentOutput?: Record<string, unknown>; contextLedger?: ContextLedgerMeasure; workspace?: string }, lease: ReturnType<typeof startLease>, sections: readonly ContextSection[] = [], check?: DoneCheck): Promise<JobResult> {
    // Integers, enums and hashes only (C8 section 6). The one section the runner knows is the repository map it built (D#600 CX-3b): a byte count and the
    // text's sha256, never a path or any of the text. The other sections are the cloud's, which sent the prompt.
    const contextLedger = result.contextLedger === undefined ? undefined : contextLedgerToWire(result.contextLedger, sections);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const reply = await deps.client.done({ runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, sessionId: result.sessionId, agentOutput: result.agentOutput, contextLedger, check });
      if (reply.kind === "done") {
        if (result.sessionId !== undefined && result.workspace !== undefined) {
          await deps.recordSession(result.sessionId, result.workspace).catch(() => undefined);
        }
        return { status: "completed", outcome: reply.outcome, failureReason: reply.failureReason, prNumber: reply.prNumber };
      }
      if (reply.kind === "stop") return { status: "stopped", reason: reply.reason };
      if (reply.kind === "error" && reply.status === 401) return { status: "stopped", reason: "lease_lost" };
      // Retry: the cloud could not ask GitHub (503) or the call did not get through. The lease loops keep going meanwhile.
      const waitSeconds = Math.min(reply.kind === "retry" ? reply.retryAfter : DONE_RETRY_AFTER_SECONDS, MAX_DONE_WAIT_SECONDS);
      if (attempt < attempts) await deps.clock.sleep(waitSeconds * 1000, deps.shutdown === undefined ? lease.signal : AbortSignal.any([lease.signal, deps.shutdown]));
      const ended = lease.ended();
      if (ended !== undefined) return stoppedBy(ended);
      if (deps.shutdown?.aborted) return { status: "aborted" };
    }
    return { status: "unconfirmed" };
  }
}

/** A store whose `create` also fills the new directory; a directory that cannot be filled is removed and the error passes on. */
function filledWith(store: WorkspaceStore, fill: (workspace: string) => Promise<void>): WorkspaceStore {
  return {
    owns: (dir) => store.owns(dir),
    discard: (dir) => store.discard(dir),
    async create(runId) {
      const dir = await store.create(runId);
      try {
        await fill(dir);
      } catch (error) {
        await store.discard(dir).catch(() => undefined); // fx-swallow-ok: the fill's own error is the one that matters
        throw error;
      }
      return dir;
    },
  };
}

const stoppedBy = (ended: LeaseEnd): JobResult => ({ status: "stopped", reason: ended.kind === "stopped" ? ended.reason : "lease_lost" });
