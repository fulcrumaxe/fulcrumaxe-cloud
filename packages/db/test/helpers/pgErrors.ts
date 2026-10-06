/**
 * SQLSTATE codes for asserting on the SPECIFIC Postgres error a rejected
 * query raised, rather than matching a free-text message (security fix
 * round 5, suggestion 4). A message-regex assertion can pass for the
 * wrong reason: the reviewer found a case where a UNIQUE violation stood
 * in for an intended RLS rejection in one of our own tests, because both
 * happened to reject and the test only checked ".rejects.toThrow()" with
 * no constraint on WHY.
 *
 * Use with `.rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE })`.
 * node-postgres attaches `code` as the raw SQLSTATE string on the thrown
 * error object.
 *
 * INSUFFICIENT_PRIVILEGE (42501) covers BOTH an RLS policy rejection
 * ("new row violates row-level security policy") and a missing-grant
 * rejection ("permission denied for table ...") -- Postgres raises the
 * same SQLSTATE class for either, so this one code is the correct
 * assertion for every "app_user can't do X at all" test in this suite,
 * regardless of which of those two reasons is the one that actually fires.
 */
export const PG_ERROR = {
  INSUFFICIENT_PRIVILEGE: '42501',
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  // D#2607 P01: support_grants' 60-minute CHECK is asserted by SQLSTATE,
  // same reasoning as the codes above -- a free-text message match could
  // pass for the wrong constraint.
  CHECK_VIOLATION: '23514',
  // PR #75 review fix round (D#64, MUST 1): the SQLSTATE Postgres itself
  // raises for a REPEATABLE READ / SERIALIZABLE `SELECT ... FOR UPDATE`
  // whose target row was changed by another transaction that committed
  // after this one's snapshot was taken ("could not serialize access due
  // to concurrent update/delete") -- distinct from the trigger's OWN
  // `23514 last owner` raise, and what the fixed last-owner count now
  // relies on to fail closed at those isolation levels.
  SERIALIZATION_FAILURE: '40001',
  // D#76: audit_write/audit_write_system raise this for a bad action
  // (not on the allowlist), a non-object payload, or a malformed
  // audit_write_system source string.
  INVALID_PARAMETER_VALUE: '22023',
} as const;
