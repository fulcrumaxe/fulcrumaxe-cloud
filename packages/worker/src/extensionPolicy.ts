import type { Pool } from "pg";
import { RUN_LIMIT_BOUNDS } from "@fx/core/src/run-limits/limits.js";
import { getRoleEntry } from "@fx/roles";
import { SANDBOX_TIMEOUT_MARGIN_MS, type ExecutionRun, type ExtensionPolicyInput } from "@fx/runner";
import { reserve } from "@fx/spend";
import { RUN_TIME_CEILING_MS } from "./seat.js";

/**
 * D#2 H14c-3-2e: the production `extensionPolicyFor`. It hands the runner the facts a run needs to be extended
 * in-run (how many extensions, the platform ceilings, whether the role writes, how to hold the money) and
 * decides nothing: E1-E5 are the runner's. Every number is read from its one exported source.
 */

/**
 * The gh-proxy write counter. Nothing counts a run's GitHub writes yet (GW-COUNT), so this is a named zero: a role
 * that writes gets at most ONE in-run extension (a later one needs a write since the last), then the run ends
 * resumably and continuation takes over. Fails safe.
 */
export const noGhWriteCounter = (): number => 0;

export interface ExtensionPolicyDeps {
  /** The runner login's pool: the one the sandbox target's `admit` reserves on. */
  pool: Pool;
  /** The sandbox target's payer function, so an extension is held against the account `admit` charged. */
  resolvePayer: (run: ExecutionRun) => string;
  /**
   * The sandbox target's operator decision (same function, same arguments). A run on the operator's own
   * subscription holds no model money, so an extension is not reserved against any budget; the run's
   * extension count, the platform ceilings and the live per-run cap still bound it.
   */
  operatorToken?: (accountId: string, payerAccountId: string) => string | undefined;
}

export function createExtensionPolicyFor(deps: ExtensionPolicyDeps): (run: ExecutionRun) => ExtensionPolicyInput | undefined {
  return (run) => {
    // A run that did not come from a seat, or whose seat allows none, is not extendable (today's behaviour).
    if (run.maxExtensions === undefined || run.maxExtensions <= 0) return undefined;
    // The manifest says whether the role writes. A role it does not know is left unanswered: the runner reads that as writing.
    const entry = getRoleEntry(run.role);
    return {
      maxExtensions: run.maxExtensions,
      ...(entry !== undefined && { roleWrites: entry.writeAccess }),
      ceilings: {
        runMs: run.timeoutMs === undefined ? RUN_TIME_CEILING_MS : Math.min(RUN_TIME_CEILING_MS, run.timeoutMs - SANDBOX_TIMEOUT_MARGIN_MS),
        modelCalls: RUN_LIMIT_BOUNDS.max_model_calls.ceiling,
        usd: RUN_LIMIT_BOUNDS.per_run_usd.ceiling,
      },
      ghWrites: noGhWriteCounter,
      // The same reserve() and payer `admit` uses. A throw (a payer that cannot be resolved) is the runner's denial.
      reserveExtension: async (estimateUsd) => {
        const payer = deps.resolvePayer(run);
        if (deps.operatorToken?.(run.accountId, payer) !== undefined) return estimateUsd > 0;
        const result = await reserve(deps.pool, { accountId: payer, runId: run.id, ...run.spend, modelBrokeredBy: undefined, estimateModelUsd: estimateUsd, estimateComputeUsd: 0 });
        // An admit that recorded nothing (an estimate of 0 or NaN) held no money: not an extension.
        return result.decision === "admit" && result.reservations.length > 0;
      },
    };
  };
}
