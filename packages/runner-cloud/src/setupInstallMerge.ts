import type { PoolClient } from "pg";
import { summarizeInstall } from "@fx/core/src/onboarding/installSummary.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import type { InstallPullRequest, PullRequestRepo, SetupInstallPort } from "./runPullRequest.js";
import { installPathRefused } from "./setupInstallPr.js";
import { githubFailure } from "./setupJobs.js";

/**
 * D#845 ON-20a: what the install pull request is, and the person's click that merges it.
 *
 * `installSummaryRun` (any member of the account) and `installMergeRun` (an owner or admin, with a session: the routes take no token and no runner signature) share one read, `readInstall`: the setup's recorded
 * pull request number and pushed commit come from OUR rows (never the request); GitHub is asked for that pull request (A30) and for the pushed commit's parents (A25). The pull request is what the cloud opened
 * only if its head IS `install_head_sha` (else 409 `install_pr_changed`, as for a pull request closed without a merge), that commit's one parent IS the job's `base_sha`, and every file is one the install may
 * hold, in a list that is whole (else 409 `install_pr_files_differ`). Nothing here merges on its own: the reconcile job, the install step and the watch never call `mergeInstall`; this click is its only caller (Ruling 95).
 *
 * The merge takes the setup's row lock, reads everything again under it, writes `project.install_merged` (the clicking person, the setup, the pull request number and the head commit) in the same transaction, and
 * then asks GitHub to squash-merge exactly that number at exactly that head. A refusal throws and the audit row rolls back with it. A pull request that is already merged at that head answers 200 `already: true`;
 * if GitHub shows OUR App made that merge and no row was written yet (the answer was lost, or the commit failed), the same click writes it, once (`install_merge_recorded_at`); a merge a person made on GitHub is never
 * recorded as this click. The setup itself moves on by the watch (migration 1073), not by this route.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);
const NO_STORE = { "cache-control": "no-store" };

interface Facts { setupId: string; repo: PullRequestRepo; phase: string; state: string; number: number; head: string; base: string; recorded: boolean }

/** The setup's own rows (row security and an explicit account predicate), and the job's base commit through the definer of migration 1088. */
async function loadFacts(client: PoolClient, accountId: string, setupId: string, lock: boolean): Promise<Facts> {
  const { rows } = await client.query<{ phase: string; state: string; install_pr: number | null; install_head_sha: string | null; repo_id: string; gh_owner: string | null; gh_name: string | null; base_sha: string | null; recorded: boolean }>(
    `SELECT s.phase, s.state, s.install_pr, s.install_head_sha, r.id AS repo_id, r.gh_owner, r.gh_name, setup_install_base(s.id) AS base_sha, s.install_merge_recorded_at IS NOT NULL AS recorded
       FROM project_setups s JOIN repos r ON r.account_id = s.account_id AND r.id = s.repo_id
      WHERE s.account_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
    [accountId, setupId],
  );
  const r = rows[0];
  if (!r) throw refuse(404, "not_found", "no such setup");
  if ((r.phase !== "await_merge" && r.phase !== "finish") || r.install_pr === null || r.install_head_sha === null || !SHA.test(r.install_head_sha) || r.base_sha === null || !SHA.test(r.base_sha) || r.gh_owner === null || r.gh_name === null) {
    throw refuse(409, "setup_phase", "the setup has no install pull request to look at");
  }
  return { setupId, repo: { id: r.repo_id, owner: r.gh_owner, name: r.gh_name }, phase: r.phase, state: r.state, number: r.install_pr, head: r.install_head_sha, base: r.base_sha, recorded: r.recorded };
}

/** GitHub's view of the pull request, held to the setup's rows. */
async function readInstall(port: SetupInstallPort, f: Facts): Promise<InstallPullRequest> {
  const pr = await github(() => port.installPullRequest({ repo: f.repo, number: f.number }));
  if (pr === null || pr.state === "CLOSED") throw refuse(409, "install_pr_changed", "the install pull request was closed or changed on GitHub");
  // somebody pushed to the branch since the runner's push: the summary the person saw is not this pull request any more (the UI rebuilds it on this code)
  if (pr.headSha !== f.head) throw refuse(409, "install_pr_changed", "the install pull request was closed or changed on GitHub");
  const parents = await github(() => port.commitParents({ repo: f.repo, sha: f.head }));
  if (parents === null || parents.length !== 1 || parents[0] !== f.base || !pr.complete || pr.files.length === 0 || pr.files.some((file) => installPathRefused(file.path))) {
    throw refuse(409, "install_pr_files_differ", "the install pull request no longer holds the files that were prepared");
  }
  return pr;
}

const need = (deps: RunnerCloudDeps, setupId: string): SetupInstallPort => {
  if (!UUID.test(setupId)) throw refuse(404, "not_found", "no such setup");
  return deps.setupInstall ?? (() => { throw refuse(503, "not_configured", "the cloud cannot read GitHub now"); })();
};

/** GET /api/v1/setups/:id/install/summary. */
export async function installSummaryRun(deps: RunnerCloudDeps, principal: SessionPrincipal, setupId: string): Promise<RunnerHttpResponse> {
  const port = need(deps, setupId);
  const f = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    await requireMemberRole(client);
    return loadFacts(client, principal.accountId, setupId.toLowerCase(), false);
  });
  const pr = await readInstall(port, f);
  return {
    status: 200,
    body: { setup_id: f.setupId, pr_number: f.number, head_sha: f.head, merged: pr.merged, pr_url: `https://github.com/${f.repo.owner}/${f.repo.name}/pull/${f.number}`, ...summarizeInstall(pr.files) },
    headers: NO_STORE,
  };
}

/** Runs one GitHub call; anything but one of our own refusals becomes the fixed 502 or 503. */
async function github<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    return githubFailure(error);
  }
}

/**
 * Writes `project.install_merged` for the clicking person, once for this setup: the marker column and the row go in together, under the setup's lock, so a repeat writes nothing (`app_user` cannot read the
 * audit log, so the marker is what says "already written"). It is how a merge GitHub made whose answer was lost, or whose commit failed, is still recorded by the next click.
 */
async function record(client: PoolClient, principal: SessionPrincipal, f: Facts): Promise<void> {
  const marked = await client.query("UPDATE project_setups SET install_merge_recorded_at = now() WHERE account_id = $1 AND id = $2 AND install_merge_recorded_at IS NULL", [principal.accountId, f.setupId]);
  if (marked.rowCount === 1) await client.query("SELECT audit_write('project.install_merged', $1::jsonb)", [JSON.stringify({ actor: principal.userId, setup_id: f.setupId, pr_number: f.number, head_sha: f.head })]);
}

/** POST /api/v1/setups/:id/install/merge. */
export async function installMergeRun(deps: RunnerCloudDeps, principal: SessionPrincipal, setupId: string): Promise<RunnerHttpResponse> {
  const port = need(deps, setupId);
  const id = setupId.toLowerCase();
  let res: RunnerHttpResponse;
  try {
    res = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const role = await requireMemberRole(client);
      if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can merge the install");
      const f = await loadFacts(client, principal.accountId, id, true);
      const done = (already: boolean): RunnerHttpResponse => ({ status: 200, body: { setup_id: id, pr_number: f.number, merged: true, already }, headers: NO_STORE });
      if (f.recorded) return done(true);
      // Already merged: recorded here only when GitHub says OUR App made the merge (only this route does), so a merge a person made on GitHub is never taken for this click.
      if (f.phase === "finish") {
        const seen = await github(() => port.installPullRequest({ repo: f.repo, number: f.number }));
        if (seen?.merged === true && seen.headSha === f.head && seen.mergedByApp) await record(client, principal, f);
        return done(true);
      }
      if (f.state !== "ok") throw refuse(409, "install_pr_changed", "the install pull request was closed or changed on GitHub");
      const pr = await readInstall(port, f);
      if (pr.merged) {
        if (pr.mergedByApp) await record(client, principal, f);
        return done(true);
      }
      await record(client, principal, f);
      const out = await github(() => port.mergeInstall({ repo: f.repo, number: f.number, sha: f.head }));
      if (out === "changed") throw refuse(409, "install_pr_changed", "the install pull request was changed on GitHub; look at it again");
      if (out === "blocked") throw refuse(409, "install_pr_blocked", "GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again");
      return done(false);
    });
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can merge the install");
    throw error;
  }
  // D#845 Ruling 122.1: GitHub answered merged, so the setup moves to the finish phase now, the same move the webhook's definer makes, bound to the pull request this request verified (whichever runs second finds it
  // moved and answers `none`). Only a request whose own call moved the setup marks the reconciler and starts the hand-off: a repeated click, a merge the webhook already acted on and a setup with a newer pull request start nothing.
  // A failure here is the webhook's and the tick's to cover; the merge itself is already answered.
  let moved = false;
  try {
    const pr = (res.body as { pr_number: number }).pr_number;
    moved = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => (await client.query<{ r: string }>("SELECT setup_install_merged($1::uuid, $2::int) AS r", [id, pr])).rows[0]?.r === "finished");
    if (moved) void markWorkPending("reconcile");
  } catch {
    // fx-swallow-ok: the webhook and the reconcile tick are the backstops, and the merge is already answered; one coded log line
    (deps.log ?? console.warn)(JSON.stringify({ event: "onboarding.install_merge_phase_failed", code: "definer_failed" }));
  }
  // D#845 Ruling 122: the person is waiting on the finish phase, so it starts now, for this setup alone (the transactions above have committed). A hook that throws is logged by code; the webhook and the tick still act.
  if (moved) {
    try {
      deps.afterInstallMerge?.(id);
    } catch {
      // fx-swallow-ok: the hand-off is best effort; the webhook and the reconcile tick are the backstops, and the merge is already answered
      (deps.log ?? console.warn)(JSON.stringify({ event: "onboarding.install_merge_handoff_failed", code: "hook_threw" }));
    }
  }
  return res;
}
