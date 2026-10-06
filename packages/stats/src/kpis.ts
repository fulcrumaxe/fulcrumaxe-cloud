import { percentileCont, round } from './percentile.js';

/**
 * Row shapes mirror `v_kpi_work_items`/`v_kpi_runs`/`installations`
 * column-for-column (snake_case, as `pg` hands them back) -- `@fx/stats`
 * takes already-fetched rows and does no I/O of its own (S2 criterion 11),
 * so there is no reason to rename anything on the way in, and the D#31
 * API-3a read service (S3) can pass query results straight through.
 */
export interface WorkItemKpiRow {
  account_id: string;
  work_item_id: string;
  repo_id: string | null;
  kind: string | null;
  stage: string;
  created_at: Date;
  t_discussing: Date | null;
  t_spec_ready: Date | null;
  t_in_progress: Date | null;
  t_pr_opened: Date | null;
  t_first_verdict: Date | null;
  first_verdict_stage: 'changes_requested' | 'review_passed' | null;
  t_needs_human: Date | null;
  t_merged: Date | null;
  t_closed_unmerged: Date | null;
  t_closed: Date | null;
  n_changes_requested: number;
  n_needs_human: number;
  model_usd: number;
  compute_usd: number;
  tokens: number;
}

export interface RunKpiRow {
  account_id: string;
  run_id: string;
  work_item_id: string | null;
  repo_id: string | null;
  role: string;
  runtime: 'local' | 'production';
  status: string;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  tokens_in: number | null;
  tokens_out: number | null;
  model_usd: number;
  compute_usd: number;
}

export interface InstallationKpiRow {
  created_at: Date;
  app_kind: 'team' | 'team_readonly' | 'sitekit';
}

export interface ComputeKpisInput {
  items: readonly WorkItemKpiRow[];
  runs: readonly RunKpiRow[];
  installations: readonly InstallationKpiRow[];
}

export interface ComputeKpisWindow {
  from: Date;
  to: Date;
  now: Date;
}

/** Output shapes (S2 binding: "Output shapes and rounding"). */
export interface DistributionResult {
  p50: number | null;
  p90: number | null;
  mean: number | null;
  n: number;
}
export interface RateResult {
  value: number | null;
  numerator: number;
  denominator: number;
}
export type RateByRoleResult = Record<string, RateResult>;
export interface CountResult {
  value: number;
}
export interface PerPrResult {
  value: number | null;
  total: number;
  n: number;
}
export interface UsdTotalResult {
  value: number;
  n: number;
}
export interface FirstPrResult {
  status: 'met' | 'missed' | 'pending' | 'no_install';
  installed_at: string | null;
  first_pr_at: string | null;
  minutes: number | null;
  target_minutes: 60;
}

export interface KpiResults {
  lead_time_minutes: DistributionResult;
  time_to_merge_minutes: DistributionResult;
  spec_to_first_pr_minutes: DistributionResult;
  queue_wait_minutes: DistributionResult;
  review_latency_minutes: DistributionResult;
  fix_rounds: DistributionResult;
  first_pass_review_rate: RateResult;
  escalation_rate: RateResult;
  merged_count: CountResult;
  open_age_minutes: DistributionResult;
  run_success_rate: RateByRoleResult;
  model_usd_per_merged_pr: PerPrResult;
  compute_usd_per_merged_pr: PerPrResult;
  tokens_per_merged_pr: PerPrResult;
  abandoned_usd: UsdTotalResult;
  first_pr_from_install: FirstPrResult;
}

const MINUTES_DECIMALS = 1;
const COUNT_DECIMALS = 2;
const RATE_DECIMALS = 4;
const USD_DECIMALS = 4;
const TOKENS_DECIMALS = 0;
const FIRST_PR_TARGET_MINUTES = 60;

const OPEN_STAGES_EXCLUDED = new Set(['merged', 'closed_unmerged', 'closed']);
const TERMINAL_RUN_STATUSES_EXCLUDED_FROM_SUCCESS_RATE = new Set(['cancelled', 'refused_spend']);

function inWindow(at: Date, from: Date, to: Date): boolean {
  return from.getTime() <= at.getTime() && at.getTime() < to.getTime();
}

function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60_000;
}

/**
 * Builds a `distribution` result from a set of already-filtered, in-window
 * minute/count values. Negative-duration items ("end stamp earlier than
 * start stamp") are the caller's job to leave out before calling this --
 * every distribution metric below does that at the point it pushes a
 * value, so this function only ever sees legal durations.
 */
function distribution(values: readonly number[], decimals: number): DistributionResult {
  const n = values.length;
  if (n === 0) return { p50: null, p90: null, mean: null, n: 0 };
  const p50 = percentileCont(values, 0.5)!;
  const p90 = percentileCont(values, 0.9)!;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  return { p50: round(p50, decimals), p90: round(p90, decimals), mean: round(mean, decimals), n };
}

function rate(numerator: number, denominator: number): RateResult {
  return {
    value: denominator === 0 ? null : round(numerator / denominator, RATE_DECIMALS),
    numerator,
    denominator,
  };
}

function perPr(total: number, n: number, decimals: number): PerPrResult {
  return { value: n === 0 ? null : round(total / n, decimals), total: round(total, decimals), n };
}

/**
 * D#45 S2-9: `first_pr_from_install`. Ignores `from`, `to` and `repo_id`
 * -- it is a single, account-wide, unwindowed figure.
 */
export function firstPrFromInstall(
  items: readonly WorkItemKpiRow[],
  installations: readonly InstallationKpiRow[],
  now: Date,
): FirstPrResult {
  const teamInstalls = installations.filter((i) => i.app_kind === 'team');
  if (teamInstalls.length === 0) {
    return { status: 'no_install', installed_at: null, first_pr_at: null, minutes: null, target_minutes: FIRST_PR_TARGET_MINUTES };
  }
  const installedAt = teamInstalls.reduce(
    (min, i) => (i.created_at.getTime() < min.getTime() ? i.created_at : min),
    teamInstalls[0]!.created_at,
  );

  const prTimes = items
    .map((w) => w.t_pr_opened)
    .filter((t): t is Date => t !== null && t.getTime() >= installedAt.getTime());
  const firstPrAt =
    prTimes.length > 0
      ? prTimes.reduce((min, t) => (t.getTime() < min.getTime() ? t : min), prTimes[0]!)
      : null;

  if (firstPrAt !== null) {
    const minutes = minutesBetween(installedAt, firstPrAt);
    return {
      status: minutes <= FIRST_PR_TARGET_MINUTES ? 'met' : 'missed',
      installed_at: installedAt.toISOString(),
      first_pr_at: firstPrAt.toISOString(),
      minutes: round(minutes, MINUTES_DECIMALS),
      target_minutes: FIRST_PR_TARGET_MINUTES,
    };
  }

  const elapsedMinutes = minutesBetween(installedAt, now);
  return {
    status: elapsedMinutes >= FIRST_PR_TARGET_MINUTES ? 'missed' : 'pending',
    installed_at: installedAt.toISOString(),
    first_pr_at: null,
    minutes: null,
    target_minutes: FIRST_PR_TARGET_MINUTES,
  };
}

/**
 * D#45 S2-8: pure (no I/O), returns every id in `KPI_METRICS`. `from`/`to`
 * bound "in window" per metric's own anchor (S2's registry table); `now`
 * is `open_age_minutes`' and `first_pr_from_install`'s reference clock.
 */
export function computeKpis(input: ComputeKpisInput, window: ComputeKpisWindow): KpiResults {
  const { items, runs, installations } = input;
  const { from, to, now } = window;

  const leadTimeValues: number[] = [];
  const timeToMergeValues: number[] = [];
  const specToFirstPrValues: number[] = [];
  const queueWaitValues: number[] = [];
  const reviewLatencyValues: number[] = [];
  const fixRoundsValues: number[] = [];
  const openAgeValues: number[] = [];

  let firstPassNumerator = 0;
  let firstPassDenominator = 0;
  let escalationNumerator = 0;
  let escalationDenominator = 0;
  let mergedInWindowCount = 0;
  let modelUsdTotal = 0;
  let computeUsdTotal = 0;
  let tokensTotal = 0;
  let abandonedTotal = 0;
  let abandonedN = 0;

  for (const w of items) {
    const mergedInWindow = w.t_merged !== null && inWindow(w.t_merged, from, to);

    if (mergedInWindow) {
      const start = w.t_spec_ready ?? w.created_at;
      const diff = minutesBetween(start, w.t_merged!);
      if (diff >= 0) leadTimeValues.push(diff);
    }

    if (mergedInWindow && w.t_pr_opened !== null) {
      const diff = minutesBetween(w.t_pr_opened, w.t_merged!);
      if (diff >= 0) timeToMergeValues.push(diff);
    }

    if (w.t_pr_opened !== null && w.t_spec_ready !== null && inWindow(w.t_pr_opened, from, to)) {
      const diff = minutesBetween(w.t_spec_ready, w.t_pr_opened);
      if (diff >= 0) specToFirstPrValues.push(diff);
    }

    if (w.t_in_progress !== null && w.t_spec_ready !== null && inWindow(w.t_in_progress, from, to)) {
      const diff = minutesBetween(w.t_spec_ready, w.t_in_progress);
      if (diff >= 0) queueWaitValues.push(diff);
    }

    if (w.t_first_verdict !== null && w.t_pr_opened !== null && inWindow(w.t_first_verdict, from, to)) {
      const diff = minutesBetween(w.t_pr_opened, w.t_first_verdict);
      if (diff >= 0) reviewLatencyValues.push(diff);
    }

    if (mergedInWindow) {
      fixRoundsValues.push(w.n_changes_requested);
    }

    if (mergedInWindow && w.t_first_verdict !== null) {
      firstPassDenominator += 1;
      if (w.first_verdict_stage === 'review_passed') firstPassNumerator += 1;
    }

    if (w.t_pr_opened !== null && inWindow(w.t_pr_opened, from, to)) {
      escalationDenominator += 1;
      if (w.n_needs_human > 0) escalationNumerator += 1;
    }

    if (mergedInWindow) {
      mergedInWindowCount += 1;
      modelUsdTotal += w.model_usd;
      computeUsdTotal += w.compute_usd;
      tokensTotal += w.tokens;
    }

    if (!OPEN_STAGES_EXCLUDED.has(w.stage)) {
      const diff = minutesBetween(w.created_at, now);
      if (diff >= 0) openAgeValues.push(diff);
    }

    if (w.t_closed_unmerged !== null && inWindow(w.t_closed_unmerged, from, to)) {
      abandonedTotal += w.model_usd + w.compute_usd;
      abandonedN += 1;
    }
  }

  const runSuccessByRole = new Map<string, { succeeded: number; ended: number }>();
  for (const r of runs) {
    if (r.ended_at === null || !inWindow(r.ended_at, from, to)) continue;
    if (TERMINAL_RUN_STATUSES_EXCLUDED_FROM_SUCCESS_RATE.has(r.status)) continue;
    const bucket = runSuccessByRole.get(r.role) ?? { succeeded: 0, ended: 0 };
    bucket.ended += 1;
    if (r.status === 'succeeded') bucket.succeeded += 1;
    runSuccessByRole.set(r.role, bucket);
  }
  const runSuccessRate: RateByRoleResult = {};
  for (const [role, { succeeded, ended }] of runSuccessByRole) {
    runSuccessRate[role] = rate(succeeded, ended);
  }

  return {
    lead_time_minutes: distribution(leadTimeValues, MINUTES_DECIMALS),
    time_to_merge_minutes: distribution(timeToMergeValues, MINUTES_DECIMALS),
    spec_to_first_pr_minutes: distribution(specToFirstPrValues, MINUTES_DECIMALS),
    queue_wait_minutes: distribution(queueWaitValues, MINUTES_DECIMALS),
    review_latency_minutes: distribution(reviewLatencyValues, MINUTES_DECIMALS),
    fix_rounds: distribution(fixRoundsValues, COUNT_DECIMALS),
    first_pass_review_rate: rate(firstPassNumerator, firstPassDenominator),
    escalation_rate: rate(escalationNumerator, escalationDenominator),
    merged_count: { value: mergedInWindowCount },
    open_age_minutes: distribution(openAgeValues, MINUTES_DECIMALS),
    run_success_rate: runSuccessRate,
    model_usd_per_merged_pr: perPr(modelUsdTotal, mergedInWindowCount, USD_DECIMALS),
    compute_usd_per_merged_pr: perPr(computeUsdTotal, mergedInWindowCount, USD_DECIMALS),
    tokens_per_merged_pr: perPr(tokensTotal, mergedInWindowCount, TOKENS_DECIMALS),
    abandoned_usd: { value: round(abandonedTotal, USD_DECIMALS), n: abandonedN },
    first_pr_from_install: firstPrFromInstall(items, installations, now),
  };
}
