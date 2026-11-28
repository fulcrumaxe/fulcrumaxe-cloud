import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import type { EngineCommandSigner } from "./engineCommands.js";
import { engineSessionSpendGuard } from "./engineSpendGuard.js";
import { RunPullRequestError, type RunPullRequestPort } from "./runPullRequest.js";

/**
 * D#845 ON-13c1 (Ruling 98): the system first start. When the rows say a session must be up (an install finished and recorded `start_pending`, or the operate queue's claimed `start` row of ON-13c2) a start is signed here and written through
 * `engine_system_start_issue`, which holds the bytes to the rows, re-checks every gate under the person issuers' locks and consumes the cause in the same transaction (a replay answers `cause_gone`). Level-triggered: the list is derived
 * on every call. The default branch head is read through the App port outside any transaction, once per repo; a GitHub that cannot be asked leaves the repo due. The spend guard runs once per account's batch before anything is read or signed.
 */

export type SystemStartCause = "first_start" | "operate_on" | "engine_update" | "state_carry";
export type SystemStartResult =
  | "issued" | "cause_gone" | "plan" | "busy" | "epoch_moved" | "not_placed"
  | "github_unavailable" | "github_refused" | "default_branch_empty" | "hosted_engine_unavailable" | "carry_gone" | "import_failed" | "error";

type HeadReader = Pick<RunPullRequestPort, "defaultBranch" | "branchState">;

export interface SystemStartDeps {
  pool: Pool;
  engineCommandSigner: () => Promise<Pick<EngineCommandSigner, "signMachineJob"> | null>;
  /** The App port; built only when a start is due, so an idle tick opens no GitHub client. */
  pullRequests: () => HeadReader;
  /** How many of an account's starts would need a hosted sandbox. Absent: none (every placement is a customer's machine). */
  hostedFor?: (accountId: string) => number;
  now?: () => Date;
  reportError: (err: unknown, ctx: { stage: string; route: string; code?: string }) => void;
}

export interface SystemStartScope {
  accountId?: string;
  /** Needs `accountId`. */
  repoId?: string;
  cause?: SystemStartCause;
  limit?: number;
  msLeft?: () => number;
}

export interface SystemStartPass {
  not_configured: boolean;
  issued: number;
  results: Array<{ account_id: string; repo_id: string; result: SystemStartResult }>;
}

interface DueRow {
  o_account: string; o_repo: string; o_runner: string; o_repo_gh_id: string; o_owner: string | null; o_name: string | null; o_epoch: number; o_resume: boolean;
  /** `state_carry` rows only: the sealed carry the start imports (its id, size, chunk count and whole-bundle sha256, as the row has them). */
  o_carry?: string; o_bytes?: number; o_chunks?: number; o_sha256?: string;
}

const ROUTE = "reconcile.engine_session_starts";
const SHA40 = /^[0-9a-f]{40}$/;

/**
 * `first_start` lists the finished installs that still hold `start_pending`; `operate_on` lists the repos whose queue row (ON-13c2) the drain has claimed; `engine_update` lists the repos whose merged update waits for its restart (ON-15c);
 * `state_carry` (D#845 MC-9b2d) lists the sealed carries of a move: its start has the carry's facts in its args and is written by `state_carry_start_issue` (1124), which also binds the carry to its repo and machine.
 */
const LISTERS: Record<SystemStartCause, string> = { first_start: "engine_system_starts_due", operate_on: "engine_operate_on_starts_due", engine_update: "engine_update_starts_due", state_carry: "state_carry_starts_due" };
const listDue = async (pool: Pool, cause: SystemStartCause, accountId: string | null, repoId: string | null, limit: number): Promise<DueRow[]> =>
  (await pool.query<DueRow>(`SELECT * FROM ${LISTERS[cause]}($1::uuid, $2::uuid, $3::integer)`, [accountId, repoId, limit])).rows;

/** The head of the default branch, or the reason it could not be read. */
async function readHead(port: HeadReader, row: DueRow): Promise<{ head: string } | { refused: SystemStartResult }> {
  if (row.o_owner === null || row.o_name === null) return { refused: "github_refused" };
  try {
    const repo = { id: row.o_repo, owner: row.o_owner, name: row.o_name };
    const branch = await port.defaultBranch(repo);
    const state = await port.branchState({ repo, branch, base: branch });
    return state.exists && state.headOid !== null && SHA40.test(state.headOid) ? { head: state.headOid } : { refused: "default_branch_empty" };
  } catch (error) {
    if (error instanceof RunPullRequestError) return { refused: error.retryable ? "github_unavailable" : "github_refused" };
    throw error;
  }
}

/** One signed start, written in its own transaction through the issuer. */
async function issueOne(deps: SystemStartDeps, sign: (job: MachineJob) => unknown, row: DueRow, cause: SystemStartCause, head: string): Promise<SystemStartResult> {
  const jobId = randomUUID();
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const signed = sign({
    v: 1, job_id: jobId, runner_id: row.o_runner, repo_gh_id: Number(row.o_repo_gh_id), requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(),
    kind: "engine_session_start",
    args: cause === "state_carry"
      ? { at_sha: head, resume: false, operate_epoch: row.o_epoch, carry: { id: row.o_carry, bytes: row.o_bytes, chunks: row.o_chunks, sha256: row.o_sha256 } }
      : { at_sha: head, resume: row.o_resume, operate_epoch: row.o_epoch },
  } as MachineJob);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const result = (await client.query<{ result: SystemStartResult }>(
      cause === "state_carry"
        ? "SELECT state_carry_start_issue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::timestamptz, $7::timestamptz) AS result"
        : "SELECT engine_system_start_issue($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::timestamptz, $7::timestamptz) AS result",
      [jobId, row.o_account, row.o_repo, cause === "state_carry" ? row.o_carry : cause, JSON.stringify(signed), issued, expires],
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

/** One pass over the starts the rows say are due (see the header). With no signer it lists nothing and says `not_configured`. An error on one repo is reported and the pass goes on; an epoch that moved is listed again once. */
export async function issueSystemStarts(deps: SystemStartDeps, scope: SystemStartScope = {}): Promise<SystemStartPass> {
  if (scope.repoId !== undefined && scope.accountId === undefined) throw new Error("issueSystemStarts: a repo needs its account");
  const signer = (await deps.engineCommandSigner()) ?? null;
  const pass: SystemStartPass = { not_configured: false, issued: 0, results: [] };
  if (signer?.signMachineJob === undefined) return { ...pass, not_configured: true };
  const cause = scope.cause ?? "first_start";
  const rows = await listDue(deps.pool, cause, scope.accountId ?? null, scope.repoId ?? null, scope.limit ?? 200);
  const sign = (job: MachineJob): unknown => signer.signMachineJob?.(job);
  const note = (row: DueRow, result: SystemStartResult): void => void pass.results.push({ account_id: row.o_account, repo_id: row.o_repo, result });
  const allowed = new Map<string, boolean>();
  let port: HeadReader | undefined;
  for (const first of rows) {
    if (scope.msLeft !== undefined && scope.msLeft() <= 0) break;
    try {
      // Once per account's batch, before anything is read or signed.
      if (!allowed.has(first.o_account)) {
        const starts = rows.filter((r) => r.o_account === first.o_account).length;
        allowed.set(first.o_account, engineSessionSpendGuard({ accountId: first.o_account, starts, hosted: deps.hostedFor?.(first.o_account) ?? 0 }).ok);
      }
      if (allowed.get(first.o_account) !== true) {
        note(first, "hosted_engine_unavailable");
        continue;
      }
      port ??= deps.pullRequests();
      const read = await readHead(port, first);
      if ("refused" in read) {
        note(first, read.refused);
        continue;
      }
      let row = first;
      let result = await issueOne(deps, sign, row, cause, read.head);
      if (result === "epoch_moved") {
        const again = (await listDue(deps.pool, cause, first.o_account, first.o_repo, 1))[0];
        if (again !== undefined) {
          row = again;
          result = await issueOne(deps, sign, row, cause, read.head);
        }
      }
      if (result === "issued") pass.issued += 1;
      note(row, result);
    } catch (error) {
      deps.reportError(error, { stage: "engine_system_starts.issue", route: ROUTE, code: "engine_system_start_failed" });
      note(first, "error");
    }
  }
  return pass;
}
