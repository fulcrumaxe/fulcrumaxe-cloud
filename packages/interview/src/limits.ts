/**
 * The session bounds (D#291 section 3), in one place. Migration 1065's `interview_session_start` enforces the same numbers inside the
 * database; these constants are for display ("2 of 2 interviews in progress") and a test pins the two together at every boundary.
 * The USD and per-minute bounds belong to the turn service, which is a later row.
 */
export interface SessionBounds {
  /** Live (active or capped) sessions per account; null means no account-wide bound. */
  readonly activePerAccount: number | null;
  readonly activePerUser: number;
  /** Starts per account in a rolling 24 hours; abandoned sessions still count. */
  readonly startsPerDay: number;
}

export const UNPAID_BOUNDS: SessionBounds = { activePerAccount: 2, activePerUser: 2, startsPerDay: 10 };
export const PAID_BOUNDS: SessionBounds = { activePerAccount: null, activePerUser: 3, startsPerDay: 20 };

/** One answer, in bytes of UTF-8. A question's own `max_bytes` can only lower it. */
export const MAX_ANSWER_BYTES = 8 * 1024;

export function boundsFor(hostedPlanPaid: boolean): SessionBounds {
  return hostedPlanPaid ? PAID_BOUNDS : UNPAID_BOUNDS;
}
