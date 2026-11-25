import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import type { EngineCommandSigner } from "./engineCommands.js";

/**
 * D#845 ON-13a5: system-caused engine-session stops. When the cloud's own state says a session must not run (the account's operate switch is off, the repo is no longer ticked, or the engine plan ended) a stop
 * is signed here and written through `engine_system_stop_issue`, a definer that accepts only `engine_session_stop` with reason `operate_off` or `plan` and re-checks the cause from the rows under the repo's session lock.
 * No person is borrowed: a plan stop has no person, and an owner removed in between must not block it.
 *
 * Level-triggered: `engine_system_stops_due` derives what is due from the rows and the clock on every call, so a missed marker, a failed webhook hook or a crashed tick is picked up by the next tick, and calling this twice
 * stops each session once (the second call answers `already_stopping`). Nothing here is stamped, and nothing runs inside the request that changed a switch.
 *
 * The pool is the one the caller hands over (production passes the reconciler's, which is the only login the two definers admit); this file never builds a pool or reads a connection setting.
 */

export type SystemStopReason = "operate_off" | "plan";
export type SystemStopResult = "issued" | "superseded_only" | "cause_gone" | "already_stopping" | "awaiting_report" | "epoch_moved" | "not_placed";

export type SystemStopReportError = (err: unknown, ctx: { stage: string; route: string; code?: string }) => void;

export interface SystemStopDeps {
  /** The login the two definers admit. They refuse any other session, and a session that carries a person or a runner. */
  pool: Pool;
  engineCommandSigner: () => Promise<Pick<EngineCommandSigner, "signMachineJob"> | null>;
  now?: () => Date;
  reportError: SystemStopReportError;
}

export interface SystemStopScope {
  accountId?: string;
  /** Needs `accountId`. */
  repoId?: string;
  /** Rows to take from the list, 1 to 500. Defaults to 200. */
  limit?: number;
  /** Milliseconds left for the pass; no further repo is started once it is spent. */
  msLeft?: () => number;
}

export interface SystemStopPass {
  not_configured: boolean;
  issued: number;
  results: Array<{ account_id: string; repo_id: string; reason: SystemStopReason; result: SystemStopResult | "error" }>;
}

interface DueRow {
  o_account: string;
  o_repo: string;
  o_runner: string;
  o_repo_gh_id: string;
  o_reason: SystemStopReason;
  o_epoch: number;
  o_issued_starts: number;
}

const DEFAULT_LIMIT = 200;
const ROUTE = "reconcile.engine_session_stops";

async function listDue(pool: Pool, accountId: string | null, repoId: string | null, limit: number): Promise<DueRow[]> {
  return (await pool.query<DueRow>("SELECT * FROM engine_system_stops_due($1::uuid, $2::uuid, $3::integer)", [accountId, repoId, limit])).rows;
}

/** One signed stop, written in its own transaction through the issuer. */
async function issueOne(deps: SystemStopDeps, sign: (job: MachineJob) => unknown, row: DueRow): Promise<SystemStopResult> {
  const jobId = randomUUID();
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const job: MachineJob = {
    v: 1, job_id: jobId, runner_id: row.o_runner, repo_gh_id: Number(row.o_repo_gh_id), requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(),
    kind: "engine_session_stop", args: { reason: row.o_reason, operate_epoch: row.o_epoch },
  } as MachineJob;
  const signed = sign(job);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const result = (await client.query<{ result: SystemStopResult }>(
      "SELECT engine_system_stop_issue($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::timestamptz, $7::timestamptz) AS result",
      [jobId, row.o_account, row.o_repo, row.o_reason, JSON.stringify(signed), issued, expires],
    )).rows[0]!.result;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((): void => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * One pass over the sessions a system cause says to stop (see the header). With no signer it lists nothing and says `not_configured`. An error on one repo is reported and the pass goes on to the next; a signed
 * epoch that moved between the list and the issue (an operate switch in between) re-lists that one repo and tries once more.
 */
export async function issueSystemStops(deps: SystemStopDeps, scope: SystemStopScope = {}): Promise<SystemStopPass> {
  if (scope.repoId !== undefined && scope.accountId === undefined) throw new Error("issueSystemStops: a repo needs its account");
  const signer = (await deps.engineCommandSigner()) ?? null;
  const pass: SystemStopPass = { not_configured: false, issued: 0, results: [] };
  if (signer?.signMachineJob === undefined) return { ...pass, not_configured: true };
  const limit = scope.limit ?? DEFAULT_LIMIT;
  const rows = await listDue(deps.pool, scope.accountId ?? null, scope.repoId ?? null, limit);
  const sign = (job: MachineJob): unknown => signer.signMachineJob?.(job);
  for (const first of rows) {
    if (scope.msLeft !== undefined && scope.msLeft() <= 0) break;
    let row = first;
    try {
      let result = await issueOne(deps, sign, row);
      if (result === "epoch_moved") {
        // An operate switch landed between the list and the issue: the one repo is listed again at the epoch now, and tried once more.
        const again = (await listDue(deps.pool, first.o_account, first.o_repo, 1))[0];
        if (again !== undefined) {
          row = again;
          result = await issueOne(deps, sign, row);
        }
      }
      if (result === "issued") pass.issued += 1;
      pass.results.push({ account_id: row.o_account, repo_id: row.o_repo, reason: row.o_reason, result });
    } catch (error) {
      deps.reportError(error, { stage: "engine_system_stops.issue", route: ROUTE, code: "engine_system_stop_failed" });
      pass.results.push({ account_id: row.o_account, repo_id: row.o_repo, reason: row.o_reason, result: "error" });
    }
  }
  return pass;
}
