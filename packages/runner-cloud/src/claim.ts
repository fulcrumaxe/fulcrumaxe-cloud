import { CLAIM_IDLE_RETRY_AFTER_SECONDS, CLAIM_MIN_INTERVAL_SECONDS, ClaimMessage, ClaimReply, ClaimRateLimitedReply } from "@fulcrumaxe/runner-protocol";
import { PAUSED_RETRY_AFTER_SECONDS } from "@fx/runner";
import { asRunner, parseJsonBody, parseMessage, requireLeases, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const CLAIM_PATH = "/api/runner/claim";
/** The longest `retry_after` an idle claim answer may carry (the protocol's own bound). */
const CLAIM_PAUSED_RETRY_AFTER_MAX_SECONDS = 3600;

/**
 * POST /api/runner/claim (D#6 R2b-3, body criteria 1 to 3 and 5). The signature names the runner; the cloud reads its scope
 * (repos, roles, credential mode) from the runner's own row, so the body is empty. In order:
 *  1. the request is verified and its nonce is spent (a replayed claim would hand a run to whoever captured it);
 *  2. at most one claim every 4 seconds per runner (`runner_claim_throttle`, 0754): a faster one is 429 with `retry_after`,
 *     before the worker is asked anything, so no claim query runs;
 *  3. the worker claims in one transaction (`claimRunnerRun`) and the answer is the signed job with its run id and lease
 *     generation, or `{retry_after}`.
 * A poll that names `sandbox_unavailable` (C16 section 1.3) is a status poll, not a claim: the runner cannot sandbox a job and takes none.
 * An idle runner has no heartbeat, and only a claim or a heartbeat refreshes `last_seen_at`, so the poll is how such a runner stays visible.
 * It passes steps 1 and 2 like any claim, the reason is stored (step 3 is skipped, so no run is leased and no job can leave), and the answer
 * is `retry_after` only. Every ordinary claim clears the stored reason, so a fixed machine needs nothing more than its next poll.
 * A runner held back by its plan's usage limit (D#6 C43-6) gets the idle answer whatever is queued, with a `retry_after` up to the end of the pause.
 * So does a runner a person paused or set to drain (D#605 FL-3, `runner_settings`): idle with `retry_after` 300, enforced here in the cloud whatever the
 * runner's own marker says. The runs it already holds are untouched.
 * A claim may declare its capacity per job class (D#6 C43-2b): the cloud stores the limits and hands the runner a run only for a class
 * with a free slot. A claim without one is an older runner and holds one job in total.
 * The reply is parsed against the protocol's schema before it is sent, so a field that should not be there is a 500, not a leak.
 */
export async function claimRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, CLAIM_PATH, req, { replay: "once" });
  const message = parseMessage(ClaimMessage, parseJsonBody(req));
  const leases = requireLeases(deps);

  const gate = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      // A runner revoked between the verification and here, or whose account is suspended, gets 42501: `asRunner` makes it a 401.
      const { rows } = await client.query<{ wait: number }>("SELECT runner_claim_throttle($1) AS wait", [CLAIM_MIN_INTERVAL_SECONDS * 1000]);
      const waited = rows[0]!.wait;
      // The sandbox status (C16 section 1.3) is recorded in the same session, only for a poll that passed the throttle: a named reason is
      // stored, and an ordinary claim clears it. One checkout and one transaction serve both.
      if (waited <= 0) await client.query("SELECT runner_sandbox_status_record($1)", [message.sandbox_unavailable ?? null]);
      // D#6 C43-2b: the capacity this claim declares is kept for the runner list (limits only; what it holds is counted from the rows). A claim
      // that declares none is stored as "declared nothing", which reads as one job in total. A status poll takes no job, so it records nothing.
      if (waited <= 0 && message.sandbox_unavailable === undefined) await client.query("SELECT runner_capacity_record($1::int, $2::int, $3::text)", [message.capacity?.light.limit ?? null, message.capacity?.heavy.limit ?? null, message.capacity?.limited_by ?? null]);
      // D#6 C43-6: how long this runner is still held back by its plan's usage limit, in whole seconds rounded up (0: not at all). Worked out from the
      // stored end time against the database clock on every claim, so a pause that has ended needs no cleanup and the next claim just goes ahead.
      let pausedFor = 0;
      if (waited <= 0 && message.sandbox_unavailable === undefined) {
        const paused = await client.query<{ secs: number }>("SELECT CEIL(EXTRACT(EPOCH FROM (claim_paused_until - now())))::int AS secs FROM runner_capacity WHERE runner_id = $1 AND claim_paused_until > now()", [runner.runnerId]);
        pausedFor = paused.rows[0]?.secs ?? 0;
      }
      // D#605 FL-3: a person's pause or drain, worked out from the settings row on every claim (no flag in the runner's own marker is trusted or needed).
      // Running runs are untouched: only this claim answers idle, so a heartbeat or an event batch for a run it already holds goes on as before.
      let heldByPerson = false;
      if (waited <= 0 && message.sandbox_unavailable === undefined) {
        const held = await client.query<{ held: boolean }>("SELECT (paused_at IS NOT NULL OR draining) AS held FROM runner_settings WHERE runner_id = $1", [runner.runnerId]);
        heldByPerson = held.rows[0]?.held === true;
      }
      return { waited, pausedFor, heldByPerson };
    }),
  );
  const wait = gate.waited;
  if (wait > 0) {
    const retryAfter = Math.min(CLAIM_MIN_INTERVAL_SECONDS, Math.max(1, Math.ceil(wait / 1000)));
    const body = ClaimRateLimitedReply.parse({ retry_after: retryAfter });
    return { status: 429, body, headers: { "retry-after": String(retryAfter) } };
  }

  if (message.sandbox_unavailable !== undefined) {
    return { status: 200, body: ClaimReply.parse({ retry_after: CLAIM_IDLE_RETRY_AFTER_SECONDS }), headers: { "retry-after": String(CLAIM_IDLE_RETRY_AFTER_SECONDS) } };
  }

  // A runner whose plan has hit its usage limit is offered nothing until the reported reset: the answer is idle, and it tells the runner to ask again
  // when the pause ends (at most an hour from now, the longest an idle answer may say).
  // A runner a person paused or set to drain (D#605 FL-3) is told to ask again in 5 minutes; if a usage pause runs longer, that longer time stands.
  if (gate.pausedFor > 0 || gate.heldByPerson) {
    const retryAfter = Math.min(Math.max(gate.pausedFor, gate.heldByPerson ? PAUSED_RETRY_AFTER_SECONDS : 0), CLAIM_PAUSED_RETRY_AFTER_MAX_SECONDS);
    return { status: 200, body: ClaimReply.parse({ retry_after: retryAfter }), headers: { "retry-after": String(retryAfter) } };
  }

  const result = await asRunner(() => leases.claimRunnerRun({ accountId: runner.accountId, runnerId: runner.runnerId, ...(message.capacity ? { capacity: message.capacity } : {}) }));
  const body =
    result.kind === "claimed"
      ? ClaimReply.parse({ signed_job: result.signedJob, run_id: result.runId, lease_generation: result.leaseGeneration })
      : ClaimReply.parse({ retry_after: result.retryAfter });
  if (result.kind === "idle") return { status: 200, body, headers: { "retry-after": String(result.retryAfter) } };
  return { status: 200, body };
}
