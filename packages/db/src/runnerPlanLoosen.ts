import type { PoolClient } from 'pg';
import type { Disposition } from '@fx/decisions';

/**
 * D#7 DW-R7: who may loosen the dial for `runner_run_on_member_plan`. A looser dial lets a run spend a team member's Claude plan with less asking, so
 * a preset never loosens it, and an explicit loosening on a repo with a live subscription runner is the plan holders' alone (every holder's: the dial is per repo).
 */
const LOOSENESS: Record<Disposition, number> = { ask: 0, announce: 1, act: 2 };
/** The decision type whose dial this governs. */
export const RUNNER_RUN_DECISION_TYPE = 'runner_run_on_member_plan';
export const isLoosening = (from: Disposition, to: Disposition): boolean => LOOSENESS[to] > LOOSENESS[from];

export const PLAN_HOLDER_ONLY_CODE = 'plan_holder_only';
export const PLAN_HOLDER_ONLY_SENTENCE = "Only the person whose Claude plan a runner on this repository uses can make this setting looser. Ask them, or make it stricter yourself.";
export const PRESET_HELD_SENTENCE = "This preset would make \"Running work on a team member's own plan\" looser, so it was left as it is. Only the plan holder can loosen it.";

export const ADD_REPO_HOLDER_ONLY_SENTENCE = "Only the person who registered this runner can add a repository whose setting lets work start without asking them.";

export class PlanHolderOnlyError extends Error {
  readonly code = PLAN_HOLDER_ONLY_CODE;
  constructor(message = PLAN_HOLDER_ONLY_SENTENCE) {
    super(message);
    this.name = 'PlanHolderOnlyError';
  }
}

/**
 * Throws PlanHolderOnlyError unless `userId` is the registrant of every live subscription runner that lists the repo (none listed: anyone the caller already let in). Call it
 * inside the transaction that writes the dial. It first takes the lock the runner registration functions hold to their commit (`runner_register:<account>`), so a runner
 * being registered or given the repo at that moment either committed before this read, and is seen, or waits until the write has committed.
 */
export async function assertMayLoosenRunnerPlanDial(client: PoolClient, accountId: string, repoId: string, userId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`runner_register:${accountId}`]);
  const { rows } = await client.query(
    `SELECT 1 FROM runners WHERE account_id = $1 AND credential_mode = 'subscription' AND revoked_at IS NULL AND $2::uuid = ANY (allowed_repo_ids) AND registered_by IS DISTINCT FROM $3::uuid LIMIT 1`,
    [accountId, repoId, userId],
  );
  if (rows.length > 0) throw new PlanHolderOnlyError();
}

/**
 * Throws PlanHolderOnlyError when someone other than a subscription runner's registrant adds it a repository whose current dial row is not `ask` (a repository with no row is unchanged).
 * Call it under the `runner_register` lock, in the transaction that writes the runner's repository list.
 */
export async function assertMayAddReposToRunner(client: PoolClient, userId: string, runnerId: string, repoIds: readonly string[]): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM runners r WHERE r.id = $1 AND r.credential_mode = 'subscription' AND r.registered_by IS DISTINCT FROM $2::uuid
        AND EXISTS (SELECT 1 FROM unnest($3::uuid[]) AS a(id) WHERE NOT (a.id = ANY (r.allowed_repo_ids))
          AND (SELECT d.disposition FROM decision_settings d WHERE d.account_id = r.account_id AND d.repo_id = a.id AND d.decision_type = '${RUNNER_RUN_DECISION_TYPE}' ORDER BY d.version DESC LIMIT 1) <> 'ask')`,
    [runnerId, userId, repoIds],
  );
  if (rows.length > 0) throw new PlanHolderOnlyError(ADD_REPO_HOLDER_ONLY_SENTENCE);
}
