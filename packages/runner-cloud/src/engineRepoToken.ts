import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, REPO_TOKEN_PATH, REPO_TOKEN_STOP_PATH, RepoTokenMessage, RepoTokenReply, RepoTokenStopMessage, RepoTokenStopReply, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { readEngineCoverage } from "@fx/core/src/onboarding/engineCoverage.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { readOperate, repoOperated, signerOf } from "./engineSession.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

/**
 * D#845 ON-18 (Rulings 70, 126): POST /api/runner/engine/repo-token. The runner of a placed repo with a running engine session asks for the one token the engine uses on that repository: an `engine_session` installation token
 * (this repository only, `contents`, `issues`, `pull_requests`, `discussions` write and `metadata` read), valid for an hour and minted fresh on every ask. Signed like every runner route (a single-use nonce), strict message
 * `{repo_gh_id, session_id}`. Only the runner process asks: it holds the signing key, which no sandbox and no model run ever has.
 *
 * A session is RUNNING (Ruling 126.2) when all of these hold, each read from our own rows and none from the message: the repository is the account's and is placed on THIS runner; `session_id` is the id of the repository's
 * newest delivered or done `engine_session_start` on this runner (a new start makes the old id invalid, which is the revocation); this runner's lease row for the repository has not expired and carries the account's current
 * operate epoch; the repository is operated; and the Engine plan has not ended. A foreign repository, or one placed on another runner, is 404; anything else that is not running is 409 `session_not_running`. Nothing of the
 * account, the repository or GitHub is in an error. A stop or delete of the repository on this runner issued after the start ends minting at once (409). At most 12 tokens an hour per runner and repository (429 `rate_limited`). Statuses: 401, 400, 404, 409 `session_not_running` | `app_not_installed` | `repo_unnamed`, 429, 502 `token_scope_mismatch`, 503.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * A cap on how often one runner may be given a token for one repository: 12 an hour (a healthy loop asks about 1.3 times an hour, and three failed asks in a row end it). Kept in this process's memory, so it bounds a looping
 * runner on one instance and is not shared between instances. Only an ask that reaches the mint counts; a refused one does not.
 */
export const REPO_TOKEN_MINTS_PER_HOUR = 12;
const WINDOW_MS = 3600_000;
const mintLog = new Map<string, number[]>();
function mintAllowed(runnerId: string, repoId: string, at: number): number | null {
  const key = `${runnerId}:${repoId}`;
  const recent = (mintLog.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
  if (recent.length >= REPO_TOKEN_MINTS_PER_HOUR) {
    mintLog.set(key, recent);
    return Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - at) / 1000));
  }
  recent.push(at);
  mintLog.set(key, recent);
  if (mintLog.size > 10_000) for (const [k, v] of mintLog) if (v.every((t) => at - t >= WINDOW_MS)) mintLog.delete(k);
  return null;
}

type Verdict = { ok: true; id: string; owner: string | null; name: string | null } | { ok: false; status: 404 | 409 };

/**
 * Whether the session `sessionId` of the repository `ghId` is RUNNING for this runner, by the rules in the header, read from our own rows. Shared by the token route and the stop report.
 */
async function judgeSession(client: PoolClient, account: string, runnerId: string, ghId: number, sessionId: string): Promise<Verdict> {
  const repo = (await client.query<{ id: string; gh_owner: string | null; gh_name: string | null }>("SELECT id, gh_owner, gh_name FROM repos WHERE account_id = $1 AND gh_repo_id = $2", [account, ghId])).rows[0];
  if (!repo) return { ok: false, status: 404 };
  const placed = await client.query("SELECT 1 FROM project_placements WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3", [account, repo.id, runnerId]);
  if (placed.rowCount === 0) return { ok: false, status: 404 };
  const newest = (await client.query<{ id: string; issued_at: Date }>(
    "SELECT id, issued_at FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND kind = 'engine_session_start' AND state IN ('delivered', 'done') ORDER BY issued_at DESC, id DESC LIMIT 1",
    [account, repo.id, runnerId],
  )).rows[0];
  if (newest?.id !== sessionId.toLowerCase()) return { ok: false, status: 409 };
  // a stop or a delete of this repository on this runner that is newer than the start ends the session, whether or not the machine has done it yet: no more tokens
  const ended = await client.query(
    "SELECT 1 FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND kind IN ('engine_session_stop', 'engine_session_delete') AND state IN ('issued', 'delivered', 'done') AND issued_at > $4 LIMIT 1",
    [account, repo.id, runnerId, newest.issued_at],
  );
  if ((ended.rowCount ?? 0) > 0) return { ok: false, status: 409 };
  const lease = (await client.query<{ operate_epoch: number }>(
    "SELECT operate_epoch FROM engine_session_leases WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND expires_at > now()",
    [account, repo.id, runnerId],
  )).rows[0];
  const operate = await readOperate(client, account, false);
  const running = lease !== undefined && operate.enabled && lease.operate_epoch === operate.epoch && (await repoOperated(client, account, repo.id)) && (await readEngineCoverage(client, account, true)).state !== "plan_ended";
  return running ? { ok: true, id: repo.id, owner: repo.gh_owner, name: repo.gh_name } : { ok: false, status: 409 };
}

export async function engineRepoTokenRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, REPO_TOKEN_PATH, req, { replay: "once" });
  const { repo_gh_id: ghId, session_id: sessionId } = parseMessage(RepoTokenMessage, parseJsonBody(req));
  const port = deps.engineRepoToken;
  if (!port) throw new RunnerHttpError(503, "not_configured", "the runner API has no repository credential configured");
  const verdict = await asRunner(() => withRunnerSession(deps.appUserPool, runner, (client) => judgeSession(client, runner.accountId, runner.runnerId, ghId, sessionId)));
  if (!verdict.ok) throw verdict.status === 404 ? new RunnerHttpError(404, "not_found", "no such repository") : new RunnerHttpError(409, "session_not_running", "the repository has no running engine session");
  if (verdict.owner === null || verdict.name === null) throw new RunnerHttpError(409, "repo_unnamed", "the repository has no name on record");
  const wait = mintAllowed(runner.runnerId, verdict.id, (deps.now ?? (() => new Date()))().getTime());
  if (wait !== null) throw new RunnerHttpError(429, "rate_limited", "too many tokens were asked for this repository; try again later", { retry_after: wait });
  let minted: { token: string; expiresAt: Date };
  try {
    minted = await port.mint({ id: verdict.id, owner: verdict.owner, name: verdict.name });
  } catch (error) {
    // fx-swallow-ok: mapped to a fixed status below; nothing of the error (it may name an installation) is sent
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    const reason = typeof error === "object" && error !== null ? (error as { reason?: unknown }).reason : undefined;
    if (code === "app_not_installed") throw new RunnerHttpError(409, "app_not_installed", "the GitHub App is not installed on the repository");
    if (reason === "token_scope_mismatch") throw new RunnerHttpError(502, "token_scope_mismatch", "GitHub did not narrow the token as asked");
    throw new RunnerHttpError(503, "github_unavailable", "GitHub could not be asked");
  }
  try {
    return { status: 200, body: RepoTokenReply.parse({ token: minted.token, expires_at: minted.expiresAt.toISOString() }), headers: NO_STORE };
  } catch (error) {
    await port.revoke(minted.token);
    throw error;
  }
}

/**
 * D#845 ON-18 (Ruling 126.2): POST /api/runner/engine/repo-token-stop. The runner that gave up refreshing a session's repository token (three failed asks in a row) reports it BEFORE it stops the session itself, so the cloud records
 * one stop of the reason `token_refresh_failed`: the Team card then says the engine lost its GitHub access, and Try again can reissue the stop. Signed like every runner route; the message is the token route's. It is accepted only
 * from the runner the repository is placed on, for that runner's current running session (the token route's own judgement, then the definer's again under the repo's lock), and once per session. 200 `{result: "recorded" | "already"}`;
 * 404 `not_found` (a foreign repository, or one placed elsewhere); 409 `session_not_running`; 503 `not_configured` (no signer). The recorded job is `failed`, not `done`: the stop has not run yet, and the card clears by itself when the
 * machine reports the sandbox down.
 */
export async function engineRepoTokenStopRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, REPO_TOKEN_STOP_PATH, req, { replay: "once" });
  const { repo_gh_id: ghId, session_id: sessionId } = parseMessage(RepoTokenStopMessage, parseJsonBody(req));
  const signer = await signerOf(deps);
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const result = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client): Promise<"recorded" | "already" | "not_found" | "not_running"> => {
      const verdict = await judgeSession(client, runner.accountId, runner.runnerId, ghId, sessionId);
      if (!verdict.ok) return verdict.status === 404 ? "not_found" : "not_running";
      const { epoch } = await readOperate(client, runner.accountId, false);
      const jobId = randomUUID();
      const signed = signer.signMachineJob({
        v: 1, job_id: jobId, runner_id: runner.runnerId, repo_gh_id: ghId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "engine_session_stop", args: { reason: "token_refresh_failed", operate_epoch: epoch },
      } as MachineJob);
      const answer = (await client.query<{ r: string }>("SELECT engine_repo_token_stop_report($1, $2, $3::jsonb, $4, $5) AS r", [jobId, sessionId.toLowerCase(), JSON.stringify(signed), issued, expires])).rows[0]!.r;
      return answer === "recorded" || answer === "already" ? answer : answer === "not_found" ? "not_found" : "not_running"; // epoch_moved and not_running are both "not running"
    }),
  );
  if (result === "not_found") throw new RunnerHttpError(404, "not_found", "no such repository");
  if (result === "not_running") throw new RunnerHttpError(409, "session_not_running", "the repository has no running engine session");
  return { status: 200, body: RepoTokenStopReply.parse({ result }), headers: NO_STORE };
}
