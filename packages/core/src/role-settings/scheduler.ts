import { withTenant } from '../tenancy/withTenant.js';
import type { RoleSchedulerCtx } from './types.js';

/**
 * D#31/brief (H16 dependency): "Criterion 4 (the H16 scheduler reads
 * settings; a role in `off` never starts) ... depend[s] on H16, which is
 * not built. Deliver the service-level contract H16 will call." This is
 * that contract's read half: whether `role` is currently allowed to
 * start for `repoId`, per `role_settings.mode`. A role with no
 * `role_settings` row is `off`: presence carries the meaning since
 * H08-followup (every repo gets a row per manifest role at creation, and
 * migration 0687 backfilled the existing ones), so a role added to the
 * manifest later never runs on an existing repo until the customer turns
 * it on. It does NOT fall back to the manifest's `defaultMode`.
 *
 * This function does NOT decide `weekly`'s "at most once per 7 days"
 * gate, or `feature_critical`'s "only on Feature/Critical work" gate --
 * both are H16's own scheduling logic once it exists (H16 pass/fail
 * item 2). All H12 owns and can honestly claim here is the `off` half of
 * criterion 4: a role in `off` is never runnable, full stop.
 *
 * Uses `withTenant`'s 2-arg overload (app_user pool, no `userId`): H16's
 * cron tick has no end-user session, but it does already know which
 * account it's ticking for -- see `RoleSchedulerCtx`'s own doc comment
 * for why this is `withTenant`, not `withPlatformOps`.
 */
export async function isRoleRunnable(
  ctx: RoleSchedulerCtx,
  accountId: string,
  repoId: string,
  role: string,
): Promise<boolean> {
  return withTenant(ctx.pool, accountId, async (client) => {
    const { rows } = await client.query<{ mode: string }>(
      'SELECT mode FROM role_settings WHERE repo_id = $1 AND role = $2',
      [repoId, role],
    );
    const mode = rows[0]?.mode ?? 'off';
    return mode !== 'off';
  });
}

export interface SkippedBudgetEntry {
  role: string;
  skippedAt: Date;
}

/**
 * D#31/brief (H16 dependency): criterion 4c's read side -- "the list is
 * derived from what happened rather than from what we think should have
 * run." Reads `run_events` rows of kind `skipped_budget`, joined back to
 * the role that was skipped through `agent_runs`.
 *
 * NOT delivered here, because it depends on decisions H12 does not own:
 *  - `run_events.run_id` is NOT NULL, foreign-keyed to `agent_runs(account_id, id)`
 *    (migrations/0001_core.sql). A skipped run never actually ran, so
 *    H16 must decide how it represents "skipped" within that constraint
 *    (most likely: still create an `agent_runs` row, with a `status`
 *    value H16 defines for this -- sec-criteria A8 leaves `agent_runs.
 *    status`'s vocabulary to the task that owns it) before it can write
 *    the matching `run_events` row this function reads.
 *  - "when the budget resets" (criterion 4c's dashboard text) is a
 *    billing-cycle fact H10 owns, not something derivable from
 *    `run_events`. This function returns only what IS derivable today:
 *    which role, and when it was skipped. The caller (H16's dashboard
 *    surface, or WS-F4) combines that with H10's billing-cycle data.
 *
 * Scoped by `accountId`, not `repoId`: `agent_runs` has no `repo_id`
 * column of its own (only `work_item_id`, and `work_items.repo_id` is
 * nullable) -- how a scheduled-but-skipped role attaches to a specific
 * repo is the same H16 modeling question as the bullet above. Account
 * scope is what's unambiguous today.
 */
export async function listSkippedForBudget(ctx: RoleSchedulerCtx, accountId: string): Promise<SkippedBudgetEntry[]> {
  return withTenant(ctx.pool, accountId, async (client) => {
    const { rows } = await client.query<{ role: string; skipped_at: Date }>(
      `SELECT ar.role AS role, re.created_at AS skipped_at
         FROM run_events re
         JOIN agent_runs ar ON ar.id = re.run_id AND ar.account_id = re.account_id
        WHERE re.account_id = $1
          AND re.kind = 'skipped_budget'
        ORDER BY re.created_at DESC`,
      [accountId],
    );
    return rows.map((r) => ({ role: r.role, skippedAt: r.skipped_at }));
  });
}
