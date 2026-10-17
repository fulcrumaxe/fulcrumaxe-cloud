import type { PoolClient } from "pg";
import { resolveRunLimits } from "@fx/core/src/run-limits/resolve.js";
import { isRunnerMode, roleRunComputeUpperBoundUsd, runnerLimitsFrom } from "@fx/runner";

/**
 * D#483 S5-e1: what the first run of an item reserves, the smallest spend envelope that could ever admit the item's first run (a limit below it is
 * refused `envelope_below_first_run` when it is written). It lives beside the estimate because it is a price, and nothing else may compute one.
 *
 * The first run is triage's classify, a project-manager run. `reserve()` admits a run by its model cap plus its compute upper bound, both from the
 * role's own resolved limits, so that is the figure here: the per-run model cap, plus for a hosted repo the compute upper bound `seat.ts` prices
 * the reservation from. A runner repo has no compute of ours. Rounded UP to the unit the money columns hold, so a limit equal to the figure admits.
 *
 * Must run inside a `withTenant` transaction for `accountId`.
 */
export const FIRST_RUN_ROLE = "project-manager";

export async function firstRunReservationUsd(client: PoolClient, input: { accountId: string; repoId: string }): Promise<number> {
  const { accountId, repoId } = input;
  const repo = (await client.query<{ execution_mode: string | null }>("SELECT execution_mode FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId])).rows[0];
  if (repo === undefined) throw new Error("estimate: repo not found");
  const { perRunUsd } = runnerLimitsFrom(await resolveRunLimits(client, { accountId, role: FIRST_RUN_ROLE }));
  const compute = isRunnerMode(repo.execution_mode ?? "sandbox") ? 0 : await roleRunComputeUpperBoundUsd(client, { accountId, role: FIRST_RUN_ROLE });
  return Math.ceil((perRunUsd + compute) * 1e4 - 1e-9) / 1e4;
}
