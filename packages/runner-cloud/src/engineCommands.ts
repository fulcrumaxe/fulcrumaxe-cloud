import { ENGINE_COMMAND_PURPOSE, type SandboxCommand, type SignedSandboxCommand, EngineCommandAck, EngineCommandsPullReply, EngineCommandsPullRequest, type EngineCommand, type EngineAllowedRepo, type SignedEngineCommand } from "@fulcrumaxe/runner-protocol";
import { START_LIKE_KINDS, readHaltStates } from "@fx/db/src/engineCommands.js";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import type { PoolClient } from "pg";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession, type VerifiedRunner } from "./verifyRunnerRequest.js";

export const ENGINE_COMMANDS_PULL_PATH = "/api/runner/engine/commands/pull";
export const engineCommandAckPath = (commandId: string): string => `/api/runner/engine/commands/${commandId}/ack`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

/** What signs a command: the job-signing key and its `key_id`, held by the worker's composition root. Null while that key is not configured. */
export interface EngineCommandSigner {
  readonly keyId: string;
  signEngineCommand(command: EngineCommand): SignedEngineCommand;
  /** D#587 B-7b: the same key and `key_id`, signing a sandbox command (its own purpose string). Absent in a deployment that signs none. */
  signSandboxCommand?(command: SandboxCommand): SignedSandboxCommand;
}

interface CoveredRepo {
  id: string;
  gh_repo_id: number;
  full_name: string | null;
}

interface CommandRow {
  id: string;
  command_seq: string;
  kind: EngineCommand["kind"];
  args: Record<string, unknown>;
  issued_by: string;
  issued_at: Date;
  expires_at: Date;
  halt_epoch_at_issue: number;
  repo_id: string;
  gh_repo_id: string;
}

/**
 * POST /api/runner/engine/commands/pull (EB-8a). The runner asks for its pending commands.
 *
 *  - The account and the runner come from the verified key only. The request names repos by GitHub id; one the runner is not paired with (or runs
 *    anywhere but locally) is silently absent from the answer, so the route is no probe for which repos exist. A request for any one id still
 *    answers `allowed_repos`, which is how a runner with nothing enabled yet learns the names it may enable.
 *  - It returns only THIS runner's pending commands that have not expired, for covered repos the request named, above the `after_seq` it gave for
 *    each, lowest sequence first, at most 20, each signed. Pulled commands become `delivered` in the same transaction as the signing: when a signature
 *    cannot be made nothing is delivered. A command is delivered once; losing the reply leaves it `delivered`, and a late or missing ack reads as
 *    `not_confirmed`.
 *  - Pending commands past their life become `expired` here, on read.
 *  - While a repo is halted its start-like commands are withheld, on top of the insert-time refusal and the runner's own check. A start-like command
 *    issued under an earlier halt epoch than the repo's current one is never delivered either: clearing a halt lifts the stop and starts nothing by
 *    itself. Such a row stays `pending` (the guard trigger moves a pending row to `expired` only once its life is over, at most 600 s) and is read as
 *    expired then.
 *  - While operate is off no command at all is delivered (the runner must refuse on `controls[].operate_enabled === false` as well).
 *  - `controls` carries each named covered repo's halt epoch, whether it is halted and whether operate is on.
 *  - Without a signing key the answer is 503 and nothing is delivered.
 */
export async function pullEngineCommands(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, ENGINE_COMMANDS_PULL_PATH, req, { replay: "once" });
  const message = parseMessage(EngineCommandsPullRequest, parseJsonBody(req));
  const signer = deps.engineCommandSigner ? await deps.engineCommandSigner() : null;
  if (signer === null) throw new RunnerHttpError(503, "not_configured", "engine commands cannot be signed in this deployment");
  const reply = await asRunner(() => withRunnerSession(deps.appUserPool, runner, (client) => pullInside(client, runner, message, signer)));
  return { status: 200, body: EngineCommandsPullReply.parse(reply), headers: NO_STORE };
}

async function pullInside(client: PoolClient, runner: VerifiedRunner, message: EngineCommandsPullRequest, signer: EngineCommandSigner): Promise<EngineCommandsPullReply> {
  // One pull at a time per runner, so two of them cannot hand out a higher sequence before a lower one.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('engine_pull:' || $1::text, 0))`, [runner.runnerId]);
  const covered = await client.query<CoveredRepo & { gh_repo_id: string }>(
    `SELECT r.id, r.gh_repo_id, CASE WHEN r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL THEN r.gh_owner || '/' || r.gh_name END AS full_name
       FROM runners rn JOIN repos r ON r.account_id = rn.account_id AND r.id = ANY (rn.allowed_repo_ids) AND r.execution_mode = 'runner_local'
      WHERE rn.id = $1 AND rn.account_id = $2 AND rn.revoked_at IS NULL
      ORDER BY r.gh_repo_id LIMIT 100`,
    [runner.runnerId, runner.accountId],
  );
  const repos = covered.rows.map((r) => ({ ...r, gh_repo_id: Number(r.gh_repo_id) }));
  const allowed: EngineAllowedRepo[] = repos.flatMap((r) => (r.full_name === null ? [] : [{ repo_gh_id: r.gh_repo_id, full_name: r.full_name }]));
  const named = repos.filter((r) => message.repo_gh_ids.includes(r.gh_repo_id));

  await client.query(`UPDATE engine_commands SET state = 'expired' WHERE runner_id = $1 AND state = 'pending' AND expires_at <= now()`, [runner.runnerId]);

  const settings = await client.query<{ operate_enabled: boolean }>("SELECT (watch_enabled AND operate_enabled) AS operate_enabled FROM engine_bridge_settings WHERE account_id = $1", [runner.accountId]);
  const operate = settings.rows[0]?.operate_enabled === true;
  const halts = await readHaltStates(client, named.map((r) => r.id));
  const controls = named.map((r) => ({ repo_gh_id: r.gh_repo_id, halt_epoch: halts.get(r.id)!.halt_epoch, halted: halts.get(r.id)!.halted, operate_enabled: operate }));
  // Operate off holds back every command, as a halt holds back the start-like ones: fail closed, nothing is signed.
  if (named.length === 0 || !operate) return { commands: [], controls, allowed_repos: allowed };

  const after = named.map((r) => message.after_seq[String(r.gh_repo_id)] ?? 0);
  const halted = named.filter((r) => halts.get(r.id)!.halted).map((r) => r.id);
  const epochs = named.map((r) => halts.get(r.id)!.halt_epoch);
  const due = await client.query<CommandRow>(
    `SELECT c.id, c.command_seq, c.kind, c.args, c.issued_by, c.issued_at, c.expires_at, c.halt_epoch_at_issue, c.repo_id, r.gh_repo_id
       FROM engine_commands c
       JOIN unnest($2::uuid[], $3::bigint[], $6::int[]) AS w (repo_id, after_seq, halt_epoch) ON w.repo_id = c.repo_id AND c.command_seq > w.after_seq
       JOIN repos r ON r.account_id = c.account_id AND r.id = c.repo_id
      WHERE c.runner_id = $1 AND c.state = 'pending' AND c.expires_at > now()
        AND NOT (c.kind = ANY ($4::text[]) AND (c.repo_id = ANY ($5::uuid[]) OR c.halt_epoch_at_issue < w.halt_epoch))
      ORDER BY c.command_seq, c.issued_at, c.id
      LIMIT 20
      FOR UPDATE OF c`,
    [runner.runnerId, named.map((r) => r.id), after, [...START_LIKE_KINDS], halted, epochs],
  );
  const commands = due.rows.map((c) =>
    signer.signEngineCommand({
      v: 1,
      purpose: ENGINE_COMMAND_PURPOSE,
      command_id: c.id,
      command_seq: Number(c.command_seq),
      runner_id: runner.runnerId,
      repo_gh_id: Number(c.gh_repo_id),
      kind: c.kind,
      args: c.args,
      issued_by: c.issued_by,
      issued_at: c.issued_at.toISOString(),
      expires_at: c.expires_at.toISOString(),
      halt_epoch: c.halt_epoch_at_issue,
    } as EngineCommand),
  );
  if (due.rows.length > 0) await client.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = ANY ($1::uuid[]) AND state = 'pending'`, [due.rows.map((c) => c.id)]);
  return { commands, controls, allowed_repos: allowed };
}

/**
 * POST /api/runner/engine/commands/:id/ack (EB-8a). The delivering runner reports what became of a command: applied, refused (with the reason),
 * expired or not confirmed. One ack per command: the update names the state it expects, so of two acks racing for one command exactly one writes.
 *
 *  - Another runner's command, another account's, and an id that is not a command all answer 404. A command still pending (never delivered) or
 *    already acked answers 409 (`not_delivered`, `already_acked`) and nothing changes.
 *  - The audit row `engine_command.acked` is written in the same transaction, in the name of the person who registered the runner (a runner has no
 *    member of its own). When it cannot be written, the ack is not stored and the answer is a 500: the runner sends it again.
 */
export async function ackEngineCommand(deps: RunnerCloudDeps, req: RunnerHttpRequest, commandId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, engineCommandAckPath(commandId), req, { replay: "once" });
  // After the signature, not before: an unsigned caller must not learn from a 404 which ids are well formed.
  if (!UUID.test(commandId)) throw new RunnerHttpError(404, "not_found", "no such command");
  const ack = parseMessage(EngineCommandAck, parseJsonBody(req));
  const id = commandId.toLowerCase();
  await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      const moved = await client.query<{ repo_id: string; kind: string }>(
        `UPDATE engine_commands SET state = $3, acked_at = now(), refusal = $4
          WHERE id = $1 AND runner_id = $2 AND state = 'delivered' RETURNING repo_id, kind`,
        [id, runner.runnerId, ack.outcome, ack.refusal ?? null],
      );
      const row = moved.rows[0];
      if (row === undefined) {
        const seen = await client.query<{ state: string }>("SELECT state FROM engine_commands WHERE id = $1 AND runner_id = $2", [id, runner.runnerId]);
        if (seen.rows[0] === undefined) throw new RunnerHttpError(404, "not_found", "no such command");
        if (seen.rows[0].state === "pending") throw new RunnerHttpError(409, "not_delivered", "this command has not been delivered");
        throw new RunnerHttpError(409, "already_acked", "this command is already acknowledged");
      }
      await client.query("SELECT set_config('app.user_id', $1, true)", [runner.registeredBy]);
      await writeEngineAudit(client, "engine_command.acked", {
        repo_id: row.repo_id,
        command_id: id,
        kind: row.kind,
        outcome: ack.outcome,
        ...(ack.refusal === undefined ? {} : { refusal: ack.refusal }),
      });
    }),
  );
  return { status: 200, body: { command_id: id, state: ack.outcome }, headers: NO_STORE };
}
