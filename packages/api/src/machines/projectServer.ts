import { RunnerHttpError, removeProjectCloudOnly, type RunnerCloudDeps } from "@fx/runner-cloud";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ApiError } from "../errors.js";
import { DELETE_RUN_MAX_MINUTES, ensureCredential, requireCredential } from "./lifecycle.js";
import { machineServerDeps, type ServerCtx } from "./servers.js";

/**
 * D#845 MC-12: "Also delete server" on a project's Remove sheet. The route only checks and starts: one Workflow run then removes the project's cloud parts (the machine parts
 * are skipped: deleting the server deletes its disk, and with it the sandbox and snapshots) and then runs MC-7's delete, which revokes the runner and deletes the server at Hetzner.
 * Both halves are safe to repeat, so a retried step finishes what an earlier try left.
 */
export interface ProjectServerArgs { serverId: string; repoId: string; removalPr: boolean }

/** Where the repo stands against the server: on the server's runner (`here`) or on another machine (`elsewhere`). A runner holds one project, so `here` is the whole of what the server holds. */
export async function projectServerState(ctx: ServerCtx, serverId: string, repoId: string): Promise<{ here: boolean; elsewhere: boolean; credential_id: string; provider_server_id: string | null; at_hetzner: boolean; status: string }> {
  const { accountId, userId } = ctx.principal;
  const row = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<{ here: boolean; elsewhere: boolean; credential_id: string; provider_server_id: string | null; at_hetzner: boolean; status: string }>(
    `SELECT EXISTS (SELECT 1 FROM project_placements p WHERE p.account_id = $1 AND p.repo_id = $3 AND p.runner_id = s.runner_id) AS here,
            EXISTS (SELECT 1 FROM project_placements p WHERE p.account_id = $1 AND p.repo_id = $3 AND p.runner_id IS DISTINCT FROM s.runner_id) AS elsewhere,
            s.credential_id, s.provider_server_id, (s.provider_server_id IS NOT NULL OR s.provider_firewall_id IS NOT NULL) AS at_hetzner, s.status
       FROM managed_servers s WHERE s.account_id = $1 AND s.id = $2 AND s.status <> 'deleted'`, [accountId, serverId, repoId])).rows[0]);
  if (!row) throw new ApiError(404, "not_found", "no such server");
  return row;
}

/** Refuses what the sheet's box must never do: the project is on another machine, or (when it must be there) not on this one. Nothing is written. */
function check(s: Awaited<ReturnType<typeof projectServerState>>, allowGone: boolean): void {
  if (s.elsewhere || (!allowGone && !s.here)) throw new ApiError(409, "project_not_on_server", "That project is not placed on this server");
}

/**
 * The route's work: checks, refuses a running install and a token that is not the one that made the server (so the person hears it now, not from a step; a reconnected token for the same Hetzner project is accepted and the server follows it), and, last, marks the server
 * `deleting` before the run starts. That mark is what keeps the project from being placed on the server again between the run's two steps (placement skips a server being deleted),
 * and it takes the server out of the sheet's lookup. A run that cannot be started puts the status back.
 */
export async function startProjectServerDelete(ctx: ServerCtx, a: ProjectServerArgs): Promise<void> {
  const { accountId, userId } = ctx.principal;
  const state = await projectServerState(ctx, a.serverId, a.repoId);
  check(state, false);
  if (state.status === "deleting") throw new ApiError(409, "server_deleting", "This server is already being deleted");
  if (state.at_hetzner) state.credential_id = await ensureCredential(ctx, { id: a.serverId, credential_id: state.credential_id, provider_server_id: state.provider_server_id });
  const running = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query(
    "SELECT 1 FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND kind IN ('project_setup', 'engine_update') AND state IN ('issued', 'delivered') LIMIT 1", [accountId, a.repoId])).rows.length > 0);
  if (running) throw new ApiError(409, "setup_running", "Wait for the install to finish, or let it fail, then remove");
  if (!machineServerDeps.startServerDelete) throw new ApiError(503, "not_configured", "Deleting a server with its project is not available right now");
  const mark = (to: string, from: string) => withTenant(ctx.pool, accountId, userId, (c) => c.query(
    "UPDATE managed_servers SET status = $3, status_at = now() WHERE account_id = $1 AND id = $2 AND status = $4", [accountId, a.serverId, to, from]));
  const marked = await mark("deleting", state.status);
  if (marked.rowCount !== 1) throw new ApiError(409, "project_not_on_server", "That server changed while this was being checked. Close this and try again");
  try {
    // The token may have been removed between the check above and the mark; from here on its removal is refused, so one more look closes the gap.
    if (state.at_hetzner) await requireCredential(ctx, state.credential_id);
    await machineServerDeps.startServerDelete({ accountId, userId, ...a });
  } catch (e) {
    await mark(state.status, "deleting");
    throw e;
  }
}

/**
 * `DELETE_RUN_MAX_MINUTES` (30) is how long a delete run is expected to hold a server at `deleting`. A soft window: a typical run ends well inside it, but a Hetzner that times out on every
 * call can keep one going for longer (two steps of up to four tries, each try several timeouts). A run that goes over meets the token check on its next try, which refuses before anything is
 * destroyed, so that check is the backstop and the window only a courtesy. The bound exists so a dead run (killed on its last try, which never marks the row) cannot hold the token for ever.
 */
export { DELETE_RUN_MAX_MINUTES };

/**
 * The token's removal is refused while a server of the account is being deleted with that token: that server's last step needs it, and with none connected it would keep billing with
 * no way to delete it. Only a recent `deleting` row counts (see DELETE_RUN_MAX_MINUTES), and only one whose token is still `ok`: a token Hetzner no longer accepts cannot finish the
 * delete, and removing it is the way to replace it. Checked at the removal; the delete's own start looks at the token again after it marks the server, so the two can both pass only
 * inside the same few milliseconds.
 */
export async function refuseWhileDeleting(ctx: Pick<ServerCtx, "pool" | "principal">): Promise<void> {
  const { accountId, userId } = ctx.principal;
  const busy = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query(
    `SELECT 1 FROM managed_servers s
       JOIN machine_provider_credentials k ON k.account_id = s.account_id AND k.id = s.credential_id
      WHERE s.account_id = $1 AND s.status = 'deleting' AND s.status_at > now() - make_interval(mins => $2::int)
        AND k.status = 'ok' AND k.removed_at IS NULL LIMIT 1`, [accountId, DELETE_RUN_MAX_MINUTES])).rows.length > 0);
  if (busy) throw new ApiError(409, "credential_in_use", "A server is being deleted with this Hetzner token. Wait for the delete to finish, then remove the token");
}

/** The run's first step. A repo that is already gone (an earlier try got that far) is fine; one that moved to another machine in the meantime is refused, never removed. */
export async function removeProjectOfServer(ctx: ServerCtx, deps: RunnerCloudDeps, a: ProjectServerArgs): Promise<void> {
  const state = await projectServerState(ctx, a.serverId, a.repoId);
  check(state, true);
  // The route checked this before the run began; a token removed since then ends the run here, before any project part is removed.
  if (state.at_hetzner) await requireCredential(ctx, state.credential_id);
  try {
    await removeProjectCloudOnly(deps, ctx.principal, a.repoId, a.removalPr);
  } catch (e) {
    if (e instanceof RunnerHttpError) throw new ApiError(e.status, e.code, e.message);
    throw e;
  }
}
