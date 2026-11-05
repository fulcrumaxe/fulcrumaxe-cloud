import type { PoolClient } from 'pg';
import { RUNNER_RUN_DECISION_TYPE } from '@fx/db/src/runnerPlanDial.js';

/**
 * D#7 DW-R7: the answer to a `runner_run_on_member_plan` ask. Only the plan holder answers (the ask spends that person's Claude plan, so another owner or admin
 * cannot consent for them): `runner_plan_asks` (0982) names the holder, written by its definer from the runner's registrant. "approve" approves the run for the
 * holder through `agent_run_approve` (0757), the function behind the Runs card's Approve, which itself refuses anyone who has no live subscription runner. Every
 * other choice approves nothing, and a "no" stands (`runner_plan_declined`, 0987): no later dial change starts the run.
 *
 * A yes is refused (`runner_gone`) when the holder no longer has a live subscription runner that lists the run's repository: `approved_by` is written once, so approving
 * then would leave a run no runner of theirs can take. Nothing is written, the ask stays open and answerable, and the person is told to add the repository to their runner. The caller writes the receipt and closes the ask in the same transaction, so a refusal below leaves the ask open.
 *
 * Returns whether the run was approved, so the caller can wake the runners. `refuse` builds the caller's error: `forbidden` for anyone but the holder, and for a
 * holder who can no longer approve; `moot` when the run is no longer waiting (cancelled, claimed, or approved some other way).
 */
export const MEMBER_PLAN_APPROVE = 'approve';
export const isMemberPlanAsk = (decisionType: string): boolean => decisionType === RUNNER_RUN_DECISION_TYPE;

export async function answerMemberPlanAsk(
  client: PoolClient,
  input: { askId: string; runId: string | null; userId: string; choice: string },
  refuse: (why: 'forbidden' | 'moot' | 'runner_gone') => Error,
): Promise<boolean> {
  const holder = (await client.query<{ plan_holder: string | null }>('SELECT plan_holder FROM runner_plan_asks WHERE ask_id = $1::uuid', [input.askId])).rows[0]?.plan_holder;
  if (holder === undefined || holder === null || holder !== input.userId || input.runId === null) throw refuse('forbidden');
  if (input.choice !== MEMBER_PLAN_APPROVE) return false;
  const covered = await client.query(
    `SELECT 1 FROM agent_runs a JOIN runners r ON r.account_id = a.account_id AND r.registered_by = $2::uuid AND r.credential_mode = 'subscription' AND r.revoked_at IS NULL AND a.dispatch_repo_id = ANY (r.allowed_repo_ids)
      WHERE a.id = $1::uuid LIMIT 1`,
    [input.runId, input.userId],
  );
  if (covered.rows.length === 0) throw refuse('runner_gone');
  try {
    await client.query('SELECT agent_run_approve($1::uuid)', [input.runId]);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '55000' || code === 'P0002') throw refuse('moot');
    if (code === '42501') throw refuse('forbidden');
    throw err;
  }
}
