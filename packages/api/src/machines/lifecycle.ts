import { HetznerError, MANAGED_LABEL, MANAGED_LABEL_VALUE, type HetznerClient } from "@fx/hetzner";
import { RunnerHttpError, revokeProvisioningToken, revokeRunner, type RunnerCloudDeps } from "@fx/runner-cloud";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ApiError } from "../errors.js";
import { machineServerDeps, toApiError, withHetznerClient, withHetznerServerClient, type ServerCtx } from "./servers.js";

/**
 * D#845 MC-7: what happens to a server after it is made. Three jobs, none of them in a request that a person waits on, except Delete, which is the person's own act.
 *
 *  - `advanceServer`: one look at a server that is not final, run by the queued status worker. It writes the status (creating, booting, registering, then ready or needs_claude_login) from Hetzner's
 *    state and from the registered runner, and past 35 minutes it marks the row failed. It is never run on a schedule: the create starts the worker, which sleeps between
 *    looks and stops at the first final status (push, not poll).
 *  - `deleteManagedServer`: refuses while projects are placed, revokes the runner and the provisioning token, deletes the server and then the firewall (a 404 counts as
 *    deleted), and writes the audit row. Idempotent: a repeat finishes what the first left, and a deleted row answers itself without calling anything.
 *  - `sweepOrphans`: every 6 hours per credential. A server that carries our label and has no row becomes an `orphaned` row; a row whose server Hetzner no longer has becomes
 *    `deleted`. It deletes nothing. It touches only servers that carry both of our labels, and only inside the Hetzner project of this account's own credential.
 */
export const REGISTRATION_TIMEOUT_SECONDS = 35 * 60;
const FINAL = new Set(["ready", "needs_claude_login", "deleting", "deleted", "failed", "orphaned"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StatusRow {
  status: string; provider_server_id: string | null; create_action_id: string | null; runner_id: string | null; age_seconds: number; heartbeated: boolean; model_auth_present: boolean | null;
}

/** One look at one server. `final` is true once the worker has nothing more to do; `delaySeconds` is how long it sleeps before the next look. */
export async function advanceServer(ctx: ServerCtx, serverId: string): Promise<{ final: boolean; status: string; delaySeconds: number }> {
  const { accountId, userId } = ctx.principal;
  const read = () => withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<StatusRow>(
    `SELECT s.status, s.provider_server_id, s.create_action_id, s.runner_id, extract(epoch FROM now() - s.created_at)::float8 AS age_seconds,
            COALESCE(r.last_seen_at IS NOT NULL AND r.revoked_at IS NULL, false) AS heartbeated, r.model_auth_present
       FROM managed_servers s LEFT JOIN runners r ON r.account_id = s.account_id AND r.id = s.runner_id
      WHERE s.account_id = $1 AND s.id = $2`, [accountId, serverId])).rows[0]);
  /** Moves the status only from the one the worker saw, so a delete that began in between is never overwritten. */
  const move = (from: string, to: string, failure: string | null = null) => withTenant(ctx.pool, accountId, userId, (c) =>
    c.query(`UPDATE managed_servers SET status = $4, status_at = now(), failure_code = $5 WHERE account_id = $1 AND id = $2 AND status = $3`, [accountId, serverId, from, to, failure]));
  let row = await read();
  if (!row || FINAL.has(row.status)) return { final: true, status: row?.status ?? "deleted", delaySeconds: 0 };
  // D#845 MC-8a: the linked runner's hello says whether the machine is signed in to Claude: yes is `ready`, no is `needs_claude_login` (the sign-in link takes it from there). A runner that has not said
  // keeps the row `registering` (never read as signed in). After this the card's sign-in state is read from the runner's own fact on each read, and no status is written for it again.
  if (row.runner_id !== null && row.heartbeated && row.model_auth_present !== null) {
    const to = row.model_auth_present ? "ready" : "needs_claude_login";
    await move(row.status, to);
    return { final: true, status: to, delaySeconds: 0 };
  }
  if (row.provider_server_id !== null && (row.status === "creating" || row.status === "booting")) {
    const providerId = Number(row.provider_server_id);
    try {
      await withHetznerClient(ctx, async (client: HetznerClient) => {
        if (row!.status === "creating") {
          if ((await client.getServer(providerId)).status !== "running") return;
          await move("creating", "booting");
          row = { ...row!, status: "booting" };
        }
        // The create action finishing is what the person's server being up means. A create that found an earlier server stored no action: that server is already made.
        const action = row!.create_action_id === null ? null : await client.getAction(Number(row!.create_action_id));
        if (action?.status === "error") await move("booting", "failed", "hetzner_action_failed");
        else if (action === null || action.status === "success") await move("booting", "registering");
      });
    } catch (e) {
      if (e instanceof HetznerError && e.code === "not_found") await move(row!.status, "failed", "server_missing");
      // fx-swallow-ok: Hetzner or the stored token could not be read this time (down, rate limited, token revoked); the next look tries again, and the 35-minute rule below does not depend on it
    }
  }
  const now = await read();
  if (!now || FINAL.has(now.status)) return { final: true, status: now?.status ?? "deleted", delaySeconds: 0 };
  if (now.age_seconds > REGISTRATION_TIMEOUT_SECONDS) {
    await move(now.status, "failed", "registration_timeout");
    return { final: true, status: "failed", delaySeconds: 0 };
  }
  return { final: false, status: now.status, delaySeconds: now.age_seconds < 300 ? 15 : 60 };
}

const runnerDeps = (ctx: ServerCtx): RunnerCloudDeps => ({ appUserPool: ctx.pool, origin: machineServerDeps.getOrigin() ?? "", failRunnerLeases: machineServerDeps.failRunnerLeases ?? null });
/** A runner or token that is already gone or used answers 404: it can no longer be redeemed, which is what a revoke is for. Anything else is an error. */
async function revokeQuietly(f: () => Promise<unknown>, leasesMayWait = false): Promise<void> {
  try { await f(); } catch (e) {
    if (e instanceof RunnerHttpError && e.status === 404) return;
    // The sweep: the runner is revoked and its server is gone; runs it held fail when the lease sweep reaches them, so that answer must not stop the sweep.
    if (leasesMayWait && e instanceof RunnerHttpError && e.code === "leases_not_failed") return;
    throw toApiError(e);
  }
}
/** True while a create with this key is running: it holds an advisory lock for the whole create, and a create that was killed lets it go with its connection. */
async function createInFlight(ctx: ServerCtx, key: string | null): Promise<boolean> {
  if (key === null) return false;
  const { rows } = await ctx.pool.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [`machine-server-create:${ctx.principal.accountId}:${key}`]);
  return rows[0]?.got !== true;
}

export interface DeleteInput { removeProjects: boolean }
export interface DeleteResult { id: string; status: "deleted"; already_deleted: boolean }
interface DeleteRow {
  status: string; credential_id: string; provider_server_id: string | null; provider_firewall_id: string | null; runner_id: string | null; provisioning_token_id: string | null;
  failure_code: string | null; idempotency_key: string | null;
}

/** Owner or admin (the route enforces it, and opening the token checks it again). Returns once the server and its firewall are gone from Hetzner and the row says so. */
export async function deleteManagedServer(ctx: ServerCtx, id: string, input: DeleteInput): Promise<DeleteResult> {
  if (!UUID.test(id)) throw new ApiError(400, "invalid_request", "the server id is not valid");
  const { accountId, userId } = ctx.principal;
  const inTx = <T>(f: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => withTenant(ctx.pool, accountId, userId, f);
  const row = await inTx(async (c) => (await c.query<DeleteRow>(
    `SELECT status, credential_id, provider_server_id, provider_firewall_id, runner_id, provisioning_token_id, failure_code, idempotency_key FROM managed_servers WHERE account_id = $1 AND id = $2`, [accountId, id])).rows[0]);
  if (!row) throw new ApiError(404, "not_found", "no such server");
  if (row.status === "deleted") return { id, status: "deleted", already_deleted: true };
  // While the create is still running there is nothing to delete here, and a delete now would leave the server it is about to make without a row. A create that was killed
  // (a timeout, a crash, a deploy) leaves the row `creating` with no id and no lock held: then Delete goes on and finds the server by its label.
  if (row.status === "creating" && row.provider_server_id === null && (await createInFlight(ctx, row.idempotency_key))) throw new ApiError(409, "server_creating", "This server is still being created. Try again in a minute");
  const ownedBy = (l: { labels: Record<string, string> }): boolean => l.labels[MANAGED_LABEL] === MANAGED_LABEL_VALUE && l.labels["fx-server"] === id;
  const byLabel = row.provider_server_id === null && row.provider_firewall_id === null && row.provisioning_token_id !== null && (row.status === "creating" || row.status === "deleting" || row.failure_code === "cleanup_failed");

  // 1. Projects. A server whose runner holds a placement is not deleted unless the person said to remove them too.
  if (row.runner_id !== null) {
    const placed = () => inTx(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM project_placements WHERE account_id = $1 AND runner_id = $2`, [accountId, row.runner_id])).rows[0]!.n));
    if ((await placed()) > 0) {
      if (!input.removeProjects) throw new ApiError(409, "projects_placed", "Projects are placed on this server. Remove them first, or choose to remove them with it");
      if (!machineServerDeps.removeProjects) throw new ApiError(409, "project_removal_unavailable", "Removing the projects with the server isn't available yet. Remove them first");
      await machineServerDeps.removeProjects(ctx, row.runner_id);
      if ((await placed()) > 0) throw new ApiError(409, "projects_placed", "Projects are still placed on this server");
    }
  }
  // An orphan that is linked to a Hetzner server: the sweep found it by our label, but the label may have been taken off since. A server that no longer says it is ours is not
  // deleted from here, by either route (this one and delete-orphan). Gone at Hetzner is fine (404 is done).
  if (row.status === "orphaned" && row.provider_server_id !== null) {
    const labels = await withHetznerServerClient(ctx, row.provider_server_id, (client) => client.getServer(Number(row.provider_server_id)).then((s) => s.labels, (e: unknown) => {
      if (e instanceof HetznerError && e.code === "not_found") return null;
      throw e;
    })).catch((e: unknown) => { throw toApiError(e); });
    if (labels !== null && labels[MANAGED_LABEL] !== MANAGED_LABEL_VALUE) throw new ApiError(409, "not_an_orphan", "That server no longer carries our label, so it isn't deleted from here");
  }
  // A row that began as a create has a token; an orphan found by the sweep does not and has no `deleting` step. A sweep-returned orphan that kept its token does, and a "kept" mark
  // (only valid while orphaned or deleted) is cleared by the same update, so the CHECK keeps its meaning.
  if (row.provisioning_token_id !== null) await inTx((c) => c.query(`UPDATE managed_servers SET status = 'deleting', status_at = now(), kept_at = NULL, kept_by = NULL WHERE account_id = $1 AND id = $2 AND status <> 'deleted'`, [accountId, id]));

  // 2. The runner and the token: both are made useless before the machine goes, so neither can be used from a copy of its secrets.
  // Each has its own try: a runner that is already gone answers 404, and the token must still be revoked.
  const deps = runnerDeps(ctx);
  if (row.runner_id !== null) await revokeQuietly(() => revokeRunner(deps, ctx.principal, row.runner_id!));
  if (row.provisioning_token_id !== null) await revokeQuietly(() => revokeProvisioningToken(deps, ctx.principal, row.provisioning_token_id!));

  // 3. Hetzner: the server, then the firewall (Hetzner refuses to delete a firewall that is still applied). A 404 on either is deleted.
  if (row.provider_server_id !== null || row.provider_firewall_id !== null || byLabel) {
    const active = await inTx(async (c) => (await c.query<{ id: string }>(`SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND provider = 'hetzner_cloud' AND removed_at IS NULL`, [accountId])).rows[0]?.id);
    // The server belongs to the Hetzner project of the credential that made it. Another token (or none) must never be used to delete it.
    if (active !== row.credential_id) throw new ApiError(409, "credential_changed", "The Hetzner token that made this server is no longer connected. Connect it again to delete the server");
    try {
      const door = row.provider_server_id !== null ? (f: (client: HetznerClient) => Promise<void>) => withHetznerServerClient(ctx, row.provider_server_id!, f) : (f: (client: HetznerClient) => Promise<void>) => withHetznerClient(ctx, f);
      // A row with a Hetzner server id opens the token for that server through the machine-ops reader, which refuses an id that is not this account's.
      await door(async (client) => {
        // A row with no ids (a create that was killed) is found by the label its server and firewall were made with: both labels, and this row's id.
        const servers = row.provider_server_id !== null ? [Number(row.provider_server_id)] : byLabel ? (await client.listServers({ labelSelector: `fx-server=${id}` })).filter(ownedBy).map((s) => s.id) : [];
        let firewalls: number[] = [];
        if (row.provider_firewall_id !== null) firewalls = [Number(row.provider_firewall_id)];
        else if (byLabel) firewalls = (await client.listFirewalls({ labelSelector: `fx-server=${id}` })).filter(ownedBy).map((f) => f.id);
        else if (row.provider_server_id !== null) {
          // A row with a server and no firewall id (an adopted orphan): its server's own label names the create that made the firewall.
          const made = await client.getServer(Number(row.provider_server_id)).then((s) => s.labels["fx-server"], (e: unknown) => { if (e instanceof HetznerError && e.code === "not_found") return undefined; throw e; });
          if (made !== undefined) firewalls = (await client.listFirewalls({ labelSelector: `fx-server=${made}` })).filter((f) => f.labels[MANAGED_LABEL] === MANAGED_LABEL_VALUE && f.labels["fx-server"] === made).map((f) => f.id);
        }
        for (const serverId of servers) {
          const action = await client.deleteServer(serverId);
          for (let i = 0; action !== null && i < 10; i++) {
            if ((await client.getAction(action.id)).status !== "running") break;
            await new Promise((r) => setTimeout(r, machineServerDeps.actionWaitMs ?? 1000));
          }
        }
        for (const firewallId of firewalls) await client.deleteFirewall(firewallId);
      });
    } catch (e) {
      throw toApiError(e);
    }
  }

  // 4. The row and the audit entry, together.
  await inTx(async (c) => {
    await c.query(`UPDATE managed_servers SET status = 'deleted', status_at = now(), deleted_at = now(), deleted_by = $3 WHERE account_id = $1 AND id = $2 AND status <> 'deleted'`, [accountId, id, userId]);
    await c.query("SELECT audit_write('server.deleted', $1::jsonb)", [JSON.stringify({ server_id: id })]);
  });
  return { id, status: "deleted", already_deleted: false };
}

/** Hetzner's side of what the sweep found. */
export interface SweepResult { orphaned: number; deleted: number }

/** The sweep of one credential. Reads Hetzner and writes rows; calls no delete, ever. `credentialId` must be the account's own connected credential. */
export async function sweepOrphans(ctx: ServerCtx, credentialId: string): Promise<SweepResult> {
  const { accountId, userId } = ctx.principal;
  const cred = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<{ created_by: string }>(
    `SELECT created_by FROM machine_provider_credentials WHERE account_id = $1 AND id = $2 AND provider = 'hetzner_cloud' AND removed_at IS NULL AND status = 'ok'`, [accountId, credentialId])).rows[0]);
  if (!cred) return { orphaned: 0, deleted: 0 };
  return withHetznerClient(ctx, async (client) => {
    // Ours means both labels, checked here as well as asked of Hetzner: nothing else in the project is looked at again.
    const mine = (await client.listServers({ labelSelector: `${MANAGED_LABEL}=${MANAGED_LABEL_VALUE}` })).filter((s) => s.labels[MANAGED_LABEL] === MANAGED_LABEL_VALUE);
    const rows = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<{ id: string; provider_server_id: string | null; status: string; failure_code: string | null; runner_id: string | null; old: boolean }>(
      `SELECT id, provider_server_id, status, failure_code, runner_id, created_at < now() - interval '10 minutes' AS old FROM managed_servers WHERE account_id = $1 AND credential_id = $2`, [accountId, credentialId])).rows);
    const listed = new Set(mine.map((s) => String(s.id)));
    let orphaned = 0;
    for (const s of mine) {
      const sid = String(s.id);
      const owner = s.labels["fx-server"];
      // The row that holds this server: by its Hetzner id, or by the row id the server's label names (a create that has not stamped its id yet).
      const held = rows.find((r) => r.provider_server_id === sid) ?? (owner === undefined ? undefined : rows.find((r) => r.id === owner));
      if (held === undefined) {
        const made = await withTenant(ctx.pool, accountId, userId, (c) => c.query(
          `INSERT INTO managed_servers (account_id, kind, credential_id, provider_server_id, name, server_type, location, public_ipv4, status, created_by)
           VALUES ($1, 'hetzner_cloud', $2, $3, $4, $5, $6, $7::inet, 'orphaned', $8)
           ON CONFLICT (credential_id, provider_server_id) WHERE provider_server_id IS NOT NULL DO NOTHING`,
          [accountId, credentialId, sid, s.name.slice(0, 80), s.serverType.name, s.location.name, s.ipv4, cred.created_by]));
        orphaned += made.rowCount ?? 0;
      } else if (held.status === "deleted") {
        // A row says this server is gone but Hetzner still lists it with our labels (a delete that raced a create, or a mistake): it is a leftover, so the row says so again.
        const back = await withTenant(ctx.pool, accountId, userId, (c) => c.query(
          `UPDATE managed_servers SET status = 'orphaned', status_at = now(), deleted_at = NULL, deleted_by = NULL, kept_at = NULL, kept_by = NULL, provider_server_id = $3
            WHERE account_id = $1 AND id = $2 AND status = 'deleted'`, [accountId, held.id, sid]));
        orphaned += back.rowCount ?? 0;
      } else if (held.status === "creating" && held.provider_server_id === null && held.old) {
        // A create that was killed after its row was inserted (the request limit is far below ten minutes): the server it made is stamped on the row, which says so, and Delete can remove it.
        await withTenant(ctx.pool, accountId, userId, (c) => c.query(
          `UPDATE managed_servers SET status = 'failed', failure_code = 'cleanup_failed', status_at = now(), provider_server_id = $3
            WHERE account_id = $1 AND id = $2 AND status = 'creating' AND provider_server_id IS NULL`, [accountId, held.id, sid]));
      } else if (held.status === "failed" && held.failure_code === "cleanup_failed" && held.provider_server_id === null) {
        // A create that ended without a clear answer may have made this server after all: the row takes its id, so Delete can remove it.
        await withTenant(ctx.pool, accountId, userId, (c) => c.query(
          `UPDATE managed_servers SET provider_server_id = $3 WHERE account_id = $1 AND id = $2 AND provider_server_id IS NULL AND status = 'failed'`, [accountId, held.id, sid]));
      }
    }
    // A row whose server is not among ours is checked at Hetzner by id before it is called gone: a server whose label was removed is still there, and still billed.
    let deleted = 0;
    for (const r of rows) {
      if (r.provider_server_id === null || listed.has(r.provider_server_id) || r.status === "deleted") continue;
      try { await client.getServer(Number(r.provider_server_id)); continue; } catch (e) {
        if (!(e instanceof HetznerError && e.code === "not_found")) throw e;
      }
      // The machine is gone, so its runner is revoked before the row says so (a failure leaves the row as it was for the next sweep).
      if (r.runner_id !== null) await revokeQuietly(() => revokeRunner(runnerDeps(ctx), ctx.principal, r.runner_id!), true);
      const gone = await withTenant(ctx.pool, accountId, userId, (c) => c.query(
        `UPDATE managed_servers SET status = 'deleted', status_at = now(), deleted_at = now() WHERE account_id = $1 AND id = $2 AND status <> 'deleted'`, [accountId, r.id]));
      deleted += gone.rowCount ?? 0;
    }
    return { orphaned, deleted };
  });
}
