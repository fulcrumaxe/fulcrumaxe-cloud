import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type SessionPrincipal } from "./http.js";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { moveProject } from "./placement.js";
import { configuredWakeKey } from "./wakeToken.js";
import { RunPullRequestError } from "./runPullRequest.js";
import {
  asPerson, hadSession, insertJob, readOperate, repoOperated, requireEngineCoverage, requireOwnerOrAdmin, signerOf, type SessionTarget,
} from "./engineSession.js";

/**
 * D#845 MC-9b1: moving a project's engine to another machine. One tenant transaction, so a refusal at any step changes nothing:
 *   1. the placement, both machines' repository lists and `project.moved` (MC-9's `moveProject`: owner or admin, the new machine eligible and not still removing this repo, the plan holder's check);
 *   2. the start the old machine has not been handed yet (`issued`) is taken back, so it can never start the engine after the move; one it holds (`delivered`) is its own, and the stop below comes after it;
 *   3. when the old machine ever ran this engine, a `machine_cleanups` request with reason `move` (migration 1083, on ON-16a1's table) for it. NO stop or delete is issued here: the old machine's own claim issues
 *      `engine_session_stop {reason: "move"}` at once, and `engine_session_delete` only after the NEW session's first heartbeat, so a start that never comes up leaves the old copy in place, and a machine that is offline
 *      gets both when it comes back. There is no "Remove the old copy" button;
 *   4. `engine_session_start {at_sha: <default branch head>, resume: false}` to the NEW machine, person-issued behind the coverage and operate gates every start has.
 * A machine that was removed has nothing to stop or delete, so it gets no request; the move is the placement and the start. After the commit the old machine is woken so its claim comes at once.
 *
 * Gates, before anything is signed or written: 403 `forbidden`; 404 `not_found` (a repo or machine that is not the account's); 409 `project_not_placed`, `machine_not_eligible`, `machine_single_project`, `removal_pending`
 * (the target still has to finish removing or moving off this repo), `operate_off`, `session_changed`, `default_branch_empty`; 402 `plan_required`, `account_held`, `engine_quantity`; 409 `state_carry_unavailable` (the carry is
 * MC-9b2); 503 `not_configured`, `github_unavailable`; 502 `github_refused`. Every query names the account itself, on top of row security.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA40 = /^[0-9a-f]{40}$/;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

export interface MovedEngine {
  from_runner_id: string;
  to_runner_id: string;
  start_job_id: string;
  operate_epoch: number;
  /** `queued`: the old machine has a stop and a delete to run when it claims. `none`: it never ran this engine, or it was removed. */
  old_copy: "queued" | "none";
}

async function defaultBranchHead(deps: RunnerCloudDeps, repo: { id: string; owner: string; name: string }): Promise<string> {
  const github = deps.pullRequests ?? null;
  if (github === null) throw refuse(503, "not_configured", "the cloud cannot issue an engine job now");
  try {
    const branch = await github.defaultBranch(repo);
    const state = await github.branchState({ repo, branch, base: branch });
    if (!state.exists || state.headOid === null || !SHA40.test(state.headOid)) throw refuse(409, "default_branch_empty", "the default branch has no commit yet");
    return state.headOid;
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    if (error instanceof RunPullRequestError) throw error.retryable ? refuse(503, "github_unavailable", "GitHub could not be read now") : refuse(502, "github_refused", "GitHub refused the read");
    throw error;
  }
}

/** The machine the project is placed on and whether it was removed. The one place a removed machine is allowed, because "its machine was removed" is a reason to move. */
export async function placedOn(client: PoolClient, accountId: string, repoId: string): Promise<{ runnerId: string; removed: boolean; owner: string | null; name: string | null; ghRepoId: number }> {
  const repo = (await client.query<{ gh_repo_id: string; gh_owner: string | null; gh_name: string | null }>("SELECT gh_repo_id, gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2", [accountId, repoId])).rows[0];
  if (!repo) throw refuse(404, "not_found", "no such repository");
  const placed = (await client.query<{ runner_id: string; removed: boolean }>(
    `SELECT pl.runner_id, (rn.revoked_at IS NOT NULL) AS removed FROM project_placements pl JOIN runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id WHERE pl.account_id = $1 AND pl.repo_id = $2`,
    [accountId, repoId],
  )).rows[0];
  if (!placed) throw refuse(409, "project_not_placed", "the project is not placed on a machine");
  return { runnerId: placed.runner_id, removed: placed.removed, owner: repo.gh_owner, name: repo.gh_name, ghRepoId: Number(repo.gh_repo_id) };
}

/** Whether the machine holds a start of this repo that is not finished (`issued` or `delivered`). Named by the account, on top of row security. */
async function liveStart(client: PoolClient, accountId: string, repoId: string, runnerId: string): Promise<boolean> {
  return (await client.query("SELECT 1 FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND kind = 'engine_session_start' AND state IN ('issued', 'delivered') LIMIT 1", [accountId, repoId, runnerId])).rows.length > 0;
}

export async function moveEngineProject(deps: RunnerCloudDeps, principal: SessionPrincipal, input: { repoId: string; toRunnerId: string; carryState?: boolean }): Promise<MovedEngine> {
  if (!UUID.test(input.repoId)) throw refuse(404, "not_found", "no such repository");
  if (!UUID.test(input.toRunnerId)) throw refuse(404, "not_found", "no such machine");
  const repoId = input.repoId.toLowerCase();
  const toRunnerId = input.toRunnerId.toLowerCase();
  const { accountId } = principal;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, accountId, principal.userId, fn);
  // The cheap refusals first, so a move that cannot be made never costs a GitHub call. The same gates run again under the lock below.
  const first = await asPerson(() => tenant(async (client) => {
    await requireOwnerOrAdmin(client);
    const placed = await placedOn(client, accountId, repoId);
    await requireEngineCoverage(client, accountId, repoId);
    if (!(await readOperate(client, accountId, false)).enabled || !(await repoOperated(client, accountId, repoId))) throw refuse(409, "operate_off", "operate is off, so the engine cannot be started on the new machine");
    return placed;
  }));
  // After the role check: a member is told 403 whether or not the cloud can sign a job.
  const signer = await signerOf(deps);
  if (first.owner === null || first.name === null) throw refuse(409, "default_branch_empty", "the repository has no name on record");
  const head = await defaultBranchHead(deps, { id: repoId, owner: first.owner, name: first.name });

  const moved = await asPerson(() => tenant(async (client) => {
    await requireOwnerOrAdmin(client);
    // The lock every session issuer takes, so a start, a stop and a move of this repo never interleave, and two clicks make one move.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`engine_session:${accountId}:${repoId}`]);
    const placed = await placedOn(client, accountId, repoId);
    if (placed.runnerId !== first.runnerId) throw refuse(409, "session_changed", "the project moved while the job was made; try again");
    await requireEngineCoverage(client, accountId, repoId);
    const operate = await readOperate(client, accountId, true);
    if (!operate.enabled || operate.epoch < 1 || !(await repoOperated(client, accountId, repoId))) throw refuse(409, "operate_off", "operate is off, so the engine cannot be started on the new machine");
    // Whether the old machine has anything to clean up, read before its undelivered start is taken back.
    const needed = !placed.removed && ((await hadSession(client, accountId, { accountId, repoId, ghRepoId: placed.ghRepoId, owner: null, name: null, runnerId: placed.runnerId })) || (await liveStart(client, accountId, repoId, placed.runnerId)));
    const out = await moveProject(client, { accountId, userId: principal.userId }, { repoId, toRunnerId, carryState: input.carryState, now: (deps.now ?? (() => new Date()))(), wakeEnabled: configuredWakeKey(deps.wakeKey) !== null });
    await client.query("SELECT machine_cleanup_supersede_starts($1, $2)", [repoId, out.from_runner_id]);
    if (needed) await client.query("SELECT machine_cleanup_request_move($1, $2)", [repoId, out.from_runner_id]);
    const session: SessionTarget = { accountId, repoId, ghRepoId: placed.ghRepoId, owner: first.owner, name: first.name, runnerId: out.to_runner_id };
    const startJobId = await insertJob(client, deps, signer, session, { kind: "engine_session_start", args: { at_sha: head, resume: false, operate_epoch: operate.epoch } });
    await client.query("SELECT audit_write('engine_session.started', $1::jsonb)", [JSON.stringify({ repo_id: repoId, job_id: startJobId, resume: false })]);
    return { from_runner_id: out.from_runner_id, to_runner_id: out.to_runner_id, start_job_id: startJobId, operate_epoch: operate.epoch, old_copy: needed ? ("queued" as const) : ("none" as const) };
  }));
  // The wake: the old machine claims within seconds and its claim issues the stop.
  if (moved.old_copy === "queued") void markRunnerWork(accountId);
  return moved;
}
