import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { blockError, blockFor, readRepoVisibility } from "./repoPrivacy.js";
import { RunPullRequestError } from "./runPullRequest.js";

/**
 * D#845 ON-10b1 (Ruling 88 item 8): the cloud starts a project survey, for an owner or admin. The first look is the person's own tenant transaction on the web login: the setup is theirs and waiting at the survey step, its
 * repository is placed on a machine, and that machine's Claude login is one this person may use (a subscription machine runs only its registrant's runs). Then the repository must be private (read live), and the default
 * branch's head is read through the App's read-only port. The worker's `startSurveyRun` does the rest: the seat, the fixed prompt and the one create transaction that binds the run to the setup.
 *
 * Nothing is written before the worker's start, and a refusal at any step writes nothing. Refusals: 403 `forbidden`; 404 `not_found`; 409 `setup_phase`, `setup_not_placed`, `survey_needs_machine_owner`, `public_repo`,
 * `repo_visibility_unknown`, `default_branch_empty`, `survey_running` (with `run_id`) and `survey_not_started` (with a closed `reason`); 503 `not_configured` and `github_unavailable`; 502 `github_refused`.
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
  if (runs === null || github === null) throw refuse(503, "not_configured", "the cloud cannot start a survey now");
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
  if (result.ok) return { setup_id: id, run_id: result.runId };
  if (result.code === "forbidden") throw refuse(403, "forbidden", "only an owner or admin can start the survey");
  if (result.code === "survey_running") throw refuse(409, "survey_running", "a survey is already running", { run_id: result.runId });
  if (result.code === "survey_not_started") throw refuse(409, "survey_not_started", "the survey could not be started", { reason: result.reason });
  throw new RunnerHttpError(500, "internal", "internal error");
}
