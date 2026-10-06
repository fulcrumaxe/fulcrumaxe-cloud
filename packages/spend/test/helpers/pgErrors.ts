/**
 * SQLSTATE codes this suite asserts on directly, rather than matching a
 * free-text message -- same rationale as packages/db/test/helpers/
 * pgErrors.ts (D#2605 H02 security fix round 5 suggestion 4): a
 * message-regex assertion can pass for the wrong reason. Duplicated here
 * (rather than imported) because packages/db publishes no test-helper
 * exports and H05's file scope doesn't touch packages/db/test.
 */
export const PG_ERROR = {
  INSUFFICIENT_PRIVILEGE: '42501',
  /** Raised by migrations/0002_spend_fns.sql's
   * spend_reservations_check_transition() trigger (`USING ERRCODE =
   * 'check_violation'`) for an illegal spend_reservations.state jump, by
   * migrations/0003_spend_security_fixes.sql's two trigger functions, and
   * by an ordinary CHECK constraint violation (e.g. 'NaN' or a negative
   * value in a `usd`-denominated column). */
  CHECK_VIOLATION: '23514',
  /** Raised by Postgres itself, before any CHECK constraint runs, when a
   * value exceeds a `numeric(precision, scale)` column's bound --
   * including 'Infinity', which (unlike 'NaN') has a magnitude the bound
   * check rejects. See migrations/0003_spend_security_fixes.sql's file
   * header. */
  NUMERIC_OVERFLOW: '22003',
  /** Raised by a UNIQUE constraint violation -- e.g.
   * migrations/0629_ledger_account_run_budget_unique.sql's
   * ledger_account_run_budget_unique. */
  UNIQUE_VIOLATION: '23505',
} as const;
