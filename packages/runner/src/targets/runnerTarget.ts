import type { Pool, PoolClient } from "pg";
import { RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
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
 *  - the account may start at most `RUNNER_RUNS_PER_DAY` runner runs in a UTC day;
 *  - the repo must be private. A public repo is refused, and so is a repo whose visibility could not be read.
 *
 * The account's runner count is capped where runners are created (`runner_register`, 0712), not here: `admit` has no
 * refusal reason to give for it and the count cannot change between registration and a run.
 */

/** Runs a runner-plan account may start per UTC day. PROVISIONAL, D#6 R2b criterion 12 (source D#6 18502844). */
export const RUNNER_RUNS_PER_DAY = 30;

/** How long a runner run may wait to be claimed: 72 hours. A constant of this class and nothing else (C12 section 3, from
 * body R3.7): no tenant, account or repo setting changes it. R2b's sweeper owns the `pending -> timed_out` move. */
export const RUNNER_QUEUE_TTL_MS = 259_200_000;

/** Every role `admit` accepts: runner-protocol's list, which the owner ruling (C12 section 1) widened to the four reviewers. */
export const RUNNER_TARGET_ROLES: ReadonlySet<string> = new Set<string>(RUNNER_ELIGIBLE_ROLES);

/** What a `RepoVisibilityPort` could read. Anything it cannot read is `unknown`, never a guess. */
export type RepoVisibility = "private" | "public" | "unknown";

/**
 * Reads whether a repo is private. R3b supplies the real port (a metadata read through our App). `admit` treats a throw
 * or any answer other than `private` as a refusal, so a port that fails closes the door.
 */
export interface RepoVisibilityPort {
  visibility(repo: { accountId: string; repoId: string }): Promise<RepoVisibility>;
}

/** What a run continues when it is a fix round: the earlier run and its session. The branch is the issuer's to derive. */
export interface RunContinues {
  parentRunId: string | null;
  sessionId: string;
}

/**
 * Builds, signs and records the job for a run. R3a injects a fake; R3b injects the real one, backed by a `JobSigner` that
 * is the only holder of the private key. The issuer writes the signed job through `agent_run_set_runner_job`. `dispatch`
 * calls it once per dispatch and never looks inside what it wrote.
 */
export interface JobIssuer {
  issue(input: { run: ExecutionRun; continues?: RunContinues }): Promise<void>;
}

/** The runner target's own dependencies (C12 A7). No sandbox port, no spend, no model-key port. */
export interface RunnerTargetDeps {
  /** The runner login's pool: it counts the day's runs under the run's tenant. */
  pool: Pool;
  issuer: JobIssuer;
  visibility: RepoVisibilityPort;
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

export class RunnerTarget implements ExecutionTarget {
  readonly runtime = "runner" as const;
  /** See `RUNNER_QUEUE_TTL_MS`. */
  readonly queueTtlMs = RUNNER_QUEUE_TTL_MS;

  constructor(private readonly deps: RunnerTargetDeps) {}

  /** `client` is accepted for the interface; `startAgentRun` has already released it, so nothing here uses it. */
  async admit(run: ExecutionRun, client: PoolClient): Promise<AdmitResult> {
    void client;
    if (!RUNNER_TARGET_ROLES.has(run.role)) return { admitted: false, reason: "role_not_runner_eligible" };

    if ((await this.runsToday(run.accountId)) > RUNNER_RUNS_PER_DAY) return { admitted: false, reason: "runner_daily_limit" };

    // A repo the port could not read is refused, whatever the cause: a throw is the same as "unknown".
    const seen: RepoVisibility = run.repoId
      ? await this.deps.visibility.visibility({ accountId: run.accountId, repoId: run.repoId }).catch((): RepoVisibility => "unknown")
      : "unknown";
    if (seen === "public") return { admitted: false, reason: "public_repo" };
    if (seen !== "private") return { admitted: false, reason: "repo_visibility_unknown" };
    return { admitted: true };
  }

  async dispatch(run: ExecutionRun): Promise<DispatchResult> {
    await this.deps.issuer.issue({ run });
    this.markQueued();
    return { queued: true };
  }

  async resume(run: ExecutionRun, sessionId: string): Promise<DispatchResult> {
    await this.deps.issuer.issue({ run, continues: { parentRunId: run.parentRunId ?? null, sessionId } });
    this.markQueued();
    return { queued: true };
  }

  /**
   * Tells the runner sweeper when this run's queue time ends, so its cron tick does not open the database before then
   * (D#454 H3c's marker). Best effort and never awaited: the marker is a hint and the sweeper's backstop tick finds the
   * run anyway. An earlier marker is never pushed later.
   */
  private markQueued(): void {
    void markWorkPending("runner-sweeper", { since: Date.now() + this.queueTtlMs });
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
