/**
 * D#2605 H05 / #173 review comment: the single UTC calendar-month
 * boundary every monthly spend check and dedup window shares. Deliberately
 * never local `getFullYear()`/`getMonth()` -- those read the process's own
 * timezone, so the boundary would disagree with a UTC timestamp near a
 * month rollover depending on server TZ (e.g. 2026-10-01T00:00:00.000Z
 * reads back as September 30 in America/Los_Angeles, and as already
 * October in Pacific/Auckland). Two independent callers
 * (packages/spend/src/reserve.ts's `monthToDateUsd` and this file's own
 * `emitBudgetExhaustedOnce`) used to compute this boundary separately --
 * one in local time, one in UTC -- and could disagree about which
 * calendar month a given moment belonged to on any non-UTC host. Both
 * now import this one function so there is exactly one place the boundary
 * is defined.
 */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
