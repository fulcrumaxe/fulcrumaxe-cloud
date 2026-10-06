/**
 * Local copy of packages/db/test/helpers/pgErrors.ts's SQLSTATE table --
 * each package keeps its own (see that file's own header for why: assert
 * on the specific Postgres error, never a free-text message match).
 */
export const PG_ERROR = {
  INSUFFICIENT_PRIVILEGE: '42501',
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;
