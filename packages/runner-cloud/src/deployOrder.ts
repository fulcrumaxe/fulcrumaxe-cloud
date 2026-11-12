import {
  CLAIM_IDLE_RETRY_AFTER_SECONDS,
  DEPLOY_ORDER_CAPABILITY,
  DEPLOY_ORDER_CLAIM_PATH,
  DEPLOY_ORDER_LEASE_SECONDS,
  DEPLOY_ORDER_MAX_ATTEMPTS,
  DEPLOY_ORDER_REPORT_PATH,
  DeployOrderClaimMessage,
  DeployOrderClaimReply,
  DeployOrderReportMessage,
  DeployOrderReportReply,
} from "@fulcrumaxe/runner-protocol";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

/**
 * D#749 V2a: the two routes by which a runner takes and reports a deploy order (the cloud's record that a merged commit should be deployed on the repository's own
 * machine). THE CLOUD CAN ONLY SAY "DEPLOY SHA X OF REPOSITORY R": the reply names the repository and the commit and nothing else, and the command that deploys it
 * is in the runner's own local configuration. Both routes are verified like every signed runner route (the RFC 9421 signature with a single-use nonce, the strict
 * message). The runner is the one the signature names; nothing the runner sends names a repository, a commit or a runner that is then used.
 *
 *   POST /api/runner/deploy-order-claim    the oldest order this runner may take, leased for DEPLOY_ORDER_LEASE_SECONDS (a lapsed lease is taken over), or `{ retry_after }`.
 *   POST /api/runner/deploy-order-report   the result, under the lease generation the claim returned. A stale generation, a lapsed lease or another runner's order is 409 `fenced`.
 *
 * The eligibility rule is written once (`DEPLOY_ORDER_ELIGIBLE_SQL`) and the claim route's hint on a claim reply reads the same text, so what a runner is told is waiting
 * is what it can take. The database holds the same line (the guard trigger of migration 1004 refuses a claim by a runner that may not take the order, and a report by one
 * that does not hold it), so a mistake here cannot widen what a runner may do.
 *
 * Statuses: 401 (unsigned or wrong runner), 400 (invalid message), 403 `capability_missing`, 409 `fenced` (with the reason).
 */

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * The orders the runner in `$2` of the account in `$1` may take now, as a FROM/WHERE: pending, or claimed with a lease that has lapsed; not past its deadline; fewer than
 * `$3` attempts used; the repository in the runner's list; the runner live, its registrant still an owner or admin, its latest hello listing the capability `$4`, and not paused
 * or draining. The same eligibility as the merge order hint, plus the lease takeover.
 */
export const DEPLOY_ORDER_ELIGIBLE_SQL = `
  FROM verify_deploy_orders o
  JOIN runners rn ON rn.account_id = o.account_id AND rn.id = $2 AND rn.revoked_at IS NULL
  JOIN account_members am ON am.account_id = rn.account_id AND am.user_id = rn.registered_by AND am.role IN ('owner', 'admin')
  JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id AND $4::text = ANY(cap.capabilities)
  JOIN repos r ON r.account_id = o.account_id AND r.id = o.repo_id AND r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL
  LEFT JOIN runner_settings s ON s.account_id = rn.account_id AND s.runner_id = rn.id
 WHERE o.account_id = $1
   AND (o.state = 'pending' OR (o.state = 'claimed' AND o.lease_expires_at <= now()))
   AND o.attempts < $3 AND o.deadline_at > now()
   AND o.repo_id = ANY(rn.allowed_repo_ids)
   AND (s.runner_id IS NULL OR (s.paused_at IS NULL AND s.draining = false))`;

/** True when a deploy order waits for this runner (read in the caller's runner session, for the hint on a claim reply). */
export async function deployOrderWaiting(client: { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> }, runner: { accountId: string; runnerId: string }): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 AS one ${DEPLOY_ORDER_ELIGIBLE_SQL} LIMIT 1`, [runner.accountId, runner.runnerId, DEPLOY_ORDER_MAX_ATTEMPTS, DEPLOY_ORDER_CAPABILITY]);
  return rows.length > 0;
}

const fenced = (reason: string): RunnerHttpError => new RunnerHttpError(409, "fenced", "the runner no longer holds this order", { reason });

interface ClaimedRow {
  id: string;
  lease_generation: number;
  lease_expires_at: Date;
  merge_sha: string;
  gh_owner: string;
  gh_name: string;
}

export async function deployOrderClaimRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, DEPLOY_ORDER_CLAIM_PATH, req, { replay: "once" });
  parseMessage(DeployOrderClaimMessage, parseJsonBody(req));
  const claimed = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      // The oldest eligible order, locked so two claims never take the same one; the move is the claim (the guard trigger re-checks who may make it).
      const { rows } = await client.query<ClaimedRow>(
        `WITH pick AS (
           SELECT o.id ${DEPLOY_ORDER_ELIGIBLE_SQL} ORDER BY o.created_at, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED
         ), moved AS (
           UPDATE verify_deploy_orders o
              SET state = 'claimed', runner_id = $2, lease_generation = o.lease_generation + 1, attempts = o.attempts + 1,
                  lease_expires_at = now() + make_interval(secs => $5::int)
             FROM pick WHERE o.id = pick.id
           RETURNING o.id, o.account_id, o.repo_id, o.lease_generation, o.lease_expires_at, o.merge_sha
         )
         SELECT m.id, m.lease_generation, m.lease_expires_at, m.merge_sha, r.gh_owner, r.gh_name
           FROM moved m JOIN repos r ON r.account_id = m.account_id AND r.id = m.repo_id`,
        [runner.accountId, runner.runnerId, DEPLOY_ORDER_MAX_ATTEMPTS, DEPLOY_ORDER_CAPABILITY, DEPLOY_ORDER_LEASE_SECONDS],
      );
      return rows[0] ?? null;
    }),
  );
  if (claimed === null) return { status: 200, body: DeployOrderClaimReply.parse({ retry_after: CLAIM_IDLE_RETRY_AFTER_SECONDS }), headers: { ...NO_STORE, "retry-after": String(CLAIM_IDLE_RETRY_AFTER_SECONDS) } };
  return {
    status: 200,
    body: DeployOrderClaimReply.parse({
      order_id: claimed.id,
      lease_generation: claimed.lease_generation,
      lease_expires_at: claimed.lease_expires_at.toISOString(),
      repo: { owner: claimed.gh_owner, name: claimed.gh_name },
      sha: claimed.merge_sha,
    }),
    headers: NO_STORE,
  };
}

/** Joined with newlines, the lines the runner chose to send: the column holds exactly what was sent, no more. */
const tailOf = (lines: readonly string[] | undefined): string | null => (lines === undefined || lines.length === 0 ? null : lines.join("\n"));

export async function deployOrderReportRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, DEPLOY_ORDER_REPORT_PATH, req, { replay: "once" });
  const message = parseMessage(DeployOrderReportMessage, parseJsonBody(req));
  const orderId = message.order_id.toLowerCase();
  const outcome = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      // The fence: this runner, this generation, a claimed order, a live lease. The row is locked so a takeover cannot interleave.
      const held = await client.query<{ state: string; runner_id: string | null; lease_generation: number; live: boolean }>(
        "SELECT state, runner_id, lease_generation, (lease_expires_at > now()) AS live FROM verify_deploy_orders WHERE account_id = $1 AND id = $2 FOR UPDATE",
        [runner.accountId, orderId],
      );
      const row = held.rows[0];
      if (!row || row.runner_id !== runner.runnerId) return "not_yours" as const;
      if (row.state !== "claimed") return "not_claimed" as const;
      if (row.lease_generation !== message.lease_generation) return "stale_generation" as const;
      if (!row.live) return "lease_expired" as const;
      try {
        await client.query(
          `UPDATE verify_deploy_orders
              SET state = $3, exit_code = $4, failure_code = $5, output_tail = $6, finished_at = now()
            WHERE account_id = $1 AND id = $2 AND state = 'claimed' AND runner_id = $7 AND lease_generation = $8`,
          [runner.accountId, orderId, message.result, message.exit_code ?? null, message.failure_code ?? null, tailOf(message.output_tail), runner.runnerId, message.lease_generation],
        );
      } catch (error) {
        // The table's own rules refused the move (a shape the schema allows but the table does not): a bad report, not a server fault.
        if (pgCode(error) === "23514") return "refused" as const;
        throw error;
      }
      return "recorded" as const;
    }),
  );
  // Push, not poll: the post-merge check rides the proposal-verify sweep, and a row waiting on this order is read there. Marking it here wakes the sweep now instead of at the
  // next 30-minute slot. Only a report that was recorded wakes it: a fenced or refused one changed nothing. The marker is a hint; the row stays the truth.
  if (outcome === "recorded") void markWorkPending("proposal-verify-sweep");
  if (outcome === "recorded") return { status: 200, body: DeployOrderReportReply.parse({ recorded: true }), headers: NO_STORE };
  if (outcome === "refused") throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  throw fenced(outcome);
}
