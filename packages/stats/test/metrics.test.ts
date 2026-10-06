import { describe, expect, it } from 'vitest';
import { KPI_METRICS } from '../src/metrics.js';

const HEADLINE_IDS = [
  'lead_time_minutes',
  'time_to_merge_minutes',
  'fix_rounds',
  'first_pass_review_rate',
  'model_usd_per_merged_pr',
  'compute_usd_per_merged_pr',
  'first_pr_from_install',
];

const PUBLIC_IDS = ['merged_count', 'time_to_merge_minutes', 'first_pass_review_rate', 'first_pr_from_install'];

describe('KPI_METRICS (D#45 S2 criterion 6)', () => {
  it('has exactly 16 ids', () => {
    expect(KPI_METRICS).toHaveLength(16);
    expect(new Set(KPI_METRICS.map((m) => m.id)).size).toBe(16);
  });

  it('has the exact kinds and units from the Spec table', () => {
    const byId = new Map(KPI_METRICS.map((m) => [m.id, m]));
    expect(byId.get('lead_time_minutes')).toMatchObject({ kind: 'distribution', unit: 'minutes' });
    expect(byId.get('time_to_merge_minutes')).toMatchObject({ kind: 'distribution', unit: 'minutes' });
    expect(byId.get('spec_to_first_pr_minutes')).toMatchObject({ kind: 'distribution', unit: 'minutes' });
    expect(byId.get('queue_wait_minutes')).toMatchObject({ kind: 'distribution', unit: 'minutes' });
    expect(byId.get('review_latency_minutes')).toMatchObject({ kind: 'distribution', unit: 'minutes' });
    expect(byId.get('fix_rounds')).toMatchObject({ kind: 'distribution', unit: 'count' });
    expect(byId.get('first_pass_review_rate')).toMatchObject({ kind: 'rate', unit: 'ratio' });
    expect(byId.get('escalation_rate')).toMatchObject({ kind: 'rate', unit: 'ratio' });
    expect(byId.get('merged_count')).toMatchObject({ kind: 'count', unit: 'count' });
    expect(byId.get('open_age_minutes')).toMatchObject({ kind: 'distribution', unit: 'minutes' });
    expect(byId.get('run_success_rate')).toMatchObject({ kind: 'rate_by_role', unit: 'ratio' });
    expect(byId.get('model_usd_per_merged_pr')).toMatchObject({ kind: 'per_pr', unit: 'usd' });
    expect(byId.get('compute_usd_per_merged_pr')).toMatchObject({ kind: 'per_pr', unit: 'usd' });
    expect(byId.get('tokens_per_merged_pr')).toMatchObject({ kind: 'per_pr', unit: 'tokens' });
    expect(byId.get('abandoned_usd')).toMatchObject({ kind: 'usd_total', unit: 'usd' });
    expect(byId.get('first_pr_from_install')).toMatchObject({ kind: 'first_pr', unit: 'minutes' });
  });

  it('headline is true for exactly the 7 named ids', () => {
    expect(new Set(KPI_METRICS.filter((m) => m.headline).map((m) => m.id))).toEqual(new Set(HEADLINE_IDS));
  });

  it('public is true for exactly the 4 named ids', () => {
    expect(new Set(KPI_METRICS.filter((m) => m.public).map((m) => m.id))).toEqual(new Set(PUBLIC_IDS));
  });

  it('no metric with unit usd or tokens is public', () => {
    for (const m of KPI_METRICS) {
      if (m.unit === 'usd' || m.unit === 'tokens') {
        expect(m.public).toBe(false);
      }
    }
  });

  it('"time_to_merge" and "lead_time" each appear in exactly one id', () => {
    expect(KPI_METRICS.filter((m) => m.id.includes('time_to_merge'))).toHaveLength(1);
    expect(KPI_METRICS.filter((m) => m.id.includes('lead_time'))).toHaveLength(1);
  });
});
