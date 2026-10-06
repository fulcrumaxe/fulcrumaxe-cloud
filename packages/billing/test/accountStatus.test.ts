import { describe, expect, it } from 'vitest';
import { isLegalPlan, nextAccountStatus } from '../src/accountStatus.js';

/**
 * sec-criteria A8: "H10 accounts.plan" state machine, plus the status
 * transitions H10 pass/fail 3 and 6 depend on. Pure functions, no
 * Postgres needed for the transition table itself (the DB write path is
 * covered in accountLifecycle.test.ts and webhook.test.ts against real
 * Postgres).
 */
describe('accounts.plan legal values (A8)', () => {
  it('accepts starter, team and scale', () => {
    expect(isLegalPlan('starter')).toBe(true);
    expect(isLegalPlan('team')).toBe(true);
    expect(isLegalPlan('scale')).toBe(true);
  });

  it('refuses an unrecognized plan value (no DB CHECK exists for this column)', () => {
    expect(isLegalPlan('enterprise')).toBe(false);
    expect(isLegalPlan('')).toBe(false);
    expect(isLegalPlan('Starter')).toBe(false); // case-sensitive, no normalization
  });
});

describe('accounts.status transitions (A8)', () => {
  // D#69 (migration 0606): checkout_completed/invoice_paid/
  // invoice_payment_failed are no longer `StatusEvent` members -- `status`
  // is derived in the database from marker columns now, and all three are
  // unconditionally legal (accountLifecycle.ts writes the corresponding
  // marker unconditionally; see the real-Postgres coverage in
  // accountLifecycle.test.ts and webhook.test.ts). `pause`/`resume` are
  // the only events still gated here, at the app layer, since which
  // marker to touch depends on the account's CURRENT derived status.
  it('pause is legal from active, past_due, unsubscribed and cancelled, idempotent from paused, but refused from model_key_broken (security-review fix round 2, MUST-fix 2, CWE-863)', () => {
    expect(nextAccountStatus('active', 'pause')).toBe('paused');
    expect(nextAccountStatus('paused', 'pause')).toBe('paused');
    // Security review fix round 2 (MUST-fix 2): pause from past_due used to
    // be refused (round-1 reasoning: a single-column resume forced
    // `active`, so pausing-then-resuming could launder a real payment
    // failure). Resume no longer forces `active` -- it only clears
    // owner_paused_at and lets the derivation stand -- so refusing pause
    // here just left an owner with no way to stop runs during the 7-day
    // grace window. It's legal now.
    expect(nextAccountStatus('past_due', 'pause')).toBe('paused');
    expect(nextAccountStatus('model_key_broken', 'pause')).toBeNull();
    expect(nextAccountStatus('unsubscribed', 'pause')).toBe('paused');
    expect(nextAccountStatus('cancelled', 'pause')).toBe('paused');
  });

  it('resume is legal only from paused -- an illegal transition is refused, not silently accepted', () => {
    expect(nextAccountStatus('paused', 'resume')).toBe('active');
    expect(nextAccountStatus('active', 'resume')).toBeNull();
    expect(nextAccountStatus('past_due', 'resume')).toBeNull();
    expect(nextAccountStatus('model_key_broken', 'resume')).toBeNull();
    expect(nextAccountStatus('unsubscribed', 'resume')).toBeNull();
    expect(nextAccountStatus('cancelled', 'resume')).toBeNull();
  });
});
