import { GIT_TICKET_PATH, GitTicketMessage, GitTicketReply } from "@fulcrumaxe/runner-protocol";
import { branchOf } from "./done.js";
import { stopReply } from "./heartbeat.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, requireLeases, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { signedUrl, verifyRunnerRequest } from "./verifyRunnerRequest.js";

/**
 * POST /api/runner/git-ticket (D#6 R5a-2b; correction C27 section 1). A cloud-verified run (path A) pushes and fetches through the
 * cloud's GitHub proxy, which cannot check an RFC 9421 signature itself (it has no runner key tables). So the cloud signs a short-lived
 * ticket for one run and the proxy checks that with a public key. This route is the only place a ticket is made. In order:
 *  1. the request is verified exactly as `heartbeat` is, except that its nonce is single-use (the constant path, the 256 KiB cap, the 90-day
 *     key age, 401 for a revoked or unknown runner, 409 `nonce_reused`).
 *  2. the body must match the strict message (400).
 *  3. the lease fence runs through the worker WITHOUT extending the lease (a ticket is not a sign of life). Anything but `ok` is the same
 *     409 `{continue:false, reason}` a heartbeat gives.
 *  4. the run must be a runner run whose OWN execution mode is `runner_verified`: 403 `not_cloud_verified` otherwise. The repository's current
 *     mode is never read, so a run keeps the mode it was claimed under (C24 section 2).
 *  5. the branch the ticket may push is `branchOf(job, lease)`: a fix round's own branch, otherwise `<prefix><run>-g<generation>`. It is
 *     computed from our rows only; nothing the runner sent names it, the repository or the run's role.
 *  6. the worker signs it. While the signing key or the forward host is not configured nothing is signed and the answer is 503 `not_configured`.
 * The reply is `{ticket, expires_at, proxy_origin}`. `run_id` and `lease_generation` travel to the proxy only inside the signed ticket.
 */
export async function gitTicketRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, GIT_TICKET_PATH, req, { replay: "once" });
  const message = parseMessage(GitTicketMessage, parseJsonBody(req));
  const leases = requireLeases(deps);
  // The issuer is the configured cloud origin (never a Host header); an unset or malformed origin has already failed the verification above.
  const issuer = new URL(signedUrl(deps.origin, GIT_TICKET_PATH)).origin;
  const lease = { accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation };

  const context = await asRunner(() => leases.gitTicketContext(lease));
  if (context.kind === "fenced") return stopReply(context.reason);

  // The run's own mode, never the repository's current one. `runner_local` runs (path B) have no use for a ticket and are refused.
  if (context.runtime !== "runner" || context.executionMode !== "runner_verified") throw new RunnerHttpError(403, "not_cloud_verified", "this run is not cloud-verified");
  // A run that passed the fence has its repository and job; if either is gone, nothing here can be trusted and no ticket is made.
  if (!context.repo || !context.job) throw new RunnerHttpError(500, "internal", "internal error");

  const signed = await asRunner(() => leases.signGitTicket({ issuer, ...lease, repo: context.repo!, ref: branchOf(context.job!, lease) }));
  if (!signed) throw new RunnerHttpError(503, "not_configured", "the runner API has no git ticket key configured");
  return {
    status: 200,
    body: GitTicketReply.parse({ ticket: signed.ticket, expires_at: signed.expiresAt.toISOString(), proxy_origin: signed.proxyOrigin }),
    headers: { "cache-control": "no-store" },
  };
}
