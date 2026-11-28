import {
  CLAUDE_AUTH_ORIGIN,
  GH_LOGIN_CAPABILITY,
  MACHINE_COMMAND_PURPOSE,
  MACHINE_LOGIN_CAPABILITY,
  MACHINE_ONBOARDING_MIN_PROTOCOL,
  MACHINE_COMMANDS_PER_CLAIM,
  MachineLoginCode,
  MachineLoginReport,
  machineLoginCodePath,
  machineLoginReportPath,
  type MachineCommand,
  type MachineCommandAck,
  type SignedMachineCommand,
} from "@fulcrumaxe/runner-protocol";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { MachineLoginSealer } from "@fx/model-connection";
import type { PoolClient } from "pg";
import type { EngineCommandSigner } from "./engineCommands.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { verifyRunnerRequest, withRunnerSession, type VerifiedRunner } from "./verifyRunnerRequest.js";

/**
 * D#845 MC-8a: the Claude sign-in link for a managed server (migration 1070). A person who owns or administers the account asks; the runner (MC-8b) prints a link and waits for a code; the person
 * opens the link and types the code back; the runner takes the code once, signs in and says so. The link and the code are sealed under the machine key (the machine_ops code path),
 * the code is never in a response, a log line, an event, a command row or an audit row, and the credential itself never reaches the cloud.
 *
 * Person routes (session; owner or admin, the database decides): start, read, code, cancel and sign out. Runner routes (signed): report and code. Delivery rides on the claim reply like sandbox commands.
 */
/** A path id in its one canonical form (lower case), taken once where it enters: the advisory-lock key and the seal's AAD are strings, so `ABC...` and `abc...` must not be two keys. */
export const canonicalId = (id: string): string => id.toLowerCase();
export const NO_STORE = { "cache-control": "no-store" } as const;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LIVE = "('pending', 'awaiting_code', 'code_ready')";
/** A request and its commands live ten minutes at most (the table's CHECK and the command life are the same bound). */
export const LOGIN_LIFE_SECONDS = 600;
const LOGOUT_COMMAND_LIFE_SECONDS = 300;

/** The claim's half: acks the runner carried are stored, then waiting commands are signed and marked delivered in the one transaction (nothing is delivered when a signature cannot be made). */
export async function exchangeMachineCommands(client: PoolClient, runner: VerifiedRunner, acks: readonly MachineCommandAck[], signer: () => Promise<EngineCommandSigner | null>): Promise<SignedMachineCommand[]> {
  if (acks.length > 0) {
    await client.query(
      `UPDATE machine_commands c SET state = a.outcome, refusal = a.refusal, acked_at = now()
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS a (nonce, outcome, refusal)
        WHERE c.nonce = a.nonce AND c.runner_id = $4 AND c.account_id = $5 AND c.state = 'delivered'`,
      [acks.map((a) => a.command_id), acks.map((a) => a.outcome), acks.map((a) => a.refusal ?? null), runner.runnerId, runner.accountId],
    );
  }
  await client.query(`UPDATE machine_commands SET state = 'expired' WHERE runner_id = $1 AND account_id = $2 AND state = 'pending' AND expires_at <= now()`, [runner.runnerId, runner.accountId]);
  const due = await client.query<{ id: string; kind: MachineCommand["kind"]; request_id: string | null; nonce: string; issued_by: string; issued_at: Date; expires_at: Date }>(
    `SELECT c.id, c.kind, c.request_id, c.nonce, c.issued_by, c.issued_at, c.expires_at
       FROM machine_commands c
       JOIN runners rn ON rn.account_id = c.account_id AND rn.id = c.runner_id AND rn.revoked_at IS NULL AND rn.protocol_version >= $3
       JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id AND (CASE WHEN c.kind LIKE 'gh\_%' THEN $6::text ELSE $4::text END) = ANY (cap.capabilities)
      WHERE c.runner_id = $1 AND c.account_id = $2 AND c.state = 'pending' AND c.expires_at > now()
      ORDER BY c.issued_at, c.id LIMIT $5 FOR UPDATE OF c`,
    [runner.runnerId, runner.accountId, MACHINE_ONBOARDING_MIN_PROTOCOL, MACHINE_LOGIN_CAPABILITY, MACHINE_COMMANDS_PER_CLAIM, GH_LOGIN_CAPABILITY],
  );
  if (due.rows.length === 0) return [];
  const keyHolder = await signer();
  if (keyHolder?.signMachineCommand === undefined) return [];
  let signed: SignedMachineCommand[];
  try {
    signed = due.rows.map((c) =>
      keyHolder.signMachineCommand!({
        v: 1, purpose: MACHINE_COMMAND_PURPOSE, command_id: c.nonce, runner_id: runner.runnerId, issued_by: c.issued_by, issued_at: c.issued_at.toISOString(), expires_at: c.expires_at.toISOString(),
        kind: c.kind, args: c.request_id === null ? {} : { request_id: c.request_id },
      } as MachineCommand),
    );
  } catch {
    // fx-swallow-ok: a key that cannot sign delivers nothing; the claim itself goes on and the commands age out
    return [];
  }
  await client.query(`UPDATE machine_commands SET state = 'delivered', delivered_at = now() WHERE id = ANY ($1::uuid[]) AND state = 'pending'`, [due.rows.map((c) => c.id)]);
  return signed;
}

// ---- the person's routes ------------------------------------------------------------------------------------------------------------------------

/** Runs `fn` in the person's tenant session after the owner-or-admin check and the runner checks: a live runner of the account, linked to a managed server, that lists `machine_login_v1`. */
export async function asOwnerOnManagedRunner<T>(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, fn: (client: PoolClient) => Promise<T>, capability: string = MACHINE_LOGIN_CAPABILITY): Promise<T> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  try {
    return await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
      if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can sign a server in to Claude");
      const found = (
        await client.query<{ revoked: boolean; supported: boolean; managed: boolean }>(
          `SELECT rn.revoked_at IS NOT NULL AS revoked, COALESCE(rn.protocol_version >= $3 AND $4::text = ANY (cap.capabilities), false) AS supported,
                  EXISTS (SELECT 1 FROM managed_servers s WHERE s.account_id = rn.account_id AND s.runner_id = rn.id AND s.deleted_at IS NULL AND s.status NOT IN ('deleting', 'deleted', 'failed', 'orphaned')) AS managed
             FROM runners rn LEFT JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id
            WHERE rn.id = $1 AND rn.account_id = $2`,
          [runnerId, principal.accountId, MACHINE_ONBOARDING_MIN_PROTOCOL, capability],
        )
      ).rows[0];
      if (found === undefined) throw new RunnerHttpError(404, "not_found", "no such runner");
      if (found.revoked) throw new RunnerHttpError(409, "runner_revoked", "the runner has been removed");
      // A local machine signs in at its own terminal; the link is for a server the cloud made or the person linked as one.
      if (!found.managed) throw new RunnerHttpError(409, "not_managed_server", "this machine is not a managed server; sign in to Claude in its own terminal");
      if (!found.supported) throw new RunnerHttpError(409, "not_supported", "this runner cannot sign in to Claude from here yet");
      return await fn(client);
    });
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    if (pgCode(error) === "42501") throw new RunnerHttpError(403, "forbidden", "you may not do that to this runner");
    throw error;
  }
}
export const sealerOf = (deps: RunnerCloudDeps): MachineLoginSealer => {
  if (!deps.machineLoginSealer) throw new RunnerHttpError(503, "not_configured", "signing in to Claude from here is not available right now");
  return deps.machineLoginSealer;
};
export const sealed = <T>(run: () => T): T => {
  try {
    return run();
  } catch {
    // fx-swallow-ok: the machine key is unset or the blob does not open; both are a fixed answer, and nothing of the error (key material) is kept
    throw new RunnerHttpError(503, "not_configured", "signing in to Claude from here is not available right now");
  }
};
export const insertCommand = (client: PoolClient, principal: SessionPrincipal, runnerId: string, kind: MachineCommand["kind"], requestId: string | null, lifeSeconds: number) =>
  client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO machine_commands (account_id, runner_id, kind, request_id, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(secs => $6))
     ON CONFLICT (runner_id, kind, COALESCE(request_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'pending' DO NOTHING RETURNING id, expires_at`,
    [principal.accountId, runnerId, kind, requestId, principal.userId, lifeSeconds],
  );
export const liveRequest = async (client: PoolClient, principal: SessionPrincipal, runnerId: string, status?: string, kind: "claude" | "github" = "claude") =>
  (
    await client.query<{ id: string; status: string; expires_at: Date }>(
      `SELECT id, status, expires_at FROM machine_login_requests WHERE account_id = $1 AND runner_id = $2 AND kind = '${kind}' AND status ${status === undefined ? `IN ${LIVE}` : "= $3"} AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      status === undefined ? [principal.accountId, runnerId] : [principal.accountId, runnerId, status],
    )
  ).rows[0];

/** POST /api/runners/:id/claude-login. Starts a sign-in (200 with the request, or the one already live: a double click starts one). 409 `not_managed_server`, `not_supported`, `runner_revoked`; 403; 404. */
export async function startClaudeLogin(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  sealerOf(deps);
  const row = await asOwnerOnManagedRunner(deps, principal, runnerId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`machine-login:${runnerId}`]);
    // A request whose life is over still holds a live status until the prune: retire it here, so asking again starts a fresh one.
    await client.query(`UPDATE machine_login_requests SET status = 'expired', auth_url_ct = NULL, code_ct = NULL WHERE account_id = $1 AND runner_id = $2 AND kind = 'claude' AND status IN ${LIVE} AND expires_at <= now()`, [principal.accountId, runnerId]);
    const live = await liveRequest(client, principal, runnerId);
    if (live) return live;
    const made = await client.query<{ id: string; status: string; expires_at: Date }>(
      `INSERT INTO machine_login_requests (account_id, runner_id, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id, status, expires_at`,
      [principal.accountId, runnerId, principal.userId, LOGIN_LIFE_SECONDS],
    );
    await insertCommand(client, principal, runnerId, "claude_login_start", made.rows[0]!.id, LOGIN_LIFE_SECONDS);
    // Only a new request is recorded (a repeat that gets the live one writes nothing). Ids only: never the link, the code or any text.
    await client.query("SELECT audit_write('machine.login_started', $1::jsonb)", [JSON.stringify({ request_id: made.rows[0]!.id, runner_id: runnerId })]);
    return made.rows[0]!;
  });
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { request_id: row.id, status: row.status, expires_at: row.expires_at.toISOString() }, headers: NO_STORE };
}

/** GET /api/runners/:id/claude-login. The newest request of this runner, with its link while it waits for the code (`auth_url`, opened here for this person only), or `{ request: null }`. */
export async function readClaudeLogin(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const seal = sealerOf(deps);
  const body = await asOwnerOnManagedRunner(deps, principal, runnerId, async (client) => {
    const r = (
      await client.query<{ id: string; status: string; expires_at: Date; failure_code: string | null; lapsed: boolean }>(
        `SELECT id, status, expires_at, failure_code, (status IN ${LIVE} AND expires_at <= now()) AS lapsed FROM machine_login_requests WHERE account_id = $1 AND runner_id = $2 AND kind = 'claude' ORDER BY created_at DESC LIMIT 1`,
        [principal.accountId, runnerId],
      )
    ).rows[0];
    if (!r) return { request: null };
    let authUrl: string | null = null;
    if (r.status === "awaiting_code" && !r.lapsed) {
      const ct = (await client.query<{ ct: Buffer | null }>("SELECT machine_login_auth_url($1) AS ct", [r.id])).rows[0]?.ct;
      if (ct) authUrl = sealed(() => seal.open({ accountId: principal.accountId, requestId: r.id, runnerId }, "auth_url", ct));
    }
    return { request: { request_id: r.id, status: r.lapsed ? "expired" : r.status, expires_at: r.expires_at.toISOString(), auth_url: authUrl, failure_code: r.failure_code } };
  });
  return { status: 200, body, headers: NO_STORE };
}

/** POST /api/runners/:id/claude-login/code with `{ code }`. Seals the code and queues `claude_login_code`; the response never carries it. 409 `no_login_waiting` when no request waits for a code. */
export async function submitClaudeLoginCode(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, input: unknown): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const seal = sealerOf(deps);
  const keys = typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input) : [];
  const code = MachineLoginCode.safeParse((input as { code?: unknown } | null)?.code);
  if (!code.success || keys.length !== 1) throw new RunnerHttpError(400, "invalid_message", "the code is not in a form the sign-in page gives");
  const row = await asOwnerOnManagedRunner(deps, principal, runnerId, async (client) => {
    const waiting = await liveRequest(client, principal, runnerId, "awaiting_code");
    if (!waiting) throw new RunnerHttpError(409, "no_login_waiting", "no sign-in is waiting for a code; start one");
    const ct = sealed(() => seal.seal({ accountId: principal.accountId, requestId: waiting.id, runnerId }, "code", code.data));
    await client.query(`UPDATE machine_login_requests SET status = 'code_ready', code_ct = $3 WHERE id = $1 AND account_id = $2 AND status = 'awaiting_code'`, [waiting.id, principal.accountId, ct]);
    await insertCommand(client, principal, runnerId, "claude_login_code", waiting.id, LOGIN_LIFE_SECONDS);
    return waiting;
  });
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { request_id: row.id, status: "code_ready", expires_at: row.expires_at.toISOString() }, headers: NO_STORE };
}

/** POST /api/runners/:id/claude-login/cancel. Ends the live request (nothing sealed is kept) and withdraws its commands that have not been delivered. 409 `no_login_waiting` when none is live. */
export async function cancelClaudeLogin(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const row = await asOwnerOnManagedRunner(deps, principal, runnerId, async (client) => {
    const live = await liveRequest(client, principal, runnerId);
    if (!live) throw new RunnerHttpError(409, "no_login_waiting", "no sign-in is in progress");
    await client.query(`UPDATE machine_login_requests SET status = 'failed', failure_code = 'cancelled', auth_url_ct = NULL, code_ct = NULL WHERE id = $1 AND account_id = $2`, [live.id, principal.accountId]);
    await client.query(`UPDATE machine_commands SET state = 'cancelled' WHERE request_id = $1 AND account_id = $2 AND state = 'pending' AND expires_at > now()`, [live.id, principal.accountId]);
    return live;
  });
  return { status: 200, body: { request_id: row.id, status: "failed", failure_code: "cancelled" }, headers: NO_STORE };
}

/** POST /api/runners/:id/claude-logout. Queues `claude_logout`: the machine signs out of Claude. The same request waiting is the same request. The card's sign-in state follows the machine's next hello. */
export async function signOutOfClaude(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  runnerId = canonicalId(runnerId);
  const row = await asOwnerOnManagedRunner(deps, principal, runnerId, async (client) => {
    await client.query(`UPDATE machine_commands SET state = 'expired' WHERE runner_id = $1 AND account_id = $2 AND state = 'pending' AND expires_at <= now()`, [runnerId, principal.accountId]);
    const made = await insertCommand(client, principal, runnerId, "claude_logout", null, LOGOUT_COMMAND_LIFE_SECONDS);
    if (made.rows[0]) return made.rows[0];
    return (await client.query<{ id: string; expires_at: Date }>(`SELECT id, expires_at FROM machine_commands WHERE runner_id = $1 AND account_id = $2 AND kind = 'claude_logout' AND state = 'pending'`, [runnerId, principal.accountId])).rows[0]!;
  });
  void markRunnerWork(principal.accountId);
  return { status: 200, body: { command_id: row.id, runner_id: runnerId, kind: "claude_logout", state: "pending", expires_at: row.expires_at.toISOString() }, headers: NO_STORE };
}

// ---- the runner's routes ------------------------------------------------------------------------------------------------------------------------

/** The Postgres answers of the definers, as the statuses a runner understands: 55000 the request is not in a state that takes this (409), no_data_found there is none for this runner (404). */
export const asLoginError = (error: unknown): unknown => {
  const code = pgCode(error);
  if (code === "55000") return new RunnerHttpError(409, "not_in_state", "the sign-in request is not in a state that takes this");
  if (code === "P0002") return new RunnerHttpError(404, "not_found", "no such sign-in request");
  if (code === "22023") return new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  return error;
};

/** POST /api/runner/machine-login/:request_id/report. The link (sealed here; its origin must be exactly the sign-in origin), or `done`, or `failed`. */
export async function machineLoginReportRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, requestId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, machineLoginReportPath(requestId), req, { replay: "once" });
  if (!UUID.test(requestId)) throw new RunnerHttpError(404, "not_found", "no such sign-in request");
  const report = parseMessage(MachineLoginReport, parseJsonBody(req));
  // The pattern already holds the host to three; the origin check is the one fixed constant of Ruling 52, so a link on any other host is refused whatever the pattern allows.
  if (report.auth_url !== undefined && new URL(report.auth_url).origin !== CLAUDE_AUTH_ORIGIN) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  const ct = report.auth_url === undefined ? null : sealed(() => sealerOf(deps).seal({ accountId: runner.accountId, requestId, runnerId: runner.runnerId }, "auth_url", report.auth_url!));
  try {
    await asRunner(() =>
      withRunnerSession(deps.appUserPool, runner, async (client) => {
        await client.query("SELECT machine_login_report($1, $2, $3, $4)", [requestId, report.state, ct, report.failure_code ?? null]);
        // A server that was waiting for its sign-in is ready once the machine says it is signed in.
        if (report.state === "done") await client.query(`UPDATE managed_servers SET status = 'ready', status_at = now() WHERE account_id = $1 AND runner_id = $2 AND status = 'needs_claude_login'`, [runner.accountId, runner.runnerId]);
      }),
    );
  } catch (error) {
    throw asLoginError(error);
  }
  return { status: 200, body: { state: report.state }, headers: NO_STORE };
}

/** GET /api/runner/machine-login/:request_id/code. The person's code, opened here, once; 410 `gone` when there is none (not typed yet, already taken, or the request is over). */
export async function machineLoginCodeRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, requestId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, machineLoginCodePath(requestId), req, { replay: "once" });
  if (!UUID.test(requestId)) throw new RunnerHttpError(404, "not_found", "no such sign-in request");
  const seal = sealerOf(deps);
  let ct: Buffer | null;
  try {
    ct = await asRunner(() => withRunnerSession(deps.appUserPool, runner, async (client) => (await client.query<{ ct: Buffer | null }>("SELECT machine_login_code_take($1) AS ct", [requestId])).rows[0]?.ct ?? null));
  } catch (error) {
    throw asLoginError(error);
  }
  if (ct === null) throw new RunnerHttpError(410, "gone", "there is no code to take");
  const code = sealed(() => seal.open({ accountId: runner.accountId, requestId, runnerId: runner.runnerId }, "code", ct!));
  return { status: 200, body: { code }, headers: NO_STORE };
}
