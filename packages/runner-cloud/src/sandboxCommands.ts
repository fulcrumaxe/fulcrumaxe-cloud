import { SANDBOX_COMMAND_CAPABILITY, SANDBOX_COMMAND_KINDS, SANDBOX_COMMAND_PURPOSE, SANDBOX_COMMANDS_PER_CLAIM, SANDBOX_COMMAND_NAME_PATTERN, SANDBOX_INVENTORY_MIN_PROTOCOL, type SandboxCommand, type SandboxCommandAck, type SignedSandboxCommand } from "@fulcrumaxe/runner-protocol";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { PoolClient } from "pg";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import type { EngineCommandSigner } from "./engineCommands.js";
import type { VerifiedRunner } from "./verifyRunnerRequest.js";

/**
 * D#587 B-7b: signed sandbox commands (migration 1041). A person asks, the claim route signs and hands over, the runner acks on its next claim.
 * Nothing here reads the sandbox inventory or the host limits: which sandboxes exist is the runner's own claim and only decides what a screen shows.
 */

/** How long a command lives, and how many a runner may have waiting at once. */
export const SANDBOX_COMMAND_LIFE_SECONDS = 300;
export const SANDBOX_COMMAND_MAX_OPEN = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };
const invalid = (): never => {
  throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
};

interface DueRow {
  id: string;
  kind: SandboxCommand["kind"];
  name: string | null;
  nonce: string;
  expires_at: Date;
}

/**
 * Called inside the claim's runner session, for an ordinary claim only. First the acks the claim carried are stored (an ack names a nonce this runner was
 * handed; any other nonce changes nothing), then pending commands that have not expired are signed and marked delivered in the one transaction: when a signature
 * cannot be made nothing is delivered. Only a runner whose latest hello listed `sandbox_commands_v1` at protocol 21 or later is handed any. A command is
 * delivered once; losing the reply leaves it `delivered` and the screens read it as unanswered.
 */
export async function exchangeSandboxCommands(client: PoolClient, runner: VerifiedRunner, acks: readonly SandboxCommandAck[], signer: () => Promise<EngineCommandSigner | null>): Promise<SignedSandboxCommand[]> {
  if (acks.length > 0) {
    await client.query(
      `UPDATE sandbox_commands c SET state = a.outcome, refusal = a.refusal, acked_at = now()
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS a (nonce, outcome, refusal)
        WHERE c.nonce = a.nonce AND c.runner_id = $4 AND c.account_id = $5 AND c.state = 'delivered'`,
      [acks.map((a) => a.nonce), acks.map((a) => a.outcome), acks.map((a) => a.refusal ?? null), runner.runnerId, runner.accountId],
    );
  }
  await client.query(`UPDATE sandbox_commands SET state = 'expired' WHERE runner_id = $1 AND account_id = $2 AND state = 'pending' AND expires_at <= now()`, [runner.runnerId, runner.accountId]);
  const due = await client.query<DueRow>(
    `SELECT c.id, c.kind, c.name, c.nonce, c.expires_at
       FROM sandbox_commands c
       JOIN runners rn ON rn.account_id = c.account_id AND rn.id = c.runner_id AND rn.revoked_at IS NULL AND rn.protocol_version >= $3
       JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id AND $4::text = ANY (cap.capabilities)
      WHERE c.runner_id = $1 AND c.account_id = $2 AND c.state = 'pending' AND c.expires_at > now()
      ORDER BY c.issued_at, c.id
      LIMIT $5
      FOR UPDATE OF c`,
    [runner.runnerId, runner.accountId, SANDBOX_INVENTORY_MIN_PROTOCOL, SANDBOX_COMMAND_CAPABILITY, SANDBOX_COMMANDS_PER_CLAIM],
  );
  if (due.rows.length === 0) return [];
  const keyHolder = await signer();
  if (keyHolder?.signSandboxCommand === undefined) return [];
  let signed: SignedSandboxCommand[];
  try {
    signed = due.rows.map((c) =>
      keyHolder.signSandboxCommand!({ purpose: SANDBOX_COMMAND_PURPOSE, runner_id: runner.runnerId, kind: c.kind, ...(c.name === null ? {} : { name: c.name }), nonce: c.nonce, exp: c.expires_at.toISOString() }),
    );
  } catch {
    // fx-swallow-ok: a key that cannot sign delivers nothing; the claim itself goes on and the commands age out
    return [];
  }
  await client.query(`UPDATE sandbox_commands SET state = 'delivered', delivered_at = now() WHERE id = ANY ($1::uuid[]) AND state = 'pending'`, [due.rows.map((c) => c.id)]);
  return signed;
}

/** The request body of POST /api/runners/:id/sandbox-commands: a kind, and a name for stop and delete. Nothing else. */
function parseRequest(input: unknown): { kind: SandboxCommand["kind"]; name: string | null } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);
  const kind = body["kind"];
  if (typeof kind !== "string" || !(SANDBOX_COMMAND_KINDS as readonly string[]).includes(kind)) return invalid();
  const reap = kind === "reap_sandboxes";
  if (keys.some((k) => k !== "kind" && k !== "name") || (reap && keys.includes("name"))) return invalid();
  const name = body["name"];
  if (!reap && (typeof name !== "string" || !SANDBOX_COMMAND_NAME_PATTERN.test(name))) return invalid();
  return { kind: kind as SandboxCommand["kind"], name: reap ? null : (name as string) };
}

/**
 * POST /api/runners/:id/sandbox-commands. An owner or admin asks one runner to stop or delete a named sandbox or to reap its stopped ones. The command is queued
 * (migration 1041), the account's runners are woken, and the runner takes it on its next claim. 200 with the queued command; asking again while the same request
 * waits answers that one and queues nothing. 400 for a body this route does not take, 403 (not an owner or admin), 404 (no such runner), 409 `runner_revoked`
 * or `not_supported` (the runner did not list `sandbox_commands_v1` at protocol 21 or later), 429 `too_many` (twenty already waiting).
 */
export async function enqueueSandboxCommand(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, input: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  const { kind, name } = parseRequest(input);
  let row: { id: string; expires_at: Date };
  try {
    row = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
      if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can manage a runner's sandboxes");
      const found = (
        await client.query<{ revoked: boolean; supported: boolean }>(
          `SELECT rn.revoked_at IS NOT NULL AS revoked, COALESCE(rn.protocol_version >= $3 AND $4::text = ANY (cap.capabilities), false) AS supported
             FROM runners rn LEFT JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id
            WHERE rn.id = $1 AND rn.account_id = $2`,
          [runnerId, principal.accountId, SANDBOX_INVENTORY_MIN_PROTOCOL, SANDBOX_COMMAND_CAPABILITY],
        )
      ).rows[0];
      if (found === undefined) throw new RunnerHttpError(404, "not_found", "no such runner");
      if (found.revoked) throw new RunnerHttpError(409, "runner_revoked", "the runner has been removed");
      if (!found.supported) throw new RunnerHttpError(409, "not_supported", "this runner does not take sandbox commands");
      // A request nobody claimed in time still holds the one-pending slot (the runner retires its own stale rows only when it claims). Retire this account's stale
      // rows for this runner first, in this transaction, so asking again after the runner was offline queues a fresh command instead of hitting the unique index.
      await client.query(`UPDATE sandbox_commands SET state = 'expired' WHERE runner_id = $1 AND account_id = $2 AND state = 'pending' AND expires_at <= now()`, [runnerId, principal.accountId]);
      // A request that is already waiting is the same request: the answer is that command, so a double click queues one.
      const waiting = await client.query<{ id: string; expires_at: Date }>(
        `SELECT id, expires_at FROM sandbox_commands WHERE runner_id = $1 AND account_id = $2 AND kind = $3 AND name IS NOT DISTINCT FROM $4 AND state = 'pending' AND expires_at > now()`,
        [runnerId, principal.accountId, kind, name],
      );
      if (waiting.rows[0] !== undefined) return waiting.rows[0];
      const open = await client.query<{ n: string }>(`SELECT count(*) AS n FROM sandbox_commands WHERE runner_id = $1 AND account_id = $2 AND state IN ('pending', 'delivered') AND expires_at > now()`, [runnerId, principal.accountId]);
      if (Number(open.rows[0]?.n ?? 0) >= SANDBOX_COMMAND_MAX_OPEN) throw new RunnerHttpError(429, "too_many", "too many sandbox commands are waiting for this runner");
      const made = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO sandbox_commands (account_id, runner_id, kind, name, issued_by, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(secs => $6))
         ON CONFLICT (runner_id, kind, COALESCE(name, '')) WHERE state = 'pending' DO NOTHING
         RETURNING id, expires_at`,
        [principal.accountId, runnerId, kind, name, principal.userId, SANDBOX_COMMAND_LIFE_SECONDS],
      );
      if (made.rows[0] !== undefined) return made.rows[0];
      // A concurrent identical request won the one-pending slot between the lookup and the insert: the answer is that command, not an error.
      const winner = await client.query<{ id: string; expires_at: Date }>(
        `SELECT id, expires_at FROM sandbox_commands WHERE runner_id = $1 AND account_id = $2 AND kind = $3 AND name IS NOT DISTINCT FROM $4 AND state = 'pending'`,
        [runnerId, principal.accountId, kind, name],
      );
      if (winner.rows[0] === undefined) throw new RunnerHttpError(409, "conflict", "the request changed while it was being queued; ask again");
      return winner.rows[0];
    });
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    if (pgCode(error) === "42501") throw new RunnerHttpError(403, "forbidden", "you may not do that to this runner");
    throw error;
  }
  // The runner takes the command on its next claim; telling the account's runners now makes that soon rather than a poll away.
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { command_id: row.id, runner_id: runnerId, kind, ...(name === null ? {} : { name }), state: "pending", expires_at: row.expires_at.toISOString() }, headers: NO_STORE };
}
