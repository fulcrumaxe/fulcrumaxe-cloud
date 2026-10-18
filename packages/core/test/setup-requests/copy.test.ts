import { describe, expect, it } from 'vitest';
import {
  CHECK_INTERVAL_SECONDS,
  CHECK_REASON_CODES,
  CHECKING_NOW_WINDOW_MS,
  COPY_CHECKING_NOW,
  COPY_WAITING_CHECKED,
  COPY_WAITING_UNCHECKED,
  checkIntervalFor,
  checkReasonSentence,
  isCheckReasonCode,
  repausedSentence,
  statusSentence,
} from '../../src/setup-requests/copy.js';
import { SETUP_REQUEST_DUE_AFTER_SECONDS } from '@fx/db/src/setupRequestLister.js';

/** D#598 P8b: the approved customer copy (C8 section 1, C9 ruling 1) as the strings the API will expose. */
describe('setup request copy (P8b)', () => {
  const FIELDS = { name: 'STRIPE_KEY', project: 'cloud-staging', environment: 'production' as const };

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
    expect(checkReasonSentence('env_var_missing', { name: 'A_B', project: '<b>x</b>', environment: 'production' })).toBe("A_B isn't set on <b>x</b> yet.");
  });

  describe('sentences 3 and 4 are derived from the row (P8b-2)', () => {
    const t0 = Date.parse('2026-10-18T10:00:00Z');
    const closed = { state: 'done' as const, checkKind: 'env_var_present' as const, checkReason: null, resolution: 'marked_done' as const, resolvedAt: new Date(t0), checkRanAt: null, target: 'cloud-staging', envName: 'STRIPE_KEY', targetEnvironment: 'production' as const };

    it('sentence 3: marked done, check not yet answered, inside the window and with a source bound', () => {
      expect(statusSentence(closed, { checksAvailable: true, now: t0 + 1000 })).toBe(COPY_CHECKING_NOW);
      expect(statusSentence({ ...closed, checkRanAt: new Date(t0 + 1) }, { checksAvailable: true, now: t0 + 1000 })).toBeNull();
      expect(statusSentence({ ...closed, checkRanAt: new Date(t0) }, { checksAvailable: true, now: t0 + 1000 })).toBe(COPY_CHECKING_NOW);
      expect(statusSentence(closed, { checksAvailable: true, now: t0 + CHECKING_NOW_WINDOW_MS + 1 })).toBeNull();
      expect(statusSentence(closed, { checksAvailable: false, now: t0 + 1000 })).toBeNull();
      expect(statusSentence({ ...closed, checkKind: null }, { checksAvailable: true, now: t0 + 1000 })).toBeNull();
      expect(statusSentence({ ...closed, resolution: 'check_passed' }, { checksAvailable: true, now: t0 + 1000 })).toBeNull();
    });

    it('sentence 4: put back by the check after Mark done, in the check\'s own words, for every reason it can give', () => {
      const back = { ...closed, state: 'open' as const, resolution: null, resolvedAt: null, repausedAt: new Date(t0) };
      expect(statusSentence({ ...back, checkReason: 'env_var_missing' }, { checksAvailable: true })).toBe(
        "We checked and it isn't done yet: STRIPE_KEY isn't set on cloud-staging yet. The item is paused again.",
      );
      expect(statusSentence({ ...back, checkReason: 'env_var_wrong_target' }, { checksAvailable: true })).toBe(
        'We checked and it isn\'t done yet: STRIPE_KEY is set on cloud-staging, but not for production. The item is paused again.',
      );
      // The environment named is the request's own.
      expect(statusSentence({ ...back, targetEnvironment: 'preview', checkReason: 'env_var_wrong_target' }, { checksAvailable: true })).toContain('but not for preview.');
      // A later look that could not reach the provider reads as unchecked, as for any request; with no source bound too.
      expect(statusSentence({ ...back, checkReason: 'check_unavailable' }, { checksAvailable: true })).toBe(COPY_WAITING_UNCHECKED);
      expect(statusSentence({ ...back, checkReason: 'env_var_missing' }, { checksAvailable: false })).toBe(COPY_WAITING_UNCHECKED);
      // Not put back (the sweep's own "not yet" stamp): sentence 1 still.
      expect(statusSentence({ ...back, repausedAt: null, checkReason: 'env_var_missing' }, { checksAvailable: true })).toBe(
        COPY_WAITING_CHECKED.replace('{interval}', `${CHECK_INTERVAL_SECONDS} seconds`),
      );
    });

    it('the interval is stated only while a check can run on an open request', () => {
      expect(checkIntervalFor({ state: 'open', checkKind: 'env_var_present' }, { checksAvailable: true })).toBe(60);
      expect(checkIntervalFor({ state: 'open', checkKind: 'env_var_present' }, { checksAvailable: false })).toBeNull();
      expect(checkIntervalFor({ state: 'open', checkKind: null }, { checksAvailable: true })).toBeNull();
      expect(checkIntervalFor({ state: 'done', checkKind: 'env_var_present' }, { checksAvailable: true })).toBeNull();
    });
  });
});
