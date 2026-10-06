/** Same rationale as packages/spend/test/helpers/pgErrors.ts: SQLSTATE
 * codes, not a free-text message match. Duplicated rather than imported
 * for the same reason that file gives -- packages/db publishes no
 * test-helper exports. */
export const PG_ERROR = {
  INSUFFICIENT_PRIVILEGE: '42501',
} as const;
