import { GH_DEVICE_URL_PATTERN, GH_LOGIN_CAPABILITY, GH_USER_CODE_PATTERN, GhLoginReport, ghLoginReportPath } from "@fulcrumaxe/runner-protocol";
import type { PoolClient } from "pg";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { LIVE, LOGIN_LIFE_SECONDS, NO_STORE, UUID, asLoginError, asOwnerOnManagedRunner, canonicalId, insertCommand, liveRequest, sealed, sealerOf } from "./machineLogin.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

/**
 * D#845 ON-19c: the GitHub sign-in relay (migration 1125), on the Claude sign-in's channel and rows (`machine_login_requests` of kind 'github', `machine_commands`). A person who owns or administers the account asks; the runner prints
 * GitHub's one-time code and the one device address, relays exactly those two values and waits while the person enters the code on GitHub's own page. Both values are sealed together (the `auth_url` purpose) and open only for the person,
 * while the request waits. Nothing else the CLI prints, and no token, ever reaches the cloud: the report's schema holds the two values to their exact shapes, and the read refuses anything that does not match them.
 */
const LOGOUT_COMMAND_LIFE_SECONDS = 300;
const onGhRunner = <T>(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, fn: (client: PoolClient) => Promise<T>) => asOwnerOnManagedRunner(deps, principal, runnerId, fn, GH_LOGIN_CAPABILITY);

/** POST /api/runners/:id/gh-login. Starts a sign-in (200 with the request, or the one already live: a double click starts one). 409 `not_managed_server`, `not_supported`, `runner_revoked`; 403; 404. */
export async function startGhLogin(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  sealerOf(deps);
  const row = await onGhRunner(deps, principal, runnerId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`machine-login:github:${runnerId}`]);
    await client.query(`UPDATE machine_login_requests SET status = 'expired', auth_url_ct = NULL, code_ct = NULL WHERE account_id = $1 AND runner_id = $2 AND kind = 'github' AND status IN ${LIVE} AND expires_at <= now()`, [principal.accountId, runnerId]);
    const live = await liveRequest(client, principal, runnerId, undefined, "github");
    if (live) return live;
    const made = await client.query<{ id: string; status: string; expires_at: Date }>(
      `INSERT INTO machine_login_requests (account_id, runner_id, kind, created_by, expires_at) VALUES ($1, $2, 'github', $3, now() + make_interval(secs => $4)) RETURNING id, status, expires_at`,
      [principal.accountId, runnerId, principal.userId, LOGIN_LIFE_SECONDS],
    );
    await insertCommand(client, principal, runnerId, "gh_login_start", made.rows[0]!.id, LOGIN_LIFE_SECONDS);
    // Ids only: never the address, the code or any text.
    await client.query("SELECT audit_write('machine.login_started', $1::jsonb)", [JSON.stringify({ request_id: made.rows[0]!.id, runner_id: runnerId })]);
    return made.rows[0]!;
  });
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { request_id: row.id, status: row.status, expires_at: row.expires_at.toISOString() }, headers: NO_STORE };
}

/** GET /api/runners/:id/gh-login. The newest request of this runner, with the address and the code while it waits for the person (`device_url`, `user_code`, opened here for this person only), or `{ request: null }`. */
export async function readGhLogin(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const seal = sealerOf(deps);
  const body = await onGhRunner(deps, principal, runnerId, async (client) => {
    const r = (
      await client.query<{ id: string; status: string; expires_at: Date; failure_code: string | null; lapsed: boolean }>(
        `SELECT id, status, expires_at, failure_code, (status IN ${LIVE} AND expires_at <= now()) AS lapsed FROM machine_login_requests WHERE account_id = $1 AND runner_id = $2 AND kind = 'github' ORDER BY created_at DESC LIMIT 1`,
        [principal.accountId, runnerId],
      )
    ).rows[0];
    if (!r) return { request: null };
    let relay: { device_url: string; user_code: string } | null = null;
    let failure = r.failure_code;
    if (r.status === "awaiting_code" && !r.lapsed) {
      const ct = (await client.query<{ ct: Buffer | null }>("SELECT machine_login_auth_url($1) AS ct", [r.id])).rows[0]?.ct;
      if (ct) {
        const [code, url, extra] = sealed(() => seal.open({ accountId: principal.accountId, requestId: r.id, runnerId }, "auth_url", ct)).split(" ");
        // Fail closed: what does not match the two exact shapes is never shown.
        if (extra === undefined && code !== undefined && url !== undefined && GH_USER_CODE_PATTERN.test(code) && GH_DEVICE_URL_PATTERN.test(url)) relay = { device_url: url, user_code: code };
        else failure = "invalid_relay";
      }
    }
    return { request: { request_id: r.id, status: r.lapsed ? "expired" : r.status, expires_at: r.expires_at.toISOString(), device_url: relay?.device_url ?? null, user_code: relay?.user_code ?? null, failure_code: failure } };
  });
  return { status: 200, body, headers: NO_STORE };
}

/** POST /api/runners/:id/gh-login/cancel. Ends the live request (nothing sealed is kept) and withdraws its commands that have not been delivered. 409 `no_login_waiting` when none is live. */
export async function cancelGhLogin(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const row = await onGhRunner(deps, principal, runnerId, async (client) => {
    const live = await liveRequest(client, principal, runnerId, undefined, "github");
    if (!live) throw new RunnerHttpError(409, "no_login_waiting", "no sign-in is in progress");
    await client.query(`UPDATE machine_login_requests SET status = 'failed', failure_code = 'cancelled', auth_url_ct = NULL, code_ct = NULL WHERE id = $1 AND account_id = $2`, [live.id, principal.accountId]);
    await client.query(`UPDATE machine_commands SET state = 'cancelled' WHERE request_id = $1 AND account_id = $2 AND state = 'pending' AND expires_at > now()`, [live.id, principal.accountId]);
    // A start the runner already has is not withdrawn by the line above: its device code stays live on the machine. So the runner is told to sign out, which ends a sign-in that is running (and undoes one that finished).
    const delivered = await client.query(`SELECT 1 FROM machine_commands WHERE request_id = $1 AND account_id = $2 AND kind = 'gh_login_start' AND state IN ('delivered', 'applied', 'refused')`, [live.id, principal.accountId]);
    if (delivered.rowCount) await insertCommand(client, principal, runnerId, "gh_logout", null, LOGOUT_COMMAND_LIFE_SECONDS);
    return live;
  });
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { request_id: row.id, status: "failed", failure_code: "cancelled" }, headers: NO_STORE };
}

/** POST /api/runners/:id/gh-logout. Queues `gh_logout`: the machine signs out of GitHub. Asking twice is one command. */
export async function signOutOfGh(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const row = await onGhRunner(deps, principal, runnerId, async (client) => {
    await client.query(`UPDATE machine_commands SET state = 'expired' WHERE runner_id = $1 AND account_id = $2 AND kind = 'gh_logout' AND state = 'pending' AND expires_at <= now()`, [runnerId, principal.accountId]);
    const made = await insertCommand(client, principal, runnerId, "gh_logout", null, LOGOUT_COMMAND_LIFE_SECONDS);
    if (made.rows[0]) return made.rows[0];
    return (await client.query<{ id: string; expires_at: Date }>(`SELECT id, expires_at FROM machine_commands WHERE runner_id = $1 AND account_id = $2 AND kind = 'gh_logout' AND state = 'pending'`, [runnerId, principal.accountId])).rows[0]!;
  });
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { command_id: row.id, runner_id: runnerId, kind: "gh_logout", state: "pending", expires_at: row.expires_at.toISOString() }, headers: NO_STORE };
}

/** POST /api/runner/machine-login/:request_id/gh-report. The address and the code (sealed together here), or `done`, or `failed`, for a github request of this runner only. */
export async function ghLoginReportRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, requestId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, ghLoginReportPath(requestId), req, { replay: "once" });
  if (!UUID.test(requestId)) throw new RunnerHttpError(404, "not_found", "no such sign-in request");
  const report = parseMessage(GhLoginReport, parseJsonBody(req));
  const ct = report.device_url === undefined ? null : sealed(() => sealerOf(deps).seal({ accountId: runner.accountId, requestId, runnerId: runner.runnerId }, "auth_url", `${report.user_code} ${report.device_url}`));
  try {
    await asRunner(() =>
      withRunnerSession(deps.appUserPool, runner, async (client) => {
        await client.query("SELECT set_config('app.login_kind', 'github', true)");
        await client.query("SELECT machine_login_report($1, $2, $3, $4)", [requestId, report.state, ct, report.failure_code ?? null]);
      }),
    );
  } catch (error) {
    throw asLoginError(error);
  }
  return { status: 200, body: { state: report.state }, headers: NO_STORE };
}
