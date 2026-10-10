import { describe, expect, it } from 'vitest';
import { RUNNER_EVENT_KIND, RUNNER_WAITING_KIND, lineFor } from '../src/onboarding/previewProgress.js';
import { RUNNER_USAGE_NOTE, runnerUsageStateOf, type RunnerUsage } from '../src/runs/runnerUsage.js';
import { runnerCheckedInAt, RUNNER_LEASE_SECONDS_READ } from '../src/work-items/activity.js';

/** D#6 C42-3: the fixed lines of a runner run's states, and its cost state, as pure functions. */

const runnerEvent = (fields: Record<string, string | null>) => lineFor(RUNNER_EVENT_KIND, fields);

describe('runner state lines', () => {
  it('words waiting, taken over and the usage limit with fixed templates', () => {
    expect(lineFor(RUNNER_WAITING_KIND, {})).toBe('Waiting for your runner to come online');
    expect(runnerEvent({ type: 'taken_over' })).toBe('Taken over on the runner machine');
    expect(runnerEvent({ type: 'usage_limit_reached', reset_at: '2026-10-03T14:05:00.000Z' })).toBe('Plan usage limit reached; resumes at 14:05 UTC');
  });

  it('shows the reset time as UTC whatever offset the runner wrote, and no time when it is not an ISO time', () => {
    expect(runnerEvent({ type: 'usage_limit_reached', reset_at: '2026-10-03T23:30:00+02:00' })).toBe('Plan usage limit reached; resumes at 21:30 UTC');
    for (const bad of [null, '', 'tomorrow', '14:05', '2026-13-45T99:99:99Z', 'x'.repeat(40)]) {
      expect(runnerEvent({ type: 'usage_limit_reached', reset_at: bad }), String(bad)).toBe('Plan usage limit reached');
    }
  });

  it('gives a run_ended the plain form, in words, and nothing when the reason is not a closed code', () => {
    expect(runnerEvent({ type: 'run_ended', reason: 'wall_clock' })).toBe('The run ended (wall clock)');
    expect(runnerEvent({ type: 'run_ended' })).toBe('The run ended');
    expect(runnerEvent({ type: 'run_ended', reason: 'Bearer abc.def' })).toBe('The run ended');
    expect(runnerEvent({ type: 'run_ended', reason: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' })).toBe('The run ended');
  });

  it('gives no line to a runner event of any other type, or to an unknown one', () => {
    for (const type of ['tool_use', 'file_changed', 'command_exit', 'usage', 'credential_mismatch', 'engine_version', 'stage', 'whatever', null]) {
      expect(runnerEvent({ type }), String(type)).toBeNull();
    }
  });
});

describe('runnerUsageStateOf', () => {
  const usage = (over: Partial<RunnerUsage> = {}): RunnerUsage => ({
    credential_mode: 'subscription',
    model: 'sonnet-5',
    tokens_in: 1,
    tokens_out: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    api_equivalent_usd: 0.01,
    price_table_version: 'v',
    ...over,
  });

  it('is recorded with a price, not_priced without one, and a real zero stays a number', () => {
    expect(runnerUsageStateOf('runner', 'succeeded', usage())).toEqual({ state: 'recorded', note: null });
    expect(runnerUsageStateOf('runner', 'succeeded', usage({ api_equivalent_usd: 0 }))).toEqual({ state: 'recorded', note: null });
    expect(runnerUsageStateOf('runner', 'succeeded', usage({ api_equivalent_usd: null, price_table_version: null }))).toEqual({ state: 'not_priced', note: RUNNER_USAGE_NOTE.not_priced });
  });

  it('is not_recorded for every ended status with no usage, and no state yet for a run still going', () => {
    for (const status of ['succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled', 'paused']) {
      expect(runnerUsageStateOf('runner', status, null), status).toEqual({ state: 'not_recorded', note: RUNNER_USAGE_NOTE.not_recorded });
    }
    for (const status of ['pending', 'running']) expect(runnerUsageStateOf('runner', status, null), status).toEqual({ state: null, note: null });
  });

  it('says nothing for a run that is not a runner run', () => {
    expect(runnerUsageStateOf('production', 'succeeded', undefined)).toBeNull();
  });

  it('explains both missing-figure states in words that say it is not zero', () => {
    for (const note of Object.values(RUNNER_USAGE_NOTE)) expect(note).toMatch(/not the same as \$0/);
    expect(RUNNER_USAGE_NOTE.not_recorded).toMatch(/token/);
    expect(RUNNER_USAGE_NOTE.not_priced).toMatch(/no API price/);
  });
});

describe('runnerCheckedInAt', () => {
  const lease = new Date('2026-10-03T10:05:00.000Z');
  it('is the lease expiry less the lease length, for a running run only', () => {
    expect(runnerCheckedInAt('running', lease)).toBe(new Date(lease.getTime() - RUNNER_LEASE_SECONDS_READ * 1000).toISOString());
    for (const status of ['pending', 'succeeded', 'failed', 'cancelled', 'timed_out']) expect(runnerCheckedInAt(status, lease), status).toBeNull();
    expect(runnerCheckedInAt('running', null)).toBeNull();
  });
});
