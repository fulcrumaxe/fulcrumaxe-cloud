import type { Pool, PoolClient } from "pg";
import { sanitize } from "@fx/trust";
import { reportError } from "@fx/telemetry";
import { raiseAskMarked } from "@fx/core/src/decisions/raiseAskMarked.js";
import { RUNNER_RUN_DECISION_TYPE } from "@fx/db/src/runnerPlanDial.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_MODES_SQL } from "@fx/runner";

/**
 * D#7 DW-R7: the `runner_run_on_member_plan` ask. A subscription runner's claim never offers it a run that its registrant did not start or approve unless the
 * repo's dial lets the claim approve it (announce or act, 0767), so under `ask` such a run used to wait with nobody told. Called from the claim's idle path, this
 * raises ONE ask for each such run: it names the repo and the plan holder (the runner's registrant, whose plan the run would spend), and only that person
 * answers it (answerAsk). Yes approves the run for the holder through `agent_run_approve`, the same function as the Runs card's Approve, so the claim then takes
 * it as it takes any run the holder approved; no is a receipt and nothing else: it keeps the run off the holder's plan, but does not stop it (the person who started it, or a runner on an API key, can still run it). Silence stops and flags: the catalogue allows no other timeout.
 *
 * Runs on the RECEIPT login's pool (the only login that may call the ask definer). Once per run, ever: the run's own key in `runner_plan_asks` (0982) is read
 * under a lock on the run, and the definer that writes it refuses a second row, so a repeat claim attempt, two runners, or a run answered "no" gets no second ask.
 */
const MAX_PER_CLAIM = 5;
/** Waiting runs looked at in one call. A run whose ask cannot be raised is skipped and the next one tried, so one bad run never starves the rest; this bounds the work when many fail. */
const MAX_TRIED_PER_CLAIM = 25;
export const MEMBER_PLAN_ASK_OPTIONS = [
  { id: "approve", label: "Yes, use my plan for this run" },
  { id: "decline", label: "No, not on my plan" },
] as const;

interface WaitingRun {
  id: string;
  work_item_id: string;
  repo: string;
  holder_name: string;
}

/** Raises one run's ask and records its holder. Throws, leaving the caller's savepoint to undo it. */
async function raiseOne(client: PoolClient, run: WaitingRun, runnerId: string): Promise<void> {
  // The repo and the holder's name are customer text, so the whole sentence is stored fenced and shown as a quotation.
  const rationale = sanitize(`A run in ${run.repo} is waiting to use ${run.holder_name}'s Claude plan. It runs on that plan only with ${run.holder_name}'s go-ahead. If nobody answers here in time, the run is not started on that plan until ${run.holder_name} answers.`);
  const askId = await raiseAskMarked(client, {
    class: "human_over_the_loop",
    decisionType: RUNNER_RUN_DECISION_TYPE,
    workItemId: run.work_item_id,
    runId: run.id,
    options: MEMBER_PLAN_ASK_OPTIONS,
    proposed: "approve",
    rationale,
    quotedInputs: [{ trust: "untrusted", storedBody: rationale }],
  });
  // The one writer of the holder: it reads the runner's registrant itself and refuses unless the run, the runner and the dial still match.
  if (!(await client.query<{ ok: boolean }>("SELECT runner_plan_ask_record($1::uuid, $2::uuid, $3::uuid) AS ok", [askId, run.id, runnerId])).rows[0]?.ok) throw new Error("runner_plan_ask: the run already has an ask");
}

export function createRunnerPlanAsk(receiptPool: Pool, hooks: { onFailure?: (runId: string, error: unknown) => void } = {}) {
  /** Returns the number of asks raised. `roles` are the roles this runner may take, so a run it could never claim is not asked about. */
  return async function raiseMemberPlanAsks(input: { accountId: string; runnerId: string; roles: readonly string[] }): Promise<number> {
    const { accountId, runnerId } = input;
    return withTenant(receiptPool, accountId, async (client) => {
      // The runs that wait on a plan holder's answer: pending, unapproved, started by someone else, on a repo this runner lists whose dial is `ask` now, and with no ask yet.
      const { rows } = await client.query<WaitingRun>(
        `SELECT a.id, a.work_item_id, r.gh_owner || '/' || r.gh_name AS repo, COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, ''), 'a team member') AS holder_name
           FROM runners rn
           JOIN account_members m ON m.account_id = rn.account_id AND m.user_id = rn.registered_by AND m.role IN ('owner', 'admin')
           JOIN users u ON u.id = rn.registered_by
           JOIN agent_runs a ON a.account_id = rn.account_id AND a.dispatch_repo_id = ANY (rn.allowed_repo_ids)
           JOIN repos r ON r.account_id = a.account_id AND r.id = a.dispatch_repo_id
          WHERE rn.account_id = $1 AND rn.id = $2 AND rn.credential_mode = 'subscription' AND rn.revoked_at IS NULL
            AND a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode IN (${RUNNER_MODES_SQL}) AND a.runner_id IS NULL AND a.approved_by IS NULL
            AND a.work_item_id IS NOT NULL AND a.job_signed IS NOT NULL AND (a.claimable_after IS NULL OR a.claimable_after <= now()) AND a.initiated_by IS DISTINCT FROM rn.registered_by AND a.role = ANY($3::text[])
            AND (SELECT d.disposition FROM decision_settings d WHERE d.account_id = a.account_id AND d.repo_id = a.dispatch_repo_id AND d.decision_type = $4 ORDER BY d.version DESC LIMIT 1) = 'ask'
            AND NOT EXISTS (SELECT 1 FROM runner_plan_asks p WHERE p.account_id = a.account_id AND p.run_id = a.id)
          ORDER BY a.created_at, a.id LIMIT ${MAX_TRIED_PER_CLAIM}`,
        [accountId, runnerId, input.roles, RUNNER_RUN_DECISION_TYPE],
      );
      let raised = 0;
      for (const run of rows) {
        if (raised >= MAX_PER_CLAIM) break;
        // Two claims at once raise one ask: the second waits here, then finds the first one's row.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${accountId}:runner_plan_ask:${run.id}`]);
        if ((await client.query("SELECT 1 FROM runner_plan_asks WHERE account_id = $1 AND run_id = $2", [accountId, run.id])).rows.length > 0) continue;
        // One run's failure undoes that run's ask alone (a savepoint) and is reported with the run's id; the next run is tried.
        await client.query("SAVEPOINT member_plan_ask");
        try {
          await raiseOne(client, run, runnerId);
          await client.query("RELEASE SAVEPOINT member_plan_ask");
          raised++;
        } catch (error) {
          // If the rollback itself fails the transaction is lost, and that failure is the caller's.
          await client.query("ROLLBACK TO SAVEPOINT member_plan_ask");
          reportError(error, { stage: "runner_plan_ask.run" });
          hooks.onFailure?.(run.id, error);
        }
      }
      return raised;
    });
  };
}

export type RaiseMemberPlanAsks = ReturnType<typeof createRunnerPlanAsk>;
