import { describe, expect, it } from 'vitest';
import { ENGINE_STOP_REASONS } from '@fulcrumaxe/runner-protocol';
import { failedStopOf, isSystemStopReason, jobFactOf, needsPlanRead, stopFailedOf, type SessionJobFact, type StopFacts } from '../src/engine/stopFailed.js';

/** D#845 ON-13c4a: the one rule behind `stop_failed` on the repos list and behind the retry route. Pure: every row of the table is a repo's newest session job, its sandbox and its switches. */
const AT = '2026-11-26T12:00:00.000Z';
const stop = (over: Partial<SessionJobFact> = {}): SessionJobFact => ({ kind: 'engine_session_stop', state: 'failed', stopReason: 'person', failureCode: 'snapshot_failed', at: AT, ...over });
const facts = (job: SessionJobFact | null, over: Partial<StopFacts> = {}): StopFacts => ({ job, sandboxUp: true, watchEnabled: true, operateEnabled: true, ...over });

describe('stopFailedOf', () => {
  it('is null with no job, and null while the sandbox is not up', () => {
    expect(stopFailedOf(facts(null), true)).toBeNull();
    expect(stopFailedOf(facts(stop(), { sandboxUp: false }), true)).toBeNull();
  });

  it('is null unless the newest job is a stop in failed or expired', () => {
    for (const state of ['issued', 'delivered', 'done']) expect(stopFailedOf(facts(stop({ state })), true), state).toBeNull();
    for (const kind of ['engine_session_start', 'engine_session_delete']) {
      for (const state of ['issued', 'delivered', 'done', 'failed', 'expired']) expect(stopFailedOf(facts(stop({ kind, state, stopReason: null })), true), `${kind} ${state}`).toBeNull();
    }
  });

  it.each([['failed', 'snapshot_failed'], ['failed', null], ['expired', 'job_expired'], ['expired', 'job_silent'], ['expired', 'job_overran']] as const)('reads a %s stop with code %s', (state, code) => {
    expect(stopFailedOf(facts(stop({ state, failureCode: code })), false)).toEqual({ reason: 'person', code, at: AT });
  });

  it('answers each of the six reasons as itself when its cause holds', () => {
    const holds: Record<(typeof ENGINE_STOP_REASONS)[number], Partial<StopFacts>> = {
      person: {}, halt: {}, move: {}, remove: {}, operate_off: { operateEnabled: false }, plan: {},
    };
    for (const reason of ENGINE_STOP_REASONS) expect(stopFailedOf(facts(stop({ stopReason: reason }), holds[reason]), true)?.reason, reason).toBe(reason);
  });

  it('answers a reason outside the closed list as reason null, and no reason the same', () => {
    expect(stopFailedOf(facts(stop({ stopReason: 'park' })), true)).toEqual({ reason: null, code: 'snapshot_failed', at: AT });
    expect(stopFailedOf(facts(stop({ stopReason: null })), true)?.reason).toBeNull();
  });

  it('hides operate_off exactly while watch and operate are both on', () => {
    const off = stop({ stopReason: 'operate_off' });
    expect(stopFailedOf(facts(off, { operateEnabled: false }), true)).not.toBeNull();
    expect(stopFailedOf(facts(off, { watchEnabled: false }), true)).not.toBeNull();
    expect(stopFailedOf(facts(off, { watchEnabled: false, operateEnabled: false }), true)).not.toBeNull();
    expect(stopFailedOf(facts(off), true)).toBeNull();
  });

  it('hides plan unless the plan has ended', () => {
    const plan = stop({ stopReason: 'plan' });
    expect(stopFailedOf(facts(plan), false)).toBeNull();
    expect(stopFailedOf(facts(plan), true)).toMatchObject({ reason: 'plan' });
  });

  it('never hides a person-caused stop on a system cause: person, halt, move and remove ignore the switches and the plan', () => {
    for (const stopReason of ['person', 'halt', 'move', 'remove']) {
      expect(stopFailedOf(facts(stop({ stopReason }), { watchEnabled: false, operateEnabled: false }), false)?.reason, stopReason).toBe(stopReason);
      expect(stopFailedOf(facts(stop({ stopReason })), false)?.reason, stopReason).toBe(stopReason);
    }
  });

  it('writes the time as ISO from a Date or a string', () => {
    expect(stopFailedOf(facts(stop({ at: new Date(AT) })), true)?.at).toBe(AT);
  });
});

describe('the helpers around it', () => {
  it('failedStopOf, needsPlanRead and isSystemStopReason', () => {
    expect(failedStopOf(facts(stop()))).not.toBeNull();
    expect(failedStopOf(facts(stop(), { sandboxUp: false }))).toBeNull();
    expect(needsPlanRead(facts(stop({ stopReason: 'plan' })))).toBe(true);
    expect(needsPlanRead(facts(stop({ stopReason: 'person' })))).toBe(false);
    expect(needsPlanRead(facts(stop({ stopReason: 'plan', state: 'done' })))).toBe(false);
    expect(needsPlanRead(facts(stop({ stopReason: 'plan' }), { sandboxUp: false }))).toBe(false);
    expect([...ENGINE_STOP_REASONS].filter((r) => isSystemStopReason(r))).toEqual(['operate_off', 'plan']);
    expect(isSystemStopReason(null)).toBe(false);
  });

  it('jobFactOf is null for a repo with no job', () => {
    expect(jobFactOf({ job_kind: null, job_state: null, job_stop_reason: null, job_failure_code: null, job_at: null })).toBeNull();
    expect(jobFactOf({ job_kind: 'engine_session_stop', job_state: 'failed', job_stop_reason: 'halt', job_failure_code: null, job_at: AT })).toEqual({ kind: 'engine_session_stop', state: 'failed', stopReason: 'halt', failureCode: null, at: AT });
  });
});
