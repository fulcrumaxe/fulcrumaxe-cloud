import type { PoolClient } from 'pg';
import { ROLE_MANIFEST } from '@fx/roles';
import { effectiveModelId, medianCostSeedUsd, modelIdForSeedTier, seedTierForModelId } from './costModel.js';
import type { RoleModelId } from './types.js';

/**
 * D#483 S5-p: the ONE per-run price lookup. Role settings (list.ts) and the pipeline estimate both read a role's price here, so there is
 * a single answer to "what does one run of this role cost this tenant".
 *
 * The model part is the tenant's own median over that role's runs on the model it really runs on, once there are `MEDIAN_MIN_RUNS` of
 * them; before that it is the plan-data seed for the model's tier. A seed is a price, never a limit.
 */

/** Runs of a role (on one model) before the tenant's own median replaces the seed (H12 criterion 2). */
export const MEDIAN_MIN_RUNS = 10;

/**
 * What core cannot look up itself (it cannot import @fx/model-router): the model the live routing table gives a role, and the role's
 * floor. Both are optional; without them a role follows its manifest default and has no floor.
 */
export interface RoleModelResolvers {
  routedModelFor?: (role: string) => RoleModelId | undefined;
  floorFor?: (role: string) => RoleModelId | undefined;
}

export interface RunMedian {
  n: number;
  median: number;
}

interface ModelMedianRow {
  role: string;
  model: string;
  n: number;
  median: string | null;
}

/** Medians of one run's model spend, keyed by role and model: a median that mixed other models would be stale once a model is changed. */
export type ModelRunMedians = ReadonlyMap<string, RunMedian>;

const key = (role: string, model: string): string => `${role}\u0000${model}`;

/** One query for every role at once. Must run inside a `withTenant` transaction for `accountId`. */
export async function loadModelRunMedians(client: PoolClient, accountId: string): Promise<ModelRunMedians> {
  const { rows } = await client.query<ModelMedianRow>(
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
  return new Map(rows.filter((r) => r.median !== null).map((r) => [key(r.role, r.model), { n: r.n, median: Number(r.median) }]));
}

interface ComputeMedianRow {
  role: string;
  n: number;
  median: string | null;
}

/**
 * Medians of one run's compute spend, by role. Only runs that have a compute ledger row count: a run on a customer's runner books none,
 * and would otherwise drag a hosted role's median to zero. Must run inside a `withTenant` transaction for `accountId`.
 */
export async function loadComputeRunMedians(client: PoolClient, accountId: string): Promise<ReadonlyMap<string, RunMedian>> {
  const { rows } = await client.query<ComputeMedianRow>(
    `WITH run_costs AS (
       SELECT ar.role AS role, ar.id AS run_id, SUM(l.usd) AS usd
         FROM agent_runs ar
         JOIN ledger l
           ON l.run_id = ar.id
          AND l.account_id = ar.account_id
          AND l.kind = 'compute'
        WHERE ar.account_id = $1
        GROUP BY ar.role, ar.id
     )
     SELECT role, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY usd) AS median
       FROM run_costs
      GROUP BY role`,
    [accountId],
  );
  return new Map(rows.filter((r) => r.median !== null).map((r) => [r.role, { n: r.n, median: Number(r.median) }]));
}

/** The model a role really runs on: the repo's stored override, else the routing table (else the manifest default), never below the floor. */
export function effectiveRoleModel(role: string, override: string | null | undefined, resolvers: RoleModelResolvers = {}): RoleModelId {
  const entry = ROLE_MANIFEST.find((e) => e.name === role);
  const routed = resolvers.routedModelFor?.(role) ?? modelIdForSeedTier(entry === undefined ? 'sonnet' : entry.defaultModel);
  return effectiveModelId(override, routed, resolvers.floorFor?.(role));
}

export interface ModelRunPrice {
  usd: number;
  source: 'ledger' | 'seed';
}

/** The model part of one run's price: the tenant's median at or above `MEDIAN_MIN_RUNS` runs, else the seed for the model's tier. */
export function modelRunPrice(medians: ModelRunMedians, role: string, effectiveModel: RoleModelId): ModelRunPrice {
  const m = medians.get(key(role, effectiveModel));
  if (m !== undefined && m.n >= MEDIAN_MIN_RUNS) return { usd: m.median, source: 'ledger' };
  return { usd: medianCostSeedUsd(seedTierForModelId(effectiveModel)), source: 'seed' };
}
