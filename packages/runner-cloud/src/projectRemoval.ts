import type { PoolClient } from "pg";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { emitSetupChanged } from "@fx/core/src/onboarding/engineTrack.js";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { lockEngineBridge } from "@fx/db/src/engineBridge.js";
import { GithubIdentityForbidden, readRepoGithubIdentity, setRepoGithubIdentity } from "@fx/db/src/repoGithubIdentity.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { EngineRemovalError, buildEngineRemovalPr, type EngineRemovalCode } from "./engineRemovalPr.js";
import { hadSession } from "./engineSession.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { lockRunners } from "./placement.js";

/**
 * D#845 ON-16a1: `POST /api/runners/repos/:id/remove` `{ delete_sandbox, removal_pr }`, an owner or admin on a session. One tenant transaction under the session issuers' lock
 * (`engine_session:<account>:<repo>`, so no start interleaves) removes the placement, the machine's repo entry, the tick and the setup, writes `project.removed`, and, when the machine
 * has something to stop, a `machine_cleanups` row. NO job is issued here: the machine's own claim issues them (machineCleanups.ts). After commit the machine is woken and the removal PR
 * is built when ticked; a failed PR never undoes the removal. The GitHub repository is never deleted (the PR's fenced client holds no DELETE). A repeat writes nothing in the cloud.
 * Refusals, before any write: 400 `invalid_message`, 403 `forbidden`, 404 `not_found`, 409 `setup_running`, 409 `placement_busy`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

interface Actor { accountId: string; userId: string }

/** `runner_id` null: never placed. `changed` false: nothing was left to remove, and nothing was written. */
export interface ProjectRemoval { repo_id: string; runner_id: string | null; machine_parts: "queued" | "none"; changed: boolean }

/** Whether the machine holds a start of this repo that is not finished (`issued` or `delivered`). Named by the account, on top of row security. */
async function liveStart(client: PoolClient, accountId: string, repoId: string, runnerId: string): Promise<boolean> {
  return (await client.query(
    "SELECT 1 FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND kind = 'engine_session_start' AND state IN ('issued', 'delivered') LIMIT 1",
    [accountId, repoId, runnerId],
  )).rows.length > 0;
}

/** One repo's removal in the caller's tenant transaction (role and repo already checked). `machineParts: false` never writes a cleanup. Every query names the account on top of row security. */
export async function removeProjectIn(client: PoolClient, a: Actor, repoId: string, o: { deleteSandbox: boolean; removalPr: boolean; machineParts: boolean }): Promise<ProjectRemoval> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`engine_session:${a.accountId}:${repoId}`]);
  const running = await client.query(
    "SELECT 1 FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND kind IN ('project_setup', 'engine_update') AND state IN ('issued', 'delivered') LIMIT 1",
    [a.accountId, repoId],
  );
  if (running.rows.length > 0) throw refuse(409, "setup_running", "Wait for the install to finish, or let it fail, then remove");
  await lockEngineBridge(client);
  const placed = (await client.query<{ runner_id: string; revoked: boolean; gh_repo_id: string }>(
    `SELECT pl.runner_id, (rn.revoked_at IS NOT NULL) AS revoked, g.gh_repo_id
       FROM project_placements pl
       JOIN runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id
       JOIN repos g ON g.account_id = pl.account_id AND g.id = pl.repo_id
      WHERE pl.account_id = $1 AND pl.repo_id = $2
        FOR UPDATE OF pl`,
    [a.accountId, repoId],
  )).rows[0];
  const setup = (await client.query<{ id: string }>(
    "SELECT id FROM project_setups WHERE account_id = $1 AND repo_id = $2 AND phase <> 'removed' ORDER BY created_at DESC, id DESC LIMIT 1",
    [a.accountId, repoId],
  )).rows[0];
  const ticked = (await client.query("SELECT 1 FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2", [a.accountId, repoId])).rows.length > 0;
  if (!placed && !setup && !ticked) return { repo_id: repoId, runner_id: null, machine_parts: "none", changed: false };

  let parts: ProjectRemoval["machine_parts"] = "none";
  if (placed) {
    // The locks a move takes, in its order (the placement row, then the machine's list), so a move and a removal of one machine never interleave.
    await lockRunners(client, [placed.runner_id]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`runner_register:${a.accountId}`]);
    // Ruling 92.1: a start the machine has not been handed is taken back first, in this transaction, so it can never start the engine after the removal (and needs no cleanup of its own). A start the machine
    // already holds (`delivered`) is its own: it needs the stop and delete, issued after it by the machine's claim, just as a session that ran does.
    await client.query("SELECT machine_cleanup_supersede_starts($1, $2)", [repoId, placed.runner_id]);
    const needed = o.machineParts && !placed.revoked
      && ((await hadSession(client, a.accountId, { repoId, ghRepoId: Number(placed.gh_repo_id), owner: null, name: null, runnerId: placed.runner_id }))
        || (await liveStart(client, a.accountId, repoId, placed.runner_id)));
    await client.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [a.accountId, repoId]);
    if (!placed.revoked) {
      const list = (await client.query<{ a: string[] }>("SELECT allowed_repo_ids AS a FROM runners WHERE account_id = $1 AND id = $2", [a.accountId, placed.runner_id])).rows[0]?.a ?? [];
      if (list.includes(repoId)) await client.query("SELECT runner_repos_set($1, $2::uuid[])", [placed.runner_id, list.filter((id) => id !== repoId)]);
    }
    if (needed) {
      await client.query("SELECT machine_cleanup_request($1, $2, $3)", [repoId, placed.runner_id, o.deleteSandbox]);
      parts = "queued";
    }
  }
  if (ticked) {
    await client.query("DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2", [a.accountId, repoId]);
    await writeEngineAudit(client, "engine_bridge.settings_changed", { kind: "repo_removed", repo_id: repoId });
  }
  if (setup) {
    await client.query("UPDATE project_setups SET phase = 'removed', updated_at = now() WHERE account_id = $1 AND id = $2", [a.accountId, setup.id]);
    await emitSetupChanged(client, { accountId: a.accountId, setupId: setup.id, repoId });
  }
  // Consent to act as the person on GitHub does not survive a removal: a repo added again starts on the app (migration 1121's definer; the caller is an owner or admin).
  if ((await readRepoGithubIdentity(client, a.accountId, repoId)) === "personal") {
    await setRepoGithubIdentity(client, repoId, "app");
    await writeEngineAudit(client, "project.github_identity_changed", { repo_id: repoId, github_identity: "app" });
  }
  await client.query("SELECT audit_write('project.removed', $1::jsonb)", [
    JSON.stringify({ repo_id: repoId, runner_id: placed?.runner_id ?? null, delete_sandbox: o.deleteSandbox, removal_pr: o.removalPr, machine_parts: parts }),
  ]);
  return { repo_id: repoId, runner_id: placed?.runner_id ?? null, machine_parts: parts, changed: true };
}

/**
 * MC-7's seam (MC-12 wires `removeProjects` to it): the same removal, in the caller's tenant transaction, for every repo placed on the runner (at most one: one engine per machine).
 * `machineParts: false` writes no cleanup. The caller is an owner or admin; the caller wakes the machine after commit when a result says `queued`.
 */
export async function removeProjectsOnRunner(client: PoolClient, a: Actor, runnerId: string, o: { machineParts: boolean }): Promise<ProjectRemoval[]> {
  const role = await requireMemberRole(client);
  if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can remove a project");
  const { rows } = await client.query<{ repo_id: string }>("SELECT repo_id FROM project_placements WHERE account_id = $1 AND runner_id = $2 ORDER BY repo_id", [a.accountId, runnerId]);
  const out: ProjectRemoval[] = [];
  for (const r of rows) out.push(await removeProjectIn(client, a, r.repo_id, { deleteSandbox: o.machineParts, removalPr: false, machineParts: o.machineParts }));
  return out;
}

/** What the answer says of the removal pull request: what GitHub did, or the closed code of why it could not. */
export type RemovalPrReply = { outcome: "opened" | "exists" | "nothing_to_remove"; number: number | null; branch: string; url: string | null } | { code: EngineRemovalCode };

/** A test seam: runs inside the removal's transaction right before it commits. Never set in production. */
export interface RemovalHooks { beforeCommit?: () => Promise<void> }

function parse(body: unknown): { deleteSandbox: boolean; removalPr: boolean } {
  const invalid = refuse(400, "invalid_message", "the request does not match what this route takes");
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== 2 || typeof b.delete_sandbox !== "boolean" || typeof b.removal_pr !== "boolean") throw invalid;
  return { deleteSandbox: b.delete_sandbox, removalPr: b.removal_pr };
}

async function openRemovalPr(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, repo: { owner: string | null; name: string | null }): Promise<RemovalPrReply> {
  const install = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) =>
    (await client.query<{ install_pr: number | null; engine_version: string | null }>(
      "SELECT install_pr, engine_version FROM project_setups WHERE account_id = $1 AND repo_id = $2 AND install_pr IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
      [principal.accountId, repoId],
    )).rows[0]);
  if (!install?.install_pr || !install.engine_version) return { code: "install_pr_not_merged" };
  if (!repo.owner || !repo.name || !deps.engineRemovalGithub) return { code: "github_unavailable" };
  try {
    const github = await deps.engineRemovalGithub({ repoId, owner: repo.owner, name: repo.name });
    const out = await buildEngineRemovalPr(github, { owner: repo.owner, repo: repo.name, installPr: install.install_pr, version: install.engine_version });
    return { outcome: out.outcome, number: out.prNumber, branch: out.branch, url: out.prNumber === null ? null : `https://github.com/${repo.owner}/${repo.name}/pull/${out.prNumber}` };
  } catch (error) {
    // fx-swallow-ok: a failed pull request never undoes the removal; its closed code is the answer, and anything unexpected is logged as one closed line.
    if (error instanceof EngineRemovalError) return { code: error.code };
    (deps.log ?? console.warn)(JSON.stringify({ event: "project_removal.pr_failed", code: "github_unavailable" }));
    return { code: "github_unavailable" };
  }
}

/** POST /api/runners/repos/:id/remove. See the header. 200 `{ repo_id, runner_id, machine_parts, already_removed, pr }`, `pr` null unless `removal_pr` was ticked. */
export async function removeProjectRoute(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, body: unknown, hooks: RemovalHooks = {}, o: { machineParts: boolean } = { machineParts: true }): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw refuse(404, "not_found", "no such repository");
  repoId = repoId.toLowerCase();
  const input = parse(body);
  const actor = { accountId: principal.accountId, userId: principal.userId };
  let done: ProjectRemoval & { owner: string | null; name: string | null };
  try {
    done = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const role = await requireMemberRole(client);
      if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can remove a project");
      const repo = (await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2 FOR UPDATE", [principal.accountId, repoId])).rows[0];
      if (!repo) throw refuse(404, "not_found", "no such repository");
      const out = await removeProjectIn(client, actor, repoId, { ...input, machineParts: o.machineParts });
      await hooks.beforeCommit?.();
      return { ...out, owner: repo.gh_owner, name: repo.gh_name };
    });
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    // The identity reset (a personal identity goes back to the app) throws its own class for the same 42501, so both mean "not an owner or admin of an active account".
    if (error instanceof GithubIdentityForbidden || pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can remove a project");
    // 40P01: two changes to one machine waited on each other and Postgres ended this one, which wrote nothing. Retrying is safe.
    if (pgCode(error) === "40P01") throw refuse(409, "placement_busy", "Another change to this machine is in progress. Try again.");
    throw error;
  }
  // The wake: the machine claims within seconds and its claim issues the stop (and the delete).
  if (done.machine_parts === "queued") void markRunnerWork(principal.accountId);
  const pr = input.removalPr ? await openRemovalPr(deps, principal, repoId, done) : null;
  return {
    status: 200,
    body: { repo_id: repoId, runner_id: done.runner_id, machine_parts: done.machine_parts, already_removed: !done.changed, pr },
    headers: NO_STORE,
  };
}

/**
 * D#845 MC-12: the removal of "Also delete server". The server's disk takes the sandbox and its snapshots with it, so the machine parts are skipped and no cleanup is written:
 * the cloud parts run, then the removal PR when ticked. Safe to repeat (a removed repo writes nothing and only re-tries the PR).
 */
export const removeProjectCloudOnly = (deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, removalPr: boolean): Promise<RunnerHttpResponse> =>
  removeProjectRoute(deps, principal, repoId, { delete_sandbox: false, removal_pr: removalPr }, {}, { machineParts: false });
