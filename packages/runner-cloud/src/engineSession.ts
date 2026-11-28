import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type ENGINE_STOP_REASONS, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { engineCoverageRefusal, readEngineCoverage } from "@fx/core/src/onboarding/engineCoverage.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import type { EngineCommandSigner } from "./engineCommands.js";
import { RunPullRequestError } from "./runPullRequest.js";
import { carryPending, openCarry } from "./stateCarryMove.js";

/**
 * D#845 ON-13a2: the cloud issues the three engine session jobs (start, stop, delete) and the gates in front of a start.
 *
 * Every issuer is for an owner or admin on a session (the definer `machine_job_issue` checks that again); a token principal never gets here, and a member is 403 before anything is read. Everything runs in the person's
 * tenant transaction and names the account itself on every query, on top of row security.
 *
 * A START passes three gates, in this order, and is refused before anything is signed:
 *   1. coverage   402 `plan_required` (no engine plan, or the plan ended), 402 `account_held`. The engine already sits in the plan's count (it is placed), so `engine_quantity` is not a refusal at `live <= quantity`; above it (a downgrade) only a placement among the oldest `quantity` by `(placed_at, repo_id)` may start, any other gets 402 `engine_quantity`.
 *   2. operate    409 `operate_off`. Operate is one switch per account, and a repo is operated only when watch, operate and the repo's own tick are all on. The issuer reads `operate_enabled` and `operate_epoch` with `SELECT ... FOR SHARE` on the account's settings row in the issuing transaction and signs
 *                 that epoch. An off takes the row lock, so an issue and an off are serialized: the start is refused, or it is issued first and the off's trigger supersedes it (migration 1066).
 *   3. the runner's own admission (one engine per machine, memory) is the runner's, on the signed job.
 * A STOP and a DELETE are never gated (stopping is the safe direction); they sign the epoch as it is now, so an `operate_off` stop signs the post-off epoch. A stop or delete already issued and not yet ended is returned, not issued twice.
 *
 * Refusals: 403 `forbidden`; 404 `not_found`; 409 `not_placed`, `runner_removed`, `operate_off`, `start_pending`, `carry_pending`, `session_changed`, `default_branch_empty`; 402 `plan_required`, `account_held`, `engine_quantity`;
 * 503 `not_configured`, `github_unavailable`; 502 `github_refused`.
 */

export const ENGINE_SESSION_NAME_PREFIX = "fx-engine-";
export type EngineStopReason = (typeof ENGINE_STOP_REASONS)[number];
/** The reasons a person can give. `operate_off` and `plan` are system-only (Ruling 82): the system's own stop issuer sets them, never a person's call. */
export type PersonStopReason = Exclude<EngineStopReason, "operate_off" | "plan">;
const SYSTEM_STOP_REASONS: readonly string[] = ["operate_off", "plan"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA40 = /^[0-9a-f]{40}$/;
const NO_STORE = { "cache-control": "no-store" };
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

export interface IssuedSessionJob {
  job_id: string;
  kind: "engine_session_start" | "engine_session_stop" | "engine_session_delete";
  /** The operate epoch the job was signed with; null for a stop or delete that was already waiting (its epoch is in its signed bytes, which the cloud does not read back). */
  operate_epoch: number | null;
  /** A stop or delete that was already waiting is returned as it is. */
  already_issued: boolean;
}

/** A test seam: runs inside the issuing transaction, right after the gates have read the epoch and still hold the settings row lock. Never set in production. */
export interface IssueHooks { afterGate?: () => Promise<void> }

export interface SessionTarget { repoId: string; ghRepoId: number; owner: string | null; name: string | null; runnerId: string }

/** A refusal by a definer (42501: not an owner or admin of an active account) is the person's 403. */
export async function asPerson<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can run the engine");
    throw error;
  }
}

export async function requireOwnerOrAdmin(client: PoolClient): Promise<void> {
  const role = await requireMemberRole(client);
  if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can run the engine");
}

/** The repo and the machine its engine is placed on. 404 for a repo that is not the account's, 409 `not_placed` and 409 `runner_removed` otherwise. */
export async function loadSessionTarget(client: PoolClient, accountId: string, repoId: string): Promise<SessionTarget> {
  const repo = (await client.query<{ gh_repo_id: string; gh_owner: string | null; gh_name: string | null }>(
    "SELECT gh_repo_id, gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2",
    [accountId, repoId],
  )).rows[0];
  if (!repo) throw refuse(404, "not_found", "no such repository");
  const placed = (await client.query<{ runner_id: string; revoked: boolean }>(
    `SELECT pl.runner_id, (rn.revoked_at IS NOT NULL) AS revoked
       FROM project_placements pl JOIN runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id
      WHERE pl.account_id = $1 AND pl.repo_id = $2`,
    [accountId, repoId],
  )).rows[0];
  if (!placed) throw refuse(409, "not_placed", "the project is not placed on a machine");
  if (placed.revoked) throw refuse(409, "runner_removed", "the machine was removed");
  return { repoId, ghRepoId: Number(repo.gh_repo_id), owner: repo.gh_owner, name: repo.gh_name, runnerId: placed.runner_id };
}

/**
 * The first gate. The coverage is read from the account's rows and the clock on every call. The engine being started is a placement, so it is already counted: `engine_quantity` (every unit in use) is not a refusal,
 * and the plan having ended, never bought or an account on hold are.
 */
export async function requireEngineCoverage(client: PoolClient, accountId: string, repoId?: string): Promise<void> {
  const coverage = await readEngineCoverage(client, accountId, true);
  if (coverage.state === "covered") return;
  if (coverage.state === "engine_quantity") {
    if (coverage.live <= coverage.quantity) return;
    // Downgrade (Ruling 82): more engines are placed than the plan holds. A start passes only for a placement among the oldest `quantity`; running sessions are not stopped.
    if (repoId !== undefined && (await withinQuantity(client, accountId, repoId, coverage.quantity))) return;
  }
  const refusal = engineCoverageRefusal(coverage);
  throw new RunnerHttpError(
    refusal?.status ?? 503, refusal?.code ?? "engine_plan_unavailable", refusal?.message ?? "The Engine plan isn't available right now", refusal?.data ? { ...refusal.data } : {},
  );
}

/** Whether the repo's placement ranks among the oldest `quantity` of the account by `(placed_at, repo_id)`. Named by the account, on top of row security. */
async function withinQuantity(client: PoolClient, accountId: string, repoId: string, quantity: number): Promise<boolean> {
  const { rows } = await client.query<{ repo_id: string }>(
    "SELECT repo_id FROM project_placements WHERE account_id = $1 ORDER BY placed_at, repo_id LIMIT $2",
    [accountId, quantity],
  );
  return rows.some((r) => r.repo_id === repoId);
}

/** Item 9: a repo is operated only when watch, operate AND its tick (`engine_bridge_repos`) are all on. The same predicate as the SQL's `engine_repo_operated`, read here because app_user cannot execute the definer. */
export async function repoOperated(client: PoolClient, accountId: string, repoId: string): Promise<boolean> {
  const row = (await client.query<{ operated: boolean }>(
    `SELECT (st.watch_enabled AND st.operate_enabled AND EXISTS (SELECT 1 FROM engine_bridge_repos br WHERE br.account_id = st.account_id AND br.repo_id = $2)) AS operated
       FROM engine_bridge_settings st WHERE st.account_id = $1`,
    [accountId, repoId],
  )).rows[0];
  return row?.operated === true;
}

/** The account's operate switch and epoch. With `lock`, the row is taken `FOR SHARE` (needs a session whose UPDATE policy admits the row: an owner or admin on a session); a row that is absent or not visible reads as off. */
export async function readOperate(client: PoolClient, accountId: string, lock: boolean): Promise<{ enabled: boolean; epoch: number }> {
  const row = (await client.query<{ operate_enabled: boolean; operate_epoch: number }>(
    `SELECT operate_enabled, operate_epoch FROM engine_bridge_settings WHERE account_id = $1${lock ? " FOR SHARE" : ""}`,
    [accountId],
  )).rows[0];
  return { enabled: row?.operate_enabled === true, epoch: row?.operate_epoch ?? 0 };
}

/** The id of the repo's issued or delivered job of this kind, if any (app_user reads the row's facts, never the signed bytes). */
export async function pendingJob(client: PoolClient, accountId: string, repoId: string, kind: IssuedSessionJob["kind"]): Promise<string | null> {
  const row = (await client.query<{ id: string }>(
    `SELECT id FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND kind = $3 AND state IN ('issued', 'delivered') ORDER BY issued_at DESC, id DESC LIMIT 1`,
    [accountId, repoId, kind],
  )).rows[0];
  return row?.id ?? null;
}

export async function signerOf(deps: RunnerCloudDeps): Promise<EngineCommandSigner & Required<Pick<EngineCommandSigner, "signMachineJob">>> {
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  if (signer?.signMachineJob === undefined) throw refuse(503, "not_configured", "the cloud cannot issue an engine job now");
  return signer as EngineCommandSigner & Required<Pick<EngineCommandSigner, "signMachineJob">>;
}

/** Signs and inserts one session job (no setup) through the definer, which re-checks the person and the runner. */
export async function insertJob(client: PoolClient, deps: RunnerCloudDeps, signer: Awaited<ReturnType<typeof signerOf>>, t: SessionTarget, job: Pick<MachineJob, "kind" | "args">, at?: Date): Promise<string> {
  const jobId = randomUUID();
  const issued = at ?? (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: t.runnerId, repo_gh_id: t.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), ...job,
  } as MachineJob);
  await client.query("SELECT machine_job_issue($1, $2, $3, NULL::uuid, $4, $5::jsonb, $6, $7) AS attempt", [jobId, t.runnerId, t.repoId, job.kind, JSON.stringify(signed), issued, expires]);
  return jobId;
}

/** Whether the machine lists this engine's sandbox, or has started it before (a sandbox it evicted is then taken fresh and reported so). Named by the account, on top of row security. */
export async function hadSession(client: PoolClient, accountId: string, t: SessionTarget): Promise<boolean> {
  return (await client.query<{ resume: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM runner_sandboxes s WHERE s.account_id = $1 AND s.runner_id = $2 AND s.name = $3)
             OR EXISTS (SELECT 1 FROM machine_jobs j WHERE j.account_id = $1 AND j.repo_id = $4 AND j.runner_id = $2 AND j.kind = 'engine_session_start' AND j.state = 'done')) AS resume`,
    [accountId, t.runnerId, `${ENGINE_SESSION_NAME_PREFIX}${t.ghRepoId}`, t.repoId],
  )).rows[0]!.resume;
}

/** Issues `engine_session_start` for a placed repo. See the gates in the header. */
export async function issueEngineSessionStart(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, hooks: IssueHooks = {}): Promise<IssuedSessionJob> {
  const signer = await signerOf(deps);
  const github = deps.pullRequests ?? null;
  if (github === null) throw refuse(503, "not_configured", "the cloud cannot issue an engine job now");
  const { accountId } = principal;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, accountId, principal.userId, fn);
  // The cheap refusals first, so a start that cannot be issued never costs a GitHub call. The same gates run again under the lock below.
  const first = await asPerson(() => tenant(async (client) => {
    await requireOwnerOrAdmin(client);
    const target = await loadSessionTarget(client, accountId, repoId);
    await requireEngineCoverage(client, accountId, repoId);
    if (!(await readOperate(client, accountId, false)).enabled || !(await repoOperated(client, accountId, repoId))) throw refuse(409, "operate_off", "operate is off, so the engine cannot be started");
    return target;
  }));
  if (first.owner === null || first.name === null) throw refuse(409, "default_branch_empty", "the repository has no name on record");
  let head: string;
  try {
    const repo = { id: repoId, owner: first.owner, name: first.name };
    const branch = await github.defaultBranch(repo);
    const state = await github.branchState({ repo, branch, base: branch });
    if (!state.exists || state.headOid === null || !SHA40.test(state.headOid)) throw refuse(409, "default_branch_empty", "the default branch has no commit yet");
    head = state.headOid;
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    if (error instanceof RunPullRequestError) throw error.retryable ? refuse(503, "github_unavailable", "GitHub could not be read now") : refuse(502, "github_refused", "GitHub refused the read");
    throw error;
  }
  return asPerson(() => tenant(async (client) => {
    await requireOwnerOrAdmin(client);
    // One issuer per repo at a time, so two clicks issue one start.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`engine_session:${accountId}:${repoId}`]);
    // FU-229: the switches and the ticked set are held for this transaction (the account's bridge lock, shared; every writer of either takes it exclusively), so an untick or an off either committed before the gates
    // below read it, or waits until this start has committed. It does not rely on the order in which that writer touches its rows; a start issued just before an untick is closed by the deliver check (migration 1077).
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('engine_bridge:' || NULLIF(current_setting('app.account_id', true), ''), 0))");
    const target = await loadSessionTarget(client, accountId, repoId);
    if (target.runnerId !== first.runnerId) throw refuse(409, "session_changed", "the project moved while the job was made; try again");
    await requireEngineCoverage(client, accountId, repoId);
    const operate = await readOperate(client, accountId, true);
    if (!operate.enabled || operate.epoch < 1 || !(await repoOperated(client, accountId, repoId))) throw refuse(409, "operate_off", "operate is off, so the engine cannot be started");
    await hooks.afterGate?.();
    if ((await pendingJob(client, accountId, repoId, "engine_session_start")) !== null) throw refuse(409, "start_pending", "a start is already waiting for the machine");
    // A carry that is open (being exported, or failed and waiting for the person) owns the next start: it is signed from the sealed carry, or the person abandons the carry first.
    if ((await openCarry(client, accountId, repoId)) !== null) throw carryPending();
    // Resume when the machine still lists this engine's sandbox, or has started it before (a sandbox the machine evicted is then taken fresh and reported so).
    const resume = await hadSession(client, accountId, target);
    const jobId = await insertJob(client, deps, signer, target, { kind: "engine_session_start", args: { at_sha: head, resume, operate_epoch: operate.epoch } });
    await client.query("SELECT audit_write('engine_session.started', $1::jsonb)", [JSON.stringify({ repo_id: repoId, job_id: jobId, resume })]);
    return { job_id: jobId, kind: "engine_session_start" as const, operate_epoch: operate.epoch, already_issued: false };
  }));
}

/** The body of a stop or delete, inside the caller's tenant transaction, after the owner or admin check and with the repo's advisory lock held. Shared by the issuers and by the retry of a failed stop. */
export async function issueStopOrDeleteLocked(
  client: PoolClient, deps: RunnerCloudDeps, signer: Awaited<ReturnType<typeof signerOf>>, accountId: string, target: SessionTarget, kind: "engine_session_stop" | "engine_session_delete", reason: PersonStopReason | null,
): Promise<IssuedSessionJob> {
  const repoId = target.repoId;
  const waiting = await pendingJob(client, accountId, repoId, kind);
  if (waiting !== null) return { job_id: waiting, kind, operate_epoch: null, already_issued: true };
  // Never gated; the epoch is the one now, which after an off is the post-off epoch.
  const { epoch } = await readOperate(client, accountId, false);
  const args = kind === "engine_session_stop" ? { reason: reason as PersonStopReason, operate_epoch: epoch } : { operate_epoch: epoch };
  const jobId = await insertJob(client, deps, signer, target, { kind, args } as Pick<MachineJob, "kind" | "args">);
  if (kind === "engine_session_stop") await client.query("SELECT audit_write('engine_session.stopped', $1::jsonb)", [JSON.stringify({ repo_id: repoId, job_id: jobId, reason })]);
  else await client.query("SELECT audit_write('engine_session.deleted', $1::jsonb)", [JSON.stringify({ repo_id: repoId, job_id: jobId })]);
  return { job_id: jobId, kind, operate_epoch: epoch, already_issued: false };
}

/** The per-repo lock every issuer takes, so two clicks issue one job. */
export const lockEngineSession = (client: PoolClient, accountId: string, repoId: string): Promise<unknown> =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`engine_session:${accountId}:${repoId}`]);

async function issueStopOrDelete(
  deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, kind: "engine_session_stop" | "engine_session_delete", reason: PersonStopReason | null,
): Promise<IssuedSessionJob> {
  const signer = await signerOf(deps);
  const { accountId } = principal;
  return asPerson(() => withTenant(deps.appUserPool, accountId, principal.userId, async (client) => {
    await requireOwnerOrAdmin(client);
    await lockEngineSession(client, accountId, repoId);
    const target = await loadSessionTarget(client, accountId, repoId);
    return issueStopOrDeleteLocked(client, deps, signer, accountId, target, kind, reason);
  }));
}

/** Issues `engine_session_stop` for a placed repo, with the person's reason (person, halt, move, remove). `operate_off` and `plan` are the system's alone (Ruling 82) and throw here. Never gated. */
export const issueEngineSessionStop = async (deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, reason: PersonStopReason): Promise<IssuedSessionJob> => {
  if (SYSTEM_STOP_REASONS.includes(reason)) throw new Error(`engine session stop reason ${reason} is system-only`);
  return issueStopOrDelete(deps, principal, repoId, "engine_session_stop", reason);
};

/** Issues `engine_session_delete` (the sandbox and its snapshots go) for a placed repo. Never gated. */
export const issueEngineSessionDelete = (deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<IssuedSessionJob> =>
  issueStopOrDelete(deps, principal, repoId, "engine_session_delete", null);

/**
 * POST /api/v1/engine/repos/:id/start. An owner or admin on a session (the route takes no token): issues `engine_session_start` for the repo's placed engine, behind the coverage and operate gates.
 * 200 `{job_id, kind, operate_epoch, already_issued}`.
 */
export async function startEngine(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw refuse(404, "not_found", "no such repository");
  return { status: 200, body: await issueEngineSessionStart(deps, principal, repoId.toLowerCase()), headers: NO_STORE };
}
