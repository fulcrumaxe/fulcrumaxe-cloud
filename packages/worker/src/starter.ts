import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  IdempotencyKeyTakenError,
  buildExecutionRun,
  failClosedOnQueued,
  readExecutionMode,
  resolveExecutionTarget,
  startAgentRun,
  writeRunStatus,
  type ExecutionTargetRegistry,
} from "@fx/runner";
import type { RunStarter } from "./preview.js";

/**
 * D#2 H14c-3-3a: the production run starter (preview.ts's S2). Package-internal: it is not exported from
 * index.ts and is not on the Worker, because it hands the caller's `inCreateTransaction` to the run's create
 * transaction, and only the preview performer may do that.
 *
 *  - Idempotent on `input.idempotency.key`: a key that already has a run returns that run and starts nothing
 *    (no second sandbox, no second reservation, no second follower).
 *  - `startAgentRun` gets the input as it came, `inCreateTransaction` untouched (the same function, not a wrapper).
 *  - The run's reservations are committed before this returns: `admit` reserves on its own connection, and the
 *    start is not run inside any transaction of ours.
 *  - A run that is running is handed to `follow` (apps/web starts the follower workflow there). The starter
 *    awaits only `follow`'s acceptance, never the run.
 */

/** What the follower needs to find one run's end. The token is the target-generated one and is passed on, never logged. */
export interface FollowArgs {
  runId: string;
  accountId: string;
  hookToken: string;
  /** How long the follower waits before it treats the run as lost: the run's own sandbox timeout plus a margin, never a fixed hours-long default. */
  watchdogMs: number;
}

/** Added to the run's sandbox timeout to get the follower's watchdog. */
export const WATCHDOG_MARGIN_MS = 5 * 60_000;
/** Starts whatever follows a running run to its end. Resolves once that has been accepted. */
export type RunFollower = (args: FollowArgs) => Promise<void>;

export interface RunStarterDeps {
  /** The runner login's pool. */
  pool: Pool;
  registry: ExecutionTargetRegistry;
  follow: RunFollower;
}

/** One structured line for the smoke to read in the runtime logs: a fixed event code and ids, nothing else. */
const logEvent = (event: string, runId: string, accountId: string): void => console.info(JSON.stringify({ event, run_id: runId, account_id: accountId }));

export function createRunStarter(deps: RunStarterDeps): RunStarter {
  const claimed = (accountId: string, key: string): Promise<string | undefined> =>
    withTenant(deps.pool, accountId, async (client) => {
      const { rows } = await client.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key]);
      return rows[0]?.run_id;
    });

  return {
    async start(input) {
      // The watchdog comes from the seat's timeout; a run without one has nothing to derive it from.
      if (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("run starter: the run has no positive timeoutMs to derive a watchdog from");
      const key = input.idempotency?.key;
      if (key !== undefined) {
        const existing = await claimed(input.accountId, key);
        if (existing !== undefined) return { runId: existing };
      }
      let started;
      try {
        // A queued runner run has no hook for `follow` and a preview or stage run waits on its end: cancel it and fail.
        started = await failClosedOnQueued(deps.pool, input.accountId, await startAgentRun(deps.pool, deps.registry, input));
      } catch (err) {
        // A concurrent start with the same key won the claim: that run is the answer.
        const winner = err instanceof IdempotencyKeyTakenError && key !== undefined ? await claimed(input.accountId, key) : undefined;
        if (winner === undefined) throw err;
        return { runId: winner };
      }
      // D#6 C12 A4: the target's own reason, unchanged. It is a closed code (`AdmitDenyReason`, or the fixed fallback), never free text.
      if (started.status === "refused_spend") return { runId: started.id, refused: "reason" in started ? started.reason : "refused_spend" };
      if (started.status !== "running") return { runId: started.id };

      logEvent("run.started", started.id, input.accountId);
      try {
        await deps.follow({ runId: started.id, accountId: input.accountId, hookToken: started.hookToken, watchdogMs: input.timeoutMs + WATCHDOG_MARGIN_MS });
      } catch (err) {
        // A running sandbox nobody follows would run, and spend, to its timeout: stop it and fail the run, then surface the error.
        const target = resolveExecutionTarget(await readExecutionMode(deps.pool, input.accountId, input.repoId), deps.registry);
        await target.cancel(buildExecutionRun(started.id, input)).catch(() => undefined);
        await writeRunStatus(deps.pool, { accountId: input.accountId, runId: started.id, from: "running", to: "failed", failureReason: "internal_error" }).catch(() => undefined);
        throw err;
      }
      return { runId: started.id };
    },
  };
}
