import { describe, expect, it } from 'vitest';
import { signInGate, type SignInReport } from '../src/verify/signIn.js';
import { MAX_SIGN_IN_PARKS, SIGN_IN_WAIT_HOURS, VERIFY_HOLD_REASONS, VERIFY_REASON_CODES } from '../src/verify/rows.js';

/** D#749 VERIFY-SIGNIN-EXPIRY: the one decision made from the runners' reports. Pure; the rows and the reports themselves are in the worker's pg suite. */
const T = (h: number): Date => new Date(Date.UTC(2026, 10, 15, h));
const report = (state: SignInReport['state'], h: number): SignInReport => ({ state, at: T(h) });

describe('signInGate', () => {
  it('a check about to start goes when no runner said anything (an older runner, or no address set): nothing changes for them', () => {
    expect(signInGate([], null)).toBe('go');
  });

  it('a check about to start waits only when every report is bad; one good report, ok or expiring soon, lets it go', () => {
    expect(signInGate([report('expired', 1)], null)).toBe('park');
    expect(signInGate([report('missing', 1), report('expired', 2)], null)).toBe('park');
    expect(signInGate([report('expired', 1), report('ok', 1)], null)).toBe('go');
    expect(signInGate([report('expiring_soon', 1)], null)).toBe('go');
    expect(signInGate([report('ok', 1)], null)).toBe('go');
  });

  it('a check that is waiting goes only on a good report NEWER than the start of the wait; the report that was true when it was parked does not release it', () => {
    const hold = { since: T(10) };
    expect(signInGate([report('ok', 9)], hold)).toBe('park');
    expect(signInGate([report('ok', 10)], hold)).toBe('park');
    expect(signInGate([report('expired', 11)], hold)).toBe('park');
    expect(signInGate([report('ok', 11)], hold)).toBe('go');
    expect(signInGate([report('expiring_soon', 11)], hold)).toBe('go');
    expect(signInGate([], hold)).toBe('park');
  });

  it('names the closed words and the bounds the stage uses', () => {
    expect(VERIFY_HOLD_REASONS).toContain('needs_sign_in');
    expect(VERIFY_REASON_CODES).toContain('sign_in_expired');
    expect(SIGN_IN_WAIT_HOURS).toBe(24);
    expect(MAX_SIGN_IN_PARKS).toBe(3);
  });
});
