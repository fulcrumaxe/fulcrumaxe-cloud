import type { Pool } from 'pg';
import { ALL_ROUTABLE_ROLES } from './roleUniverse.js';
import { assertRowMeetsFloor, meetsFloor } from './floors.js';
import type { ModelId, RoutingRow, RoutingTable, Size } from './types.js';

const SIZES: readonly Size[] = ['Small', 'Feature', 'Critical'];

/** One historical agent_runs observation, already resolved to the shape
 * buildProposal needs. H16's scheduled cost-analyst job is responsible
 * for querying agent_runs and shaping rows into this -- out of H22's file
 * scope (packages/model-router/**), so this package only defines the
 * shape and the pure computation over it. */
export interface RunOutcomeSample {
  role: string;
  size: Size;
  model: ModelId;
  usd: number;
  verdict: 'pass' | 'needs-fix' | 'fail';
  prMerged: boolean;
  fixRounds: number;
}

function isSuccess(sample: RunOutcomeSample): boolean {
  return sample.verdict === 'pass' && sample.prMerged && sample.fixRounds <= 1;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] as number;
}

export interface PairAggregate {
  role: string;
  size: Size;
  model: ModelId;
  n: number;
  successRate: number;
  medianCostUsd: number;
  p90CostUsd: number;
}

/** Groups samples by (role, size, model) and computes n, success rate,
 * median and p90 cost for each group (Spec H22 "Table produced from
 * outcome data"). */
export function aggregateByPair(samples: readonly RunOutcomeSample[]): PairAggregate[] {
  const groups = new Map<string, RunOutcomeSample[]>();
  for (const s of samples) {
    const key = `${s.role}|${s.size}|${s.model}`;
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }

  const out: PairAggregate[] = [];
  for (const group of groups.values()) {
    const first = group[0] as RunOutcomeSample;
    const costs = group.map((s) => s.usd).sort((a, b) => a - b);
    const successes = group.filter(isSuccess).length;
    out.push({
      role: first.role,
      size: first.size,
      model: first.model,
      n: group.length,
      successRate: successes / group.length,
      medianCostUsd: percentile(costs, 50),
      p90CostUsd: percentile(costs, 90),
    });
  }
  return out;
}

const MIN_SAMPLES_TO_REPRICE = 20;

/**
 * Computes a proposed table: for each (role, size) pair with at least
 * MIN_SAMPLES_TO_REPRICE observed runs (across all models), picks the
 * cheapest model whose success rate is within `thresholdPp` percentage
 * points of the best observed model for that pair, never below the
 * role's floor. Pairs with fewer runs keep the current table's model
 * unchanged (Spec H22: "Rows with fewer than 20 runs keep the live
 * table's model").
 */
export function buildProposal(
  samples: readonly RunOutcomeSample[],
  currentTable: RoutingTable,
  thresholdPp: number,
): RoutingRow[] {
  const aggregates = aggregateByPair(samples);
  const thresholdFraction = thresholdPp / 100;
  const rows: RoutingRow[] = [];

  for (const role of ALL_ROUTABLE_ROLES) {
    for (const size of SIZES) {
      const currentRow = currentTable.rows.find((r) => r.role === role && r.size === size);
      const candidates = aggregates.filter(
        (a) => a.role === role && a.size === size && meetsFloor(role, a.model),
      );
      const totalN = candidates.reduce((sum, c) => sum + c.n, 0);

      if (totalN < MIN_SAMPLES_TO_REPRICE || candidates.length === 0 || !currentRow) {
        if (currentRow) {
          rows.push({ ...currentRow, rationale: `kept: fewer than ${MIN_SAMPLES_TO_REPRICE} runs (n=${totalN})` });
        }
        continue;
      }

      const bestSuccessRate = Math.max(...candidates.map((c) => c.successRate));
      const eligible = candidates.filter((c) => c.successRate >= bestSuccessRate - thresholdFraction);
      const cheapest = eligible.reduce((best, c) => (c.medianCostUsd < best.medianCostUsd ? c : best), eligible[0] as PairAggregate);

      rows.push({
        role,
        size,
        model: cheapest.model,
        rationale: `proposed from outcomes: cheapest within ${thresholdPp}pp of best success rate (${bestSuccessRate.toFixed(2)}), n=${totalN}`,
      });
    }
  }

  return rows;
}

/** Total observed runs for a (role, size) pair, summed across models --
 * the promotion guard's per-pair sample-size gate. */
function pairWeight(role: string, size: Size, stats: readonly PairAggregate[]): number {
  return stats.filter((s) => s.role === role && s.size === size).reduce((sum, s) => sum + s.n, 0);
}

function successRateFor(row: RoutingRow, stats: readonly PairAggregate[]): number | undefined {
  return stats.find((s) => s.role === row.role && s.size === row.size && s.model === row.model)?.successRate;
}

/** Overall success rate a set of rows would have produced against the
 * last-30-days run mix, weighted by each pair's observed volume. A pair
 * whose table model has no matching observation counts as 0 (unmeasured
 * is treated conservatively, not optimistically). */
function weightedSuccess(rows: readonly RoutingRow[], stats: readonly PairAggregate[]): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const weight = pairWeight(row.role, row.size, stats);
    if (weight === 0) continue;
    weightedSum += weight * (successRateFor(row, stats) ?? 0);
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}

export type PromotionDecision = { promote: true } | { promote: false; reason: string };

/**
 * The promotion guard (Spec H22): a proposed table goes live only if its
 * weighted overall success rate is not lower than the live table's by
 * more than `thresholdPp`, and no single (role, size) pair with n >= 20
 * drops by more than 5 points.
 */
export function decidePromotion(
  proposedRows: readonly RoutingRow[],
  liveRows: readonly RoutingRow[],
  stats: readonly PairAggregate[],
  thresholdPp: number,
): PromotionDecision {
  const proposedOverall = weightedSuccess(proposedRows, stats);
  const liveOverall = weightedSuccess(liveRows, stats);
  if (proposedOverall < liveOverall - thresholdPp / 100) {
    return {
      promote: false,
      reason: `overall weighted success ${(proposedOverall * 100).toFixed(1)}% drops more than ${thresholdPp}pp below live's ${(liveOverall * 100).toFixed(1)}%`,
    };
  }

  for (const proposedRow of proposedRows) {
    const weight = pairWeight(proposedRow.role, proposedRow.size, stats);
    if (weight < MIN_SAMPLES_TO_REPRICE) continue;
    const liveRow = liveRows.find((r) => r.role === proposedRow.role && r.size === proposedRow.size);
    if (!liveRow) continue;
    const proposedRate = successRateFor(proposedRow, stats) ?? 0;
    const liveRate = successRateFor(liveRow, stats) ?? 0;
    if (proposedRate < liveRate - 0.05) {
      return {
        promote: false,
        reason: `${proposedRow.role}/${proposedRow.size} drops more than 5 points (n=${weight})`,
      };
    }
  }

  return { promote: true };
}

/** Stores a proposal as a new routing_tables row (status = 'proposed'),
 * with its rows -- the "stores the result as status = proposed" half of
 * the weekly cost-analyst job (Spec H22). Returns the new version number.
 *
 * Security fix round (CWE-693): validates every row against its role's
 * floor (the same check `route()` and `loadLiveRoutingTable` apply)
 * BEFORE opening a transaction, so a floor-violating proposal -- e.g.
 * security-reviewer on Haiku -- is rejected without ever touching the
 * database, rather than relying solely on route()'s runtime clamp to
 * catch it later. A per-row check, not the stricter `validateRoutingRows`
 * (which also requires every (role, size) pair to be present): a
 * proposal is allowed to cover a subset of pairs, matching how this
 * function is exercised today. */
export async function saveProposedTable(
  pool: Pool,
  rows: readonly RoutingRow[],
  opts: { source: 'offline_eval' | 'cost_analyst'; successThresholdPp: number },
): Promise<number> {
  for (const row of rows) {
    assertRowMeetsFloor(row.role, row.model);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: versionRows } = await client.query<{ version: number }>(
      "INSERT INTO routing_tables (version, status, source, success_threshold_pp) " +
        "VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM routing_tables), 'proposed', $1, $2) " +
        'RETURNING version',
      [opts.source, opts.successThresholdPp],
    );
    const version = (versionRows[0] as { version: number }).version;
    for (const row of rows) {
      await client.query(
        'INSERT INTO routing_rows (table_version, role, size, model, rationale) VALUES ($1, $2, $3, $4, $5)',
        [version, row.role, row.size, row.model, row.rationale],
      );
    }
    await client.query('COMMIT');
    return version;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies a promotion decision to a proposed version: on promote, the
 * previous live version becomes retired and the proposed version becomes
 * live (activated_at set); on reject, the proposed version becomes
 * rejected with the reason stored. Both are one transaction, so a reader
 * never observes two live versions or a promoted-but-unreasoned rejection.
 *
 * Security fix round (CWE-841, Improper Enforcement of Behavioral
 * Workflow): both target UPDATEs now require `status = 'proposed'` and
 * `rowCount === 1`, throwing (and rolling back the whole transaction,
 * including the retire above it) otherwise. Without this, each of the
 * following previously went through silently:
 *   - promoting an already-`rejected` version back to live;
 *   - promoting a nonexistent version, which still retired the live
 *     table and left zero live rows;
 *   - rejecting the CURRENTLY LIVE version, which also left zero live
 *     rows (loadLiveRoutingTable then throws for every account).
 */
export async function applyPromotionDecision(
  pool: Pool,
  proposedVersion: number,
  decision: PromotionDecision,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (decision.promote) {
      await client.query("UPDATE routing_tables SET status = 'retired' WHERE status = 'live'");
      const { rowCount } = await client.query(
        "UPDATE routing_tables SET status = 'live', activated_at = now() WHERE version = $1 AND status = 'proposed'",
        [proposedVersion],
      );
      if (rowCount !== 1) {
        throw new Error(
          `applyPromotionDecision: version ${proposedVersion} is not a 'proposed' row (matched ${rowCount}) -- refusing to promote`,
        );
      }
    } else {
      const { rowCount } = await client.query(
        "UPDATE routing_tables SET status = 'rejected', rejection_reason = $1 WHERE version = $2 AND status = 'proposed'",
        [decision.reason, proposedVersion],
      );
      if (rowCount !== 1) {
        throw new Error(
          `applyPromotionDecision: version ${proposedVersion} is not a 'proposed' row (matched ${rowCount}) -- refusing to reject`,
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
