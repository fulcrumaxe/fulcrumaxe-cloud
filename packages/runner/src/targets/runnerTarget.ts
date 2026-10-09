import type { Pool, PoolClient } from "pg";
import { RUNNER_ELIGIBLE_ROLES, REVIEW_JOB_ROLES } from "@fulcrumaxe/runner-protocol";
import { DEFAULT_BACKEND } from "@fx/runtime/src/backends/types.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { RunnerMode } from "../runnerModes.js";
import type {
  AdmitResult,
  CancelResult,
  DispatchResult,
  ExecutionRun,
  ExecutionTarget,
  TerminalReport,
} from "../executionTarget.js";

/**
 * D#6 R3a (correction C12): the second `ExecutionTarget`. A run for a `runner_local` repo is not started by us. It waits
 * in `pending` until a runner on the customer's machine claims it (R2b), so this target:
 *
 *  - holds no money. There is no sandbox, no spend reservation and no model-key dependency, and `agent_runs.usd` stays
 *    NULL. The import-boundary test fails if this file imports `@fx/spend` or anything from the sandbox cluster, and a
 *    pg test shows a runner run leaves no `spend_reservations` or ledger row;
 *  - starts nothing. `dispatch` hands the run to the injected `JobIssuer` (R3b supplies the real one, which builds and
 *    signs the job and writes it through `agent_run_set_runner_job`) and answers `{ queued: true }`. There is no Workflow
 *    hook for a runner run (C12 section 2.6), so there is no token to return;
 *  - settles nothing. `cancel` and `finalize` answer zeros. A run's end is written by R2b's handlers through the Worker
 *    facade, and whether a runner may keep working on a run is derived from its status and lease (C12 section 2.5).
 *
 * `admit` refuses before anything is created, and every refusal is a member of the closed `AdmitDenyReason` set:
 *  - the role must be one a runner may run. Per the owner ruling (C12 section 1) that includes the four reviewer roles;
 *  - the account may start at most `limits.runsPerDay()` runner runs in a UTC day (the runner plan's data, injected: this
 *    file may not import `@fx/spend`, and a figure written here would be a second copy of a private one);
 *  - the repo must be private. A public repo is refused, and so is a repo whose visibility could not be read.
 *
 * The account's runner count is capped where runners are created (`runner_register`, 0712), not here: `admit` has no
 * refusal reason to give for it and the count cannot change between registration and a run.
 */

/** How long a runner run may wait to be claimed: 72 hours. A constant of this class and nothing else (C12 section 3, from
 * body R3.7): no tenant, account or repo setting changes it. R2b's sweeper owns the `pending -> timed_out` move. */
export const RUNNER_QUEUE_TTL_MS = 259_200_000;

/** How long a runner run waits before the "no runner online" notice may be sent (15 minutes), and before the reminder (48 hours). Not before: the worker's notice sweep sends each once, at the first tick at or after. */
export const RUNNER_WAITING_NOTICE_MS = 15 * 60_000;
export const RUNNER_TTL_REMINDER_MS = 48 * 3_600_000;

/** Every role `admit` accepts: runner-protocol's list, which the owner ruling (C12 section 1) widened to the four reviewers. */
export const RUNNER_TARGET_ROLES: ReadonlySet<string> = new Set<string>(RUNNER_ELIGIBLE_ROLES);

/** The four reviewer roles. A `runner_verified` repo runs them in our sandbox (D#6 C38), so the runner target refuses them. */
export const VERIFIED_SANDBOX_REVIEW_ROLES: ReadonlySet<string> = new Set<string>(REVIEW_JOB_ROLES);

/** What a `RepoVisibilityPort` could read. Anything it cannot read is `unknown`, never a guess. */
export type RepoVisibility = "private" | "public" | "unknown";

/**
 * Reads whether a repo is private. R3b supplies the real port (a metadata read through our App). `admit` treats a throw
 * or any answer other than `private` as a refusal, so a port that fails closes the door.
 */
export interface RepoVisibilityPort {
  visibility(repo: { accountId: string; repoId: string }): Promise<RepoVisibility>;
}

/** What a run continues when it is a fix round: the earlier run and its session. */
export interface RunContinues {
  parentRunId: string | null;
  sessionId: string;
  /**
   * The branch of the pull request being fixed, carried unchanged by a follow-up of a fix round (C22 section 2). When it is not set, the issuer
   * reads the branch `done` recorded for `parentRunId` (C25 section 1.2); it never derives one from the issue. Either way the issuer checks it
   * is a run branch (`fx/<run>-g<generation>`).
   */
  branch?: string;
}

/**
 * Builds, signs and records the job for a run. R3a injects a fake; R3b injects the real one, backed by a `JobSigner` that
 * is the only holder of the private key. The issuer writes the signed job through `agent_run_set_runner_job`. `dispatch`
 * calls it once per dispatch and never looks inside what it wrote.
 */
/** The signed job's `mode`: path B (`local`) or the cloud-verified push through our proxy (`verified`). */
export type JobMode = "local" | "verified";

export interface JobIssuer {
  /** `jobMode` is the job's `mode` (D#6 R5b-1): `"verified"` exactly when the run's own mode is `runner_verified`, otherwise `"local"`. */
  issue(input: { run: ExecutionRun; continues?: RunContinues; jobMode?: JobMode }): Promise<void>;
}

/**
 * The runner tier's limits, as the target needs them. The composition root reads them from the plan data (D#6 R2b
 * criterion 12). `runsPerDay` throws when the plan data is unavailable, and `admit` then refuses: a missing figure never
 * becomes an unlimited one.
 */
export interface RunnerLimitsPort {
  runsPerDay(): number;
}

/** Fails closed: every `admit` is refused as `runner_daily_limit`. For a composition root that has no plan data wired. */
export const unwiredRunnerLimits: RunnerLimitsPort = {
  runsPerDay: () => {
    throw new Error("runner target: no limits are wired");
  },
};

/** The runner target's own dependencies (C12 A7). No sandbox port, no spend, no model-key port. */
export interface RunnerTargetDeps {
  /** The runner login's pool: it counts the day's runs under the run's tenant. */
  pool: Pool;
  issuer: JobIssuer;
  visibility: RepoVisibilityPort;
  /** Required, like `visibility`: a root that has no plan data passes `unwiredRunnerLimits` explicitly, which fails closed (`admit` refuses every run). */
  limits: RunnerLimitsPort;
}

/**
 * The ports a composition root uses until R3b supplies the real ones. Both fail closed: the visibility port reads every
 * repo as `unknown`, so `admit` refuses with `repo_visibility_unknown` before anything is dispatched, and the issuer
 * throws, so nothing is ever recorded as queued without a job behind it.
 */
export const unwiredRepoVisibility: RepoVisibilityPort = { visibility: async () => "unknown" };
export const unwiredJobIssuer: JobIssuer = {
  issue: async () => {
    throw new Error("runner target: no job issuer is wired");
  },
};

const ZERO: CancelResult = Object.freeze({ settled_usd: 0, released_usd: 0 });

/**
 * D#221 R1b: the job a runner is issued carries no backend, so the runner always runs Claude Code. A run that names any
 * other backend would quietly run the wrong one; it is refused instead (at admit, and again by the paths that skip it).
 */
function isRunnerBackend(name: string | undefined): boolean {
  return name === undefined || name === DEFAULT_BACKEND;
}

function assertRunnerBackend(name: string | undefined): void {
  if (!isRunnerBackend(name)) throw new Error("RunnerTarget: the run's backend is not selectable on a runner");
}

export class RunnerTarget implements ExecutionTarget {
  readonly runtime = "runner" as const;
  /** See `RUNNER_QUEUE_TTL_MS`. */
  readonly queueTtlMs = RUNNER_QUEUE_TTL_MS;

  /** `mode` is the run mode this instance serves: the registry holds one instance per runner mode. */
  constructor(
    private readonly deps: RunnerTargetDeps,
    private readonly mode: RunnerMode = "runner_local",
  ) {}

  /** What the issuer is told besides the run: nothing for a local run (the issuer's default), `verified` for a cloud-verified one. */
  private get modeInput(): { jobMode?: JobMode } {
    return this.mode === "runner_verified" ? { jobMode: "verified" } : {};
  }

  /** `client` is accepted for the interface; `startAgentRun` has already released it, so nothing here uses it. */
  async admit(run: ExecutionRun, client: PoolClient): Promise<AdmitResult> {
    void client;
    if (!isRunnerBackend(run.backend)) return { admitted: false, reason: "backend_not_selectable" };
    if (!RUNNER_TARGET_ROLES.has(run.role)) return { admitted: false, reason: "role_not_runner_eligible" };
    // D#6 R5b-1 (C38): in a cloud-verified repo the four reviewers run in our sandbox. That path is R5b-2a's, so until then they are refused here,
    // before anything is counted or written.
    if (this.mode === "runner_verified" && VERIFIED_SANDBOX_REVIEW_ROLES.has(run.role)) return { admitted: false, reason: "verified_review_not_wired" };

    // The limit is read first: when the plan data is unavailable the door stays shut and nothing is counted.
    let perDay: number;
    try {
      perDay = this.deps.limits.runsPerDay();
    } catch {
      // fx-swallow-ok: unavailable plan data is a refusal (fail closed), not a crash; the composition root reports it when it loads the data
      return { admitted: false, reason: "runner_daily_limit" };
    }
    if ((await this.runsToday(run.accountId)) > perDay) return { admitted: false, reason: "runner_daily_limit" };

    // A repo the port could not read is refused, whatever the cause: a throw is the same as "unknown".
    const seen: RepoVisibility = run.repoId
      ? await this.deps.visibility.visibility({ accountId: run.accountId, repoId: run.repoId }).catch((): RepoVisibility => "unknown")
      : "unknown";
    if (seen === "public") return { admitted: false, reason: "public_repo" };
    if (seen !== "private") return { admitted: false, reason: "repo_visibility_unknown" };
    return { admitted: true };
  }

  async dispatch(run: ExecutionRun): Promise<DispatchResult> {
    assertRunnerBackend(run.backend);
    await this.deps.issuer.issue({ run, ...this.modeInput });
    this.markQueued();
    return { queued: true };
  }

  async resume(run: ExecutionRun, sessionId: string): Promise<DispatchResult> {
    assertRunnerBackend(run.backend);
    await this.deps.issuer.issue({ run, ...this.modeInput, continues: { parentRunId: run.parentRunId ?? null, sessionId, ...(run.continuesBranch === undefined ? {} : { branch: run.continuesBranch }) } });
    this.markQueued();
    return { queued: true };
  }

  /**
   * Tells the runner sweeper when this run's queue time ends, so its cron tick does not open the database before then
   * (D#454 H3c's marker). Best effort and never awaited: the marker is a hint and the sweeper's backstop tick finds the
   * run anyway. An earlier marker is never pushed later. The marker is the earliest thing due for this run, the 15
   * minute notice; the sweep that connects then re-derives the rest (the 48 hour reminder and the end of the queue time).
   */
  private markQueued(): void {
    void markWorkPending("runner-sweeper", { since: Date.now() + RUNNER_WAITING_NOTICE_MS });
  }

  async cancel(run: ExecutionRun): Promise<CancelResult> {
    void run;
    return { ...ZERO };
  }

  async finalize(run: ExecutionRun, report: TerminalReport): Promise<CancelResult> {
    void run;
    // A runner run's usage is the runner's own claim and goes to `run_events` only (C12 section 2.7). Nothing is settled.
    void report;
    return { ...ZERO };
  }

  /**
   * Runner runs the account created in the current UTC day, this one included (it is inserted before `admit`). A run an
   * earlier `admit` refused does not count against the next one.
   */
  private async runsToday(accountId: string): Promise<number> {
    return withTenant(this.deps.pool, accountId, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM agent_runs
          WHERE account_id = $1 AND runtime = 'runner' AND status <> 'refused_spend'
            AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
        [accountId],
      );
      return Number(rows[0]!.n);
    });
  }
}
