import { describe, expect, it } from 'vitest';
import { assertDriverEvent, ciWaitStopReasons } from '../src/work-items/driverEvents.js';
import { ciWaitTimeoutWords, classifyStall, STOP_WORDS, type StallFacts } from '../src/work-items/stalled.js';

const stopped = (reasons: string[]): StallFacts => ({
  stage: 'pr_opened',
  halted: false,
  liveRun: false,
  pendingRequest: false,
  waitingAsk: false,
  last: { kind: 'stopped', code: 'ci_wait_timeout', reasons, at: new Date(0) },
  lastActivity: new Date(0),
  now: new Date(60 * 60_000),
});

describe('ci_wait_timeout stop reasons', () => {
  it('keeps the wait reason words, then one missing_<check> code per required check, and drops anything else', () => {
    expect(ciWaitStopReasons(['required_missing', 'check_running', 'surprise'], ['fx-gate1', 'Audit Guard'])).toEqual(['required_missing', 'check_running', 'missing_fx_gate1', 'missing_audit_guard']);
    expect(ciWaitStopReasons(undefined, undefined)).toEqual([]);
  });

  it('names the checks that had not finished as running_<check>, after the missing ones', () => {
    expect(ciWaitStopReasons(['check_running'], undefined, ['pr-gates', 'e2e'])).toEqual(['check_running', 'running_pr_gates', 'running_e2e']);
    expect(ciWaitStopReasons(['required_missing', 'check_running'], ['fx-gate1'], ['pr-gates'])).toEqual(['required_missing', 'check_running', 'missing_fx_gate1', 'running_pr_gates']);
    expect(() => assertDriverEvent({ workItemId: 'w', kind: 'stopped', dedupeKey: 'k', code: 'ci_wait_timeout', reasons: ciWaitStopReasons(['check_running'], undefined, ['9 lives', 'a/b']) })).not.toThrow();
  });

  it('are plain codes the driver-event store accepts, at most five names, whatever the check is called', () => {
    const reasons = ciWaitStopReasons(['required_missing'], ['9lives', 'x'.repeat(200), 'a/b', 'c', 'd', 'e', 'f']);
    expect(reasons).toHaveLength(1 + 5);
    expect(() => assertDriverEvent({ workItemId: 'w', kind: 'stopped', dedupeKey: 'k', code: 'ci_wait_timeout', reasons })).not.toThrow();
  });
});

describe('the card words for a ci_wait_timeout stop', () => {
  it('names the checks that had not reported finished', () => {
    const why = classifyStall(stopped(ciWaitStopReasons(['check_running'], undefined, ['pr-gates'])))!.why;
    expect(why).toContain('a check was still running');
    expect(why).toContain('the check pr_gates had not reported finished');
  });

  it('names the required check that never reported', () => {
    const s = classifyStall(stopped(ciWaitStopReasons(['required_missing'], ['fx-gate1'])))!;
    expect(s.code).toBe('stopped');
    expect(s.why).toContain('the required check fx_gate1 never reported');
    expect(s.why).toContain('two hours');
  });

  it('says several checks, and what else was still running', () => {
    const why = ciWaitTimeoutWords(['check_running', 'required_missing', 'missing_a', 'missing_b']);
    expect(why).toContain('a check was still running and the required checks a, b never reported');
  });

  it('a required check with no name recorded (an older stop) still says it never reported', () => {
    expect(ciWaitTimeoutWords(['required_missing'])).toContain('a required check never reported');
  });

  it.each([
    ['gate1_waiting', "the cloud's Gate 1 was still waiting for a full CI run"],
    ['gate1_attest_off', "the cloud's Gate 1 is turned off for this repository"],
  ])('the Gate 1 reason %s is kept on the stop and named on the card', (code, words) => {
    const reasons = ciWaitStopReasons(['required_missing', code], ['fx-gate1']);
    expect(reasons).toEqual(['required_missing', code, 'missing_fx_gate1']);
    expect(ciWaitTimeoutWords(reasons)).toContain(`${words} and the required check fx_gate1 never reported`);
  });

  it('a stop with no reasons keeps the plain sentence', () => {
    expect(classifyStall(stopped([]))!.why).toBe(STOP_WORDS.ci_wait_timeout);
  });
});
