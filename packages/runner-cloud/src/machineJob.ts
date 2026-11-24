import {
  CLAIM_IDLE_RETRY_AFTER_SECONDS,
  MACHINE_JOB_CLAIM_PATH,
  MachineJobClaimMessage,
  MachineJobClaimReply,
  SessionJobProgressBody,
  SetupProgressBody,
  SetupProgressReply,
  machineJobOffered,
  machineJobProgressPath,
  setupProgressPath,
  type MachineJobKind,
  type RunnerOffer,
} from "@fulcrumaxe/runner-protocol";
import type { PoolClient } from "pg";
import { emitSetupChanged } from "@fx/core/src/onboarding/engineTrack.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { reissueRacedSetup } from "./setupReissue.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

/**
 * D#845 ON-8a: how a runner takes a machine job (the work the cloud asks of a person's own machine) and reports on a setup. The jobs are rows (`machine_jobs`), signed when they are issued; nothing here signs.
 * Both routes are verified like every signed runner route (the RFC 9421 signature with a single-use nonce, the strict message), and the runner is the one the signature names.
 *
 *   hint      a claim reply carries `machine_job: true` when a job waits for this runner AND it may be offered it: it is not paused or draining, its latest hello (protocol 22 or later) listed the
 *             kind's capability, and, for a job that needs a microVM, its facts say its engine is one. The rule is `machineJobOffered`, so the hint and the pickup below cannot disagree.
 *   claim     POST /api/runner/machine-job/claim hands over one offered job, once, and nothing while the runner holds a delivered one. A delivered job is never delivered again: it ends, or expires.
 *   progress  POST /api/runner/setup/:setup_id/progress records one step of one job. 404 for a job that is not this runner's for this setup (so for every foreign id), 409 `job_superseded` for an earlier
 *             attempt, 409 `job_not_active` for a job that is not delivered or has ended, 409 `seq_not_increasing` for a number at or below the last. The row's own fence is the definer's (migration 1053).
 *
 *  session   POST /api/runner/machine-job/:job_id/progress (ON-13a0) is the same report for a SESSION job (start, stop, delete), keyed by the job and not by a setup; see `machineJobProgressRun` below.
 *
 * Statuses: 401 (unsigned or wrong runner), 400 (invalid message), 404, 409.
 */
class HeadNotRecorded extends Error {}
const NO_STORE = { "cache-control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** What `machineJobOffered` needs of this runner: its stored protocol, the capabilities of its latest hello and the sandbox engine of its facts (absent when it sent none). */
async function offerOf(client: PoolClient, runner: { accountId: string; runnerId: string }): Promise<RunnerOffer> {
  const { rows } = await client.query<{ protocol_version: number | null; capabilities: string[] | null; sandbox_engine: string | null }>(
    `SELECT r.protocol_version, c.capabilities, f.sandbox_engine FROM runners r
       LEFT JOIN runner_capabilities c ON c.account_id = r.account_id AND c.runner_id = r.id
       LEFT JOIN runner_facts f ON f.account_id = r.account_id AND f.runner_id = r.id
      WHERE r.account_id = $1 AND r.id = $2`,
    [runner.accountId, runner.runnerId],
  );
  const row = rows[0];
  const engine = row?.sandbox_engine;
  return { protocol_version: row?.protocol_version ?? 0, capabilities: row?.capabilities ?? [], sandbox_engine: engine === "os_sandbox" || engine === "microvm" ? engine : undefined };
}

/** The ids of the jobs waiting for this runner that it may be offered, oldest first. None for a runner a person paused or set to drain. Read in the caller's runner session. */
export async function offeredMachineJobs(client: PoolClient, runner: { accountId: string; runnerId: string }): Promise<string[]> {
  const held = await client.query<{ held: boolean }>("SELECT (paused_at IS NOT NULL OR draining) AS held FROM runner_settings WHERE runner_id = $1", [runner.runnerId]);
  if (held.rows[0]?.held === true) return [];
  const pending = await client.query<{ o_id: string; o_kind: MachineJobKind; o_requires_engine: "microvm" | "any" }>("SELECT o_id, o_kind, o_requires_engine FROM machine_job_pending()");
  if (pending.rows.length === 0) return [];
  const offer = await offerOf(client, runner);
  return pending.rows.filter((job) => machineJobOffered(job.o_kind, job.o_requires_engine, offer)).map((job) => job.o_id);
}

export async function machineJobClaimRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, MACHINE_JOB_CLAIM_PATH, req, { replay: "once" });
  parseMessage(MachineJobClaimMessage, parseJsonBody(req));
  const signed = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      for (const id of await offeredMachineJobs(client, runner)) {
        const { rows } = await client.query<{ job: unknown }>("SELECT machine_job_deliver($1::uuid) AS job", [id]);
        if (rows[0]?.job) return rows[0].job;
      }
      return null;
    }),
  );
  if (signed === null) return { status: 200, body: MachineJobClaimReply.parse({ retry_after: CLAIM_IDLE_RETRY_AFTER_SECONDS }), headers: { ...NO_STORE, "retry-after": String(CLAIM_IDLE_RETRY_AFTER_SECONDS) } };
  return { status: 200, body: MachineJobClaimReply.parse({ signed_job: signed }), headers: NO_STORE };
}

export async function setupProgressRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, setupId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, setupProgressPath(setupId), req, { replay: "once" });
  // After the signature, not before: an unsigned caller must not learn from a 404 which ids are well formed.
  if (!UUID.test(setupId)) throw new RunnerHttpError(404, "not_found", "no such setup");
  const body = parseMessage(SetupProgressBody, parseJsonBody(req));
  // D#845 Ruling 73: the push step's `ok` is the report that carries the pushed commit; without it the cloud has no record of what the repository now holds.
  if (body.sub_step === "push" && body.state === "ok" && body.head_sha === undefined) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  const result = await asRunner(async () => {
    try {
      return await withRunnerSession(deps.appUserPool, runner, async (client) => {
        const { rows } = await client.query<{ o_result: string; o_repo_id: string | null }>("SELECT o_result, o_repo_id FROM setup_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)", [
          setupId.toLowerCase(), body.job_id, body.seq, body.sub_step, body.state, body.failure_code ?? null, body.failure_reason ?? null,
        ]);
        const row = rows[0];
        if (row?.o_result === "ok" && body.head_sha !== undefined) {
          // in the report's own transaction: a head that cannot be recorded undoes the report
          const stored = (await client.query<{ ok: boolean }>("SELECT setup_head_record($1::uuid, $2::uuid, $3) AS ok", [setupId.toLowerCase(), body.job_id, body.head_sha])).rows[0]?.ok;
          if (stored !== true) throw new HeadNotRecorded();
        }
        if (row?.o_result === "ok" && row.o_repo_id) await emitSetupChanged(client, { accountId: runner.accountId, setupId: setupId.toLowerCase(), repoId: row.o_repo_id });
        return row?.o_result ?? "not_found";
      });
    } catch (error) {
      if (error instanceof HeadNotRecorded) throw new RunnerHttpError(409, "head_not_recorded", "the pushed commit could not be recorded for this job");
      // A reason or a topic the table's own rules refuse (a shape the schema allows but the column does not): a bad report, not a server fault.
      if (pgCode(error) === "23514" || pgCode(error) === "22023") throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
      throw error;
    }
  });
  // A direct-mode job that lost the race for the default branch is replaced by the same setup in PR mode; when that cannot be done it stays failed for a person's Retry.
  if (result === "ok" && body.state === "failed" && body.failure_code === "direct_raced") await reissueRacedSetup(deps, runner, setupId.toLowerCase(), body.job_id);
  // D#845 ON-8f2a: the pushed commit is recorded, so the install pull request is due; the reconcile job takes it on the next tick (never in this request, and a lost marker only costs the backstop).
  if (result === "ok" && body.sub_step === "push" && body.state === "ok") void markWorkPending("reconcile");
  if (result === "ok") return { status: 200, body: SetupProgressReply.parse({ recorded: true }), headers: NO_STORE };
  if (result === "superseded") throw new RunnerHttpError(409, "job_superseded", "a later attempt replaced this job");
  if (result === "not_active") throw new RunnerHttpError(409, "job_not_active", "this job is not running");
  if (result === "seq") throw new RunnerHttpError(409, "seq_not_increasing", "the sequence number is not above the last one");
  throw new RunnerHttpError(404, "not_found", "no such job");
}

/**
 * D#845 ON-13a0: POST /api/runner/machine-job/:job_id/progress. The runner reports one step of a SESSION job (`engine_session_start`, `_stop`, `_delete`), keyed by the signed `job_id` in the path. Same door, same
 * signature and single-use nonce, same replies as the setup route: 200 `{recorded: true}`, 404 `not_found` (a job that is not this runner's, a setup job, any id that is not a job), 409 `job_not_active`, 409
 * `seq_not_increasing`, 400 for a body outside `SessionJobProgressBody` or one the definer refuses for its kind (a step the kind does not have, a start mode on the wrong step or kind). The fence and the write are the
 * definer's `machine_job_progress_record` (migration 1066). There is no superseded reply: a superseded job is simply not active.
 */
export async function machineJobProgressRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, machineJobProgressPath(jobId), req, { replay: "once" });
  // After the signature, not before: an unsigned caller must not learn from a 404 which ids are well formed.
  if (!UUID.test(jobId)) throw new RunnerHttpError(404, "not_found", "no such job");
  const body = parseMessage(SessionJobProgressBody, parseJsonBody(req));
  const result = await asRunner(async () => {
    try {
      return await withRunnerSession(deps.appUserPool, runner, async (client) => {
        const { rows } = await client.query<{ o_result: string }>("SELECT o_result FROM machine_job_progress_record($1::uuid, $2, $3, $4, $5, $6, $7)", [
          jobId.toLowerCase(), body.seq, body.step, body.state, body.failure_code ?? null, body.failure_reason ?? null, body.start_mode ?? null,
        ]);
        return rows[0]?.o_result ?? "not_found";
      });
    } catch (error) {
      // A shape the schema allows but the kind or the column does not (a step of another kind, a start mode on a stop): a bad report, not a server fault.
      if (pgCode(error) === "23514" || pgCode(error) === "22023") throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
      throw error;
    }
  });
  if (result === "ok") return { status: 200, body: SetupProgressReply.parse({ recorded: true }), headers: NO_STORE };
  if (result === "not_active") throw new RunnerHttpError(409, "job_not_active", "this job is not running");
  if (result === "seq") throw new RunnerHttpError(409, "seq_not_increasing", "the sequence number is not above the last one");
  throw new RunnerHttpError(404, "not_found", "no such job");
}
