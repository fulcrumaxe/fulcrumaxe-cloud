import { ROLE_MANIFEST, type RoleMode } from '@fx/roles';
import { withTenant } from '../tenancy/withTenant.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { assertRepoExists } from './internal.js';
import {
  formatCostLine,
  normalizePlanTier,
  roundUsd,
  runsPerMonthSeed,
  TOKEN_COVERAGE_CAVEAT,
} from './costModel.js';
import { effectiveRoleModel, loadModelRunMedians, modelRunPrice, type RoleModelResolvers } from './runPrice.js';
import type { RoleSettingsCtx, RoleSettingsEntry } from './types.js';

// The resolvers' type lives with the shared per-run price lookup (runPrice.ts); callers still import it from here.
export type { RoleModelResolvers };

/**
 * D#31 comment 18492898 / 18494573 (H12 re-brief): criterion 1's "lists
 * all 26 roles" and criterion 2's cost line, delivered as a service READ
 * function -- no page. Returns one entry per role in `@fx/roles`'
 * ROLE_MANIFEST (frozen at exactly 26 -- packages/roles/test/
 * manifest.test.ts), each with its `allowedModes`, its current `mode`
 * (the repo's own `role_settings` row, or `off` when there is none:
 * presence carries the meaning since H08-followup, so a role added to the
 * manifest later shows `off` on existing repos), and its cost line.
 *
 * `NotFoundError` -- for a nonexistent repo, a repo on a different
 * account, or a caller no longer a member of `principal.accountId` --
 * comes from `assertActiveMembership`/`assertRepoExists` inside the same
 * `withTenant` transaction as everything else here, so all three see a
 * consistent snapshot.
 */
export async function listRoleSettings(
  ctx: RoleSettingsCtx,
  repoId: string,
  resolvers: RoleModelResolvers = {},
): Promise<RoleSettingsEntry[]> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    await assertRepoExists(client, repoId);

    const { rows: planRows } = await client.query<{ plan: string | null }>(
      'SELECT plan FROM accounts WHERE id = $1',
      [accountId],
    );
    const plan = normalizePlanTier(planRows[0]?.plan);

    const { rows: modeRows } = await client.query<{ role: string; mode: RoleMode; model: string | null }>(
      'SELECT role, mode, model FROM role_settings WHERE repo_id = $1',
      [repoId],
    );
    const modeByRole = new Map(modeRows.map((r) => [r.role, r.mode]));
    const modelByRole = new Map(modeRows.map((r) => [r.role, r.model]));

    // H12 criterion 2: "Medians are seeded from the cost-analyst's figures
    // and replaced by the tenant's own ledger medians after 10 runs."
    // D#483 S5-p: the lookup is the one shared with the pipeline estimate (runPrice.ts).
    const medians = await loadModelRunMedians(client, accountId);

    return ROLE_MANIFEST.map((manifestEntry) => {
      const mode = modeByRole.get(manifestEntry.name) ?? 'off';
      const effectiveModel = effectiveRoleModel(manifestEntry.name, modelByRole.get(manifestEntry.name), resolvers);
      const price = modelRunPrice(medians, manifestEntry.name, effectiveModel);
      const medianCostPerRunUsd = price.usd;
      const runsPerMonth = runsPerMonthSeed(mode, plan);
      const monthlyUsd = roundUsd(runsPerMonth * medianCostPerRunUsd);

      const entry: RoleSettingsEntry = {
        role: manifestEntry.name,
        allowedModes: manifestEntry.allowedModes,
        mode,
        model: modelByRole.get(manifestEntry.name) ?? null,
        costLine: {
          text: formatCostLine(monthlyUsd),
          monthlyUsd,
          runsPerMonth,
          medianCostPerRunUsd,
          medianSource: price.source,
          caveat: TOKEN_COVERAGE_CAVEAT,
        },
      };
      return entry;
    });
  });
}
