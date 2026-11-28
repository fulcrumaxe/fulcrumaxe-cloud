import type { PoolClient } from "pg";
import { RUNNER_ONLINE_SECONDS, runnerLiveSql } from "@fx/runner";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { asPerson, issueEngineSessionStart, lockEngineSession, requireOwnerOrAdmin } from "./engineSession.js";
import { openCarry, requireCarryReady } from "./stateCarryMove.js";

/**
 * D#845 MC-9b2e: what a person does with a carry that did not finish, and how a repo's carry is read. Both routes are an owner's or admin's on a session (no token), take the REPO's id (a repo has one open carry)
 * and an empty JSON object, and decide nothing themselves: the rules are the 1123 definers' (`state_carry_abandon`, `state_carry_retry`), which name the account and the person from the session.
 *
 *   abandon  POST /api/v1/engine/repos/:id/carry/abandon  "Start without the memory": closes the carry `abandoned` (its content goes) and issues the plain start the carry was holding back. 200 `{ job_id }`.
 *   retry    POST /api/v1/engine/repos/:id/carry/retry    "Try again": closes the failed carry `retried` and opens a new one for the same machines; the old machine's stop is due again. 200 `{ carry }` (the new id).
 *
 * Refusals: 400 `invalid_message`; 403 `forbidden`; 404 `not_found`; 409 `no_carry` (nothing is open), `carry_not_failed` (a carry that is still running is not retried), `nothing_to_retry` (the old machine or the placement is
 * gone: only Start without the memory is left) and, for a retry, `state_carry_unavailable` with a `reason` (the same gates as the move). An abandon whose start is then refused (a plan, operate, GitHub) leaves the carry closed: the
 * person's own Start engine is the way on. Every query names the account on top of row security.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" } as const;
const invalid = (): RunnerHttpError => new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
const noCarry = (): RunnerHttpError => new RunnerHttpError(409, "no_carry", "there is no team memory being moved for this project");

function checked(repoId: string, body: unknown): string {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0) throw invalid();
  return repoId.toLowerCase();
}

export async function abandonCarryRoute(deps: RunnerCloudDeps, principal: SessionPrincipal, repoIdIn: string, body: unknown): Promise<RunnerHttpResponse> {
  const repoId = checked(repoIdIn, body);
  const { accountId } = principal;
  await asPerson(() => withTenant(deps.appUserPool, accountId, principal.userId, async (client) => {
    await requireOwnerOrAdmin(client);
    await lockEngineSession(client, accountId, repoId);
    const open = await openCarry(client, accountId, repoId);
    if (!open) throw noCarry();
    try {
      await client.query("SELECT state_carry_abandon($1::uuid)", [open.id]);
    } catch (error) {
      if (pgCode(error) === "22023") throw noCarry();
      throw error;
    }
  }));
  // The lock is released: the start takes it again. The carry is closed, so the guard on starts lets this one through.
  const started = await issueEngineSessionStart(deps, principal, repoId);
  return { status: 200, body: { job_id: started.job_id }, headers: NO_STORE };
}

export async function retryCarryRoute(deps: RunnerCloudDeps, principal: SessionPrincipal, repoIdIn: string, body: unknown): Promise<RunnerHttpResponse> {
  const repoId = checked(repoIdIn, body);
  const { accountId } = principal;
  const id = await asPerson(() => withTenant(deps.appUserPool, accountId, principal.userId, async (client) => {
    await requireOwnerOrAdmin(client);
    await lockEngineSession(client, accountId, repoId);
    const open = (await client.query<{ id: string; failure_code: string | null; from_runner_id: string; to_runner_id: string }>(
      "SELECT id, failure_code, from_runner_id, to_runner_id FROM state_carries WHERE account_id = $1 AND repo_id = $2 AND closed_at IS NULL", [accountId, repoId],
    )).rows[0];
    if (!open) throw noCarry();
    if (open.failure_code === null) throw new RunnerHttpError(409, "carry_not_failed", "the team's memory is still being moved");
    // The same gates as the move: a machine that still lacks the capability is told so now, not after another round.
    await requireCarryReady(client, deps, accountId, [open.from_runner_id, open.to_runner_id]);
    try {
      return (await client.query<{ id: string }>("SELECT state_carry_retry($1::uuid) AS id", [open.id])).rows[0]!.id;
    } catch (error) {
      if (pgCode(error) === "22023") throw new RunnerHttpError(409, "nothing_to_retry", "the old machine cannot hand the memory over again");
      throw error;
    }
  }));
  void markRunnerWork(accountId); // the old machine claims within seconds and its claim signs the new carry's stop
  return { status: 200, body: { carry: { id } }, headers: NO_STORE };
}

/** What a repo's row shows of an open carry (derived on each read, never stored); `starting` once it is sealed, when the normal start progress takes over. */
export interface RepoCarry {
  state: "waiting_machine" | "exporting" | "starting" | "failed";
  /** One of the closed `state_carries_failure_check` words while `failed`, else null. */
  failure_code: string | null;
  from_name: string;
  to_name: string;
  /** Chunks the old machine has handed over, and how many there are (known once it has begun); null before. */
  parts_done: number | null;
  parts_total: number | null;
}

/**
 * Each repo's open carry. `failed` when a failure code is on it (it stays open until a person decides), `starting` once sealed, `exporting` once the old machine has begun (or while it is online), else `waiting_machine`
 * (it is offline, paused or draining). Machine names are the person's own; none is "Unnamed machine". Named by the account on top of row security; a second repo of the account reads its own.
 */
export async function readRepoCarries(client: Pick<PoolClient, "query">, accountId: string, repoIds: readonly string[], o: { now?: Date } = {}): Promise<Map<string, RepoCarry>> {
  const out = new Map<string, RepoCarry>();
  if (repoIds.length === 0) return out;
  const live = runnerLiveSql({ runner: "fr", now: "$3", onlineSeconds: "$4", wakeEnabled: false });
  const { rows } = await client.query<{ repo_id: string; failure_code: string | null; sealed: boolean; begun: boolean; chunks: number | null; got: number; from_name: string | null; to_name: string | null; live: boolean; held: boolean }>(
    `SELECT c.repo_id, c.failure_code, (c.sealed_at IS NOT NULL) AS sealed, (c.begun_at IS NOT NULL) AS begun, c.chunks, fs.name AS from_name, ts.name AS to_name,
            (SELECT count(*)::int FROM state_carry_chunks k WHERE k.account_id = c.account_id AND k.carry_id = c.id) AS got,
            COALESCE(${live}, false) AS live, COALESCE(fs.paused_at IS NOT NULL OR fs.draining, false) AS held
       FROM state_carries c
       JOIN runners fr ON fr.account_id = c.account_id AND fr.id = c.from_runner_id
       LEFT JOIN runner_settings fs ON fs.account_id = c.account_id AND fs.runner_id = c.from_runner_id
       LEFT JOIN runner_settings ts ON ts.account_id = c.account_id AND ts.runner_id = c.to_runner_id
      WHERE c.account_id = $1 AND c.repo_id = ANY ($2::uuid[]) AND c.closed_at IS NULL`,
    [accountId, repoIds, o.now ?? new Date(), RUNNER_ONLINE_SECONDS],
  );
  for (const r of rows) {
    const state: RepoCarry["state"] = r.failure_code !== null ? "failed" : r.sealed ? "starting" : r.begun || (r.live && !r.held) ? "exporting" : "waiting_machine";
    out.set(r.repo_id, {
      state, failure_code: r.failure_code, from_name: r.from_name ?? "Unnamed machine", to_name: r.to_name ?? "Unnamed machine",
      parts_done: state === "exporting" && r.begun ? r.got : null, parts_total: state === "exporting" && r.begun ? r.chunks : null,
    });
  }
  return out;
}
