import { HetznerError } from "@fx/hetzner";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ApiError } from "../errors.js";
import { toApiError, withHetznerServerClient, type ServerCtx } from "./servers.js";
import { deleteManagedServer, type DeleteResult } from "./lifecycle.js";

/**
 * D#845 MC-7b: the three things a person can do to one server of their own that MC-7's delete does not cover. Each is for an owner or admin (the route enforces it, and the
 * token reader checks it again) and each starts from a `managed_servers` row of the caller's account: a foreign id, a malformed id and an id that is not a server of this
 * account all answer the same 404 / 400, and Hetzner is never called for them.
 *
 *  - `rebootManagedServer`: Hetzner's `reboot` action, only for a server that is up (or coming up) and linked to a Hetzner server of its own. The token is opened by the
 *    machine-ops reader for that one Hetzner server id, which refuses an id that is not this account's.
 *  - `keepOrphan`: records that the person knows about an orphan and wants it left alone (`kept_at`, `kept_by`) and writes `server.orphan_kept`, both in one transaction.
 *    It changes nothing at Hetzner. A repeat changes nothing and writes nothing.
 *  - `deleteOrphan`: MC-7's delete, but only for an orphan: the server, then its labelled firewall, a 404 counted as done. A repeat of a finished one answers itself.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A server in one of these states can be asked to reboot: it exists at Hetzner and is not being made, torn down or gone. */
const REBOOTABLE = new Set(["registering", "needs_claude_login", "ready"]);

interface ActionRow { status: string; provider_server_id: string | null; kept_at: Date | null }

const readRow = (ctx: ServerCtx, id: string): Promise<ActionRow | undefined> => {
  if (!UUID.test(id)) throw new ApiError(400, "invalid_request", "the server id is not valid");
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<ActionRow>(
    `SELECT status, provider_server_id, kept_at FROM managed_servers WHERE account_id = $1 AND id = $2`, [accountId, id])).rows[0]);
};

export interface RebootResult { id: string; status: string; rebooting: true }

export async function rebootManagedServer(ctx: ServerCtx, id: string): Promise<RebootResult> {
  const row = await readRow(ctx, id);
  if (!row) throw new ApiError(404, "not_found", "no such server");
  if (!REBOOTABLE.has(row.status) || row.provider_server_id === null) throw new ApiError(409, "server_not_rebootable", "This server can't be rebooted in its current state");
  try {
    await withHetznerServerClient(ctx, row.provider_server_id, (client) => client.rebootServer(Number(row.provider_server_id)));
  } catch (e) {
    // The server is gone at Hetzner: the next sweep says so on the row; the person is told now and nothing is rebooted.
    if (e instanceof HetznerError && e.code === "not_found") throw new ApiError(409, "server_gone", "Hetzner no longer has this server");
    throw toApiError(e);
  }
  return { id, status: row.status, rebooting: true };
}

export interface KeepResult { id: string; status: "orphaned"; kept: true; already_kept: boolean }

export async function keepOrphan(ctx: ServerCtx, id: string): Promise<KeepResult> {
  const { accountId, userId } = ctx.principal;
  if (!UUID.test(id)) throw new ApiError(400, "invalid_request", "the server id is not valid");
  // The write comes first and names everything it needs: this account, an orphan, not yet kept. Only the first of two racing clicks matches, and the audit row goes with it.
  const first = await withTenant(ctx.pool, accountId, userId, async (c) => {
    const done = await c.query(`UPDATE managed_servers SET kept_at = now(), kept_by = $3 WHERE account_id = $1 AND id = $2 AND status = 'orphaned' AND kept_at IS NULL`, [accountId, id, userId]);
    if (done.rowCount !== 1) return false;
    await c.query("SELECT audit_write('server.orphan_kept', $1::jsonb)", [JSON.stringify({ server_id: id })]);
    return true;
  });
  if (first) return { id, status: "orphaned", kept: true, already_kept: false };
  // It matched nothing: say why.
  const row = await readRow(ctx, id);
  if (!row) throw new ApiError(404, "not_found", "no such server");
  if (row.status === "orphaned" && row.kept_at !== null) return { id, status: "orphaned", kept: true, already_kept: true };
  throw new ApiError(409, "not_an_orphan", "Only a server we created that isn't linked any more can be kept this way");
}

export async function deleteOrphan(ctx: ServerCtx, id: string): Promise<DeleteResult> {
  const row = await readRow(ctx, id);
  if (!row) throw new ApiError(404, "not_found", "no such server");
  // A repeat of a finished delete answers itself; a row that was never an orphan is refused (the ordinary Delete is for those).
  if (row.status !== "orphaned" && row.status !== "deleted") throw new ApiError(409, "not_an_orphan", "Only a server we created that isn't linked any more can be deleted this way");
  // The live label re-check (a server that no longer says it is ours is refused) lives in deleteManagedServer, so the ordinary DELETE holds it too.
  return deleteManagedServer(ctx, id, { removeProjects: false });
}
