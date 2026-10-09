/**
 * How the daemon tells the cloud that it refused a run or could not finish it (D#6 R4a-2, correction C24 section 1): one
 * `run_ended` event on the ordinary events route, signed and fenced like every other event. Without it the lease runs out and the
 * sweeper calls the run `runner_lost`, which spends a retry on a failure that would happen the same way again.
 *
 * Everything sent here is a closed code (`RunEndedReason`, and for two reasons a `RunEndedDetail`). Nothing from the job, the agent
 * or an error message goes in; a failure code the daemon does not know is sent as `runner_setup` / `other`.
 */
import { LocalOnlyEvent, RUNNER_LEASE_SECONDS, RUNNER_SETUP_DETAILS, type RunEndedDetail, type RunEndedReason } from "@fulcrumaxe/runner-protocol";
import type { Claimed, RunnerClient } from "./client.js";
import type { Clock } from "./lease.js";
import type { JobRefusal } from "./verifyJob.js";

/** Tries at sending `run_ended` while the lease is still valid. The lease path is the fallback after that. */
export const RUN_ENDED_TRIES = 3;
/** The wait before a second try, doubled before a third. */
export const RUN_ENDED_RETRY_MS = 2_000;
/** The daemon's one best-effort attempt at `runner_shutdown` is given this long. */
export const SHUTDOWN_REPORT_MS = 5_000;

export interface RunEnd {
  reason: RunEndedReason;
  detail?: RunEndedDetail;
  /** Only with `push_too_large` (C27 section 4.5): the largest commit, in whole MB. */
  sizeMb?: number;
}

/**
 * A refused job is reported under its refusal code; a public repository has its own reason. A fix round's branch that is not the shape
 * of a run branch is `job_refused` with no detail: C25 section 1.3 names no code for it, and the protocol's closed set has none.
 */
export function endOfRefusal(refusal: JobRefusal | "duplicate_job"): RunEnd {
  if (refusal === "repo_not_private") return { reason: "repo_not_private" };
  return refusal === "continues_branch_invalid" ? { reason: "job_refused" } : { reason: "job_refused", detail: refusal };
}

const SETUP_CODES: ReadonlySet<string> = new Set(RUNNER_SETUP_DETAILS.filter((code) => code !== "other"));
const AGENT_CODES: ReadonlySet<string> = new Set(["agent_error", "no_result", "agent_exit"]);

/**
 * The end to report for a run that `runJob` returned `failed` for. Null means report nothing: a credential mismatch ends the run on
 * its own event (the engine sends it), and `run_ended` is never sent for it. The set of codes `runJob` can return is open; anything
 * not listed here is a setup failure of an unknown kind.
 */
export function endOfFailure(code: string, sizeMb?: number): RunEnd | null {
  if (code === "credential_mismatch") return null;
  if (code === "wall_clock") return { reason: "wall_clock" };
  if (code === "push_rejected") return { reason: "push_rejected" };
  if (AGENT_CODES.has(code)) return { reason: "agent_failed" };
  if (code === "push_too_large") return { reason: "runner_setup", detail: "push_too_large", ...(sizeMb === undefined ? {} : { sizeMb }) };
  if (SETUP_CODES.has(code)) return { reason: "runner_setup", detail: code as RunEndedDetail };
  return { reason: "runner_setup", detail: "other" };
}

/** The event for an end. Throws if the protocol would not accept it, which would be a bug in this file. */
export function runEndedEvent(seq: number, now: Date, end: RunEnd): LocalOnlyEvent {
  return LocalOnlyEvent.parse({ seq, ts: now.toISOString(), type: "run_ended", reason: end.reason, ...(end.detail === undefined ? {} : { detail: end.detail }), ...(end.sizeMb === undefined ? {} : { size_mb: end.sizeMb }) });
}

/**
 * Sends `run_ended` as the only event of a run that has no lease loops yet (a refused job), with up to `RUN_ENDED_TRIES` tries while
 * the lease the claim gave is still valid. It stops at the first reply that settles the matter: accepted, a stop (the run is ended or
 * fenced already), `seq_not_increasing` (the cloud already holds events at or above this number, as for any event), or a 401. A reply
 * that did not get through is tried again after a short wait. Never throws, and sends nothing for a signal that has aborted.
 */
export async function sendRunEndedAlone(client: Pick<RunnerClient, "events">, clock: Clock, claimed: Pick<Claimed, "runId" | "leaseGeneration">, end: RunEnd, signal: AbortSignal): Promise<void> {
  const started = clock.now().getTime();
  for (let attempt = 1; attempt <= RUN_ENDED_TRIES; attempt++) {
    if (signal.aborted || clock.now().getTime() - started >= RUNNER_LEASE_SECONDS * 1000) return;
    const reply = await client.events(claimed.runId, claimed.leaseGeneration, [runEndedEvent(0, clock.now(), end)]);
    if (reply.kind !== "error" || reply.status === 401) return;
    if (attempt < RUN_ENDED_TRIES) await clock.sleep(RUN_ENDED_RETRY_MS * attempt, signal);
  }
}
