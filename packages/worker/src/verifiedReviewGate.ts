import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";

/**
 * D#6 R5b-2a (correction C38 section 1, body R5b.4): when the reviews of a cloud-verified pull request may start.
 *
 * The due time is DERIVED, never stored: `max(the newest end of ANY executor run of the item, whatever its status, the newest push to the pull request) + 10 minutes`;
 * no review starts while an executor run is still live. The
 * executor's end covers a runner's own pushes (a runner pushes only inside a run, through the proxy, before it ends); a person's push is the
 * `pr_head_pushed` fact the webhook records on `pull_request.synchronize` (database-clock created_at, one row per delivery). A push the webhook
 * has not delivered yet is caught by the head check: when the head the driver reads is not the one it last saw, it records the push itself.
 *
 * The answer is one of:
 *   not_verified  the repository is no longer `runner_verified` (it left the mode); the caller reviews the way that mode does.
 *   wait          the quiet period has not ended; `waitMs` is how long until it may (at most the whole period).
 *   key_missing   it has ended, and the account has no usable model key (no connection, or one marked broken, and no operator route).
 *                 Nothing is dispatched and nothing is reserved.
 *   dispatch      start the reviewers on this head.
 */
export const QUIET_PERIOD_MS = 10 * 60_000;
const TERMINAL = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"];

export type VerifiedReviewGate = { state: "not_verified"; executionMode: string } | { state: "wait"; waitMs: number } | { state: "key_missing" } | { state: "dispatch" };

export interface VerifiedReviewGateInput {
  accountId: string;
  workItemId: string;
  prNumber: number;
  /** The head just read from GitHub. */
  headSha: string;
  /** The head the previous check saw, or null on the first. A different head means a push happened while the driver waited. */
  seenHead: string | null;
  now: Date;
  /** Accounts that run on our own subscription need no connection row. */
  isOperatorAccount?: (accountId: string) => boolean;
}

export async function readVerifiedReviewGate(pool: Pool, input: VerifiedReviewGateInput): Promise<VerifiedReviewGate> {
  const { accountId, workItemId, prNumber, headSha } = input;
  return withTenant(pool, accountId, async (client) => {
    const mode = (await client.query<{ execution_mode: string }>("SELECT r.execution_mode FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id WHERE w.id = $1 AND w.account_id = $2", [workItemId, accountId])).rows[0]?.execution_mode;
    if (mode !== "runner_verified") return { state: "not_verified", executionMode: mode ?? "sandbox" } as const;

    // The head moved while the driver waited: the push counts from now, whether or not the webhook told us (a told one is already recorded and this is a no-op).
    if (input.seenHead !== null && input.seenHead !== headSha) {
      // Keyed on the change, not the head: a push back to a head seen before is a new push (A, B, A).
      await recordDriverEvent(client, accountId, { workItemId, kind: "pr_head_pushed", dedupeKey: `observed:${input.seenHead}..${headSha}`, code: "observed", headSha, prNumber });
    }
    const { rows } = await client.query<{ base: Date | null; live: boolean }>(
      `SELECT GREATEST(
                (SELECT max(ended_at) FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor'),
                (SELECT max(created_at) FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'pr_head_pushed' AND pr_number = $3)
              ) AS base,
              EXISTS (SELECT 1 FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor' AND NOT (status = ANY($4::text[]))) AS live`,
      [accountId, workItemId, prNumber, TERMINAL],
    );
    // An executor run still going may yet push: nothing is reviewed under it.
    if (rows[0]?.live === true) return { state: "wait", waitMs: QUIET_PERIOD_MS } as const;
    const base = rows[0]?.base ?? null;
    // A push recorded in this very call carries the database clock, which may be a moment after the caller's: never due before it.
    const dueAt = base === null ? null : base.getTime() + QUIET_PERIOD_MS;
    if (dueAt !== null && input.now.getTime() < dueAt) return { state: "wait", waitMs: Math.min(Math.max(dueAt - input.now.getTime(), 1000), QUIET_PERIOD_MS) } as const;

    if (input.isOperatorAccount?.(accountId) !== true) {
      // The sandbox key loader's order (ok, then unvalidated, then broken), so several connections cannot falsely read as missing.
      const key = (await client.query<{ status: string }>("SELECT status FROM model_connections WHERE account_id = $1 ORDER BY CASE status WHEN 'ok' THEN 0 WHEN 'unvalidated' THEN 1 ELSE 2 END LIMIT 1", [accountId])).rows[0];
      if (key === undefined || key.status === "broken") return { state: "key_missing" } as const;
    }
    return { state: "dispatch" } as const;
  });
}
