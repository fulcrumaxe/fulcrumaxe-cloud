/**
 * D#45 S2 criterion 7: matches PostgreSQL's `percentile_cont` (continuous,
 * linear-interpolation-between-closest-ranks) exactly, for the same reason
 * `computeKpis` is pure -- so a KPI computed here and the same figure
 * computed by a raw SQL query against `v_kpi_work_items` never drift.
 *
 * Rank formula: `p * (n - 1)`, 0-indexed into the SORTED array. When the
 * rank lands between two indices, the result is a linear interpolation
 * between them; the two-sample check ([1,2,3,4] -> p50 2.5, p90 3.7) pins
 * this exactly.
 */
export function percentileCont(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;

  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;

  const frac = rank - lower;
  return sorted[lower]! + frac * (sorted[upper]! - sorted[lower]!);
}

/** `Math.round(x * 10^d) / 10^d` (S2's binding rounding rule). */
export function round(x: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(x * factor) / factor;
}
