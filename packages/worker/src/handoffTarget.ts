import type { Pool, PoolClient } from "pg";
import { operatorMode } from "@fx/runner";
import { reserveWith } from "@fx/spend";
import { JobSignerConfigError, loadJobSigner } from "./jobSigner.js";
import { createSeatResolver } from "./seat.js";

/**
 * D#599 HO-2a: the cloud side of a handoff request. Structurally the `HandoffCloudTarget` of `@fx/runner-cloud` (which this package does not
 * depend on at run time); apps/web passes the result to the request route, where the compiler checks the two agree.
 *
 * `seat` is the seat a cloud run of the item would get (the same resolver the worker starts runs with: model, caps, plan, the account's
 * monthly budget), read on its own short transaction. `reserve` then runs the same `reserve()` on the CALLER's transaction with no run id:
 * the reservations belong to the move, not to the run being left, so settling that run never touches them (HO-2b attaches them to the new
 * run). An operator account holds no model money, as the sandbox target does for its runs.
 */
export interface HandoffCloudTargetPort {
  seat(input: { accountId: string; workItemId: string; role: string }): Promise<
    | { ok: true; reserve: (client: PoolClient) => Promise<{ ok: true; reservations: { modelId: string | null; computeId: string | null } } | { ok: false; reason: string }> }
    | { ok: false; reason: string }
  >;
}

export function createHandoffCloudTarget(deps: { pool: Pool; env: NodeJS.ProcessEnv }): HandoffCloudTargetPort {
  const resolve = createSeatResolver({ pool: deps.pool, isOperatorAccount: (id) => operatorMode(deps.env, id).active });
  return {
    async seat({ accountId, workItemId, role }) {
      const seated = await resolve({ accountId, role, workItemId });
      if (!seated.ok) return { ok: false, reason: seated.reason };
      const operator = operatorMode(deps.env, accountId).active;
      const spend = { ...seated.seat.spend, ...(operator && { estimateModelUsd: 0, modelBrokeredBy: "operator_subscription" as const }) };
      return {
        ok: true,
        reserve: async (client) => {
          const result = await reserveWith(client, { accountId, runId: null, ...spend });
          if (result.decision === "deny") return { ok: false, reason: result.reason };
          const idOf = (compute: boolean): string | null => result.reservations.find((r) => (r.budget === "model") === !compute)?.id ?? null;
          return { ok: true, reservations: { modelId: idOf(false), computeId: idOf(true) } };
        },
      };
    },
  };
}

/**
 * Whether a job to a runner can be signed in this deployment: the job-signing key pair is set and valid (the worker's own loader, so the
 * variables are read in one place). A half-set or invalid pair reads as "no", the same as unset: a move to a runner then answers 503.
 */
export function runnerJobsConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  try {
    return loadJobSigner(env) !== null;
  } catch (error) {
    if (error instanceof JobSignerConfigError) return false;
    throw error;
  }
}
