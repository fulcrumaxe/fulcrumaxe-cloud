import { CLAIM_MIN_INTERVAL_SECONDS, ClaimMessage, ClaimReply, ClaimRateLimitedReply } from "@fulcrumaxe/runner-protocol";
import { asRunner, parseJsonBody, parseMessage, requireLeases, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const CLAIM_PATH = "/api/runner/claim";

/**
 * POST /api/runner/claim (D#6 R2b-3, body criteria 1 to 3 and 5). The signature names the runner; the cloud reads its scope
 * (repos, roles, credential mode) from the runner's own row, so the body is empty. In order:
 *  1. the request is verified and its nonce is spent (a replayed claim would hand a run to whoever captured it);
 *  2. at most one claim every 4 seconds per runner (`runner_claim_throttle`, 0754): a faster one is 429 with `retry_after`,
 *     before the worker is asked anything, so no claim query runs;
 *  3. the worker claims in one transaction (`claimRunnerRun`) and the answer is the signed job with its run id and lease
 *     generation, or `{retry_after}`.
 * The reply is parsed against the protocol's schema before it is sent, so a field that should not be there is a 500, not a leak.
 */
export async function claimRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, CLAIM_PATH, req, { replay: "once" });
  parseMessage(ClaimMessage, parseJsonBody(req));
  const leases = requireLeases(deps);

  const wait = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      // A runner revoked between the verification and here, or whose account is suspended, gets 42501: `asRunner` makes it a 401.
      const { rows } = await client.query<{ wait: number }>("SELECT runner_claim_throttle($1) AS wait", [CLAIM_MIN_INTERVAL_SECONDS * 1000]);
      return rows[0]!.wait;
    }),
  );
  if (wait > 0) {
    const retryAfter = Math.min(CLAIM_MIN_INTERVAL_SECONDS, Math.max(1, Math.ceil(wait / 1000)));
    const body = ClaimRateLimitedReply.parse({ retry_after: retryAfter });
    return { status: 429, body, headers: { "retry-after": String(retryAfter) } };
  }

  const result = await asRunner(() => leases.claimRunnerRun({ accountId: runner.accountId, runnerId: runner.runnerId }));
  const body =
    result.kind === "claimed"
      ? ClaimReply.parse({ signed_job: result.signedJob, run_id: result.runId, lease_generation: result.leaseGeneration })
      : ClaimReply.parse({ retry_after: result.retryAfter });
  if (result.kind === "idle") return { status: 200, body, headers: { "retry-after": String(result.retryAfter) } };
  return { status: 200, body };
}
