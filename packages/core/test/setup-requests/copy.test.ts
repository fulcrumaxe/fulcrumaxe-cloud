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
  parityReason,
  repausedSentence,
  statusSentence,
} from '../../src/setup-requests/copy.js';
import { isValidReason } from '../../src/setup-requests/kinds.js';
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

  it('the two token reasons name the project and read as plain sentences', () => {
    expect(checkReasonSentence('token_cannot_read', FIELDS)).toBe('The connected Vercel token cannot read cloud-staging.');
    expect(checkReasonSentence('token_rejected', FIELDS)).toBe('Vercel did not accept the connected token, so cloud-staging could not be checked.');
  });

  it('a reason is one fixed code, never free text; no sentence ever shows a placeholder, null or undefined', () => {
    expect(CHECK_REASON_CODES).toEqual(['env_var_missing', 'env_var_wrong_target', 'check_unavailable', 'token_rejected', 'token_cannot_read']);
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

describe('parityReason (D#598 P1d-3)', () => {
  const f = { privateRepo: 'me/priv', publicRepo: 'me/pub', sha7: 'abcdef0123' };
  it('fills N1 and N2 from structured fields only, with a 7-character commit prefix', () => {
    const r = parityReason('drift', { ...f, paths: ['a.ts', 'b.ts'], pathCount: 2 });
    expect(r).toBe('Private main of me/priv differs from public main of me/pub outside the overlay paths, compared at public commit abcdef0. 2 paths differ: a.ts, b.ts. Port the change to a public pull request, or undo it on private main.');
    expect(parityReason('no_shared_history', { ...f, paths: ['a.ts'], pathCount: 1 })).toContain('contains none of the last 30 commits on public main of me/pub, so it was compared with public commit abcdef0. 1 paths differ: a.ts.');
  });
  it('keeps to 1,000 characters, cuts each path to 120, lists the first that fit and then says how many more', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `dir/${String(i).padStart(3, '0')}/${'x'.repeat(150)}`);
    const r = parityReason('drift', { ...f, paths, pathCount: 200 });
    expect(r.length).toBeLessThanOrEqual(1000);
    expect(r).toMatch(/200 paths differ: dir\/000\/x+…, dir\/001\//);
    expect(r).toMatch(/, and \d+ more\. Port the change/);
    const shown = (r.match(/dir\/\d{3}\//g) ?? []).length;
    expect(r).toContain(`and ${200 - shown} more.`);
    expect(r).not.toContain('x'.repeat(121));
  });
  it('replaces a control character in a path, so the reason stays valid whatever file name the public repo holds', () => {
    const r = parityReason('drift', { ...f, paths: ['bad\u0007name.ts', 'tab\there\nnl.ts', 'del\u007F.ts'], pathCount: 3 });
    expect(r).toContain('3 paths differ: bad\uFFFDname.ts, tab\uFFFDhere\uFFFDnl.ts, del\uFFFD.ts.');
    expect(isValidReason(r)).toBe(true);
  });
  it('words the other results with their approved sentences and never leaves a placeholder or a null', () => {
    for (const result of ['too_large', 'invalid_overlay', 'unsupported_branch'] as const) {
      const r = parityReason(result, { ...f, limitRepo: 'me/pub' });
      expect(r, result).not.toMatch(/[{}]|null|undefined/);
      expect(r, result).toContain('me/priv and me/pub');
    }
    expect(parityReason('unsupported_branch', f)).toBe("me/pub uses a default branch other than main, so parity between me/priv and me/pub isn't being checked.");
    expect(parityReason('unsupported_branch', { ...f, limitRepo: 'me/priv' })).toBe("me/priv uses a default branch other than main, so parity between me/priv and me/pub isn't being checked.");
    expect(parityReason('too_large', { ...f, limitRepo: 'me/priv' })).toMatch(/^We can't check me\/priv: GitHub won't list all of its files in one answer\./);
  });
});
