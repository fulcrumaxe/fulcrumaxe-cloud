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
 */
import { DONE_RETRY_AFTER_SECONDS, LocalOnlyEvent, type JobKeyring, type StopReason } from "@fulcrumaxe/runner-protocol";
import { cliModelFor, runJob, type JobLedger, type RunJobDeps, type RunJobResult } from "../job/runJob.js";
import { storeKeyOf, type JobAllowanceGrant } from "../sandbox/allowances.js";
import type { SandboxHandle, SandboxPort } from "../sandbox/port.js";
import type { WorkspaceStore } from "../job/workspace.js";
import type { Claimed, RunnerClient } from "./client.js";
import { GitPathError } from "./git.js";
import type { GitPath } from "./gitPath.js";
import { startLease, type Clock, type Lease, type LeaseEnd, type createEventRelay } from "./lease.js";
import { endOfFailure, endOfRefusal, RUN_ENDED_RETRY_MS, RUN_ENDED_TRIES, runEndedEvent, sendRunEndedAlone, SHUTDOWN_REPORT_MS, type RunEnd } from "./runEnded.js";
import { verifyJob, type JobRefusal } from "./verifyJob.js";
import type { JobWatch, WatchedJob } from "./watch.js";

/** How many times `done` is sent when the cloud cannot reach GitHub or the call fails. */
export const MAX_DONE_ATTEMPTS = 5;
/** The longest wait between two `done` attempts, whatever the cloud asks for: the lease is kept alive meanwhile. */
const MAX_DONE_WAIT_SECONDS = 60;
/** After SIGINT, the agent gets this long to end its turn before its sandbox is stopped. */
export const TAKEOVER_STOP_GRACE_MS = 10_000;

export type JobResult =
  | { status: "refused"; reason: JobRefusal }
  | { status: "duplicate" }
  /** The ledger could not record the job's id, so the job was not started; nothing is sent. */
  | { status: "unrecorded" }
  | { status: "stopped"; reason: StopReason | "lease_lost" }
  | { status: "aborted" }
  | { status: "failed"; reason: string }
  | { status: "completed"; outcome: "succeeded" | "failed"; failureReason: string | null; prNumber: number | null }
  | { status: "unconfirmed" };

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
  /** Git path A (cloud-verified, D#6 R5a-3). Absent when this build pins no GitHub relay for the cloud: a `verified` job then ends `git_proxy_unpinned`. */
  gitA?: GitPath;
  events: ReturnType<typeof createEventRelay>;
  /** Writes the local session index the next fix round reads (the engine's own recorder, bound to its file). */
  recordSession: (sessionId: string, workspace: string) => Promise<void>;
  /** Aborts when the daemon is asked to stop. */
  shutdown?: AbortSignal;
  /** Replaceable so a test can count the calls. */
  runJobFn?: typeof runJob;
  heartbeatMs?: number;
  flushMs?: number;
  doneAttempts?: number;
  /** The tmux watch and take-over (R4a-7). Absent: no watch. */
  watch?: JobWatch;
  /** Sends the agent in a sandbox SIGINT, which ends its turn cleanly. Required for a take-over to stop the agent. */
  interrupt?: (handle: SandboxHandle) => void | Promise<void>;
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

/** A port whose sandbox is stopped as soon as `signal` aborts, which ends the agent and so the run. */
function stopOnAbort(port: SandboxPort, signal: AbortSignal, held: HeldSandbox): SandboxPort {
  return {
    ...port,
    async createSandbox(opts) {
      const handle = await port.createSandbox(opts);
      held.handle = handle;
      const stop = (): void => {
        void port.stop(handle).catch(() => undefined);
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      return handle;
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

export function createJobHandler(deps: JobHandlerDeps): (claimed: Claimed) => Promise<JobResult> {
  const run = deps.runJobFn ?? runJob;
  const attempts = deps.doneAttempts ?? MAX_DONE_ATTEMPTS;

  const never = new AbortController().signal;

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

    // The first heartbeat and the first events batch are an interval away, so a run that is refused or repeated at once sends neither.
    const lease = startLease({ client: deps.client, clock: deps.clock, runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }), ...(deps.flushMs === undefined ? {} : { flushMs: deps.flushMs }) });
    const stopRun = deps.shutdown === undefined ? lease.signal : AbortSignal.any([lease.signal, deps.shutdown]);
    const detach = deps.events.attach((event) => lease.push(event));
    let abandonSend = false;
    const held: HeldSandbox = {};
    const ran = new AbortController();
    let takeoverOpen = true;
    let tookOver = false;
    const watched = await deps.watch?.begin({ runId: claimed.runId, role: job.role, repo: `${job.repo.owner}/${job.repo.name}`, started: deps.clock.now() });
    watched?.onTakeOver(() => {
      if (!takeoverOpen) return;
      tookOver = true;
      void interruptAgent();
    });
    /** SIGINT now (after the sandbox exists, if the request came first); if the agent has not ended its turn within the grace, its sandbox is stopped. */
    async function interruptAgent(): Promise<void> {
      for (let waited = 0; held.handle === undefined && waited < 40 && !ran.signal.aborted; waited++) await deps.clock.sleep(250, ran.signal);
      const handle = held.handle;
      if (handle === undefined) return;
      await Promise.resolve(deps.interrupt?.(handle)).catch(() => undefined);
      await deps.clock.sleep(TAKEOVER_STOP_GRACE_MS, ran.signal);
      if (!ran.signal.aborted) await deps.sandbox.stop(handle).catch(() => undefined);
    }
    try {
      const started: { base?: string } = {};
      let result: RunJobResult;
      try {
        // An id the price table lacks is refused first, so a fix round with a bad hint starts no process, mirror fetch or ticketed session.
        // `runJob` keeps its own check for callers that do not come through here.
        if (cliModelFor(job, deps.run.defaultModel) === undefined) result = { status: "failed", reason: "model_unsupported" };
        else {
          git.check(job, claimed);
          // A fix round resumes its kept session only when that workspace is exactly at the branch's tip after a fresh mirror sync; any other
          // workspace is left unused and the run starts fresh on the tip (C25 section 1.4). The decision is made here, before the run starts.
          let planSession = deps.run.planSession;
          const wanted = job.continues === null ? undefined : deps.run.planSession(job.continues);
          if (job.continues !== null && wanted?.kind === "resume" && deps.run.workspaces.owns(wanted.workspace)) {
            const resumed = await git.resume(job, claimed, wanted.workspace);
            if (resumed !== null) started.base = resumed.base;
            else {
              const fresh = { kind: "fresh", branch: job.continues.branch } as const;
              planSession = () => fresh;
            }
          }
          const fill = async (workspace: string): Promise<void> => {
            started.base = (await git.prepare(job, claimed, workspace)).base;
          };
          const granted = withReadGrants(deps.sandbox, git.readGrants(job));
          const allowed = job.sandbox_allowances === undefined ? granted : withAllowances(granted, { entries: job.sandbox_allowances.entries, commandTimeoutS: job.sandbox_allowances.command_timeout_s, storeKey: storeKeyOf(job.repo) });
          result = await run(job, { ...deps.run, planSession, workspaces: filledWith(deps.run.workspaces, fill), sandbox: stopOnAbort(allowed, stopRun, held), ledger: deps.ledger });
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
      try {
        if (started.base === undefined) throw new GitPathError("push_failed");
        await git.publish(job, claimed, result.workspace, started.base, () => lease.ended() !== undefined);
      } catch (error) {
        if (!(error instanceof GitPathError)) throw error;
        await lease.flush();
        const stopped = lease.ended();
        if (stopped !== undefined) return stoppedBy(stopped);
        if (isGitStop(error.code)) return { status: "stopped", reason: "lease_lost" };
        await reportEnd(lease, endOfFailure(error.code, error.sizeMb)!);
        return { status: "failed", reason: error.code };
      }
      await lease.flush();
      // A stop reply (to anything sent so far, the flush included) ends the run: `done` is not sent for it.
      const stoppedAfterPush = lease.ended();
      if (stoppedAfterPush !== undefined) return stoppedBy(stoppedAfterPush);
      const sent = await sendDone(claimed, result, lease);
      if (sent.status === "aborted") abandonSend = !(await reportShutdown(lease));
      return sent;
    } finally {
      ran.abort();
      detach();
      await lease.close({ abandon: abandonSend });
      await watched?.finish();
    }
  };

  /** The take-over, as the cloud is told: one `taken_over` event (a timestamp, nothing else), then `done` with no envelope. Then the pane is handed over. */
  async function recordTakeover(claimed: Claimed, lease: Lease, watched: WatchedJob, sessionId: string | undefined): Promise<JobResult> {
    lease.push(LocalOnlyEvent.parse({ seq: (lease.highestSeq() ?? -1) + 1, ts: deps.clock.now().toISOString(), type: "taken_over" }));
    await lease.flush();
    const stopped = lease.ended();
    const sent = stopped !== undefined ? stoppedBy(stopped) : await sendDone(claimed, { ...(sessionId === undefined ? {} : { sessionId }) }, lease);
    await watched.handOver();
    return sent;
  }

  async function sendDone(claimed: Claimed, result: { sessionId?: string; agentOutput?: Record<string, unknown>; workspace?: string }, lease: ReturnType<typeof startLease>): Promise<JobResult> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const reply = await deps.client.done({ runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, sessionId: result.sessionId, agentOutput: result.agentOutput });
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
