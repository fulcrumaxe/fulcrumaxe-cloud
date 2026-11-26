import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SURVEY_DEADLINE_GRACE_MS, SURVEY_MAX_RUN_MS, SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { reportError } from "@fx/telemetry";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { buildSurveyPrompt, SurveyPromptInputError } from "@fx/pipeline";
import {
  DispatchFailedError,
  ExecutionModeChangedError,
  IdempotencyKeyTakenError,
  JobIssueError,
  RunPrecheckRefusedError,
  acceptQueuedRunnerRun,
  startAgentRun,
  surveyEndingFor,
  writeRunStatusOn,
  type ExecutionTargetRegistry,
  type RunStatus,
} from "@fx/runner";
import type { SeatRequest, SeatResult } from "./seat.js";

/**
 * D#845 ON-10b1 (Ruling 88 items 4 and 6): the worker's start of a survey run. It holds the runner pool and is given plain facts the caller already checked as the person. It resolves the `survey` seat, builds the fixed
 * prompt and starts the run for `runner_local` only. The run is bound to its setup inside the create transaction, so the bind commits with the run or not at all, and the idempotency key
 * `survey:<setup>:<prior run or none>` lets exactly one of two clicks win. The answer is the run's id or a closed refusal; no error text, pool or client leaves this module.
 */

export interface StartSurveyRunInput {
  accountId: string;
  /** The verified session principal's user id: the only source of the id the bind runs under. */
  userId: string;
  setupId: string;
  repoId: string;
  /** The machine the repo is placed on. The seat checks it again against the placement row. */
  runnerId: string;
  owner: string;
  name: string;
  /** The default branch's head, as GitHub answered it. */
  headSha: string;
  /** The setup's `survey_run_id` as the caller read it (null when none). Part of the idempotency key. */
  priorRunId: string | null;
  /** `microvm` when the placed machine last reported that engine. */
  requiresEngine?: "microvm";
  /** The person consented to surveying this public repo (D#845 ON-10e2a): the consent audit row is written in the run's create transaction. */
  publicConsented?: true;
}

export type StartSurveyRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 403; code: "forbidden" }
  /** Another survey run is live for this setup (`runId`: its id, when it could be read). */
  | { ok: false; status: 409; code: "survey_running"; runId: string | null }
  /** The survey was not started. `reason` is a closed code: a seat refusal, an admit or precheck reason, an issuer code or `execution_mode_changed`. */
  | { ok: false; status: 409; code: "survey_not_started"; reason: string }
  | { ok: false; status: 500; code: "internal" };

/**
 * One look of the deadline Workflow at a survey run (ON-10b2). `cancel` is the start's own failure path: the Workflow could not be started, so the run is ended now, `cancelled`, whatever its deadline.
 * The answer is `final` (nothing more to look at) or the time of the next look, as ISO text so it crosses a Workflow step as plain data.
 */
export interface EndSurveyAtDeadlineInput {
  accountId: string;
  setupId: string;
  runId: string;
  cancel?: boolean;
}
export type SurveyDeadlineLook = { final: true } | { final: false; wakeAt: string };

export interface SurveyStartDeps {
  /** The runner login's pool. */
  pool: Pool;
  /** The clock the deadline reads (tests pass a fake one). */
  now?: () => Date;
  registry: ExecutionTargetRegistry;
  resolveRunSeat(request: SeatRequest): Promise<SeatResult>;
}

export interface SurveyStartFacade {
  startSurveyRun(input: StartSurveyRunInput): Promise<StartSurveyRunResult>;
  endSurveyAtDeadline(input: EndSurveyAtDeadlineInput): Promise<SurveyDeadlineLook>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = (error: unknown): string | undefined => (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined);
const notStarted = (reason: string): StartSurveyRunResult => ({ ok: false, status: 409, code: "survey_not_started", reason });

/** The bind, run inside the run's create transaction. A throw rolls the whole create back (no run row, no job, no idempotency claim). */
async function bind(client: PoolClient, userId: string, setupId: string, runId: string, consent: { headSha: string; runnerId: string } | null): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  await client.query("SELECT survey_start_record($1::uuid, $2::uuid)", [setupId, runId]);
  // D#845 ON-10e2a: the consent's audit row, after the bind and in this same transaction, so it commits with the run or not at all.
  if (consent !== null) await writeEngineAudit(client, "project.public_survey_consented", { setup_id: setupId, run_id: runId, head_sha: consent.headSha, runner_id: consent.runnerId });
  await client.query("SELECT set_config('app.user_id', '', true)");
}

export function createSurveyStart(deps: SurveyStartDeps): SurveyStartFacade {
  /** The setup's current survey run, for the 409 that names it. Account and setup both in the predicate. */
  async function currentRun(accountId: string, setupId: string): Promise<string | null> {
    try {
      return await withTenant(deps.pool, accountId, async (client) => (await client.query<{ survey_run_id: string | null }>("SELECT survey_run_id FROM project_setups WHERE account_id = $1 AND id = $2", [accountId, setupId])).rows[0]?.survey_run_id ?? null);
    } catch {
      // fx-swallow-ok: the run id only decorates a 409 that is already decided; without it the refusal still says a survey is running
      return null;
    }
  }

  /**
   * D#845 ON-10b2 (Ruling 88 item 7): one look at a survey run, in one tenant transaction on the runner login, under the setup row's lock. The setup no longer waiting for this run is final. A run that is over while its setup still waits
   * ended by a move that bypasses the status writer (a mode change): it is closed out with the same mapping the writer's hook uses. A pending run is ended `timed_out` once the survey's own 22 minutes (20 and the grace) have passed since
   * the survey started; a running one 22 minutes after it was claimed, so waiting for a machine never eats its 20. Either end goes through `writeRunStatusOn`, whose hook writes `survey_timeout`/`deadline` in the same transaction.
   */
  async function endAtDeadline(input: EndSurveyAtDeadlineInput): Promise<SurveyDeadlineLook> {
    const { accountId, setupId, runId } = input;
    if (![accountId, setupId, runId].every((id) => typeof id === "string" && UUID.test(id))) return { final: true };
    const at = (deps.now ?? (() => new Date()))();
    return withTenant(deps.pool, accountId, async (client): Promise<SurveyDeadlineLook> => {
      const setup = (await client.query<{ phase: string; state: string; survey_run_id: string | null; survey_started_at: Date | null }>("SELECT phase, state, survey_run_id, survey_started_at FROM project_setups WHERE account_id = $1 AND id = $2 FOR UPDATE", [accountId, setupId])).rows[0];
      if (!setup || setup.phase !== "survey" || setup.state !== "started" || setup.survey_run_id !== runId) return { final: true };
      const run = (await client.query<{ status: RunStatus; started_at: Date | null }>("SELECT status, started_at FROM agent_runs WHERE account_id = $1 AND id = $2 AND role = $3", [accountId, runId, SURVEY_ROLE])).rows[0];
      if (!run) return { final: true };
      if (run.status !== "pending" && run.status !== "running" && run.status !== "paused") {
        // Over, and the setup still waiting: a move that bypassed the status writer. Close it out the way the writer's hook would have (the failure reason is not known here, so `failed` reads as the run failing).
        const ending = surveyEndingFor({ from: run.started_at === null ? "pending" : "running", to: run.status });
        await client.query("SELECT survey_fail($1::uuid, $2, $3)", [runId, ending?.code ?? "survey_failed", ending?.reason ?? "no_output"]);
        return { final: true };
      }
      const from = run.status;
      const origin = from === "running" && run.started_at !== null ? run.started_at : (setup.survey_started_at ?? at);
      const due = new Date(origin.getTime() + SURVEY_MAX_RUN_MS + SURVEY_DEADLINE_GRACE_MS);
      if (input.cancel !== true && at.getTime() < due.getTime()) return { final: false, wakeAt: due.toISOString() };
      // A paused run can only be cancelled (the table has no other way out of it); pending and running end `timed_out`, or `cancelled` on the start's own failure path.
      const to: RunStatus = input.cancel === true || from === "paused" ? "cancelled" : "timed_out";
      const written = await writeRunStatusOn(client, { accountId, runId, from, to, ...(to === "timed_out" ? { failureReason: "wall_clock_limit" } : {}) });
      // The run moved under this look (a claim, or the runner's own end): look again at once, and the next look reads the new status.
      return written.updated ? { final: true } : { final: false, wakeAt: at.toISOString() };
    });
  }

  return {
    endSurveyAtDeadline: endAtDeadline,
    startSurveyRun: async (input) => {
      if (![input.accountId, input.userId, input.setupId, input.repoId, input.runnerId].every((id) => typeof id === "string" && UUID.test(id)) || (input.priorRunId !== null && !UUID.test(input.priorRunId))) return notStarted("invalid_input");
      const seat = await deps.resolveRunSeat({ accountId: input.accountId, role: SURVEY_ROLE, repoId: input.repoId, runnerId: input.runnerId, purpose: "survey" });
      if (!seat.ok) return notStarted(seat.reason);
      let prompt: string;
      try {
        prompt = buildSurveyPrompt({ owner: input.owner, name: input.name, sha: input.headSha });
      } catch (error) {
        if (error instanceof SurveyPromptInputError) return notStarted("survey_prompt_input");
        throw error;
      }
      const key = `survey:${input.setupId}:${input.priorRunId ?? "none"}`;
      try {
        const started = await startAgentRun(deps.pool, deps.registry, {
          ...seat.seat,
          accountId: input.accountId,
          role: SURVEY_ROLE,
          repoId: input.repoId,
          headSha: input.headSha,
          prompt,
          initiatedBy: input.userId,
          expectedExecutionMode: "runner_local",
          // CWE-367: the seat's $0 decision is for this machine only; the claim pin requires the claimer to be this very runner.
          // D#845 ON-10e2b (Ruling 106.1): the consent rides in the start's own facts; the job issuer refuses a public survey without it.
          startMeta: { survey_runner_id: input.runnerId, ...(input.publicConsented === true ? { public_survey_consent: true } : {}) },
          ...(input.requiresEngine === undefined ? {} : { requiresEngine: input.requiresEngine }),
          idempotency: { key, requestHash: createHash("sha256").update(`${key}\n${input.headSha}\n${input.runnerId}`).digest("hex") },
          inCreateTransaction: (client, runId) => bind(client, input.userId, input.setupId, runId, input.publicConsented === true ? { headSha: input.headSha, runnerId: input.runnerId } : null),
        });
        if ("reason" in started) return notStarted(started.reason);
        const accepted = await acceptQueuedRunnerRun(deps.pool, input.accountId, started);
        if (accepted.status !== "pending") return notStarted(accepted.status);
        return { ok: true, runId: accepted.id };
      } catch (error) {
        if (error instanceof IdempotencyKeyTakenError || code(error) === "55000") return { ok: false, status: 409, code: "survey_running", runId: await currentRun(input.accountId, input.setupId) };
        if (code(error) === "42501") return { ok: false, status: 403, code: "forbidden" };
        if (error instanceof ExecutionModeChangedError) return notStarted("execution_mode_changed");
        if (error instanceof RunPrecheckRefusedError) return notStarted(error.reason);
        if (error instanceof NotFoundError) return notStarted("no_repo");
        // The issuer's closed refusal reaches here wrapped by the dispatch cleanup; the run is already ended `failed` by it.
        if (error instanceof DispatchFailedError && error.originalError instanceof JobIssueError) return notStarted(error.originalError.code);
        // 22023 (an argument the bind refused) cannot happen with ids this module checked; it, and anything else, is a closed internal answer with nothing of the error in it.
        reportError(error, { stage: "survey.start" });
        return { ok: false, status: 500, code: "internal" };
      }
    },
  };
}
