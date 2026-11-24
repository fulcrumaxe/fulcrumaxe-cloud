import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
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
  type ExecutionTargetRegistry,
} from "@fx/runner";
import type { SeatRequest, SeatResult } from "./seat.js";

/**
 * D#845 ON-10b1 (Ruling 88 items 4 and 6): the worker's start of a survey run. It holds the runner pool; nothing else does. It is given plain facts the caller already checked as the person (the setup, the repo, its
 * placed machine, the default branch's head): it resolves the `survey` seat, builds the fixed prompt, and starts the run on the registry with three things that make it safe:
 *  - the run is created for `runner_local` only (`expectedExecutionMode`), so a mode that moved after the seat throws before any row exists;
 *  - the run is bound to its setup INSIDE the create transaction (`survey_start_record`, under the verified principal's user id, cleared again straight after), so the bind commits with the run or not at all, and
 *    the issuer writes the job only after that, so no runner can see an unbound survey;
 *  - the idempotency key is `survey:<setup>:<prior survey run or none>`, so two clicks read the same prior run and exactly one wins.
 * The answer is the run's id or a closed refusal; no error text, pool or client leaves this module.
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
}

export type StartSurveyRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 403; code: "forbidden" }
  /** Another survey run is live for this setup (`runId`: its id, when it could be read). */
  | { ok: false; status: 409; code: "survey_running"; runId: string | null }
  /** The survey was not started. `reason` is a closed code: a seat refusal, an admit or precheck reason, an issuer code or `execution_mode_changed`. */
  | { ok: false; status: 409; code: "survey_not_started"; reason: string }
  | { ok: false; status: 500; code: "internal" };

export interface SurveyStartDeps {
  /** The runner login's pool. */
  pool: Pool;
  registry: ExecutionTargetRegistry;
  resolveRunSeat(request: SeatRequest): Promise<SeatResult>;
}

export interface SurveyStartFacade {
  startSurveyRun(input: StartSurveyRunInput): Promise<StartSurveyRunResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = (error: unknown): string | undefined => (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined);
const notStarted = (reason: string): StartSurveyRunResult => ({ ok: false, status: 409, code: "survey_not_started", reason });

/** The bind, run inside the run's create transaction. A throw rolls the whole create back (no run row, no job, no idempotency claim). */
async function bind(client: PoolClient, userId: string, setupId: string, runId: string): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  await client.query("SELECT survey_start_record($1::uuid, $2::uuid)", [setupId, runId]);
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

  return {
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
          startMeta: { survey_runner_id: input.runnerId },
          ...(input.requiresEngine === undefined ? {} : { requiresEngine: input.requiresEngine }),
          idempotency: { key, requestHash: createHash("sha256").update(`${key}\n${input.headSha}\n${input.runnerId}`).digest("hex") },
          inCreateTransaction: (client, runId) => bind(client, input.userId, input.setupId, runId),
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
