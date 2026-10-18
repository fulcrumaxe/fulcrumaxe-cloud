import { describe, expect, it } from 'vitest';
import {
  CHECK_INTERVAL_SECONDS,
  CHECK_REASON_CODES,
  COPY_CHECKING_NOW,
  COPY_WAITING_CHECKED,
  COPY_WAITING_UNCHECKED,
  checkReasonSentence,
  isCheckReasonCode,
  repausedSentence,
  statusSentence,
} from '../../src/setup-requests/copy.js';
import { SETUP_REQUEST_DUE_AFTER_SECONDS } from '@fx/db/src/setupRequestLister.js';

/** D#598 P8b: the approved customer copy (C8 section 1, C9 ruling 1) as the strings the API will expose. */
describe('setup request copy (P8b)', () => {
  const FIELDS = { name: 'STRIPE_KEY', project: 'cloud-staging' };

  it('sentence 1: a waiting request with an automatic check states the interval it really runs at', () => {
    expect(statusSentence({ state: 'open', checkKind: 'env_var_present', checkReason: null }, { checksAvailable: true })).toBe(
      "We check for this every 60 seconds. The item continues by itself once it's done, or press Mark done.",
    );
    expect(COPY_WAITING_CHECKED).toContain('{interval}');
  });

  it('the stated interval is the cron interval, and no shorter than the real gap between looks (never names a shorter time than the check runs at)', () => {
    expect(CHECK_INTERVAL_SECONDS).toBe(60);
    // A request is due 45 s after its last look and the cron fires every 60 s: it is looked at every 60 s (a tick a few seconds early still finds it).
    expect(SETUP_REQUEST_DUE_AFTER_SECONDS).toBeLessThan(CHECK_INTERVAL_SECONDS);
    expect(statusSentence({ state: 'open', checkKind: 'env_var_present', checkReason: 'env_var_missing' }, { checksAvailable: true })).toContain(`${CHECK_INTERVAL_SECONDS} seconds`);
  });

  it('sentence 2: no automatic check, or no way to run one yet, or the last check could not reach the provider', () => {
    const want = "We can't check this one for you. Press Mark done when it's finished.";
    expect(COPY_WAITING_UNCHECKED).toBe(want);
    expect(statusSentence({ state: 'open', checkKind: null, checkReason: null }, { checksAvailable: true })).toBe(want);
    expect(statusSentence({ state: 'open', checkKind: 'env_var_present', checkReason: null }, { checksAvailable: false })).toBe(want);
    expect(statusSentence({ state: 'open', checkKind: 'env_var_present', checkReason: 'check_unavailable' }, { checksAvailable: true })).toBe(want);
  });

  it('a request that is not waiting has no waiting line (done and withdrawn)', () => {
    for (const state of ['done', 'withdrawn'] as const) expect(statusSentence({ state, checkKind: 'env_var_present', checkReason: null }, { checksAvailable: true })).toBeNull();
  });

  it('sentence 3 and the three reasons, word for word', () => {
    expect(COPY_CHECKING_NOW).toBe('Checking now.');
    expect(checkReasonSentence('env_var_missing', FIELDS)).toBe("STRIPE_KEY isn't set on cloud-staging yet.");
    expect(checkReasonSentence('env_var_wrong_target', FIELDS)).toBe('STRIPE_KEY is set on cloud-staging, but not for production.');
    expect(checkReasonSentence('check_unavailable', FIELDS)).toBe("We couldn't reach Vercel to check.");
  });

  it('sentence 4 wraps a reason', () => {
    expect(repausedSentence('env_var_missing', FIELDS)).toBe("We checked and it isn't done yet: STRIPE_KEY isn't set on cloud-staging yet. The item is paused again.");
    for (const code of CHECK_REASON_CODES) expect(repausedSentence(code, FIELDS)).toMatch(/^We checked and it isn't done yet: .+ The item is paused again\.$/);
  });

  it('a reason is one fixed code, never free text; no sentence ever shows a placeholder, null or undefined', () => {
    expect(CHECK_REASON_CODES).toEqual(['env_var_missing', 'env_var_wrong_target', 'check_unavailable']);
    for (const bad of ['', 'something else', null, undefined, 3]) expect(isCheckReasonCode(bad), String(bad)).toBe(false);
    for (const code of CHECK_REASON_CODES) {
      expect(checkReasonSentence(code, FIELDS)).not.toMatch(/[{}]|null|undefined/);
      expect(repausedSentence(code, FIELDS)).not.toMatch(/[{}]|null|undefined/);
    }
  });

  it('the sentences are built from structured fields only: a name with markup stays literal text in the sentence', () => {
    expect(checkReasonSentence('env_var_missing', { name: 'A_B', project: '<b>x</b>' })).toBe("A_B isn't set on <b>x</b> yet.");
  });
});
