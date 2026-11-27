import { failedStopOf, isSystemStopReason, planHasEnded, readStopFacts, stopFailedOf } from "@fx/core/src/engine/stopFailed.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { asPerson, issueStopOrDeleteLocked, loadSessionTarget, lockEngineSession, pendingJob, requireOwnerOrAdmin, signerOf, type IssuedSessionJob } from "./engineSession.js";

/**
 * D#845 ON-13c4a: Try again on a stop that did not finish. An owner or admin on a session, no body: the SERVER picks the reason from the repo's newest session job (the same read as `stop_failed` on the repos list, one rule in
 * `stopFailedOf`), so a client can never sign a reason it did not already have.
 *
 *   person, halt        (and `token_refresh_failed`, as a person's stop) reissued with the same reason through the stop issuer (never gated; a halted repo stays halted, only its machine-side stop is asked again). 200 `{job_id, kind, operate_epoch, already_issued}`.
 *   operate_off, plan   system causes: a person cannot sign them. The route re-checks that the cause still holds (else 409 `cause_gone`), marks the reconcile tick and answers 200 `{queued: true}`. The system lister
 *                       re-issues after the machine's next inventory report, so this wakes the tick and cannot beat that report.
 *   move, remove        409 `not_retryable`: the stop is link 1 of a chain whose own flow retries it.
 * Refusals: 403 `forbidden` (before any read); 404 `not_found`; 409 `not_placed`, `runner_removed`, `nothing_to_retry` (the newest job is not a failed stop, or the sandbox is down), `cause_gone`, `not_retryable`;
 * 503 `not_configured` (no signer; person and halt only). A stop already issued or delivered answers 200 with `already_issued: true` (a double click). Everything runs in one tenant transaction under the repo's advisory
 * lock, so a later start or stop cannot slip in between the read and the issue.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

type Outcome = { job: IssuedSessionJob } | { queued: true };

export async function retryEngineStop(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw refuse(404, "not_found", "no such repository");
  const id = repoId.toLowerCase();
  const { accountId } = principal;
  const outcome = await asPerson(() => withTenant(deps.appUserPool, accountId, principal.userId, async (client): Promise<Outcome> => {
    await requireOwnerOrAdmin(client);
    await lockEngineSession(client, accountId, id);
    const target = await loadSessionTarget(client, accountId, id);
    const waiting = await pendingJob(client, accountId, id, "engine_session_stop");
    if (waiting !== null) return { job: { job_id: waiting, kind: "engine_session_stop", operate_epoch: null, already_issued: true } };
    const facts = await readStopFacts(client, accountId, id);
    const failed = failedStopOf(facts);
    if (failed === null) throw refuse(409, "nothing_to_retry", "the stop already changed");
    const reason = failed.stopReason;
    // ON-18: a session the runner stopped for `token_refresh_failed` that did not end is asked again as a person's stop (the cause was on the machine and is gone with the session)
    if (reason === "person" || reason === "halt" || reason === "token_refresh_failed") {
      const signer = await signerOf(deps);
      return { job: await issueStopOrDeleteLocked(client, deps, signer, accountId, target, "engine_session_stop", reason === "token_refresh_failed" ? "person" : reason) };
    }
    if (isSystemStopReason(reason)) {
      if (stopFailedOf(facts, reason === "plan" ? await planHasEnded(client, accountId) : false) === null) throw refuse(409, "cause_gone", "that cause no longer holds");
      return { queued: true };
    }
    throw refuse(409, "not_retryable", "this stop is retried by its own flow");
  }));
  if ("queued" in outcome) {
    void markWorkPending("reconcile");
    return { status: 200, body: { queued: true }, headers: NO_STORE };
  }
  return { status: 200, body: outcome.job, headers: NO_STORE };
}
