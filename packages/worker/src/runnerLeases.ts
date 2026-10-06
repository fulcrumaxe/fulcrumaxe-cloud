import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeRunStatus, type FailureReason } from "@fx/runner";
import { guarded, requireUuid, RunActionInputError, RunActionRefusedError } from "./runActions.js";

/**
 * D#6 R2a0: the runner-lease facade on the `Worker`.
 *
 * A runner's leases are `agent_runs` rows, and every write to `agent_runs.status` goes through
 * `agent_run_set_status`, which only the runner login may execute (0642). That login is the worker's alone
 * (CARRY-8), so the web routes that revoke a runner get this method instead: it is bound to the runner pool
 * here, takes plain data and returns plain data. No pool, client or login is an argument, a result or a
 * property of what is returned.
 *
 * It moves a runner's `running` and `pending` runs to `failed`, the two edges `RUN_STATUS_TRANSITIONS` allows
 * into `failed` for a live run, through the same compare-and-set writer (`writeRunStatus`) every other status
 * change uses, so each move records its `run.status_changed` event with the reason. A `paused` run has only a
 * `cancelled` edge, so it is not moved, and terminal runs are never selected. No transition is added.
 *
 * AUTHORITY WARNING. This method does not decide who may call it. `accountId` MUST come from the authenticated
 * session and `runnerId` must already have been revoked by the caller (`runner_revoke` or the demotion trigger):
 * for `runner_revoked` the method refuses a runner that is not revoked, so a caller bug cannot fail a healthy
 * runner's work.
 *
 * Errors: invalid input is refused before any SQL with a fixed `RunActionInputError`. A runner that is not in
 * the account (another account's id included) is a `RunActionRefusedError("P0002")` and nothing is changed. A
 * runner that is not revoked is a `RunActionRefusedError("55000")`. Connection failures become
 * `RunActionUnavailableError`, as for the run actions.
 */

/**
 * Why a runner's leases may be failed. R2a0 starts the list with `runner_revoked`; R2b adds `runner_lost`. Every
 * member must also be a `FailureReason` (checked here at compile time), which is the recorded value.
 */
export const RUNNER_LEASE_FAIL_REASONS = ["runner_revoked"] as const satisfies readonly FailureReason[];
export type RunnerLeaseFailReason = (typeof RUNNER_LEASE_FAIL_REASONS)[number];

export interface FailRunnerLeasesInput {
  accountId: string;
  runnerId: string;
  reason: RunnerLeaseFailReason;
}

export interface FailRunnerLeasesResult {
  /** The runs this call moved to `failed`. */
  runIds: string[];
  /** False only when more runs remained than one call handles; call again. */
  complete: boolean;
}

export interface RunnerLeaseFacade {
  /** Fails the named runner's live leases (`running`, `pending`) with `reason`. Paused and terminal runs are left alone. */
  failRunnerLeases(input: FailRunnerLeasesInput): Promise<FailRunnerLeasesResult>;
}

/** Runs read per page, and the pages one call handles (5,000 runs). */
const PAGE = 100;
const MAX_PAGES = 50;

interface LeaseRow {
  id: string;
  status: "running" | "pending";
}

const REASONS: ReadonlySet<string> = new Set(RUNNER_LEASE_FAIL_REASONS);

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerLeaseFacade(runnerPool: Pool): RunnerLeaseFacade {
  return {
    failRunnerLeases: (input) =>
      guarded(async () => {
        if (typeof input !== "object" || input === null || typeof input.reason !== "string" || !REASONS.has(input.reason)) throw new RunActionInputError();
        const accountId = requireUuid(input.accountId);
        const runnerId = requireUuid(input.runnerId);
        const reason = input.reason;

        const runner = await withTenant(runnerPool, accountId, async (client) => {
          const { rows } = await client.query<{ revoked: boolean }>("SELECT (revoked_at IS NOT NULL) AS revoked FROM runners WHERE id = $1 AND account_id = $2", [runnerId, accountId]);
          return rows[0];
        });
        if (!runner) throw new RunActionRefusedError("P0002");
        if (reason === "runner_revoked" && !runner.revoked) throw new RunActionRefusedError("55000");

        const runIds: string[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const live = await withTenant(runnerPool, accountId, async (client) => {
            const { rows } = await client.query<LeaseRow>(
              "SELECT id, status FROM agent_runs WHERE account_id = $1 AND runner_id = $2 AND status IN ('running', 'pending') ORDER BY created_at, id LIMIT $3",
              [accountId, runnerId, PAGE],
            );
            return rows;
          });
          if (live.length === 0) return { runIds, complete: true };
          for (const run of live) {
            // Compare-and-set: a run another writer already moved is skipped, never overwritten.
            const written = await writeRunStatus(runnerPool, { accountId, runId: run.id, from: run.status, to: "failed", failureReason: reason });
            if (written.updated) runIds.push(run.id);
          }
        }
        return { runIds, complete: false };
      }),
  };
}
