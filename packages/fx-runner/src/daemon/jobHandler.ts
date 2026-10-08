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
 * The push of the run's branch (git path B) belongs between the run and `done`; it is a later change's step.
 */
import { DONE_RETRY_AFTER_SECONDS, type JobKeyring, type StopReason } from "@fulcrumaxe/runner-protocol";
import { runJob, type JobLedger, type RunJobDeps, type RunJobResult } from "../job/runJob.js";
import type { SandboxPort } from "../sandbox/port.js";
import type { Claimed, RunnerClient } from "./client.js";
import { startLease, type Clock, type Lease, type LeaseEnd, type createEventRelay } from "./lease.js";
import { endOfFailure, endOfRefusal, RUN_ENDED_RETRY_MS, RUN_ENDED_TRIES, runEndedEvent, sendRunEndedAlone, SHUTDOWN_REPORT_MS, type RunEnd } from "./runEnded.js";
import { verifyJob, type JobRefusal } from "./verifyJob.js";

/** How many times `done` is sent when the cloud cannot reach GitHub or the call fails. */
export const MAX_DONE_ATTEMPTS = 5;
/** The longest wait between two `done` attempts, whatever the cloud asks for: the lease is kept alive meanwhile. */
const MAX_DONE_WAIT_SECONDS = 60;

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
}

/** A port whose sandbox is stopped as soon as `signal` aborts, which ends the agent and so the run. */
function stopOnAbort(port: SandboxPort, signal: AbortSignal): SandboxPort {
  return {
    ...port,
    async createSandbox(opts) {
      const handle = await port.createSandbox(opts);
      const stop = (): void => {
        void port.stop(handle).catch(() => undefined);
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      return handle;
    },
  };
}

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
    // The reply's own run id must be the signed job's. The reply schema checks it as well; this is the second check.
    if (job.run_id !== claimed.runId) return refuse(claimed, "run_id_mismatch");

    // The first heartbeat and the first events batch are an interval away, so a run that is refused or repeated at once sends neither.
    const lease = startLease({ client: deps.client, clock: deps.clock, runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }), ...(deps.flushMs === undefined ? {} : { flushMs: deps.flushMs }) });
    const stopRun = deps.shutdown === undefined ? lease.signal : AbortSignal.any([lease.signal, deps.shutdown]);
    const detach = deps.events.attach((event) => lease.push(event));
    let abandonSend = false;
    try {
      const result = await run(job, { ...deps.run, sandbox: stopOnAbort(deps.sandbox, stopRun), ledger: deps.ledger });
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
        // A credential mismatch ends the run on its own event; the engine has queued it, so nothing more is sent for it.
        const end = lease.saw("credential_mismatch") ? null : endOfFailure(result.reason);
        if (end !== null) await reportEnd(lease, end);
        return { status: "failed", reason: result.reason };
      }
      await lease.flush();
      const sent = await sendDone(claimed, result, lease);
      if (sent.status === "aborted") abandonSend = !(await reportShutdown(lease));
      return sent;
    } finally {
      detach();
      await lease.close({ abandon: abandonSend });
    }
  };

  async function sendDone(claimed: Claimed, result: Extract<RunJobResult, { status: "done" }>, lease: ReturnType<typeof startLease>): Promise<JobResult> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const reply = await deps.client.done({ runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, sessionId: result.sessionId, agentOutput: result.agentOutput });
      if (reply.kind === "done") {
        if (result.sessionId !== undefined) {
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

const stoppedBy = (ended: LeaseEnd): JobResult => ({ status: "stopped", reason: ended.kind === "stopped" ? ended.reason : "lease_lost" });
