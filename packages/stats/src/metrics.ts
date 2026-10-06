/**
 * D#45 S2's metric registry (binding). One entry per row of the Spec's
 * "The metric registry (binding)" table -- `kpis.test.ts` and
 * `docs.test.ts` both check this array directly, so this file's shape
 * must never drift from the table without a Spec correction.
 */

export type KpiMetricKind =
  | 'distribution'
  | 'rate'
  | 'rate_by_role'
  | 'count'
  | 'per_pr'
  | 'usd_total'
  | 'first_pr';

export type KpiMetricUnit = 'minutes' | 'count' | 'ratio' | 'usd' | 'tokens';

export interface KpiMetricDefinition {
  readonly id: string;
  readonly kind: KpiMetricKind;
  readonly unit: KpiMetricUnit;
  /** Whether this metric appears on the Stats app's headline row (D#45 Spec). */
  readonly headline: boolean;
  /** Whether this metric may appear in D#3's cross-tenant `public_figures` view. */
  readonly public: boolean;
}

export const KPI_METRICS: readonly KpiMetricDefinition[] = [
  { id: 'lead_time_minutes', kind: 'distribution', unit: 'minutes', headline: true, public: false },
  { id: 'time_to_merge_minutes', kind: 'distribution', unit: 'minutes', headline: true, public: true },
  { id: 'spec_to_first_pr_minutes', kind: 'distribution', unit: 'minutes', headline: false, public: false },
  { id: 'queue_wait_minutes', kind: 'distribution', unit: 'minutes', headline: false, public: false },
  { id: 'review_latency_minutes', kind: 'distribution', unit: 'minutes', headline: false, public: false },
  { id: 'fix_rounds', kind: 'distribution', unit: 'count', headline: true, public: false },
  { id: 'first_pass_review_rate', kind: 'rate', unit: 'ratio', headline: true, public: true },
  { id: 'escalation_rate', kind: 'rate', unit: 'ratio', headline: false, public: false },
  { id: 'merged_count', kind: 'count', unit: 'count', headline: false, public: true },
  { id: 'open_age_minutes', kind: 'distribution', unit: 'minutes', headline: false, public: false },
  { id: 'run_success_rate', kind: 'rate_by_role', unit: 'ratio', headline: false, public: false },
  { id: 'model_usd_per_merged_pr', kind: 'per_pr', unit: 'usd', headline: true, public: false },
  { id: 'compute_usd_per_merged_pr', kind: 'per_pr', unit: 'usd', headline: true, public: false },
  { id: 'tokens_per_merged_pr', kind: 'per_pr', unit: 'tokens', headline: false, public: false },
  { id: 'abandoned_usd', kind: 'usd_total', unit: 'usd', headline: false, public: false },
  { id: 'first_pr_from_install', kind: 'first_pr', unit: 'minutes', headline: true, public: true },
] as const;

export type KpiMetricId = (typeof KPI_METRICS)[number]['id'];
