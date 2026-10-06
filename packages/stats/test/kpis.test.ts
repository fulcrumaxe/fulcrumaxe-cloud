import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeKpis, type InstallationKpiRow, type RunKpiRow, type WorkItemKpiRow } from '../src/kpis.js';

const d = (s: string) => new Date(s);

/** Every field defaults to "never happened" -- tests only set what they need. */
function mkItem(overrides: Partial<WorkItemKpiRow> = {}): WorkItemKpiRow {
  return {
    account_id: 'acct',
    work_item_id: randomUUID(),
    repo_id: 'repo',
    kind: 'feature',
    stage: 'triaged',
    created_at: d('2024-01-01T00:00:00Z'),
    t_discussing: null,
    t_spec_ready: null,
    t_in_progress: null,
    t_pr_opened: null,
    t_first_verdict: null,
    first_verdict_stage: null,
    t_needs_human: null,
    t_merged: null,
    t_closed_unmerged: null,
    t_closed: null,
    n_changes_requested: 0,
    n_needs_human: 0,
    model_usd: 0,
    compute_usd: 0,
    tokens: 0,
    ...overrides,
  };
}

function mkRun(overrides: Partial<RunKpiRow> = {}): RunKpiRow {
  return {
    account_id: 'acct',
    run_id: randomUUID(),
    work_item_id: null,
    repo_id: null,
    role: 'executor',
    runtime: 'local',
    status: 'succeeded',
    created_at: d('2024-01-01T00:00:00Z'),
    started_at: null,
    ended_at: null,
    tokens_in: null,
    tokens_out: null,
    model_usd: 0,
    compute_usd: 0,
    ...overrides,
  };
}

const WINDOW = { from: d('2024-01-01T00:00:00Z'), to: d('2024-02-01T00:00:00Z'), now: d('2024-01-25T00:00:00Z') };

describe('computeKpis (D#45 S2 criterion 8): one shared fixture, one literal expectation per metric', () => {
  // Item 1: a full pipeline whose pr_opened/verdict stamps fall BEFORE the
  // window, but merges INSIDE it -- exercises per-metric anchors (S2's
  // registry table) differing from the item's own merge date.
  const item1 = mkItem({
    created_at: d('2023-12-25T00:00:00Z'),
    t_spec_ready: d('2023-12-26T00:00:00Z'),
    t_in_progress: d('2023-12-27T00:00:00Z'),
    t_pr_opened: d('2023-12-28T00:00:00Z'),
    t_first_verdict: d('2023-12-29T00:00:00Z'),
    first_verdict_stage: 'review_passed',
    t_merged: d('2024-01-10T00:00:00Z'),
    model_usd: 4,
    compute_usd: 2,
    tokens: 500,
    stage: 'merged',
  });
  // Item 2: a quick merge, entirely inside the window, one changes_requested round.
  const item2 = mkItem({
    created_at: d('2024-01-01T00:00:00Z'),
    t_spec_ready: d('2024-01-02T00:00:00Z'),
    t_in_progress: d('2024-01-02T12:00:00Z'),
    t_pr_opened: d('2024-01-03T00:00:00Z'),
    t_first_verdict: d('2024-01-04T00:00:00Z'),
    first_verdict_stage: 'changes_requested',
    n_changes_requested: 1,
    t_merged: d('2024-01-06T00:00:00Z'),
    model_usd: 1,
    compute_usd: 0.5,
    tokens: 200,
    stage: 'merged',
  });
  // Item 3: escalated and abandoned, never merged.
  const item3 = mkItem({
    created_at: d('2024-01-01T00:00:00Z'),
    t_spec_ready: d('2024-01-01T06:00:00Z'),
    t_in_progress: d('2024-01-01T12:00:00Z'),
    t_pr_opened: d('2024-01-02T00:00:00Z'),
    t_needs_human: d('2024-01-03T00:00:00Z'),
    n_needs_human: 1,
    t_closed_unmerged: d('2024-01-15T00:00:00Z'),
    model_usd: 0.3,
    compute_usd: 0.2,
    tokens: 50,
    stage: 'closed_unmerged',
  });
  // Item 4: still open (discussing), for open_age_minutes.
  const item4 = mkItem({ created_at: d('2024-01-20T00:00:00Z'), stage: 'discussing' });
  // Item 5: T(pr_opened) earlier than T(spec_ready) -- criterion 8's
  // required negative-order exclusion case.
  const item5 = mkItem({
    created_at: d('2024-01-01T00:00:00Z'),
    t_pr_opened: d('2024-01-02T00:00:00Z'),
    t_spec_ready: d('2024-01-05T00:00:00Z'),
    stage: 'pr_opened',
  });

  const items = [item1, item2, item3, item4, item5];

  const runs = [
    mkRun({ role: 'executor', status: 'succeeded', ended_at: d('2024-01-10T01:00:00Z') }),
    mkRun({ role: 'executor', status: 'failed', ended_at: d('2024-01-06T01:00:00Z') }),
    mkRun({ role: 'executor', status: 'cancelled', ended_at: d('2024-01-07T00:00:00Z') }),
    mkRun({ role: 'code-reviewer', status: 'succeeded', ended_at: d('2024-01-12T00:00:00Z') }),
    mkRun({ role: 'code-reviewer', status: 'refused_spend', ended_at: d('2024-01-13T00:00:00Z') }),
    mkRun({ role: 'executor', status: 'succeeded', ended_at: d('2023-12-20T00:00:00Z') }), // out of window
    mkRun({ role: 'executor', status: 'running', ended_at: null }), // never ended
  ];

  const installations: InstallationKpiRow[] = [{ created_at: d('2024-01-01T00:00:00Z'), app_kind: 'team' }];

  const result = computeKpis({ items, runs, installations }, WINDOW);

  it('lead_time_minutes: merged items, start = coalesce(spec_ready, created_at)', () => {
    expect(result.lead_time_minutes).toEqual({ p50: 13680, p90: 20016, mean: 13680, n: 2 });
  });

  it('time_to_merge_minutes: merged items with a pr_opened stamp', () => {
    expect(result.time_to_merge_minutes).toEqual({ p50: 11520, p90: 17280, mean: 11520, n: 2 });
  });

  it('spec_to_first_pr_minutes: anchored on pr_opened; item1 (out of window) and item5 (negative order) excluded', () => {
    expect(result.spec_to_first_pr_minutes).toEqual({ p50: 1260, p90: 1404, mean: 1260, n: 2 });
  });

  it('queue_wait_minutes: anchored on in_progress', () => {
    expect(result.queue_wait_minutes).toEqual({ p50: 540, p90: 684, mean: 540, n: 2 });
  });

  it('review_latency_minutes: anchored on the first verdict; only item2 qualifies', () => {
    expect(result.review_latency_minutes).toEqual({ p50: 1440, p90: 1440, mean: 1440, n: 1 });
  });

  it('fix_rounds: merged items, count of changes_requested rows', () => {
    expect(result.fix_rounds).toEqual({ p50: 0.5, p90: 0.9, mean: 0.5, n: 2 });
  });

  it("first_pass_review_rate: item1's first verdict is review_passed, item2's is not", () => {
    expect(result.first_pass_review_rate).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
  });

  it('escalation_rate: item2, item3, item5 opened a PR in window; only item3 escalated', () => {
    expect(result.escalation_rate).toEqual({ value: 0.3333, numerator: 1, denominator: 3 });
  });

  it('merged_count: item1 and item2', () => {
    expect(result.merged_count).toEqual({ value: 2 });
  });

  it('open_age_minutes: item4 and item5 are not merged/closed_unmerged/closed; ignores the window', () => {
    expect(result.open_age_minutes).toEqual({ p50: 20880, p90: 31824, mean: 20880, n: 2 });
  });

  it('run_success_rate: per role, excluding cancelled/refused_spend/unended/out-of-window', () => {
    expect(result.run_success_rate).toEqual({
      executor: { value: 0.5, numerator: 1, denominator: 2 },
      'code-reviewer': { value: 1, numerator: 1, denominator: 1 },
    });
  });

  it('model_usd_per_merged_pr / compute_usd_per_merged_pr / tokens_per_merged_pr', () => {
    expect(result.model_usd_per_merged_pr).toEqual({ value: 2.5, total: 5, n: 2 });
    expect(result.compute_usd_per_merged_pr).toEqual({ value: 1.25, total: 2.5, n: 2 });
    expect(result.tokens_per_merged_pr).toEqual({ value: 350, total: 700, n: 2 });
  });

  it('abandoned_usd: item3 only', () => {
    expect(result.abandoned_usd).toEqual({ value: 0.5, n: 1 });
  });

  it('first_pr_from_install: earliest in-or-after-install PR is item3/item5\'s (item1\'s predates the install)', () => {
    expect(result.first_pr_from_install).toEqual({
      status: 'missed',
      installed_at: '2024-01-01T00:00:00.000Z',
      first_pr_at: '2024-01-02T00:00:00.000Z',
      minutes: 1440,
      target_minutes: 60,
    });
  });
});

describe('computeKpis: an open item contributes to open_age_minutes only', () => {
  const openItem = mkItem({ created_at: d('2024-01-20T00:00:00Z'), stage: 'in_progress' });
  const result = computeKpis({ items: [openItem], runs: [], installations: [] }, WINDOW);

  it('every duration/rate/count metric except open_age_minutes sees n=0/denominator=0', () => {
    expect(result.lead_time_minutes.n).toBe(0);
    expect(result.time_to_merge_minutes.n).toBe(0);
    expect(result.spec_to_first_pr_minutes.n).toBe(0);
    expect(result.queue_wait_minutes.n).toBe(0);
    expect(result.review_latency_minutes.n).toBe(0);
    expect(result.fix_rounds.n).toBe(0);
    expect(result.first_pass_review_rate.denominator).toBe(0);
    expect(result.escalation_rate.denominator).toBe(0);
    expect(result.merged_count.value).toBe(0);
    expect(result.model_usd_per_merged_pr.n).toBe(0);
    expect(result.abandoned_usd.n).toBe(0);
  });

  it('open_age_minutes sees exactly this item', () => {
    expect(result.open_age_minutes).toEqual({ p50: 7200, p90: 7200, mean: 7200, n: 1 });
  });
});

describe('computeKpis: window boundaries (merged just-before/at from/at to)', () => {
  const justBefore = mkItem({
    t_spec_ready: d('2023-12-31T23:00:00Z'),
    t_merged: d('2023-12-31T23:59:59.999Z'),
    stage: 'merged',
  });
  const atFrom = mkItem({
    t_spec_ready: d('2023-12-31T23:00:00Z'),
    t_merged: d('2024-01-01T00:00:00Z'),
    stage: 'merged',
  });
  const atTo = mkItem({
    t_spec_ready: d('2024-01-31T23:00:00Z'),
    t_merged: d('2024-02-01T00:00:00Z'),
    stage: 'merged',
  });

  it('just before `from` and exactly at `to` are outside the window; exactly at `from` is inside', () => {
    const result = computeKpis({ items: [justBefore, atFrom, atTo], runs: [], installations: [] }, WINDOW);
    expect(result.merged_count.value).toBe(1);
    expect(result.lead_time_minutes.n).toBe(1);
    expect(result.lead_time_minutes.mean).toBe(60);
  });
});

describe('computeKpis: first_pr_from_install (D#45 S2-9)', () => {
  it('no_install: no team installation', () => {
    const result = computeKpis({ items: [], runs: [], installations: [] }, WINDOW);
    expect(result.first_pr_from_install).toEqual({
      status: 'no_install',
      installed_at: null,
      first_pr_at: null,
      minutes: null,
      target_minutes: 60,
    });
  });

  it('no_install: a team_readonly installation does not start the first-PR clock', () => {
    const result = computeKpis(
      { items: [], runs: [], installations: [{ created_at: d('2024-01-01T00:00:00Z'), app_kind: 'team_readonly' }] },
      WINDOW,
    );
    expect(result.first_pr_from_install).toEqual({
      status: 'no_install',
      installed_at: null,
      first_pr_at: null,
      minutes: null,
      target_minutes: 60,
    });
  });

  it('pending: no PR yet, 59 minutes since install', () => {
    const installedAt = d('2024-01-01T00:00:00Z');
    const now = d('2024-01-01T00:59:00Z');
    const result = computeKpis(
      { items: [], runs: [], installations: [{ created_at: installedAt, app_kind: 'team' }] },
      { ...WINDOW, now },
    );
    expect(result.first_pr_from_install.status).toBe('pending');
    expect(result.first_pr_from_install.minutes).toBeNull();
  });

  it('missed: no PR yet, 61 minutes since install', () => {
    const installedAt = d('2024-01-01T00:00:00Z');
    const now = d('2024-01-01T01:01:00Z');
    const result = computeKpis(
      { items: [], runs: [], installations: [{ created_at: installedAt, app_kind: 'team' }] },
      { ...WINDOW, now },
    );
    expect(result.first_pr_from_install.status).toBe('missed');
    expect(result.first_pr_from_install.minutes).toBeNull();
  });

  it('met: a PR at 42 minutes', () => {
    const installedAt = d('2024-01-01T00:00:00Z');
    const prItem = mkItem({ t_pr_opened: d('2024-01-01T00:42:00Z') });
    const result = computeKpis(
      { items: [prItem], runs: [], installations: [{ created_at: installedAt, app_kind: 'team' }] },
      WINDOW,
    );
    expect(result.first_pr_from_install).toMatchObject({ status: 'met', minutes: 42 });
  });

  it('missed: a PR at 75 minutes', () => {
    const installedAt = d('2024-01-01T00:00:00Z');
    const prItem = mkItem({ t_pr_opened: d('2024-01-01T01:15:00Z') });
    const result = computeKpis(
      { items: [prItem], runs: [], installations: [{ created_at: installedAt, app_kind: 'team' }] },
      WINDOW,
    );
    expect(result.first_pr_from_install).toMatchObject({ status: 'missed', minutes: 75 });
  });

  it('a PR opened before the install only: first_pr_at is NULL, status by elapsed time', () => {
    const installedAt = d('2024-01-01T01:00:00Z');
    const earlyPrItem = mkItem({ t_pr_opened: d('2024-01-01T00:00:00Z') });
    const now = d('2024-01-01T01:30:00Z'); // 30 min since install -> pending
    const result = computeKpis(
      { items: [earlyPrItem], runs: [], installations: [{ created_at: installedAt, app_kind: 'team' }] },
      { ...WINDOW, now },
    );
    expect(result.first_pr_from_install.first_pr_at).toBeNull();
    expect(result.first_pr_from_install.status).toBe('pending');
  });
});
