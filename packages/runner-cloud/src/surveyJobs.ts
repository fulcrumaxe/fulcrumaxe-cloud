import type { PoolClient } from "pg";
import { reportError } from "@fx/telemetry";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { blockError, blockFor, readRepoVisibility } from "./repoPrivacy.js";
import { RunPullRequestError } from "./runPullRequest.js";

/**
 * D#845 ON-10b1 and ON-10b2 (Ruling 88 items 7 and 8): the cloud starts a project survey for an owner or admin. The first look is the person's own tenant transaction (the setup is theirs and at the survey step, its repo is
 * placed, and that machine's Claude login is one they may use); then the repo must be private and the default branch's head is read through the App's read-only port. The worker's `startSurveyRun` does the rest, and
 * the deadline Workflow is started once the run exists; if that start throws, the run is cancelled at once and the answer is 503 `survey_unavailable`. Nothing is written before the worker's start, and every refusal
 * writes nothing. `retrySurvey` is the same start for a survey that failed or has no live run (409 `not_retryable` otherwise; any body is 400).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): RunnerHttpError => new RunnerHttpError(status, code, message, extra);

interface FirstLook {
  repoId: string;
  priorRunId: string | null;
  runnerId: string;
  owner: string | null;
  name: string | null;
  credentialMode: string;
  registeredBy: string;
  engine: string | null;
}

async function firstLook(client: PoolClient, accountId: string, setupId: string): Promise<FirstLook> {
  const role = await requireMemberRole(client);
  if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start the survey");
  const setup = (await client.query<{ repo_id: string; phase: string; survey_run_id: string | null }>("SELECT repo_id, phase, survey_run_id FROM project_setups WHERE account_id = $1 AND id = $2", [accountId, setupId])).rows[0];
  if (!setup) throw refuse(404, "not_found", "no such setup");
  if (setup.phase !== "survey") throw refuse(409, "setup_phase", "the setup is not at the survey step");
  const placed = (
    await client.query<{ runner_id: string; credential_mode: string; registered_by: string; sandbox_engine: string | null; gh_owner: string | null; gh_name: string | null }>(
      `SELECT pp.runner_id, rn.credential_mode, rn.registered_by, f.sandbox_engine, r.gh_owner, r.gh_name
         FROM project_placements pp
         JOIN runners rn ON rn.account_id = pp.account_id AND rn.id = pp.runner_id AND rn.revoked_at IS NULL
         JOIN repos r ON r.account_id = pp.account_id AND r.id = pp.repo_id
         LEFT JOIN runner_facts f ON f.account_id = pp.account_id AND f.runner_id = pp.runner_id
        WHERE pp.account_id = $1 AND pp.repo_id = $2`,
      [accountId, setup.repo_id],
    )
  ).rows[0];
  if (!placed) throw refuse(409, "setup_not_placed", "the project is not placed on a machine");
  return { repoId: setup.repo_id, priorRunId: setup.survey_run_id, runnerId: placed.runner_id, owner: placed.gh_owner, name: placed.gh_name, credentialMode: placed.credential_mode, registeredBy: placed.registered_by, engine: placed.sandbox_engine };
}

export interface StartedSurvey {
  setup_id: string;
  run_id: string;
}

/** Starts the survey of a setup. Used by the confirm route and the retry route (ON-10b2) and, later, Start over (ON-11). */
export async function startSurvey(deps: RunnerCloudDeps, principal: SessionPrincipal, setupId: string): Promise<StartedSurvey> {
  if (!UUID.test(setupId)) throw refuse(404, "not_found", "no such setup");
  const runs = (await deps.surveyRuns?.()) ?? null;
  const github = deps.pullRequests ?? null;
  const deadline = deps.surveyDeadline ?? null;
  if (runs === null || github === null || deadline === null) throw refuse(503, "not_configured", "the cloud cannot start a survey now");
  const id = setupId.toLowerCase();
  const first = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => firstLook(client, principal.accountId, id));
  // A subscription machine takes only runs its registrant started (the claim would never offer this one to anyone else), so refuse now rather than let a survey wait 22 minutes and time out.
  if (first.credentialMode === "subscription" && first.registeredBy !== principal.userId) throw refuse(409, "survey_needs_machine_owner", "this machine's Claude login belongs to someone else on the team");
  const block = blockFor(await readRepoVisibility(deps, principal.accountId, first.repoId));
  if (block !== null) throw blockError(block);
  if (first.owner === null || first.name === null) throw refuse(409, "survey_not_started", "the repository has no name on record", { reason: "survey_prompt_input" });
  const repo = { id: first.repoId, owner: first.owner, name: first.name };
  let head: string;
  try {
    const branch = await github.defaultBranch(repo);
    const state = await github.branchState({ repo, branch, base: branch });
    if (!state.exists || state.headOid === null) throw refuse(409, "default_branch_empty", "the default branch has no commit yet");
    head = state.headOid;
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    if (error instanceof RunPullRequestError) throw error.retryable ? refuse(503, "github_unavailable", "GitHub could not be read now") : refuse(502, "github_refused", "GitHub refused the read");
    throw error;
  }
  const result = await runs.startSurveyRun({
    accountId: principal.accountId,
    userId: principal.userId,
    setupId: id,
    repoId: first.repoId,
    runnerId: first.runnerId,
    owner: first.owner,
    name: first.name,
    headSha: head,
    priorRunId: first.priorRunId,
    ...(first.engine === "microvm" ? { requiresEngine: "microvm" as const } : {}),
  });
  if (result.ok) {
    try {
      await deadline.start({ accountId: principal.accountId, setupId: id, runId: result.runId });
    } catch (error) {
      reportError(error, { stage: "survey.deadline_start" });
      // No survey is left without its deadline: end the run now. If even that fails the run is still live and its end is written by whoever ends it; the answer is the same.
      await runs.endSurveyAtDeadline({ accountId: principal.accountId, setupId: id, runId: result.runId, cancel: true }).catch((cancelError: unknown) => reportError(cancelError, { stage: "survey.deadline_cancel" }));
      throw refuse(503, "survey_unavailable", "the survey could not be started now. Try again");
    }
    return { setup_id: id, run_id: result.runId };
  }
  if (result.code === "forbidden") throw refuse(403, "forbidden", "only an owner or admin can start the survey");
  if (result.code === "survey_running") throw refuse(409, "survey_running", "a survey is already running", { run_id: result.runId });
  if (result.code === "survey_not_started") throw refuse(409, "survey_not_started", "the survey could not be started", { reason: result.reason });
  throw new RunnerHttpError(500, "internal", "internal error");
}

/**
 * POST /api/v1/setups/:id/survey/retry. An owner or admin, a session, no body. Allowed only at the survey step and only when nothing is running: the survey failed, or it has no run, or its run is over. Anything else is 409
 * `not_retryable`. It is `startSurvey`, so two clicks make one run (the second answers 409 `survey_running`).
 */
export async function retrySurvey(deps: RunnerCloudDeps, principal: SessionPrincipal, setupId: string, body: unknown): Promise<RunnerHttpResponse> {
  if (body !== null && body !== undefined) throw refuse(400, "invalid_message", "this request takes no body");
  if (!UUID.test(setupId)) throw refuse(404, "not_found", "no such setup");
  const id = setupId.toLowerCase();
  await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start the survey");
    const setup = (await client.query<{ phase: string; state: string; survey_run_id: string | null }>("SELECT phase, state, survey_run_id FROM project_setups WHERE account_id = $1 AND id = $2", [principal.accountId, id])).rows[0];
    if (!setup) throw refuse(404, "not_found", "no such setup");
    const notRetryable = (): RunnerHttpError => refuse(409, "not_retryable", "the survey is not in a state that can be retried");
    if (setup.phase !== "survey") throw notRetryable();
    if (setup.state === "failed" || setup.survey_run_id === null) return;
    const run = (await client.query<{ status: string }>("SELECT status FROM agent_runs WHERE account_id = $1 AND id = $2", [principal.accountId, setup.survey_run_id])).rows[0];
    if (run && (run.status === "pending" || run.status === "running" || run.status === "paused")) throw notRetryable();
  });
  return { status: 200, body: await startSurvey(deps, principal, id), headers: { "cache-control": "no-store" } };
}
