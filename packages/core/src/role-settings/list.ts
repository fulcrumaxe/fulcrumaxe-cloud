import { ROLE_MANIFEST, type RoleMode } from '@fx/roles';
import { withTenant } from '../tenancy/withTenant.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { assertRepoExists } from './internal.js';
import {
  effectiveModelId,
  formatCostLine,
  medianCostSeedUsd,
  modelIdForSeedTier,
  seedTierForModelId,
  normalizePlanTier,
  roundUsd,
  runsPerMonthSeed,
  TOKEN_COVERAGE_CAVEAT,
} from './costModel.js';
import type { RoleModelId, RoleSettingsCtx, RoleSettingsEntry } from './types.js';

/**
 * What core cannot look up itself (it cannot import @fx/model-router): the
 * model the live routing table gives a role, and the role's floor. Both are
 * optional; without them a role follows its manifest default (which is the
 * routing table's Feature row) and has no floor.
 */
export interface RoleModelResolvers {
  routedModelFor?: (role: string) => RoleModelId | undefined;
  floorFor?: (role: string) => RoleModelId | undefined;
}

interface LedgerMedianRow {
  role: string;
  model: string;
  n: number;
  median: string | null;
}

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
    // One query across every role at once, rather than one query per role.
    const { rows: ledgerRows } = await client.query<LedgerMedianRow>(
      `WITH run_costs AS (
         SELECT ar.role AS role, ar.model AS model, ar.id AS run_id, COALESCE(SUM(l.usd), 0) AS usd
           FROM agent_runs ar
           LEFT JOIN ledger l
             ON l.run_id = ar.id
            AND l.account_id = ar.account_id
            AND l.kind = 'model'
            AND l.source IN ('customer_gateway', 'customer_anthropic')
          WHERE ar.account_id = $1
          GROUP BY ar.role, ar.model, ar.id
       )
       SELECT role, model, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY usd) AS median
         FROM run_costs
        WHERE model IS NOT NULL
        GROUP BY role, model`,
      [accountId],
    );
    // Keyed by role and model: a median that mixed runs on other models
    // would be stale the moment the customer picks a different one.
    const ledgerByRoleModel = new Map(ledgerRows.map((r) => [`${r.role}\u0000${r.model}`, r]));

    return ROLE_MANIFEST.map((manifestEntry) => {
      const mode = modeByRole.get(manifestEntry.name) ?? 'off';
      const routed = resolvers.routedModelFor?.(manifestEntry.name) ?? modelIdForSeedTier(manifestEntry.defaultModel);
      const effectiveModel = effectiveModelId(
        modelByRole.get(manifestEntry.name),
        routed,
        resolvers.floorFor?.(manifestEntry.name),
      );
      const ledger = ledgerByRoleModel.get(`${manifestEntry.name}\u0000${effectiveModel}`);
      const useLedger = ledger !== undefined && ledger.n >= 10 && ledger.median !== null;
      const medianCostPerRunUsd = useLedger ? Number(ledger!.median) : medianCostSeedUsd(seedTierForModelId(effectiveModel));
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
          medianSource: useLedger ? 'ledger' : 'seed',
          caveat: TOKEN_COVERAGE_CAVEAT,
        },
      };
      return entry;
    });
  });
}
