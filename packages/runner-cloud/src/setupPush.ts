import { SetupPushTokenMessage, SetupPushTokenReply, setupPushTokenPath } from "@fulcrumaxe/runner-protocol";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { definersForJob } from "./engineUpdateDefiners.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

/**
 * D#845 ON-8f: POST /api/runner/setup/:setup_id/push-token. The runner running a setup job asks for the one credential it pushes with. Signed like every runner route (a single-use nonce), strict message `{job_id}`.
 *
 * D#845 ON-27b: the same route serves a `twin_seed` job (the definer is chosen by the job's kind, `engineUpdateDefiners.ts`). Its repository is the twin's private repository, which the job is bound to and the definer returns; the
 * public repository is never a target, so no token is ever minted for it. Its fence is the seed's own: fetched first, push step started, once per job.
 *
 * It answers only for this runner's own delivered, current `project_setup` job of this setup whose setup reported the `push` step started (so after the verified bundle was applied), and once per job: the fence and the
 * once-marker are one definer (`setup_push_grant`, migration 1071), committed BEFORE the mint, so a second ask mints nothing (the same order as the merge order's credential). The repository is read from our own rows and
 * never from the message. The token is a `setup_push` installation token: one repository, `contents: write` and `metadata: read`. The cloud keeps no copy; a token it minted and could not hand out is revoked first.
 * A mint that fails after the marker was set leaves the attempt without a credential: the runner reports `push_failed` and the install is retried as a new attempt.
 * Statuses: 401, 400, 404 (no such job of this runner for this setup), 409 `job_superseded` | `job_not_active` | `push_not_started` | `already_issued` | `app_not_installed` | `repo_unnamed`, 502 `token_scope_mismatch`, 503.
 */
const NO_STORE = { "cache-control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSAL: Record<string, [number, string, string]> = {
  not_found: [404, "not_found", "no such job"],
  superseded: [409, "job_superseded", "a later attempt replaced this job"],
  not_active: [409, "job_not_active", "this job is not running"],
  not_ready: [409, "push_not_started", "the push step has not begun"],
  // D#845 ON-27c2: a twin publish whose private set or base is no longer the signed one is told so, and nothing is minted.
  set_changed: [409, "pairing_changed", "the twin's private paths changed since this job was issued"],
  already_issued: [409, "already_issued", "the credential of this attempt was already handed out"],
};

export async function setupPushTokenRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, setupId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, setupPushTokenPath(setupId), req, { replay: "once" });
  if (!UUID.test(setupId)) throw new RunnerHttpError(404, "not_found", "no such setup");
  const { job_id: jobId } = parseMessage(SetupPushTokenMessage, parseJsonBody(req));
  const port = deps.setupPush;
  if (!port) throw new RunnerHttpError(503, "not_configured", "the runner API has no push credential configured");
  const granted = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      // an engine_update job is fenced by its own definer (migration 1093); every other job by 1071's
      const definers = await definersForJob(client, runner.accountId, setupId.toLowerCase(), jobId.toLowerCase());
      const { rows } = await client.query<{ o_result: string; o_repo_id: string | null }>(definers.grant, [setupId.toLowerCase(), jobId.toLowerCase()]);
      const row = rows[0];
      if (row?.o_result !== "ok" || !row.o_repo_id) return { ok: false, result: row?.o_result ?? "not_found" } as const;
      const repo = (await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2", [runner.accountId, row.o_repo_id])).rows[0];
      return { ok: true, id: row.o_repo_id, owner: repo?.gh_owner ?? null, name: repo?.gh_name ?? null, publicTarget: definers.publicTarget } as const;
    }),
  );
  if (!granted.ok) {
    const [status, code, message] = REFUSAL[granted.result] ?? ([404, "not_found", "no such job"] as [number, string, string]);
    throw new RunnerHttpError(status, code, message);
  }
  if (granted.owner === null || granted.name === null) throw new RunnerHttpError(409, "repo_unnamed", "the repository has no name on record");
  // D#845 ON-27c2: a twin publish pushes to the PUBLIC repository (the grant answered it from the twin's own row): the hosted public-push token, contents and pull_requests write on that one repository (gh-policy's public-side rule).
  const hosted = granted.publicTarget ? (deps.planePush ?? null) : null;
  if (granted.publicTarget && hosted === null) throw new RunnerHttpError(503, "not_configured", "the runner API has no access for public pushes configured");
  const revoke = async (token: string): Promise<void> => void (hosted === null ? await port.revoke(token) : await hosted.revokeToken(token));
  let minted: { token: string; expiresAt: Date };
  try {
    minted = hosted === null ? await port.mint({ id: granted.id, owner: granted.owner, name: granted.name }) : await hosted.mintToken(`${granted.owner}/${granted.name}`, runner.accountId);
  } catch (error) {
    // fx-swallow-ok: mapped to a fixed status below; nothing of the error (it may name an installation) is sent
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    const reason = typeof error === "object" && error !== null ? (error as { reason?: unknown }).reason : undefined;
    if (code === "app_not_installed" || code === "code_repo_installation_not_owned") throw new RunnerHttpError(409, "app_not_installed", "the GitHub App is not installed on the repository");
    if (reason === "token_scope_mismatch" || code === "token_scope_mismatch") throw new RunnerHttpError(502, "token_scope_mismatch", "GitHub did not narrow the token as asked");
    throw new RunnerHttpError(503, "github_unavailable", "GitHub could not be asked");
  }
  try {
    return { status: 200, body: SetupPushTokenReply.parse({ token: minted.token, expires_at: minted.expiresAt.toISOString() }), headers: NO_STORE };
  } catch (error) {
    await revoke(minted.token);
    throw error;
  }
}
